// The checking pipeline: pick query sentences, search, download candidate
// pages, then attribute every copied word in the document to one source.

import {
  tokenize,
  splitSentences,
  excludedRanges,
  markExcluded,
  shingleSet,
  coverage,
  wordCount,
  normalizeWord,
} from "./text.js";
import { searchWeb, searchWikipedia, fetchSource, pool } from "./sources.js";

export const LIMITS = { maxChars: 60_000, maxQueries: 24, maxSources: 20, minSourceWords: 6 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickQueries(text, tokens, max) {
  const sentences = splitSentences(text)
    .map((s) => {
      const words = tokens.filter((t) => !t.excluded && t.start >= s.start && t.end <= s.end);
      return { ...s, words };
    })
    .filter((s) => s.words.length >= 8);
  // Spread queries across the whole document rather than only its start.
  const step = Math.max(1, sentences.length / max);
  const picked = [];
  for (let i = 0; i < sentences.length && picked.length < max; i += step) {
    picked.push(sentences[Math.floor(i)]);
  }
  return picked.map((s) => text.slice(s.words[0].start, s.words.at(-1).end).split(/\s+/).slice(0, 32).join(" "));
}

// Greedy attribution: the source covering the most words claims them first,
// the next source only gets words nobody has claimed yet. This is how
// overlapping sources still add up to a similarity no higher than 100%.
export function attribute(tokens, sources, n, minRun) {
  const scored = sources.map((s) => {
    const set = shingleSet(tokenize(s.text).map((t) => t.norm), n);
    const covered = coverage(tokens, set, n, minRun);
    let count = 0;
    for (const c of covered) count += c;
    return { ...s, covered, count };
  });
  scored.sort((a, b) => b.count - a.count);

  const owner = new Int16Array(tokens.length).fill(-1);
  const kept = [];
  for (const s of scored) {
    if (s.count < LIMITS.minSourceWords) continue;
    const id = kept.length;
    let words = 0;
    for (let i = 0; i < tokens.length; i++) {
      if (s.covered[i] && owner[i] === -1) {
        owner[i] = id;
        words++;
      }
    }
    if (words >= LIMITS.minSourceWords) {
      kept.push({ id, url: s.url, title: s.title, words, totalOverlap: s.count });
    } else {
      for (let i = 0; i < tokens.length; i++) if (owner[i] === id) owner[i] = -1;
    }
  }
  return { owner, sources: kept };
}

// Joins neighbouring words owned by the same source into one highlight span.
function buildSpans(text, tokens, owner) {
  const spans = [];
  let cur = null;
  tokens.forEach((t, i) => {
    if (t.excluded) return;
    const o = owner[i];
    if (o >= 0 && cur && cur.source === o && /^[\s\p{P}]*$/u.test(text.slice(cur.end, t.start))) {
      cur.end = t.end;
    } else if (o >= 0) {
      cur = { start: t.start, end: t.end, source: o };
      spans.push(cur);
    } else {
      cur = null;
    }
  });
  return spans;
}

export async function runCheck(text, options = {}, onProgress = () => {}) {
  const {
    excludeQuotes = true,
    excludeReferences = true,
    web = true,
    ownSources = [],
    shingle = 5,
  } = options;
  const minRun = Math.max(shingle, Math.min(40, Number(options.minRun) || 8));
  if (text.length > LIMITS.maxChars) text = text.slice(0, LIMITS.maxChars);

  const excluded = excludedRanges(text, { quotes: excludeQuotes, references: excludeReferences });
  const tokens = markExcluded(tokenize(text), excluded);
  const total = wordCount(tokens);
  if (total < 15) throw new Error("Add at least 15 words of text to check.");

  const candidates = ownSources
    .filter((s) => s.text && s.text.trim())
    .map((s, i) => ({ url: null, title: s.title || `Your source ${i + 1}`, text: s.text }));

  let stats = { queries: 0, found: 0, fetched: 0, failed: 0, searchErrors: 0 };

  if (web) {
    const queries = pickQueries(text, tokens, LIMITS.maxQueries);
    stats.queries = queries.length;
    const hits = new Map();
    let done = 0;
    onProgress({ stage: "search", done, total: queries.length });

    await pool(queries, 2, async (q) => {
      const keywords = q.split(/\s+/).filter((w) => normalizeWord(w).length > 3).slice(0, 8).join(" ");
      const [ddg, wiki] = await Promise.allSettled([searchWeb(q), searchWikipedia(keywords)]);
      for (const r of [ddg, wiki]) {
        if (r.status === "rejected") stats.searchErrors++;
        else for (const url of r.value) hits.set(url, (hits.get(url) || 0) + 1);
      }
      onProgress({ stage: "search", done: ++done, total: queries.length });
      await sleep(350);
    });

    // URLs returned for several different sentences are the likeliest sources.
    const ranked = [...hits.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u).slice(0, LIMITS.maxSources);
    stats.found = hits.size;
    done = 0;
    onProgress({ stage: "fetch", done, total: ranked.length });
    const pages = await pool(ranked, 6, async (url) => {
      try {
        return await fetchSource(url);
      } finally {
        onProgress({ stage: "fetch", done: ++done, total: ranked.length });
      }
    });
    for (const p of pages) {
      if (p.ok && p.value.text.length > 200) candidates.push(p.value);
      else stats.failed++;
    }
    stats.fetched = pages.length - stats.failed;
  }

  onProgress({ stage: "compare", done: 0, total: candidates.length });
  const { owner, sources } = attribute(tokens, candidates, shingle, minRun);
  const matched = sources.reduce((sum, s) => sum + s.words, 0);

  return {
    text,
    wordCount: total,
    matchedWords: matched,
    similarity: Math.round((matched / total) * 1000) / 10,
    sources: sources.map((s) => ({ ...s, percent: Math.round((s.words / total) * 1000) / 10 })),
    spans: buildSpans(text, tokens, owner),
    excluded,
    stats,
  };
}
