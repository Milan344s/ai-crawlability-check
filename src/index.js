// AI crawlability MCP server for milan-novotny.com.
// Stateless Streamable HTTP: every POST is a self-contained JSON-RPC exchange,
// so it runs on a free Cloudflare Worker with no storage and no LLM key.

import { checkAiCrawlerAccess, checkAiIndexability } from "./crawl.js";
import { checkAiCitability } from "./citability.js";
import { checkSeoBasics } from "./seo.js";
import { rubricPayload } from "./rubrics.js";

// Rubrics exposed by get_review_rubric.
const PUBLIC_RUBRICS = ["geo", "seo"];

const SERVER = { name: "ai-crawlability-check", title: "AI Crawlability Check", version: "2.0.0" };
const REGISTRY_AUTH = "v=MCPv1; k=ed25519; p=Wp4mdD3ME4PeKIBpNpwaZM39dUdgN+/H5/Cz0P/ywrk=";
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS =
  "AI Crawlability Check answers one question about any public URL: can AI search engines and assistants (ChatGPT, Claude, Perplexity, Google AI Overviews, Copilot) crawl it, index it and quote it? Start with check_ai_crawler_access for robots.txt and bot access. Use check_ai_indexability for noindex, canonical, JavaScript rendering and sitemap coverage. Use check_ai_citability for content structure and evidence, and check_seo_basics for on-page SEO. Every tool is read-only and returns a 0-100 score, per-check status with the measured value, and fixes. Report the measured values as given and do not claim a page is or is not in any index: these tools measure whether it can be.";

const readOnly = (openWorld) => ({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: openWorld });

const urlInput = (extra = {}) => ({ type: "object", properties: { url: { type: "string", description: "Public http(s) URL of the page to check, for example https://example.com/pricing." }, ...extra }, required: ["url"], additionalProperties: false });

const TOOLS = [
  {
    name: "check_ai_crawler_access",
    title: "Check AI crawler access to a URL",
    description:
      "Reports which AI crawlers may fetch a public URL. Reads the site's robots.txt and returns allowed or blocked, with the deciding rule, for each known AI crawler from OpenAI, Anthropic, Perplexity, Google, Microsoft, Apple, Meta, Amazon and others, split into search and answer-time bots versus training bots. Also checks whether the server answers an automated request, noindex and nosnippet directives, declared sitemaps, Content-Signal lines and llms.txt. Use for \"are we blocking GPTBot or ClaudeBot?\", \"can ChatGPT read this page?\" or an AI crawler audit of robots.txt.",
    inputSchema: urlInput(),
    annotations: readOnly(true),
    run: (a) => checkAiCrawlerAccess(a.url),
  },
  {
    name: "check_ai_indexability",
    title: "Check AI indexability of a URL",
    description:
      "Checks whether a public page can be indexed by search and AI engines once a crawler reaches it. Measures HTTP status and redirects, noindex, canonical target, how much copy exists in the raw HTML without JavaScript, client-side rendering signals, title and H1, XML sitemap coverage, response time, HTML size, structured data validity, dates and language. Use for \"why is this page not showing up in ChatGPT or Perplexity?\", \"is this page indexable?\" or to check a JavaScript-rendered page. It does not query any index.",
    inputSchema: urlInput(),
    annotations: readOnly(true),
    run: (a) => checkAiIndexability(a.url),
  },
  {
    name: "check_ai_citability",
    title: "Check AI citability of a URL",
    description:
      "Fetches a public page and scores how quotable its content is for AI engines once it is crawled and indexed. Measures answer-first structure, question headings, lists and tables, FAQ, paragraph and sentence length, statistic and source density, named entities, schema, author, freshness and llms.txt, plus a short crawler-access summary. Use for \"will AI cite this page?\", \"is this article LLM-friendly?\" or a GEO check. Tuned for articles and guides.",
    inputSchema: urlInput(),
    annotations: readOnly(true),
    run: (a) => checkAiCitability(a.url),
  },
  {
    name: "check_seo_basics",
    title: "Check on-page SEO basics of a URL",
    description:
      "Fetches a public page and runs 24 measurable on-page SEO checks: title and meta description length, H1, heading hierarchy, keyword placement and density, slug, canonical, internal and external links, anchor text, image alt text, schema and social tags. Pass the target keyword to enable the keyword checks. Does not cover rankings or backlinks.",
    inputSchema: urlInput({ keyword: { type: "string", description: "Target keyword or phrase. Optional; without it the keyword checks are skipped." } }),
    annotations: readOnly(true),
    run: (a) => checkSeoBasics(a.url, a.keyword),
  },
  {
    name: "get_review_rubric",
    title: "Get a content review rubric",
    description: "Returns a scoring rubric as text for the judgment items the URL tools cannot measure: geo (would an AI engine quote this article?) or seo (pre-publish SEO review). Fetches nothing.",
    inputSchema: { type: "object", properties: { type: { type: "string", enum: PUBLIC_RUBRICS, description: "Which rubric to return." } }, required: ["type"], additionalProperties: false },
    annotations: readOnly(false),
    run: (a) => {
      if (!PUBLIC_RUBRICS.includes(a.type)) throw new Error(`Unknown rubric "${a.type}". Use one of: ${PUBLIC_RUBRICS.join(", ")}.`);
      return rubricPayload(a.type);
    },
  },
];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type, accept, authorization, mcp-session-id, mcp-protocol-version, last-event-id",
  "access-control-max-age": "86400",
};
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS, ...extra } });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handleRpc(msg) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return msg && "id" in msg && !("method" in msg) ? null : rpcError(msg?.id, -32600, "Invalid JSON-RPC request");
  }
  const isNotification = !("id" in msg);
  const { id, method, params = {} } = msg;
  if (isNotification) return null;

  switch (method) {
    case "initialize": {
      const wanted = params.protocolVersion;
      return { jsonrpc: "2.0", id, result: { protocolVersion: PROTOCOLS.includes(wanted) ? wanted : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: INSTRUCTIONS } };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS.map(({ run, ...t }) => t) } };
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
      const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
      const missing = (tool.inputSchema.required || []).filter((k) => args[k] == null || args[k] === "");
      try {
        if (missing.length) throw new Error(`Missing required argument: ${missing.join(", ")}`);
        const out = await tool.run(args);
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 1) }], isError: false } };
      } catch (e) {
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(e?.message || e) }], isError: true } };
      }
    }
    case "resources/list":
      return { jsonrpc: "2.0", id, result: { resources: [] } };
    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

function landing(origin) {
  const tools = TOOLS.map((t) => `<li><code>${t.name}</code>: ${t.description.split(". ")[0]}.</li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Crawlability Check MCP | Milan Novotny</title><meta name="description" content="A free MCP server that checks whether AI crawlers can reach, index and quote a web page."><link rel="canonical" href="https://www.milan-novotny.com/tools/ai-crawlability-mcp/"><style>body{font:16px/1.6 system-ui,sans-serif;max-width:680px;margin:48px auto;padding:0 16px;color:#16181d;background:#fff}code,pre{font:14px ui-monospace,monospace;background:#f2f3f5;border-radius:6px}code{padding:2px 6px}pre{padding:12px;overflow-x:auto}h1{font-size:28px;line-height:1.2}@media(prefers-color-scheme:dark){body{background:#111317;color:#e8e9ec}code,pre{background:#1e2127}a{color:#8ab4ff}}</style></head><body><h1>AI Crawlability Check</h1><p>A free Model Context Protocol server by <a href="https://www.milan-novotny.com/">Milan Novotny</a>. It checks whether AI crawlers can reach a page, whether the page can be indexed, and whether its content is quotable. No account, no key, nothing stored. <a href="https://www.milan-novotny.com/tools/ai-crawlability-mcp/">Full documentation</a>.</p><h2>Connect</h2><p>Add this URL as a custom connector (remote MCP server) in your AI client:</p><pre>${origin}/mcp</pre><p>Claude Code:</p><pre>claude mcp add --transport http ai-crawlability ${origin}/mcp</pre><h2>Tools</h2><ul>${tools}</ul><h2>Privacy</h2><p>The server keeps no state and stores no input. It fetches the page you name plus that site's robots.txt, llms.txt and sitemaps, identified as <code>milan-novotny-mcp</code>. <a href="https://www.milan-novotny.com/tools/ai-crawlability-mcp/#privacy">Privacy details</a>.</p></body></html>`;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const isMcpPath = url.pathname === "/mcp" || url.pathname === "/mcp/" || url.pathname === "/";
    if (request.method === "GET") {
      if (url.pathname === "/") return new Response(landing(url.origin), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" } });
      if (url.pathname === "/health") return json({ ok: true, server: SERVER });
      // Proves control of this hostname to the official MCP Registry (namespace com.milan-novotny.mcp).
      if (url.pathname === "/.well-known/mcp-registry-auth") return new Response(REGISTRY_AUTH, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
      // No server-initiated stream: the spec allows 405 here.
      if (isMcpPath) return json(rpcError(null, -32000, "This server answers POST requests only."), 405, { allow: "POST, OPTIONS" });
      return json({ error: "not found" }, 404);
    }
    if (request.method !== "POST" || !isMcpPath) return json(rpcError(null, -32000, "Method not allowed"), 405, { allow: "POST, OPTIONS" });

    const raw = await request.text();
    if (raw.length > 200_000) return json(rpcError(null, -32600, "Request too large"), 413);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(rpcError(null, -32700, "Parse error"), 400);
    }

    if (Array.isArray(body)) {
      if (!body.length || body.length > 20) return json(rpcError(null, -32600, "Invalid batch"), 400);
      const out = (await Promise.all(body.map(handleRpc))).filter(Boolean);
      return out.length ? json(out) : new Response(null, { status: 202, headers: CORS });
    }
    const out = await handleRpc(body);
    return out ? json(out) : new Response(null, { status: 202, headers: CORS });
  },
};
