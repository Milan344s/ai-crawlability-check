// The two core tools: can AI crawlers reach this URL, and can they index what they find.

import { fetchText, safeUrl } from "./fetchpage.js";
import { parsePage } from "./html.js";
import { AI_BOTS, parseRobots, isAllowed } from "./robots.js";
import { gradeChecks, topFixes } from "./citability.js";

const looksHtml = (t) => /<html[\s>]|<!doctype html/i.test(t.slice(0, 600));
const st = (pass, warn) => (pass ? "pass" : warn ? "warn" : "fail");
const SOURCE = "milan-novotny.com AI crawlability MCP";

// robots.txt for one URL: state, per-bot verdicts, sitemaps and content signals.
export async function loadRobots(url) {
  const res = await fetchText(`${url.origin}/robots.txt`, "text/plain,*/*;q=0.5");
  const isText = res.ok && !looksHtml(res.text);
  // 4xx means "no robots.txt, everything allowed". 5xx or a network error means crawlers hold back.
  const state = isText ? "found" : (res.status >= 400 && res.status < 500) || (res.ok && !isText) ? "missing" : "unreadable";
  const text = isText ? res.text : "";
  const groups = parseRobots(text);
  const path = url.pathname + url.search;
  const bots = AI_BOTS.map((b) => {
    if (state === "unreadable") return { ...b, allowed: null, via: "robots.txt could not be read" };
    return { ...b, ...isAllowed(groups, b.name, path) };
  });
  const lines = text.split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim());
  const sitemaps = [...new Set(lines.map((l) => l.match(/^sitemap\s*:\s*(\S+)/i)?.[1]).filter(Boolean))];
  const contentSignals = [...new Set(lines.map((l) => l.match(/^content-signal\s*:\s*(.+)$/i)?.[1]).filter(Boolean))];
  const wildcard = state === "found" ? isAllowed(groups, "a-bot-with-no-rule-of-its-own", path) : { allowed: true };
  return { state, status: res.status, error: res.error || null, bytes: text.length, truncated: res.truncated, groups, bots, sitemaps, contentSignals, wildcardBlocked: wildcard.allowed === false, wildcardRule: wildcard.rule || null };
}

const botRow = (b) => ({ bot: b.name, owner: b.owner, role: b.role, purpose: b.note, vendor_position_on_robots_txt: b.robots, allowed: b.allowed, decided_by: b.rule ? `${b.rule} (group ${b.via})` : b.via });

function robotsDirectives(page, res) {
  const generic = `${page?.metas["robots"] || ""},${res.xRobotsTag || ""}`.toLowerCase();
  const perBot = {};
  for (const [k, v] of Object.entries(page?.metas || {})) {
    if (k !== "robots" && AI_BOTS.some((b) => b.name.toLowerCase() === k)) perBot[k] = v;
  }
  const all = `${generic},${Object.values(perBot).join(",")}`.toLowerCase();
  return {
    meta_robots: page?.metas["robots"] || null,
    x_robots_tag: res.xRobotsTag || null,
    per_bot_meta: perBot,
    noindex: /noindex|(^|[,\s])none([,\s]|$)/.test(generic),
    nosnippet: /nosnippet|max-snippet\s*:\s*0\b/.test(generic),
    noai: /\bnoai\b|\bnoimageai\b/.test(all),
    anyBotNoindex: Object.entries(perBot).filter(([, v]) => /noindex|none/i.test(v)).map(([k]) => k),
  };
}

export async function checkAiCrawlerAccess(input) {
  const url = safeUrl(input);
  const [res, robots, llms, llmsFull] = await Promise.all([
    fetchText(url.href),
    loadRobots(url),
    fetchText(`${url.origin}/llms.txt`, "text/plain,text/markdown,*/*;q=0.5"),
    fetchText(`${url.origin}/llms-full.txt`, "text/plain,text/markdown,*/*;q=0.5"),
  ]);
  const html = res.ok && (/html|xml/i.test(res.contentType) || looksHtml(res.text));
  const page = html ? parsePage(res.text, res.finalUrl) : null;
  const dir = robotsDirectives(page, res);

  const answer = robots.bots.filter((b) => b.role === "answer");
  const training = robots.bots.filter((b) => b.role === "training");
  const blockedAnswer = answer.filter((b) => b.allowed === false).map((b) => b.name);
  const blockedTraining = training.filter((b) => b.allowed === false).map((b) => b.name);
  const unknown = robots.state === "unreadable";
  const llmsOk = llms.ok && !looksHtml(llms.text) && llms.text.trim().length > 20;
  const llmsFullOk = llmsFull.ok && !looksHtml(llmsFull.text) && llmsFull.text.trim().length > 20;
  const blockedForUs = !res.ok;

  const checks = [
    { id: "robots_txt_readable", weight: 12, status: st(robots.state === "found", robots.state === "missing"),
      value: robots.state === "found" ? `found, ${robots.bytes} characters` : robots.state === "missing" ? `no robots.txt (HTTP ${robots.status})` : `could not be read (${robots.error || `HTTP ${robots.status}`})`,
      why: "A robots.txt that answers with a server error makes well-behaved crawlers treat the whole site as off limits. A missing file means everything is allowed, but you have no stated policy.",
      fix: robots.state === "missing" ? "Publish a robots.txt, even a short one, so your AI crawler policy is explicit." : "Make /robots.txt return HTTP 200 with plain text." },
    { id: "answer_bots_allowed", weight: 30, status: unknown ? "skip" : st(blockedAnswer.length === 0, blockedAnswer.length <= 3 && !answer.some((b) => b.core && b.allowed === false)),
      value: blockedAnswer.length ? `blocked: ${blockedAnswer.join(", ")}` : `all ${answer.length} search and answer-time bots allowed`,
      why: "These bots build AI search indexes or fetch a page when a person asks a question. A blocked bot cannot show or quote this URL.",
      fix: `Allow these user agents for this path in robots.txt: ${blockedAnswer.join(", ")}.` },
    { id: "training_bots_policy", weight: 8, status: unknown ? "skip" : st(blockedTraining.length === 0, true),
      value: blockedTraining.length ? `blocked: ${blockedTraining.join(", ")}` : `all ${training.length} training bots allowed`,
      why: "Blocking training bots is a legitimate choice. It also keeps the brand out of what future models know without searching.",
      fix: `Decide on purpose. If brand recall inside models matters more than content protection, allow: ${blockedTraining.join(", ")}.` },
    { id: "wildcard_rule", weight: 10, status: unknown ? "skip" : st(!robots.wildcardBlocked),
      value: robots.wildcardBlocked ? `"User-agent: *" blocks this path (${robots.wildcardRule})` : "the catch-all group does not block this path",
      why: "A catch-all Disallow blocks every new AI crawler that has no group of its own, including ones launched after the file was written.",
      fix: "Remove the catch-all Disallow for this path, or add explicit Allow groups for the AI bots you want." },
    { id: "page_reachable", weight: 15, status: st(res.ok, res.status === 403 || res.status === 429 || res.status === 0),
      value: res.ok ? `HTTP ${res.status} in ${res.ms} ms` : res.error ? `request failed: ${res.error}` : `HTTP ${res.status} to an automated request`,
      why: "robots.txt is only a request. A firewall, bot manager or rate limit that refuses automated clients blocks AI crawlers whatever robots.txt says.",
      fix: res.status === 403 || res.status === 429 ? "This server refused an automated request. Check the CDN or WAF bot settings and confirm verified AI crawlers are not challenged or blocked." : "Make the URL return HTTP 200 to a plain GET request." },
    { id: "not_noindex", weight: 10, status: !page ? "skip" : st(!dir.noindex && dir.anyBotNoindex.length === 0, !dir.noindex),
      value: dir.noindex ? "noindex set for all robots" : dir.anyBotNoindex.length ? `noindex for: ${dir.anyBotNoindex.join(", ")}` : "no noindex",
      why: "noindex removes the page from the search indexes that AI answers are drawn from.", fix: "Remove noindex from the robots meta tag and the X-Robots-Tag header." },
    { id: "snippets_and_ai_directives", weight: 5, status: !page ? "skip" : st(!dir.nosnippet && !dir.noai, !dir.nosnippet),
      value: dir.nosnippet ? "nosnippet or max-snippet:0 set" : dir.noai ? "noai or noimageai directive set" : "no snippet or AI restrictions",
      why: "nosnippet stops Google from quoting the page, which removes it from AI Overviews. noai is a non-standard opt-out some crawlers honour.", fix: "Remove nosnippet, max-snippet:0 and noai unless the restriction is intended." },
    { id: "sitemap_declared", weight: 5, status: unknown ? "skip" : st(robots.sitemaps.length > 0),
      value: robots.sitemaps.length ? `${robots.sitemaps.length} sitemap line(s) in robots.txt` : "no Sitemap line in robots.txt",
      why: "A Sitemap line is how a crawler that has never seen the site finds its pages.", fix: "Add a line such as \"Sitemap: https://example.com/sitemap.xml\" to robots.txt." },
    { id: "llms_txt", weight: 5, status: st(llmsOk, false), value: llmsOk ? `found, ${llms.text.length} characters${llmsFullOk ? "; llms-full.txt also found" : ""}` : "not found",
      why: "llms.txt is a proposed convention, not a standard, and no major AI engine has confirmed using it for ranking. It is cheap to publish, so it carries little weight here.", fix: "Optional: publish /llms.txt listing the pages you most want AI assistants to read." },
  ];

  const { score, verdict } = gradeChecks(checks);
  return {
    tool: "check_ai_crawler_access",
    url: url.href,
    score,
    verdict,
    summary: unknown
      ? "robots.txt could not be read, so crawler access is unknown and well-behaved bots will hold back."
      : `${answer.length - blockedAnswer.length} of ${answer.length} search and answer-time bots and ${training.length - blockedTraining.length} of ${training.length} training bots may fetch this URL according to robots.txt.${blockedForUs ? " The server refused this tool's own request, so a firewall may also be blocking bots." : ""}`,
    top_fixes: topFixes(checks),
    checks: checks.map(({ id, weight, status, value, why, fix }) => ({ id, weight, status, value, why, ...(status === "pass" || status === "skip" ? {} : { fix }) })),
    bots: robots.bots.map(botRow),
    robots_txt: { state: robots.state, sitemaps: robots.sitemaps, content_signals: robots.contentSignals, truncated: robots.truncated },
    page: { http_status: res.status, final_url: res.finalUrl, redirected: res.redirected, meta_robots: dir.meta_robots, x_robots_tag: dir.x_robots_tag, per_bot_meta: dir.per_bot_meta },
    llms_txt: { found: llmsOk, llms_full_txt: llmsFullOk },
    limits: [
      "This reads robots.txt, robots meta tags and HTTP headers. It cannot see firewall, CDN or bot-manager rules that target a specific crawler.",
      "The page was requested once with this tool's own user agent. It never impersonates another company's crawler.",
      "robots.txt is a request, not an enforcement. User-triggered fetchers may be documented by their vendor as not bound by it.",
      "Crawler names and purposes follow each vendor's public documentation and change over time.",
    ],
    scored_by: SOURCE,
  };
}

// Looks for the URL in the site's sitemaps. Reads at most 5 files.
async function findInSitemaps(url, declared) {
  const want = (u) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").toLowerCase();
  const target = want(url.origin + url.pathname);
  const queue = declared.length ? [...declared] : [`${url.origin}/sitemap.xml`];
  const read = [];
  let urls = 0;
  while (queue.length && read.length < 5) {
    const next = queue.shift();
    let safe;
    try { safe = safeUrl(next); } catch { continue; }
    if (read.includes(safe.href)) continue;
    const r = await fetchText(safe.href, "application/xml,text/xml,*/*;q=0.5");
    if (!r.ok || looksHtml(r.text)) { read.push(safe.href); continue; }
    read.push(safe.href);
    const locs = [...r.text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
    if (/<sitemapindex[\s>]/i.test(r.text)) {
      // Prefer child sitemaps whose name hints at this URL's section.
      const section = url.pathname.split("/").filter(Boolean)[0] || "";
      queue.push(...locs.sort((a, b) => Number(section && b.includes(section)) - Number(section && a.includes(section))));
    } else {
      urls += locs.length;
      if (locs.some((l) => want(l) === target)) return { found: true, files_read: read.length, urls_seen: urls, in: safe.href };
    }
  }
  return { found: false, files_read: read.length, urls_seen: urls, unread_remaining: queue.length, any_sitemap: urls > 0 };
}

export async function checkAiIndexability(input) {
  const url = safeUrl(input);
  const [res, robots] = await Promise.all([fetchText(url.href), loadRobots(url)]);
  const html = res.ok && (/html|xml/i.test(res.contentType) || looksHtml(res.text));
  if (!html) {
    const reason = res.error || (!res.ok ? `the page returned HTTP ${res.status}` : `the response is not HTML (${res.contentType || "no content type"})`);
    throw new Error(`Could not read ${url.href}: ${reason}. A page that refuses an automated request cannot be assessed, and may be refusing AI crawlers too. Run check_ai_crawler_access for the robots.txt view.`);
  }
  const page = parsePage(res.text, res.finalUrl);
  const finalUrl = new URL(res.finalUrl);
  const dir = robotsDirectives(page, res);
  const sm = await findInSitemaps(finalUrl, robots.sitemaps);

  const raw = res.text;
  const scripts = (raw.match(/<script\b/gi) || []).length;
  const appShell = /<div[^>]+id=["'](root|app|__next|__nuxt|svelte)["'][^>]*>\s*<\/div>/i.test(raw);
  const wc = page.wordCount;
  const h1s = page.headings.filter((h) => h.level === 1);
  const canon = page.canonical ? new URL(page.canonical, finalUrl).href.replace(/\/$/, "") : null;
  const self = (finalUrl.origin + finalUrl.pathname).replace(/\/$/, "");
  const sameHostPath = (a, b) => a.replace(/^https?:\/\/(www\.)?/, "") === b.replace(/^https?:\/\/(www\.)?/, "");
  const dateStr = page.jsonld.map((n) => n.dateModified || n.datePublished).find((v) => typeof v === "string") || page.metas["article:modified_time"] || page.metas["article:published_time"] || page.timeTags[0] || null;
  const answerBlocked = robots.bots.filter((b) => b.role === "answer" && b.allowed === false).map((b) => b.name);
  const kb = Math.round(raw.length / 1024);

  const checks = [
    { id: "http_status", weight: 12, status: "pass", value: `HTTP ${res.status}${res.redirected ? `, after a redirect to ${res.finalUrl}` : ""}`, why: "Only a page that answers 200 gets indexed.", fix: "" },
    { id: "no_redirect", weight: 3, status: st(!res.redirected, true), value: res.redirected ? `redirects to ${res.finalUrl}` : "no redirect", why: "Linking to a URL that redirects costs a crawler a second request and splits signals.", fix: "Link and submit the final URL directly." },
    { id: "indexable", weight: 15, status: st(!dir.noindex && dir.anyBotNoindex.length === 0, !dir.noindex), value: dir.noindex ? "noindex set" : dir.anyBotNoindex.length ? `noindex for: ${dir.anyBotNoindex.join(", ")}` : "no noindex", why: "noindex keeps the page out of the search indexes AI answers draw from.", fix: "Remove noindex from the robots meta tag and the X-Robots-Tag header." },
    { id: "crawl_allowed", weight: 12, status: robots.state === "unreadable" ? "skip" : st(answerBlocked.length === 0, !robots.bots.some((b) => b.core && b.allowed === false)), value: answerBlocked.length ? `robots.txt blocks: ${answerBlocked.join(", ")}` : "robots.txt allows all search and answer-time bots", why: "A page a bot may not fetch is never indexed by that engine.", fix: `Allow these bots for this path: ${answerBlocked.join(", ")}. Run check_ai_crawler_access for the rule that decided each one.` },
    { id: "canonical", weight: 8, status: st(Boolean(canon) && sameHostPath(canon, self), !canon), value: !canon ? "no canonical tag" : sameHostPath(canon, self) ? "self-referencing" : `points to ${canon}`, why: "A canonical that points elsewhere tells engines to index the other URL instead of this one.", fix: canon ? "Confirm the canonical target is intended. If this page should be indexed, point the canonical at itself." : "Add a self-referencing canonical tag." },
    { id: "content_in_raw_html", weight: 15, status: st(wc >= 300, wc >= 120), value: `${wc} words in the HTML the server sends`, why: "Most AI crawlers do not run JavaScript. Copy that only appears after rendering does not exist for them.", fix: "Server-render or pre-render the main copy so it is in the initial HTML response." },
    { id: "javascript_dependence", weight: 8, status: st(!(appShell && wc < 300) && !(wc < 120 && scripts >= 5), !(appShell && wc < 120)), value: `${scripts} script tags, ${appShell ? "empty app-shell container found" : "no empty app-shell container"}`, why: "An empty root container plus many scripts is the signature of a client-rendered app, which AI crawlers see as a blank page.", fix: "Use server-side rendering, static generation or pre-rendering for pages you want cited." },
    { id: "title_and_h1_in_html", weight: 6, status: st(Boolean(page.title) && h1s.length === 1, Boolean(page.title) && h1s.length >= 1), value: `title ${page.title ? "present" : "missing"}, ${h1s.length} H1`, why: "The title and H1 tell an index what the page is about before it reads anything else.", fix: "Send one title tag and exactly one H1 in the initial HTML." },
    { id: "in_sitemap", weight: 8, status: sm.found ? "pass" : sm.any_sitemap && sm.unread_remaining ? "skip" : sm.any_sitemap ? "warn" : "fail", value: sm.found ? `listed in ${sm.in}` : sm.any_sitemap ? `not found in ${sm.urls_seen} URLs across ${sm.files_read} sitemap file(s)${sm.unread_remaining ? `; ${sm.unread_remaining} more files not read` : ""}` : "no readable XML sitemap found", why: "A sitemap entry is the most direct way to tell a crawler a page exists and when it changed.", fix: sm.any_sitemap ? "Add this URL to the XML sitemap." : "Publish an XML sitemap and declare it in robots.txt." },
    { id: "response_time", weight: 5, status: st(res.ms <= 1500, res.ms <= 4000), value: `${res.ms} ms for the HTML, measured once from a Cloudflare data centre`, why: "Crawlers work on a time budget and answer-time fetchers on a tight one. A slow page gets skipped.", fix: "Cache the HTML at the edge and cut server response time below 1.5 seconds." },
    { id: "html_size", weight: 4, status: st(!res.truncated && kb <= 800, !res.truncated), value: `${kb} KB of HTML${res.truncated ? " (larger than the 1.5 MB this tool reads)" : ""}`, why: "Crawlers stop reading at a size limit, so copy that comes late in a very large document can be cut off.", fix: "Move inline scripts, styles and data out of the HTML, and put the main copy early." },
    { id: "structured_data", weight: 5, status: st(page.schemaTypes.length > 0 && page.jsonldErrors === 0, page.schemaTypes.length > 0), value: page.schemaTypes.length ? `${page.schemaTypes.join(", ")}${page.jsonldErrors ? `; ${page.jsonldErrors} JSON-LD block(s) do not parse` : ""}` : page.jsonldErrors ? `${page.jsonldErrors} JSON-LD block(s) do not parse` : "no JSON-LD found", why: "Valid schema states what the page is, who wrote it and when, without the engine having to guess.", fix: page.jsonldErrors ? "Fix the JSON-LD syntax error so the block parses." : "Add JSON-LD for the page type, for example Article, Product or FAQPage." },
    { id: "machine_readable_date", weight: 5, status: st(Boolean(dateStr), Boolean(res.lastModified)), value: dateStr ? `dated ${String(dateStr).slice(0, 10)}` : res.lastModified ? `Last-Modified header only: ${res.lastModified}` : "no date in schema, meta tags or headers", why: "An index needs a date to know which of two similar pages is current.", fix: "Publish datePublished and dateModified in schema, or article:modified_time in meta tags." },
    { id: "language_declared", weight: 3, status: st(Boolean(page.lang)), value: page.lang ? `lang="${page.lang}"` : "no lang attribute", why: "The lang attribute lets an engine match the page to queries in that language.", fix: "Set the lang attribute on the html element." },
    { id: "snippets_allowed", weight: 3, status: st(!dir.nosnippet), value: dir.nosnippet ? "nosnippet or max-snippet:0 set" : "snippets allowed", why: "A page that may be indexed but not quoted cannot appear in AI Overviews.", fix: "Remove nosnippet and max-snippet:0 unless intended." },
  ];

  const { score, verdict } = gradeChecks(checks);
  return {
    tool: "check_ai_indexability",
    url: res.finalUrl,
    score,
    verdict,
    top_fixes: topFixes(checks),
    checks: checks.map(({ id, weight, status, value, why, fix }) => ({ id, weight, status, value, why, ...(status === "pass" || status === "skip" ? {} : { fix }) })),
    page_facts: { title: page.title, h1: h1s[0]?.text || null, words_in_raw_html: wc, script_tags: scripts, html_kb: kb, canonical: page.canonical, meta_robots: dir.meta_robots, x_robots_tag: dir.x_robots_tag, schema_types: page.schemaTypes, sitemaps_checked: sm.files_read },
    limits: [
      "This shows whether the page can be indexed. It does not query any search or AI index, so it cannot confirm the page is in one.",
      "The page was read as raw HTML without running JavaScript, the way most AI crawlers read it.",
      "At most 5 sitemap files are read. On a large site a missing sitemap entry is reported as not checked, not as a failure.",
      "Response time is one request from one location and will vary.",
    ],
    scored_by: SOURCE,
  };
}
