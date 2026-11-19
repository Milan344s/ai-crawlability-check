import { fetchText, safeUrl } from "./fetchpage.js";
import { parsePage, words, sentences } from "./html.js";
import { AI_BOTS, parseRobots, isAllowed } from "./robots.js";

const STAT_RE = /(?:[$€£]\s?\d[\d,.]*\s?(?:k|m|bn|million|billion)?\b|\b\d[\d,.]*\s?(?:%|percent\b|x\b|million\b|billion\b|ms\b|seconds?\b|minutes?\b|hours?\b|days?\b|weeks?\b|months?\b|users\b|customers\b|companies\b|respondents\b|marketers\b|times\b))/gi;
const SOURCE_RE = /\b(according to|report|study|survey|research|data from|found that|analysis of|benchmark)\b/i;
const YEAR_RE = /\b(19|20)\d\d\b/;
const HEDGES = ["essentially", "basically", "arguably", "in some sense", "can be thought of as", "may help", "could potentially", "might be able to", "it is important to note", "in today's", "at the end of the day"];
const HYPE = ["game-changing", "game changer", "revolutionary", "best-in-class", "paradigm shift", "cutting-edge", "world-class", "next-generation", "seamless", "supercharge", "unlock the power"];

export function gradeChecks(checks) {
  let got = 0;
  let max = 0;
  for (const c of checks) {
    if (c.status === "skip") continue;
    max += c.weight;
    got += c.status === "pass" ? c.weight : c.status === "warn" ? c.weight / 2 : 0;
  }
  const score = max ? Math.round((got / max) * 100) : 0;
  const verdict = score >= 85 ? "Strong" : score >= 70 ? "Good" : score >= 50 ? "Leaking" : "Weak";
  return { score, verdict };
}

export function topFixes(checks, n = 5) {
  return checks
    .filter((c) => c.status === "fail" || c.status === "warn")
    .sort((a, b) => (b.status === "fail" ? b.weight : b.weight / 2) - (a.status === "fail" ? a.weight : a.weight / 2))
    .slice(0, n)
    .map((c) => ({ check: c.id, status: c.status, fix: c.fix }));
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function countPhrases(text, list) {
  const lower = text.toLowerCase();
  const hits = {};
  for (const p of list) {
    const n = lower.split(p).length - 1;
    if (n) hits[p] = n;
  }
  return hits;
}

function schemaDate(page) {
  const pick = (k) => page.jsonld.map((n) => n[k]).find((v) => typeof v === "string");
  const modified = pick("dateModified") || page.metas["article:modified_time"] || page.metas["og:updated_time"];
  const published = pick("datePublished") || page.metas["article:published_time"] || page.timeTags[0];
  return { modified: modified || null, published: published || null };
}

export async function loadPage(input) {
  const url = safeUrl(input);
  const res = await fetchText(url.href);
  const isHtml = /html|xml/i.test(res.contentType) || /<html[\s>]/i.test(res.text.slice(0, 2000));
  if (!res.ok || !isHtml) {
    const reason = res.error || (!res.ok ? `the page returned HTTP ${res.status}` : `the page is not HTML (${res.contentType || "no content type"})`);
    throw new Error(`Could not read ${url.href}: ${reason}. Some sites block automated requests; if this is one, run check_ai_crawler_access for the robots.txt view.`);
  }
  return { res, page: parsePage(res.text, res.finalUrl) };
}

export async function checkAiCitability(input) {
  const { res, page } = await loadPage(input);
  const url = new URL(res.finalUrl);
  const origin = url.origin;

  const [robotsRes, llmsRes] = await Promise.all([
    fetchText(`${origin}/robots.txt`, "text/plain,*/*;q=0.5"),
    fetchText(`${origin}/llms.txt`, "text/plain,text/markdown,*/*;q=0.5"),
  ]);

  // --- crawler access -------------------------------------------------------
  const robotsIsText = robotsRes.ok && !/<html[\s>]/i.test(robotsRes.text.slice(0, 500));
  const robotsState = robotsIsText ? "found" : robotsRes.status === 404 || (robotsRes.ok && !robotsIsText) ? "missing" : "unreadable";
  const groups = robotsIsText ? parseRobots(robotsRes.text) : [];
  const path = url.pathname + url.search;
  const bots = AI_BOTS.map((b) => {
    if (robotsState === "unreadable") return { ...b, allowed: null, via: "robots.txt could not be read" };
    return { ...b, ...isAllowed(groups, b.name, path) };
  });
  const answerBots = bots.filter((b) => b.role === "answer");
  const trainingBots = bots.filter((b) => b.role === "training");
  const blockedAnswer = answerBots.filter((b) => b.allowed === false).map((b) => b.name);
  const blockedTraining = trainingBots.filter((b) => b.allowed === false).map((b) => b.name);

  const robotsMeta = `${page.metas["robots"] || ""},${page.metas["googlebot"] || ""},${res.xRobotsTag}`.toLowerCase();
  const noindex = /noindex/.test(robotsMeta);
  const nosnippet = /nosnippet|max-snippet\s*:\s*0\b/.test(robotsMeta);

  // --- content signals ------------------------------------------------------
  const text = page.text;
  const wc = page.wordCount;
  const sents = sentences(text);
  const sentLens = sents.map((s) => words(s).length);
  const longShare = sentLens.length ? sentLens.filter((n) => n > 30).length / sentLens.length : 0;
  const paraLens = page.paragraphs.map((p) => words(p).length);
  const h1s = page.headings.filter((h) => h.level === 1);
  const subheads = page.headings.filter((h) => h.level === 2 || h.level === 3);
  const questionHeads = subheads.filter((h) => /\?\s*$/.test(h.text) || /^(what|why|how|when|where|who|which|can|does|do|is|are|should|will)\b/i.test(h.text));
  const qShare = subheads.length ? questionHeads.length / subheads.length : 0;

  const firstPara = page.paragraphs.find((p) => words(p).length >= 8) || "";
  const firstParaWords = words(firstPara).length;
  const definitional = /\b(is|are|means|refers to|is defined as|lets|helps)\b/i.test(firstPara) || /\d/.test(firstPara);

  const statMatches = text.match(STAT_RE) || [];
  const statsPer1k = wc ? (statMatches.length / wc) * 1000 : 0;
  const sourcedStats = sents.filter((s) => { STAT_RE.lastIndex = 0; return STAT_RE.test(s) && (YEAR_RE.test(s) || SOURCE_RE.test(s)); });
  STAT_RE.lastIndex = 0;
  const externalLinks = page.links.filter((l) => !l.internal);
  const externalDomains = [...new Set(externalLinks.map((l) => new URL(l.href).hostname.replace(/^www\./, "")))];

  // Named-entity proxy: capitalised or digit-bearing tokens that do not start a sentence.
  let entityTokens = 0;
  for (const s of sents) {
    const toks = words(s).slice(1);
    entityTokens += toks.filter((t) => /^[\p{Lu}][\p{L}\p{N}.'-]+/u.test(t) || /\d/.test(t)).length;
  }
  const entityShare = wc ? entityTokens / wc : 0;

  const hedges = countPhrases(text, HEDGES);
  const hype = countPhrases(text, HYPE);
  const fluffCount = [...Object.values(hedges), ...Object.values(hype)].reduce((a, b) => a + b, 0);
  const fluffPer1k = wc ? (fluffCount / wc) * 1000 : 0;

  const types = page.schemaTypes;
  const hasType = (...names) => names.some((n) => types.includes(n));
  const contentSchema = hasType("Article", "BlogPosting", "NewsArticle", "TechArticle", "WebPage", "Product", "SoftwareApplication", "HowTo", "FAQPage", "Dataset", "ProfilePage", "AboutPage", "CollectionPage");
  const authorRaw = page.jsonld.map((n) => n.author).find(Boolean);
  const authorNode = Array.isArray(authorRaw) ? authorRaw[0] : authorRaw;
  // An author given as {"@id": ...} points at another node in the graph.
  const author = authorNode && !authorNode.name && authorNode["@id"] ? page.jsonld.find((n) => n["@id"] === authorNode["@id"] && n.name) || authorNode : authorNode;
  const authorName = author?.name || (typeof author === "string" ? author : null) || page.metas["author"] || null;
  const sameAs = page.jsonld.some((n) => [].concat(n["@type"]).some((t) => ["Person", "Organization"].includes(t)) && n.sameAs);
  const dates = schemaDate(page);
  const dateStr = dates.modified || dates.published;
  const dateMs = dateStr ? Date.parse(dateStr) : NaN;
  const ageMonths = Number.isNaN(dateMs) ? null : Math.round((Date.now() - dateMs) / (30.44 * 864e5));
  const faqHeading = page.headings.some((h) => /\b(faq|frequently asked|common questions)\b/i.test(h.text));
  const llmsOk = llmsRes.ok && !/<html[\s>]/i.test(llmsRes.text.slice(0, 500)) && llmsRes.text.trim().length > 20;

  const st = (pass, warn) => (pass ? "pass" : warn ? "warn" : "fail");
  const checks = [
    // Access (30)
    { id: "indexable", group: "access", weight: 6, status: st(!noindex), value: noindex ? "noindex set" : "indexable",
      why: "A noindex page is dropped from the search indexes that AI answers are built on.", fix: "Remove noindex from the robots meta tag and the X-Robots-Tag header." },
    { id: "answer_bots_allowed", group: "access", weight: 10,
      status: robotsState === "unreadable" ? "skip" : st(blockedAnswer.length === 0, blockedAnswer.length <= 3 && !answerBots.some((b) => b.core && b.allowed === false)),
      value: blockedAnswer.length ? `blocked: ${blockedAnswer.join(", ")}` : `all ${answerBots.length} answer-time bots allowed`,
      why: "Answer-time bots fetch the page when someone asks a question. A blocked bot cannot quote the page.", fix: `Allow these user agents in robots.txt for this path: ${blockedAnswer.join(", ") || "none blocked"}.` },
    { id: "training_bots_allowed", group: "access", weight: 4,
      status: robotsState === "unreadable" ? "skip" : st(blockedTraining.length === 0, true),
      value: blockedTraining.length ? `blocked: ${blockedTraining.join(", ")}` : `all ${trainingBots.length} training bots allowed`,
      why: "Blocking training bots is a legitimate choice. It also keeps the brand out of what future models know by default.", fix: `Decide on purpose. If brand recall in models matters more than content protection, allow: ${blockedTraining.join(", ") || "none blocked"}.` },
    { id: "content_in_raw_html", group: "access", weight: 8, status: st(wc >= 300, wc >= 120), value: `${wc} words in the HTML the server sends`,
      why: "Most AI crawlers do not run JavaScript. Text that only appears after rendering is invisible to them.", fix: "Server-render or pre-render the main copy so it is present in the initial HTML." },
    { id: "snippets_allowed", group: "access", weight: 2, status: st(!nosnippet), value: nosnippet ? "nosnippet or max-snippet:0 set" : "snippets allowed",
      why: "nosnippet tells Google not to quote the page, which also removes it from AI Overviews.", fix: "Remove nosnippet and max-snippet:0 unless the block is intended." },
    // Structure (30)
    { id: "single_h1", group: "structure", weight: 3, status: st(h1s.length === 1, h1s.length > 1), value: `${h1s.length} H1`,
      why: "One H1 names the page's main entity without ambiguity.", fix: "Use exactly one H1 that states the topic." },
    { id: "answer_first", group: "structure", weight: 6, status: !firstPara ? "fail" : st(firstParaWords <= 60 && definitional, firstParaWords <= 90),
      value: firstPara ? `first paragraph: ${firstParaWords} words - "${firstPara.slice(0, 160)}${firstPara.length > 160 ? "..." : ""}"` : "no opening paragraph found",
      why: "Models lift the sentence that answers the query. An opening that defines the topic in under 60 words gets quoted; a warm-up does not.", fix: "Open with one self-contained sentence in the form \"[Topic] is ...\" that answers the core query, before any background." },
    { id: "question_headings", group: "structure", weight: 5, status: subheads.length < 3 ? "skip" : st(qShare >= 0.3, qShare >= 0.1),
      value: `${questionHeads.length} of ${subheads.length} H2/H3 headings are questions (${Math.round(qShare * 100)}%)`,
      why: "A question heading followed by a direct answer matches the shape of an AI answer and is extracted more often.", fix: "Rephrase headings as the questions readers ask, and answer each in the first sentence under it." },
    { id: "lists_or_tables", group: "structure", weight: 4, status: st(page.lists + page.tables >= 2, page.lists + page.tables >= 1), value: `${page.lists} lists (${page.orderedLists} numbered), ${page.tables} tables`,
      why: "Steps, lists and comparison tables are already answer-shaped, so they are lifted with little rewriting.", fix: "Turn the process into a numbered list and any comparison into a table with a header row." },
    { id: "faq_block", group: "structure", weight: 4, status: st(faqHeading || types.includes("FAQPage"), questionHeads.length >= 3), value: faqHeading || types.includes("FAQPage") ? "FAQ found" : "no FAQ section",
      why: "Short question-and-answer pairs are the easiest format for a model to extract.", fix: "Add 4 to 8 real user questions, each answered directly in 1 to 3 sentences." },
    { id: "paragraph_length", group: "structure", weight: 4, status: paraLens.length < 3 ? "skip" : st(median(paraLens) <= 70, median(paraLens) <= 100), value: `median paragraph ${median(paraLens)} words over ${paraLens.length} paragraphs`,
      why: "Short, self-contained paragraphs survive being quoted out of context.", fix: "Split paragraphs so each holds one idea in 2 to 4 lines." },
    { id: "sentence_length", group: "structure", weight: 4, status: sentLens.length < 5 ? "skip" : st(longShare <= 0.12, longShare <= 0.25), value: `${Math.round(longShare * 100)}% of ${sentLens.length} sentences run over 30 words`,
      why: "A long sentence buries its claim, and the model picks a shorter competitor's sentence.", fix: "Break sentences over 30 words into subject-verb-object statements." },
    // Evidence (25)
    { id: "stat_density", group: "evidence", weight: 8, status: wc < 150 ? "skip" : st(statsPer1k >= 5, statsPer1k >= 2), value: `${statMatches.length} quantified facts, ${statsPer1k.toFixed(1)} per 1,000 words`,
      why: "Specific numbers are what a model cites. Pages without them are paraphrased without credit.", fix: "Replace vague claims (\"many\", \"significant\") with a number, a unit and a date." },
    { id: "sourced_stats", group: "evidence", weight: 5, status: wc < 150 ? "skip" : st(sourcedStats.length >= 3, sourcedStats.length >= 1), value: `${sourcedStats.length} sentences carry a number with a year or a named source`,
      why: "A statistic is quotable when the number, the year and the source sit in one sentence.", fix: "Write stats as \"According to [source]'s [year] [report], [number] ...\"." },
    { id: "outbound_sources", group: "evidence", weight: 5, status: wc < 150 ? "skip" : st(externalDomains.length >= 3, externalDomains.length >= 1), value: `${externalLinks.length} external links to ${externalDomains.length} domains`,
      why: "Links to primary sources let a model cross-check a claim, which raises the chance it trusts the page.", fix: "Link every statistic to its original publisher." },
    { id: "named_entities", group: "evidence", weight: 4, status: wc < 150 ? "skip" : st(entityShare >= 0.08, entityShare >= 0.04), value: `${Math.round(entityShare * 100)}% of words are names or numbers (heuristic)`,
      why: "Named brands, people, tools and versions are anchors a model can verify. Generic prose has none.", fix: "Name the specific tools, companies, people and versions instead of \"various solutions\"." },
    { id: "hedging_and_hype", group: "evidence", weight: 3, status: wc < 150 ? "skip" : st(fluffPer1k <= 1, fluffPer1k <= 3), value: fluffCount ? `${fluffCount} hits: ${Object.keys({ ...hedges, ...hype }).join(", ")}` : "none found",
      why: "Hedged or hyped sentences are skipped in favour of direct statements.", fix: "Delete the listed phrases and state the claim directly." },
    // Entity and freshness (15)
    { id: "schema_markup", group: "entity", weight: 4, status: st(contentSchema, types.length > 0), value: types.length ? types.join(", ") : "no JSON-LD found",
      why: "Schema states what the page is and who wrote it in a form machines read without guessing.", fix: "Add JSON-LD: Article or BlogPosting for posts, FAQPage for the FAQ, HowTo for steps." },
    { id: "author", group: "entity", weight: 3, status: st(Boolean(authorName)), value: authorName || "no author in schema or meta",
      why: "A named author is a trust signal for both ranking and citation.", fix: "Add author to the Article schema and show a byline that links to a bio." },
    { id: "freshness", group: "entity", weight: 4, status: ageMonths == null ? "fail" : st(ageMonths <= 12, ageMonths <= 24), value: ageMonths == null ? "no machine-readable date" : `last dated ${dateStr.slice(0, 10)} (${ageMonths} months ago)`,
      why: "Models prefer the most recent source when several say the same thing.", fix: "Publish datePublished and dateModified in schema, and update the page when facts change." },
    { id: "entity_sameas", group: "entity", weight: 2, status: st(sameAs, hasType("Person", "Organization")), value: sameAs ? "Person/Organization with sameAs" : hasType("Person", "Organization") ? "Person/Organization without sameAs" : "none",
      why: "sameAs links tie the site to its profiles elsewhere, so a model treats them as one entity.", fix: "Add Person or Organization schema with sameAs links to LinkedIn and other profiles." },
    { id: "llms_txt", group: "entity", weight: 2, status: st(llmsOk, false), value: llmsOk ? `found (${llmsRes.text.length} characters)` : "not found",
      why: "llms.txt is an emerging convention with limited confirmed use by AI engines, so it carries little weight here.", fix: "Optional: publish /llms.txt listing the pages you most want cited." },
  ];

  const { score, verdict } = gradeChecks(checks);
  const groupScore = (g) => gradeChecks(checks.filter((c) => c.group === g)).score;

  return {
    tool: "check_ai_citability",
    url: res.finalUrl,
    score,
    verdict,
    section_scores: { access: groupScore("access"), structure: groupScore("structure"), evidence: groupScore("evidence"), entity_and_freshness: groupScore("entity") },
    top_fixes: topFixes(checks),
    checks: checks.map(({ id, group, weight, status, value, why, fix }) => ({ id, group, weight, status, value, why, ...(status === "pass" || status === "skip" ? {} : { fix }) })),
    ai_crawlers: { robots_txt: robotsState, bots: bots.map((b) => ({ bot: b.name, owner: b.owner, role: b.role, allowed: b.allowed, matched: b.rule || b.via })) },
    page_facts: { title: page.title, h1: h1s[0]?.text || null, words: wc, main_content_from: page.mainSource, html_truncated: res.truncated, schema_types: types, invalid_jsonld_blocks: page.jsonldErrors },
    limits: [
      "The page was read as raw HTML without JavaScript, the way most AI crawlers read it.",
      "robots.txt is checked; a firewall or CDN rule that blocks AI bots is not visible to this tool.",
      "This measures whether the page can be cited, not whether any AI engine cites it today.",
      "The score is tuned for articles and guides. A product or home page loses evidence points by design; read its access and structure scores first.",
      "Named-entity share and answer-first are heuristics. Judge tone, definitions and pronoun clarity by reading the copy against the rubric from get_review_rubric(\"geo\").",
    ],
    scored_by: "milan-novotny.com AI crawlability MCP",
  };
}
