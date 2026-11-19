// Small, dependency-free HTML helpers. Regex based on purpose: the same code
// runs in a Cloudflare Worker and in Node, and we only need coarse signals.

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: "..." };

export function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => safeChar(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeChar(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
function safeChar(n) {
  try { return String.fromCodePoint(n); } catch { return ""; }
}

export function textOf(html) {
  return decode(
    html
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/blockquote)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function words(text) {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
}

export function sentences(text) {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"“(])/u))
    .map((s) => s.trim())
    .filter((s) => words(s).length >= 3);
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? decode(m[1] ?? m[2] ?? m[3] ?? "") : null;
}

function removeBlocks(html, tags) {
  let out = html;
  for (const t of tags) out = out.replace(new RegExp(`<${t}\\b[\\s\\S]*?</${t}>`, "gi"), " ");
  return out;
}

export function parsePage(rawHtml, pageUrl) {
  const url = new URL(pageUrl);

  // JSON-LD first, before scripts are stripped.
  const jsonld = [];
  let jsonldErrors = 0;
  for (const m of rawHtml.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1].trim());
      const stack = Array.isArray(data) ? [...data] : [data];
      while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== "object") continue;
        if (Array.isArray(node["@graph"])) stack.push(...node["@graph"]);
        if (node["@type"]) jsonld.push(node);
      }
    } catch {
      jsonldErrors++;
    }
  }
  const schemaTypes = [...new Set(jsonld.flatMap((n) => [].concat(n["@type"])).map(String))];

  const noComments = rawHtml.replace(/<!--[\s\S]*?-->/g, " ");
  const head = (noComments.match(/<head\b[\s\S]*?<\/head>/i) || [noComments])[0];
  const clean = removeBlocks(noComments, ["script", "style", "noscript", "svg", "template", "iframe"]);

  const metas = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(m[0], "name") || attr(m[0], "property") || "").toLowerCase();
    const val = attr(m[0], "content");
    if (key && val != null && !(key in metas)) metas[key] = val;
  }
  const titleM = head.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? textOf(titleM[1]) : null;
  let canonical = null;
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    if ((attr(m[0], "rel") || "").toLowerCase().split(/\s+/).includes("canonical")) canonical = attr(m[0], "href");
  }
  const htmlTag = (noComments.match(/<html\b[^>]*>/i) || [""])[0];
  const lang = attr(htmlTag, "lang");

  const body = (clean.match(/<body\b[\s\S]*<\/body>/i) || [clean])[0];
  const chrome = ["nav", "footer", "aside", "form"];
  const bodyNoChrome = removeBlocks(body, chrome);

  // Main content: longest <article>, else <main>, else the body without chrome.
  let main = bodyNoChrome;
  let mainSource = "body";
  const articles = [...body.matchAll(/<article\b[\s\S]*?<\/article>/gi)].map((m) => removeBlocks(m[0], chrome));
  const bestArticle = articles.sort((a, b) => b.length - a.length)[0];
  const mainTag = body.match(/<main\b[\s\S]*<\/main>/i);
  if (bestArticle && words(textOf(bestArticle)).length >= 150) {
    main = bestArticle;
    mainSource = "article";
  } else if (mainTag) {
    main = removeBlocks(mainTag[0], chrome);
    mainSource = "main";
  }

  const headings = [...bodyNoChrome.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map((m) => ({ level: Number(m[1]), text: textOf(m[2]).replace(/\n/g, " ") }))
    .filter((h) => h.text);

  const paragraphs = [...main.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => textOf(m[1]).replace(/\n/g, " "))
    .filter((p) => words(p).length >= 3);

  const text = textOf(main);

  const links = [];
  for (const m of main.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = attr(m[0].slice(0, m[0].indexOf(">") + 1), "href");
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) continue;
    try {
      const u = new URL(href, url);
      if (!/^https?:$/.test(u.protocol)) continue;
      const bare = (h) => h.replace(/^www\./, "");
      links.push({ href: u.href, anchor: textOf(m[1]).replace(/\n/g, " "), internal: bare(u.hostname) === bare(url.hostname) });
    } catch { /* ignore bad hrefs */ }
  }

  const images = [...main.matchAll(/<img\b[^>]*>/gi)].map((m) => ({ alt: attr(m[0], "alt") }));
  const timeTags = [...main.matchAll(/<time\b[^>]*>/gi)].map((m) => attr(m[0], "datetime")).filter(Boolean);

  return {
    url: url.href,
    title,
    metas,
    canonical,
    lang,
    jsonld,
    jsonldErrors,
    schemaTypes,
    headings,
    paragraphs,
    text,
    wordCount: words(text).length,
    mainSource,
    links,
    images,
    timeTags,
    lists: (main.match(/<(ul|ol)\b/gi) || []).length,
    orderedLists: (main.match(/<ol\b/gi) || []).length,
    tables: (main.match(/<table\b/gi) || []).length,
  };
}
