// End-to-end test: drives the Worker's fetch handler the way an MCP client does.
//   node test/run.mjs                 offline protocol + copy-tool tests
//   node test/run.mjs https://...     also runs the two URL tools on that page
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { parseRobots, isAllowed } from "../src/robots.js";
import { parsePage } from "../src/html.js";
import { safeUrl } from "../src/fetchpage.js";

let nextId = 1;
async function rpc(method, params, { notify = false } = {}) {
  const body = { jsonrpc: "2.0", method, params, ...(notify ? {} : { id: nextId++ }) };
  const res = await worker.fetch(new Request("https://mcp.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) }));
  return { status: res.status, json: res.status === 202 ? null : await res.json() };
}
const call = async (name, args) => {
  const { json } = await rpc("tools/call", { name, arguments: args });
  const text = json.result.content[0].text;
  return { isError: json.result.isError, data: json.result.isError ? text : JSON.parse(text) };
};
const ok = (name) => console.log(`  ok  ${name}`);

// --- protocol ---------------------------------------------------------------
let r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
assert.equal(r.json.result.protocolVersion, "2025-06-18");
assert.ok(r.json.result.capabilities.tools);
ok("initialize echoes a supported protocol version");

r = await rpc("initialize", { protocolVersion: "1999-01-01" });
assert.equal(r.json.result.protocolVersion, "2025-11-25");
ok("initialize falls back to the newest version");

r = await rpc("notifications/initialized", {}, { notify: true });
assert.equal(r.status, 202);
ok("notification returns 202 with no body");

r = await rpc("tools/list", {});
assert.deepEqual(r.json.result.tools.map((t) => t.name), ["check_ai_crawler_access", "check_ai_indexability", "check_ai_citability", "check_seo_basics", "get_review_rubric"]);
assert.ok(r.json.result.tools.every((t) => t.inputSchema.type === "object" && !("run" in t)));
ok("tools/list returns 5 tools with schemas");

r = await rpc("nope/nope", {});
assert.equal(r.json.error.code, -32601);
ok("unknown method returns -32601");

let res = await worker.fetch(new Request("https://mcp.test/mcp", { method: "POST", body: "{not json" }));
assert.equal(res.status, 400);
res = await worker.fetch(new Request("https://mcp.test/mcp"));
assert.equal(res.status, 405);
res = await worker.fetch(new Request("https://mcp.test/"));
assert.match(await res.text(), /AI Crawlability Check/);
ok("bad JSON 400, GET /mcp 405, GET / landing page");

// --- units ------------------------------------------------------------------
const groups = parseRobots(`User-agent: *\nDisallow: /private/\nAllow: /private/open\n\nUser-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\n\nUser-agent: PerplexityBot\nDisallow: /*.pdf$\nDisallow:\n`);
assert.equal(isAllowed(groups, "GPTBot", "/blog/x").allowed, false);
assert.equal(isAllowed(groups, "CCBot", "/").allowed, false);
assert.equal(isAllowed(groups, "ClaudeBot", "/blog/x").allowed, true);
assert.equal(isAllowed(groups, "ClaudeBot", "/private/x").allowed, false);
assert.equal(isAllowed(groups, "ClaudeBot", "/private/open/x").allowed, true);
assert.equal(isAllowed(groups, "PerplexityBot", "/a/file.pdf").allowed, false);
assert.equal(isAllowed(groups, "PerplexityBot", "/a/file.pdf?x=1").allowed, true);
assert.equal(isAllowed(groups, "PerplexityBot", "/private/x").allowed, true);
ok("robots.txt: groups, longest match, wildcards, empty disallow");

for (const bad of ["http://localhost/", "http://127.0.0.1/", "http://[::1]/", "ftp://example.com/", "https://example.com:8443/", "https://intranet/", "https://box.internal/x", "https://user:pw@example.com/"]) {
  assert.throws(() => safeUrl(bad), undefined, bad);
}
assert.equal(safeUrl("example.com/a#frag").href, "https://example.com/a");
ok("URL guard refuses private, local and odd targets");

const page = parsePage(`<html lang="en"><head><title>T &amp; T</title><meta name="description" content="d"><link rel="canonical" href="/a"><script type="application/ld+json">{"@graph":[{"@type":"Article","author":{"name":"A B"},"dateModified":"2026-10-01"}]}</script></head><body><nav><a href="/x">nav</a></nav><main><h1>One</h1><p>First paragraph with enough words here.</p><h2>What is it?</h2><p>See <a href="/in">in</a> and <a href="https://other.com/o">out</a>.</p><img src="a.png"><ul><li>x</li></ul></main><footer><p>foot foot foot foot</p></footer></body></html>`, "https://www.example.com/a");
assert.equal(page.title, "T & T");
assert.deepEqual(page.schemaTypes, ["Article"]);
assert.equal(page.headings.length, 2);
assert.equal(page.links.length, 2);
assert.equal(page.links.filter((l) => l.internal).length, 1);
assert.equal(page.images[0].alt, null);
assert.ok(!page.text.includes("foot"));
ok("HTML parser: meta, JSON-LD graph, headings, links, chrome removed");

let t;
t = await call("get_review_rubric", { type: "geo" });
assert.match(t.data.instructions, /Answer first/);
t = await call("get_review_rubric", { type: "linkedin_post" });
assert.equal(t.isError, true);
r = await rpc("tools/call", { name: "review_linkedin_post", arguments: { draft: "x" } });
assert.equal(r.json.error.code, -32602);
t = await call("get_review_rubric", { type: "nope" });
assert.equal(t.isError, true);
t = await call("check_ai_citability", { url: "http://localhost:3000" });
assert.equal(t.isError, true);
t = await call("check_ai_citability", {});
assert.match(t.data, /Missing required argument/);
ok("rubric lookup, unknown rubric, blocked URL and missing argument all handled");

// --- live URL tools (optional) ----------------------------------------------
const liveUrl = process.argv[2];
if (liveUrl) {
  for (const [name, args] of [["check_ai_crawler_access", { url: liveUrl }], ["check_ai_indexability", { url: liveUrl }], ["check_ai_citability", { url: liveUrl }], ["check_seo_basics", { url: liveUrl, keyword: process.argv[3] }]]) {
    const out = await call(name, args);
    console.log(`\n=== ${name} ${liveUrl} ===`);
    if (out.isError) { console.log("ERROR:", out.data); continue; }
    const d = out.data;
    console.log(`score ${d.score} (${d.verdict})`, d.section_scores ? JSON.stringify(d.section_scores) : "");
    for (const c of d.checks) console.log(`  ${c.status.padEnd(4)} ${c.id.padEnd(28)} ${c.value}`);
    if (d.bots) console.log("  blocked:", d.bots.filter((b) => b.allowed === false).map((b) => b.bot).join(", ") || "none", "|", d.summary);
    if (d.ai_crawlers) console.log("  robots.txt:", d.ai_crawlers.robots_txt, "| blocked:", d.ai_crawlers.bots.filter((b) => b.allowed === false).map((b) => b.bot).join(", ") || "none");
    console.log("  top fixes:", d.top_fixes.map((f) => f.check).join(", "));
    console.log("  facts:", JSON.stringify(d.page_facts || d.page).slice(0, 400));
  }
}
console.log("\nall tests passed");
