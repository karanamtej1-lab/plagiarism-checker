// Finding and downloading candidate sources from the public web.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

const SKIP_HOSTS = /(^|\.)(duckduckgo\.com|youtube\.com|facebook\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|pinterest\.com)$/i;
const SKIP_EXT = /\.(pdf|docx?|pptx?|xlsx?|zip|jpg|jpeg|png|gif|mp4|mp3)(\?|$)/i;

async function fetchWithTimeout(url, opts = {}, ms = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

function usableUrl(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && !SKIP_HOSTS.test(u.hostname) && !SKIP_EXT.test(u.pathname);
  } catch {
    return false;
  }
}

// DuckDuckGo answers bursts of queries with HTTP 202 and a bot check
// instead of results. When that happens it is skipped for a few minutes and
// Bing takes over.
let ddgBlockedUntil = 0;

export async function searchWeb(query) {
  if (Date.now() > ddgBlockedUntil) {
    const urls = await searchDuckDuckGo(query).catch(() => null);
    if (urls?.length) return urls;
    if (urls === null) ddgBlockedUntil = Date.now() + 5 * 60_000;
  }
  return searchBing(query);
}

export async function searchDuckDuckGo(query) {
  const res = await fetchWithTimeout(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    { headers: { "User-Agent": UA } }
  );
  if (res.status !== 200) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const html = await res.text();
  const urls = [];
  for (const m of html.matchAll(/class="result__a"[^>]*href="[^"]*?uddg=([^"&]+)/g)) {
    try {
      const url = decodeURIComponent(m[1]);
      if (usableUrl(url)) urls.push(url);
    } catch {}
  }
  return [...new Set(urls)].slice(0, 6);
}

// Bing result links are click-trackers: bing.com/ck/a?...&u=a1<base64url>.
function unwrapBing(href) {
  const url = href.replace(/&amp;/g, "&");
  const u = url.includes("bing.com/ck/a") && new URL(url).searchParams.get("u");
  if (!u) return url;
  return Buffer.from(u.replace(/^a1/, ""), "base64url").toString("utf8");
}

export async function searchBing(query) {
  const res = await fetchWithTimeout(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`,
    { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" } }
  );
  if (!res.ok) throw new Error(`Bing HTTP ${res.status}`);
  const html = await res.text();
  const urls = [];
  for (const block of html.split('<li class="b_algo"').slice(1)) {
    const href = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"/)?.[1];
    if (!href) continue;
    try {
      const url = unwrapBing(href);
      if (usableUrl(url)) urls.push(url);
    } catch {}
  }
  return [...new Set(urls)].slice(0, 6);
}

// Wikimedia rejects API clients whose User-Agent has no contact URL.
const WIKI_UA = `plagiarism-checker/1.0 (${process.env.CONTACT_URL || "https://github.com/karanamtej1-lab"})`;

export async function searchWikipedia(query) {
  const res = await fetchWithTimeout(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=3&srsearch=${encodeURIComponent(query)}`,
    { headers: { "User-Agent": WIKI_UA } }
  );
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
  const data = await res.json();
  return (data.query?.search || []).map(
    (r) => `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`
  );
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", mdash: "—", ndash: "–", hellip: "…" };

export function htmlToText(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim();
  const text = html
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|tr|section|article)>/gi, ". ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
  return { title: decodeTitle(title), text };
}

function decodeTitle(t) {
  return t.replace(/&([a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d));
}

// Wikipedia pages are fetched through the REST API as plain HTML, which is
// faster and cleaner than the full skin.
export async function fetchSource(url) {
  const wiki = url.match(/^https:\/\/en\.wikipedia\.org\/wiki\/(.+)$/);
  const fetchUrl = wiki ? `https://en.wikipedia.org/api/rest_v1/page/html/${wiki[1]}` : url;
  const res = await fetchWithTimeout(fetchUrl, {
    headers: { "User-Agent": wiki ? WIKI_UA : UA, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "Accept-Language": "en-US,en;q=0.8" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") || "";
  if (!/html|text\/plain/.test(type)) throw new Error(`unsupported type ${type}`);
  const raw = (await res.text()).slice(0, 2_000_000);
  const { title, text } = /html/.test(type) ? htmlToText(raw) : { title: "", text: raw };
  return {
    url,
    title: title || (wiki ? decodeURIComponent(wiki[1]).replace(/_/g, " ") : new URL(url).hostname),
    text,
  };
}

// Runs async jobs with a fixed number in flight at once.
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
