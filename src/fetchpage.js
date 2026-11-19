// Fetching with guard rails: public http(s) hosts only, size cap, timeout.

export const USER_AGENT = "milan-novotny-mcp/1.0 (+https://www.milan-novotny.com/)";
const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 12_000;

export function safeUrl(input) {
  if (typeof input !== "string" || input.length > 2000) throw new Error("url must be a string under 2,000 characters");
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    throw new Error("url is not a valid URL");
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error("only http and https URLs are supported");
  if (u.port && !["80", "443"].includes(u.port)) throw new Error("non-standard ports are not supported");
  if (u.username || u.password) throw new Error("URLs with credentials are not supported");
  const h = u.hostname.toLowerCase();
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":") || h.startsWith("[");
  if (isIp || h === "localhost" || !h.includes(".") || /\.(local|localhost|internal|lan|home|test|invalid)$/.test(h)) {
    throw new Error("only public hostnames are supported");
  }
  u.hash = "";
  return u;
}

async function readCapped(res) {
  if (!res.body) return { text: await res.text(), truncated: false };
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    chunks.push(value);
    if (size >= MAX_BYTES) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const buf = new Uint8Array(Math.min(size, MAX_BYTES));
  let off = 0;
  for (const c of chunks) {
    const part = c.subarray(0, Math.min(c.byteLength, buf.length - off));
    buf.set(part, off);
    off += part.byteLength;
    if (off >= buf.length) break;
  }
  return { text: new TextDecoder("utf-8").decode(buf), truncated };
}

export async function fetchText(url, accept = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5") {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": USER_AGENT, accept },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // A redirect must not land on a host we would have refused.
    safeUrl(res.url || String(url));
    const { text, truncated } = await readCapped(res);
    return {
      ok: res.ok,
      status: res.status,
      finalUrl: res.url || String(url),
      redirected: Boolean(res.redirected),
      ms: Date.now() - started,
      lastModified: res.headers.get("last-modified") || "",
      contentType: res.headers.get("content-type") || "",
      xRobotsTag: res.headers.get("x-robots-tag") || "",
      text,
      truncated,
    };
  } catch (e) {
    return { ok: false, status: 0, redirected: false, ms: Date.now() - started, lastModified: "", finalUrl: String(url), contentType: "", xRobotsTag: "", text: "", truncated: false, error: e?.name === "TimeoutError" ? "timed out after 12 s" : String(e?.message || e) };
  }
}
