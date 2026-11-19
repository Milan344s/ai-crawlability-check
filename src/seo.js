import { loadPage, gradeChecks, topFixes } from "./citability.js";
import { words } from "./html.js";

const STOP = new Set(["the", "a", "an", "for", "to", "of", "and", "in", "on", "with", "is", "are"]);
const GENERIC_ANCHORS = /^(click here|here|read more|learn more|more|this|link|this page|this article)$/i;

function countKeyword(text, kw) {
  if (!kw) return 0;
  const esc = kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return (text.toLowerCase().match(new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "gu")) || []).length;
}

export async function checkSeoBasics(input, keywordIn) {
  const { res, page } = await loadPage(input);
  const url = new URL(res.finalUrl);
  const h1s = page.headings.filter((h) => h.level === 1);
  const h1 = h1s[0]?.text || "";
  const kw = (keywordIn || "").trim().toLowerCase() || null;
  const has = (s) => (kw ? countKeyword(s || "", kw) > 0 : false);
  const st = (pass, warn) => (pass ? "pass" : warn ? "warn" : "fail");
  const kwSkip = (status) => (kw ? status : "skip");

  const title = page.title || "";
  const desc = page.metas["description"] || "";
  const robots = `${page.metas["robots"] || ""},${res.xRobotsTag}`.toLowerCase();
  const slug = decodeURIComponent(url.pathname.replace(/\/$/, "").split("/").pop() || "");
  const slugWords = slug.split(/[-_]+/).filter(Boolean);
  const slugStops = slugWords.filter((w) => STOP.has(w.toLowerCase()));

  const skips = [];
  let prev = 0;
  for (const h of page.headings) {
    if (prev && h.level > prev + 1) skips.push(`H${prev} -> H${h.level} at "${h.text.slice(0, 50)}"`);
    prev = h.level;
  }
  const subheads = page.headings.filter((h) => h.level === 2 || h.level === 3);
  const questionHeads = subheads.filter((h) => /\?\s*$/.test(h.text) || /^(what|why|how|when|where|who|which|can|does|do|is|are|should|will)\b/i.test(h.text));
  const qShare = subheads.length ? questionHeads.length / subheads.length : 0;
  const bareLabels = subheads.filter((h) => /^(pricing|features|overview|benefits|best for|pros|cons|pros and cons|conclusion|summary|introduction|why it stands out)$/i.test(h.text.trim()));

  const wc = page.wordCount;
  const kwCount = countKeyword(page.text, kw);
  const density = wc && kw ? (kwCount * words(kw).length) / wc * 100 : 0;
  const longTail = kw ? words(kw).length >= 3 : false;
  const first100 =words(page.text).slice(0, 100).join(" ");
  const kwHeads = subheads.filter((h) => has(h.text)).length;

  const internal = page.links.filter((l) => l.internal);
  const external = page.links.filter((l) => !l.internal);
  const internalTargets = internal.map((l) => l.href.replace(/[#?].*$/, ""));
  const dupInternal = internalTargets.length - new Set(internalTargets).size;
  const generic = page.links.filter((l) => GENERIC_ANCHORS.test(l.anchor.trim()));
  const noAlt = page.images.filter((i) => i.alt == null || !i.alt.trim()).length;

  const canon = page.canonical ? new URL(page.canonical, url).href.replace(/\/$/, "") : null;
  const selfCanon = canon === (url.origin + url.pathname).replace(/\/$/, "");
  const og = ["og:title", "og:description", "og:image"].filter((k) => !page.metas[k]);

  const checks = [
    { id: "indexable", weight: 8, status: st(!/noindex/.test(robots)), value: /noindex/.test(robots) ? "noindex set" : "indexable", fix: "Remove noindex from the robots meta tag or X-Robots-Tag header." },
    { id: "title_length", weight: 5, status: !title ? "fail" : st(title.length >= 50 && title.length <= 60, title.length >= 30 && title.length <= 65), value: title ? `${title.length} characters: "${title}"` : "no title tag", fix: "Write a 50 to 60 character title." },
    { id: "title_keyword", weight: 6, status: kwSkip(st(has(title) && title.toLowerCase().indexOf(kw) <= 30, has(title))), value: kw ? (has(title) ? `keyword starts at character ${title.toLowerCase().indexOf(kw) + 1}` : "keyword not in title") : "no keyword given", fix: "Put the target keyword in the first 30 characters of the title." },
    { id: "meta_description_length", weight: 4, status: !desc ? "fail" : st(desc.length >= 140 && desc.length <= 160, desc.length >= 110 && desc.length <= 175), value: desc ? `${desc.length} characters` : "no meta description", fix: "Write a 140 to 160 character description that answers the query and gives a reason to click." },
    { id: "meta_description_keyword", weight: 2, status: kwSkip(st(has(desc))), value: kw ? (has(desc) ? "keyword present" : "keyword missing") : "no keyword given", fix: "Include the target keyword in the meta description." },
    { id: "h1_single", weight: 5, status: st(h1s.length === 1, h1s.length > 1), value: `${h1s.length} H1${h1 ? `: "${h1.slice(0, 80)}"` : ""}`, fix: "Use exactly one H1." },
    { id: "h1_length", weight: 2, status: !h1 ? "skip" : st(h1.length <= 60, h1.length <= 75), value: `${h1.length} characters`, fix: "Keep the H1 to 60 characters or fewer." },
    { id: "h1_keyword", weight: 4, status: kwSkip(!h1 ? "fail" : st(has(h1))), value: kw ? (has(h1) ? "keyword present" : "keyword missing") : "no keyword given", fix: "Include the target keyword in the H1." },
    { id: "heading_hierarchy", weight: 4, status: st(skips.length === 0, skips.length <= 2), value: skips.length ? `skipped levels: ${skips.slice(0, 4).join("; ")}` : "no skipped levels", fix: "Never skip a heading level (H2 to H4)." },
    { id: "descriptive_headings", weight: 3, status: st(bareLabels.length === 0, bareLabels.length <= 2), value: bareLabels.length ? `bare labels: ${bareLabels.map((h) => `"${h.text}"`).join(", ")}` : "no bare-label headings", fix: "Rewrite bare labels as descriptive or question headings (\"What does X cost?\")." },
    { id: "question_headings", weight: 4, status: subheads.length < 3 ? "skip" : st(qShare >= 0.5, qShare >= 0.25), value: `${questionHeads.length} of ${subheads.length} H2/H3 are questions (${Math.round(qShare * 100)}%)`, fix: "Phrase at least half of the H2/H3 headings as questions where it reads naturally." },
    { id: "keyword_in_first_100_words", weight: 5, status: kwSkip(st(has(first100))), value: kw ? (has(first100) ? "present" : "missing") : "no keyword given", fix: "Use the target keyword in the first 100 words of the body." },
    { id: "keyword_density", weight: 4, status: kwSkip(wc < 150 ? "skip" : longTail ? st(kwCount >= 3 && density <= 2.5, true) : st(density >= 0.5 && density <= 1.5, density >= 0.25 && density <= 2.5)), value: kw ? `${kwCount} exact mentions in ${wc} words (${density.toFixed(2)}%)${longTail ? "; long phrase, so judged on mention count, not density" : ""}` : "no keyword given", fix: longTail ? "Use the exact phrase at least 3 times where it reads naturally, and cover its close variants." : "Aim for 0.5% to 1.5% keyword density. Add natural mentions if low, cut repetition if high." },
    { id: "keyword_in_subheadings", weight: 3, status: kwSkip(subheads.length < 2 ? "skip" : st(kwHeads >= 2, kwHeads === 1)), value: kw ? `${kwHeads} H2/H3 headings contain the keyword` : "no keyword given", fix: "Use the keyword or a close variant in at least two H2/H3 headings." },
    { id: "word_count", weight: 4, status: st(wc >= 600, wc >= 300), value: `${wc} words of main content`, fix: "Thin page. Compare depth against the pages ranking for the keyword and cover what they cover, plus one angle they lack." },
    { id: "slug", weight: 3, status: !slug ? "skip" : st(slugWords.length <= 6 && slugStops.length === 0 && (!kw || has(slug.replace(/[-_]+/g, " "))), slugWords.length <= 9), value: `"${slug}"${slugStops.length ? `, stop-words: ${slugStops.join(", ")}` : ""}`, fix: "Use a short slug with the primary keyword and no stop-words." },
    { id: "canonical", weight: 4, status: st(Boolean(canon) && selfCanon, Boolean(canon)), value: canon ? (selfCanon ? "self-referencing" : `points to ${canon}`) : "no canonical tag", fix: "Add a self-referencing canonical tag, or confirm the cross-page canonical is intended." },
    { id: "internal_links", weight: 5, status: st(internal.length >= 3, internal.length >= 1), value: `${internal.length} internal links in the main content${dupInternal ? `, ${dupInternal} duplicates` : ""}`, fix: "Add 2 to 5 internal links to relevant pages, with no duplicates." },
    { id: "external_links", weight: 3, status: wc < 300 ? "skip" : st(external.length >= 2, external.length >= 1), value: `${external.length} external links`, fix: "Link out to the primary sources behind your claims." },
    { id: "anchor_text", weight: 2, status: st(generic.length === 0, generic.length <= 2), value: generic.length ? `${generic.length} generic anchors ("${generic[0].anchor}")` : "no generic anchors", fix: "Replace \"click here\" and \"read more\" with anchors that describe the destination." },
    { id: "image_alt", weight: 3, status: !page.images.length ? "skip" : st(noAlt === 0, noAlt / page.images.length <= 0.3), value: `${noAlt} of ${page.images.length} images lack alt text`, fix: "Add descriptive alt text to every content image." },
    { id: "schema_markup", weight: 3, status: st(page.schemaTypes.length > 0), value: page.schemaTypes.join(", ") || "no JSON-LD found", fix: "Add Article or BlogPosting schema, plus FAQPage or HowTo where they apply." },
    { id: "social_tags", weight: 2, status: st(og.length === 0, og.length < 3), value: og.length ? `missing: ${og.join(", ")}` : "og:title, og:description and og:image present", fix: "Add the missing Open Graph tags." },
    { id: "lang_and_viewport", weight: 2, status: st(Boolean(page.lang) && Boolean(page.metas["viewport"]), Boolean(page.lang) || Boolean(page.metas["viewport"])), value: `lang=${page.lang || "missing"}, viewport ${page.metas["viewport"] ? "set" : "missing"}`, fix: "Set the html lang attribute and a viewport meta tag." },
  ];

  const { score, verdict } = gradeChecks(checks);
  return {
    tool: "check_seo_basics",
    url: res.finalUrl,
    keyword: kw,
    score,
    verdict,
    top_fixes: topFixes(checks),
    checks: checks.map(({ id, weight, status, value, fix }) => ({ id, weight, status, value, ...(status === "pass" || status === "skip" ? {} : { fix }) })),
    page_facts: { title, meta_description: desc || null, h1: h1 || null, words: wc, headings: page.headings.slice(0, 40).map((h) => `H${h.level} ${h.text.slice(0, 90)}`) },
    limits: [
      kw ? "Keyword checks use exact-phrase matching, so close variants are not counted." : "No keyword was given, so the 6 keyword checks were skipped. Pass keyword to run them.",
      "This covers on-page basics only: no rankings, backlinks, search intent or competitor depth.",
      "Search intent, E-E-A-T and source quality need a human read; use get_review_rubric(\"seo\").",
    ],
    scored_by: "milan-novotny.com AI crawlability MCP",
  };
}
