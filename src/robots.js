// robots.txt parsing per RFC 9309: most specific user-agent group wins,
// longest matching rule wins, Allow beats Disallow on a tie.

// Verified against each vendor's own crawler documentation on 19 Nov 2026.
// role: "answer" = search index or user-triggered fetch, "training" = model training.
// robots: the vendor's stated position on robots.txt for that token.
// core: the bots behind the largest AI answer surfaces; blocking one is scored as a failure.
export const AI_BOTS = [
  { name: "OAI-SearchBot", owner: "OpenAI", role: "answer", core: true, robots: "honors", note: "surfaces sites in ChatGPT search" },
  { name: "ChatGPT-User", owner: "OpenAI", role: "answer", core: true, robots: "may not apply (user-triggered)", note: "live fetch when a ChatGPT user or custom GPT asks" },
  { name: "Claude-SearchBot", owner: "Anthropic", role: "answer", core: true, robots: "honors", note: "crawls to improve search results in Claude" },
  { name: "Claude-User", owner: "Anthropic", role: "answer", core: true, robots: "honors", note: "live fetch when a Claude user asks" },
  { name: "PerplexityBot", owner: "Perplexity", role: "answer", core: true, robots: "honors", note: "Perplexity search index; not used for model training" },
  { name: "Perplexity-User", owner: "Perplexity", role: "answer", core: true, robots: "generally ignores (user-triggered)", note: "live fetch when a Perplexity user asks" },
  { name: "Googlebot", owner: "Google", role: "answer", core: true, robots: "honors", note: "Google Search, including AI Overviews and AI Mode" },
  { name: "Bingbot", owner: "Microsoft", role: "answer", core: true, robots: "honors", note: "Bing index, which also grounds Copilot" },
  { name: "Applebot", owner: "Apple", role: "answer", robots: "honors", note: "search across Siri, Spotlight and Safari" },
  { name: "DuckAssistBot", owner: "DuckDuckGo", role: "answer", robots: "honors", note: "real-time fetch for DuckDuckGo AI answers; no training" },
  { name: "meta-webindexer", owner: "Meta", role: "answer", robots: "not stated", note: "Meta AI search results and citations" },
  { name: "meta-externalfetcher", owner: "Meta", role: "answer", robots: "may bypass (user-triggered)", note: "user-requested link fetches for Meta AI" },
  { name: "Amzn-SearchBot", owner: "Amazon", role: "answer", robots: "honors", note: "search in Amazon products such as Alexa; no training" },
  { name: "Amzn-User", owner: "Amazon", role: "answer", robots: "may not follow all rules (user-triggered)", note: "live fetch for Amazon user requests; no training" },
  { name: "MistralAI-Index", owner: "Mistral", role: "answer", robots: "not stated", note: "Mistral search index; no training" },
  { name: "MistralAI-User", owner: "Mistral", role: "answer", robots: "honors", note: "live fetch when a Le Chat user asks" },
  { name: "YouBot", owner: "You.com", role: "answer", robots: "honors", note: "You.com search index" },
  { name: "Google-Agent", owner: "Google", role: "answer", robots: "generally ignores (user-triggered)", note: "Google-hosted agents browsing for a user" },
  { name: "Claude-Agent", owner: "Anthropic", role: "answer", robots: "not stated", note: "hosted Claude browser acting for a user" },
  { name: "GPTBot", owner: "OpenAI", role: "training", robots: "honors", note: "OpenAI model training" },
  { name: "ClaudeBot", owner: "Anthropic", role: "training", robots: "honors", note: "Anthropic model training" },
  { name: "Google-Extended", owner: "Google", role: "training", robots: "honors", note: "control token for Gemini training and grounding; no effect on Search" },
  { name: "Applebot-Extended", owner: "Apple", role: "training", robots: "honors", note: "control token for Apple AI training on Applebot data" },
  { name: "meta-externalagent", owner: "Meta", role: "training", robots: "not stated", note: "training Meta AI models and improving products" },
  { name: "Amazonbot", owner: "Amazon", role: "training", robots: "honors", note: "improves Amazon products; data may train Amazon AI models" },
  { name: "MistralAI-Training", owner: "Mistral", role: "training", robots: "honors", note: "Mistral training datasets" },
  { name: "CCBot", owner: "Common Crawl", role: "training", robots: "honors", note: "open web archive, widely reused as AI training data" },
  { name: "AI2Bot", owner: "Allen Institute for AI", role: "training", robots: "not stated", note: "training open language models" },
  { name: "Bytespider", owner: "ByteDance", role: "training", robots: "no vendor documentation found", note: "ByteDance crawler, reported as model training" },
];

export function parseRobots(txt) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      current.rules.push({ allow: key === "allow", path: val });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function ruleMatches(rulePath, path) {
  if (rulePath === "") return false;
  const anchored = rulePath.endsWith("$");
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const re = new RegExp("^" + body.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""));
  return re.test(path);
}

export function isAllowed(groups, botName, path) {
  const bot = botName.toLowerCase();
  let matched = groups.filter((g) => g.agents.includes(bot));
  let via = botName;
  if (!matched.length) {
    matched = groups.filter((g) => g.agents.includes("*"));
    via = "*";
  }
  if (!matched.length) return { allowed: true, via: "no rule" };
  let best = null;
  for (const r of matched.flatMap((g) => g.rules)) {
    if (!ruleMatches(r.path, path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow && !best.allow)) best = r;
  }
  if (!best) return { allowed: true, via };
  return { allowed: best.allow, via, rule: `${best.allow ? "Allow" : "Disallow"}: ${best.path}` };
}
