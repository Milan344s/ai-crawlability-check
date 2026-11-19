# AI Crawlability Check

<img src="listing/icon.svg" width="72" height="72" alt="AI Crawlability Check icon">

AI Crawlability Check is a free [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that tells your AI assistant whether AI crawlers can reach a web page, whether the page can be indexed, and whether its content is quotable.

It checks robots.txt rules for 29 AI crawlers, including GPTBot, ClaudeBot, PerplexityBot and OAI-SearchBot, and runs 70 measured checks across four tools. It is hosted, needs no account and no API key, and stores nothing.

- **Endpoint:** `https://mcp.milan-novotny.com/mcp` (Streamable HTTP, no authentication)
- **Documentation:** https://www.milan-novotny.com/tools/ai-crawlability-mcp/
- **Privacy and terms:** https://www.milan-novotny.com/tools/ai-crawlability-mcp/privacy/
- **MCP Registry name:** `io.github.Milan344s/ai-crawlability-check`

## Connect

**Claude (web and desktop).** Settings, Connectors, "Add custom connector", then paste the endpoint URL.

**Claude Code**

```bash
claude mcp add --transport http ai-crawlability https://mcp.milan-novotny.com/mcp
```

**Cursor and other clients with a JSON config**

```json
{
  "mcpServers": {
    "ai-crawlability": { "url": "https://mcp.milan-novotny.com/mcp" }
  }
}
```

Then ask in plain language:

- "Are we blocking GPTBot, ClaudeBot or PerplexityBot on https://example.com/pricing?"
- "Check whether this page can be indexed by AI search engines, and list the fixes."
- "Run all the crawlability checks on our five most important URLs and give me one table."

## Tools

All five tools are read-only.

| Tool | Input | What it returns |
|---|---|---|
| `check_ai_crawler_access` | `url` | Allowed or blocked for 29 AI crawlers with the deciding robots.txt rule, plus 9 scored checks: robots.txt health, catch-all rules, server refusals, noindex, snippet rules, declared sitemaps, `Content-Signal` lines and llms.txt. |
| `check_ai_indexability` | `url` | 15 scored checks: HTTP status and redirects, noindex, canonical target, copy present in the raw HTML, JavaScript dependence, XML sitemap coverage, response time, HTML size, structured data, dates and language. |
| `check_ai_citability` | `url` | 22 scored checks on answer-first structure, question headings, lists and tables, statistics with sources, named entities, schema, author and freshness. Tuned for articles and guides. |
| `check_seo_basics` | `url`, `keyword` (optional) | 24 on-page SEO checks: title, meta description, H1, heading order, keyword use, slug, canonical, links, alt text and schema. |
| `get_review_rubric` | `type`: `geo` or `seo` | A review rubric as text, for the judgment a script cannot make. |

Every URL tool returns a 0 to 100 score, the measured value behind each check, the reason the check matters and a fix for each failure.

### Example result

`check_ai_crawler_access` on a page whose robots.txt blocks most AI crawlers (shortened):

```json
{
  "tool": "check_ai_crawler_access",
  "score": 45,
  "verdict": "Weak",
  "summary": "9 of 19 search and answer-time bots and 3 of 10 training bots may fetch this URL according to robots.txt.",
  "top_fixes": [
    { "check": "answer_bots_allowed", "status": "fail", "fix": "Allow these user agents for this path in robots.txt: ..." }
  ],
  "bots": [
    { "bot": "OAI-SearchBot", "owner": "OpenAI", "role": "answer", "allowed": false, "decided_by": "Disallow: / (group OAI-SearchBot)" }
  ]
}
```

## Crawlers checked

Names and purposes were verified against each vendor's own crawler documentation on 19 November 2026. Bytespider has no vendor documentation and is included because it appears in most block lists. Corrections are welcome as issues or pull requests against `src/robots.js`.

### Search and answer-time crawlers

| Crawler | Owner | What it is for | Vendor position on robots.txt |
|---|---|---|---|
| `OAI-SearchBot` | OpenAI | Surfaces sites in ChatGPT search | Honors |
| `ChatGPT-User` | OpenAI | Live fetch when a ChatGPT user or custom GPT asks | May not apply (user-triggered) |
| `Claude-SearchBot` | Anthropic | Crawls to improve search results in Claude | Honors |
| `Claude-User` | Anthropic | Live fetch when a Claude user asks | Honors |
| `PerplexityBot` | Perplexity | Perplexity search index; not used for model training | Honors |
| `Perplexity-User` | Perplexity | Live fetch when a Perplexity user asks | Generally ignores (user-triggered) |
| `Googlebot` | Google | Google Search, including AI Overviews and AI Mode | Honors |
| `Bingbot` | Microsoft | Bing index, which also grounds Copilot | Honors |
| `Applebot` | Apple | Search across Siri, Spotlight and Safari | Honors |
| `DuckAssistBot` | DuckDuckGo | Real-time fetch for DuckDuckGo AI answers; no training | Honors |
| `meta-webindexer` | Meta | Meta AI search results and citations | Not stated |
| `meta-externalfetcher` | Meta | User-requested link fetches for Meta AI | May bypass (user-triggered) |
| `Amzn-SearchBot` | Amazon | Search in Amazon products such as Alexa; no training | Honors |
| `Amzn-User` | Amazon | Live fetch for Amazon user requests; no training | May not follow all rules (user-triggered) |
| `MistralAI-Index` | Mistral | Mistral search index; no training | Not stated |
| `MistralAI-User` | Mistral | Live fetch when a Le Chat user asks | Honors |
| `YouBot` | You.com | You.com search index | Honors |
| `Google-Agent` | Google | Google-hosted agents browsing for a user | Generally ignores (user-triggered) |
| `Claude-Agent` | Anthropic | Hosted Claude browser acting for a user | Not stated |

### Training crawlers and control tokens

| Crawler | Owner | What it is for | Vendor position on robots.txt |
|---|---|---|---|
| `GPTBot` | OpenAI | OpenAI model training | Honors |
| `ClaudeBot` | Anthropic | Anthropic model training | Honors |
| `Google-Extended` | Google | Control token for Gemini training and grounding; no effect on Search | Honors |
| `Applebot-Extended` | Apple | Control token for Apple AI training on Applebot data | Honors |
| `meta-externalagent` | Meta | Training Meta AI models and improving products | Not stated |
| `Amazonbot` | Amazon | Improves Amazon products; data may train Amazon AI models | Honors |
| `MistralAI-Training` | Mistral | Mistral training datasets | Honors |
| `CCBot` | Common Crawl | Open web archive, widely reused as AI training data | Honors |
| `AI2Bot` | Allen Institute for AI | Training open language models | Not stated |
| `Bytespider` | ByteDance | ByteDance crawler, reported as model training | No vendor documentation found |

robots.txt matching follows [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309): the most specific user-agent group wins, the longest matching rule wins, and Allow beats Disallow on a tie.

## Limits

- **It queries no index.** The scores say whether a page can be crawled, indexed and quoted. They do not say whether any AI engine cites it today.
- **Bot-specific firewall rules are invisible.** The server reads robots.txt, meta tags and headers. It reports when its own request is refused, and it never sends another company's crawler user agent.
- **No JavaScript.** Pages are read as raw HTML on purpose, because that is how most AI crawlers read them.
- **Sitemaps are sampled.** At most 5 sitemap files are read per check.
- **Public pages only.** Private, local and non-standard addresses are refused.

## How it works

The server is one Cloudflare Worker with no dependencies, no storage and no language model. It implements the MCP Streamable HTTP transport statelessly: every POST to `/mcp` is a self-contained JSON-RPC exchange.

| File | Purpose |
|---|---|
| `src/index.js` | MCP protocol handling, tool definitions, landing page |
| `src/crawl.js` | Crawler access and indexability tools |
| `src/citability.js`, `src/seo.js` | Citability and SEO tools, scoring |
| `src/robots.js` | Crawler list and RFC 9309 matching |
| `src/html.js` | Dependency-free HTML extraction |
| `src/fetchpage.js` | Fetch guard: public hosts only, 1.5 MB cap, 12 second timeout |
| `src/rubrics.js` | The two review rubrics |
| `test/run.mjs` | Protocol, unit and tool tests |

## Run it yourself

Requires Node.js 22 or later.

```bash
npm test
```

Run the URL tools against a live page:

```bash
node test/run.mjs https://example.com/ "optional keyword"
```

Start a local server on port 8787:

```bash
npm run dev
```

To deploy your own copy, remove the `routes` line from `wrangler.toml` (it points at this project's domain) and run `npm run deploy`.

## Privacy

The server keeps no state. It has no database, no accounts and no cookies, and it does not log tool inputs. For a URL it requests that page and the same site's robots.txt, llms.txt, llms-full.txt and up to 5 sitemap files, with the user agent `milan-novotny-mcp/1.0`. Full policy: https://www.milan-novotny.com/tools/ai-crawlability-mcp/privacy/

## Author and licence

Built by [Milan Novotný](https://www.milan-novotny.com/) as a personal project. Crawler and product names belong to their owners; this project is not affiliated with or endorsed by any of them.

Released under the [MIT licence](LICENSE).
