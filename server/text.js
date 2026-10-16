// Text utilities: tokenizing with character offsets, sentence splitting,
// citation exclusion, and shingle-based matching.

const STOPWORDS = new Set(
  ("a an the and or but if of to in on at by for with from as is are was were be been being " +
    "it its this that these those there their they them he she his her we our you your i " +
    "not no so than then also can could would should will may might do does did has have had " +
    "which who whom what when where why how all any each more most other some such into over")
    .split(" ")
);

export function normalizeWord(word) {
  return word
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

// Every word in the text, with its position, so matches can be highlighted
// in the original string without losing formatting.
export function tokenize(text) {
  const tokens = [];
  const re = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
  let m;
  while ((m = re.exec(text))) {
    const norm = normalizeWord(m[0]);
    if (norm) tokens.push({ norm, start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

export function splitSentences(text) {
  const sentences = [];
  // A sentence ends at . ! ? followed by whitespace, or at a blank line.
  const re = /[^.!?\n]+(?:[.!?]+(?=\s|$)|\n\s*\n|$)|[^.!?]*[.!?]+/g;
  let m;
  while ((m = re.exec(text))) {
    if (!m[0].trim()) {
      if (re.lastIndex === m.index) re.lastIndex++;
      continue;
    }
    const lead = m[0].length - m[0].trimStart().length;
    const start = m.index + lead;
    const end = m.index + m[0].trimEnd().length;
    sentences.push({ text: text.slice(start, end), start, end });
  }
  return sentences;
}

// Character ranges the user wants ignored: quoted passages and the
// bibliography (everything after a "References"-style heading).
export function excludedRanges(text, { quotes = true, references = true } = {}) {
  const ranges = [];
  if (quotes) {
    const re = /"[^"\n]{3,}"|“[^”\n]{3,}”/g;
    let m;
    while ((m = re.exec(text))) ranges.push([m.index, m.index + m[0].length]);
  }
  if (references) {
    const heading = /^[ \t]*(references|bibliography|works cited|sources|citations)[ \t]*:?[ \t]*$/im;
    const m = heading.exec(text);
    if (m) ranges.push([m.index, text.length]);
  }
  return ranges;
}

export function markExcluded(tokens, ranges) {
  for (const t of tokens) {
    t.excluded = ranges.some(([a, b]) => t.start >= a && t.end <= b);
  }
  return tokens;
}

function isAllStopwords(words) {
  return words.every((w) => STOPWORDS.has(w));
}

// Set of n-word sequences ("shingles") in a token stream. Shingles made of
// only stopwords ("one of the most") match everywhere, so they are dropped.
export function shingleSet(norms, n) {
  const set = new Set();
  for (let i = 0; i + n <= norms.length; i++) {
    const gram = norms.slice(i, i + n);
    if (!isAllStopwords(gram)) set.add(gram.join(" "));
  }
  return set;
}

// For each document token, true if it is part of some n-gram that also
// appears in the source. Excluded tokens are skipped over (they neither
// match nor break a run), so a citation in the middle of a copied sentence
// does not hide the copying around it.
export function coverage(tokens, sourceSet, n, minRun = 8) {
  const idx = [];
  tokens.forEach((t, i) => {
    if (!t.excluded) idx.push(i);
  });
  const covered = new Uint8Array(tokens.length);
  for (let k = 0; k + n <= idx.length; k++) {
    const gram = [];
    for (let j = 0; j < n; j++) gram.push(tokens[idx[k + j]].norm);
    if (sourceSet.has(gram.join(" "))) {
      for (let j = 0; j < n; j++) covered[idx[k + j]] = 1;
    }
  }
  return dropShortRuns(covered, idx, minRun);
}

// Idioms like "at the end of the day" are real overlaps but not copying, so
// a match only counts once it runs for minRun words in a row.
function dropShortRuns(covered, idx, minRun) {
  let runStart = 0;
  for (let k = 0; k <= idx.length; k++) {
    if (k < idx.length && covered[idx[k]]) continue;
    if (k - runStart < minRun) for (let j = runStart; j < k; j++) covered[idx[j]] = 0;
    runStart = k + 1;
  }
  return covered;
}

export function wordCount(tokens) {
  return tokens.filter((t) => !t.excluded).length;
}
