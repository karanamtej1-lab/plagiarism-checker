# Plagiarism Checker

A free plagiarism checker. Paste text or upload a `.txt`, `.docx` or `.pdf`. Each passage is searched on the web, and every copied phrase is highlighted and linked to the page it came from.

**Live:** https://plagiarism-checker-nu-inky.vercel.app

This is a ground-up rewrite of [cu-sanjay/Free-Turnitin-Plagiarism-Checker](https://github.com/cu-sanjay/Free-Turnitin-Plagiarism-Checker).

## Run it

```bash
npm install
npm run dev        # http://localhost:3300
npm test
```

Requires Node 20+. No API keys needed.

## Deploy

Deployed on Vercel with the Express preset (`vercel.json`). Vercel requires the entry file to import `express` itself, so the app lives in `app.js`; `server/index.js` only calls `listen()` for local dev. Uploads are capped at 4 MB because Vercel rejects request bodies over 4.5 MB.

```bash
npx vercel deploy --prod
```

## How it works

1. **Pick passages.** The document is split into sentences, and up to 24 of them are spread evenly across the text and used as search queries.
2. **Search.** Each query goes to DuckDuckGo, falling back to Bing if DuckDuckGo rate-limits, plus Wikipedia's search API. URLs returned for several different sentences are ranked first.
3. **Download.** The top 20 pages are fetched in parallel and stripped to plain text.
4. **Match.** The document and each page are broken into 5-word sequences (shingles). A word counts as copied when it belongs to a shingle the source also contains, and the matching run is at least *N* words long. *N* is the "Smallest match" setting (default 8), which filters out stock phrases like "at the end of the day".
5. **Attribute.** The source covering the most words claims them first. Each later source only gets words nobody else has claimed, so the per-source percentages add up to the overall score and never go past 100%.

Quoted text and anything under a *References / Bibliography / Works Cited* heading are ignored by default.

### What changed from the original

| Original | This version |
|---|---|
| Cosine similarity of one sentence against a whole page, so shared common words count as matches | Shingle containment with a minimum run length, so only real copied wording counts |
| Checks only the first 20 sentences, one at a time, with a 1 s pause between each | Spreads queries across the whole document and runs them in parallel; about 5–10 s total |
| Per-sentence scores averaged together | Word-level highlights, each tied to exactly one source |
| No progress shown until the end | Live progress streamed from the server |
| File upload advertised but not built | `.txt` / `.docx` / `.pdf` extraction |
| — | Compare against your own pasted sources (classmates' drafts, paywalled articles) |

## Limits

- It only finds sources that public search engines can reach. Paywalled journals and other students' papers aren't searchable unless you paste them in as your own sources.
- Heavy paraphrasing isn't detected, by design: it measures shared wording.
- A similarity score isn't proof of misconduct. Quoted and cited material is normal.
