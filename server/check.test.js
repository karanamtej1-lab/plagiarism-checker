import { test } from "node:test";
import assert from "node:assert/strict";
import { runCheck } from "./check.js";
import { splitSentences, excludedRanges, tokenize, markExcluded } from "./text.js";

const SOURCE =
  "Photosynthesis is the process by which green plants and some other organisms use sunlight to synthesize foods from carbon dioxide and water. It generally involves the green pigment chlorophyll and generates oxygen as a byproduct.";

const offline = (text, ownSources, extra = {}) => runCheck(text, { web: false, ownSources, ...extra });

test("copied passage is attributed to its source", async () => {
  const essay = `My essay starts with my own thoughts about gardening on weekends. ${SOURCE} I think this is fascinating and I want to learn more about it someday.`;
  const r = await offline(essay, [{ title: "Britannica", text: SOURCE }]);
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0].title, "Britannica");
  // 35 of the essay's words are copied.
  assert.ok(r.similarity > 50 && r.similarity < 70, `similarity ${r.similarity}`);
  const highlighted = r.spans.map((s) => essay.slice(s.start, s.end)).join(" ");
  assert.match(highlighted, /Photosynthesis is the process/);
  assert.doesNotMatch(highlighted, /gardening/);
});

test("original writing scores zero", async () => {
  const essay = "On Saturday mornings my grandmother waters her tomatoes before anyone else is awake, humming songs from a radio station that no longer exists.";
  const r = await offline(essay, [{ text: SOURCE }]);
  assert.equal(r.similarity, 0);
  assert.equal(r.spans.length, 0);
});

test("shared common phrases alone do not count", async () => {
  const essay = "In this essay I will argue that one of the most important things is the way in which people treat each other at the end of the day.";
  const src = "It is one of the most popular places and at the end of the day the way in which it works is simple.";
  const r = await offline(essay, [{ text: src }]);
  assert.equal(r.similarity, 0);
});

test("quoted text is excluded when the option is on", async () => {
  const essay = `As the encyclopedia puts it, "${SOURCE}" That definition is a good starting point for my own discussion of plants.`;
  const on = await offline(essay, [{ text: SOURCE }]);
  const off = await offline(essay, [{ text: SOURCE }], { excludeQuotes: false });
  assert.equal(on.similarity, 0);
  assert.ok(off.similarity > 50);
});

test("references section is excluded", async () => {
  const essay = `Plants are interesting and I wrote this whole paragraph myself last night without any help from anyone.\n\nReferences\n${SOURCE}`;
  const r = await offline(essay, [{ text: SOURCE }]);
  assert.equal(r.similarity, 0);
  assert.equal(r.wordCount, 17);
});

test("overlapping sources never sum above 100%", async () => {
  const r = await offline(SOURCE + " " + SOURCE, [{ text: SOURCE }, { text: SOURCE }]);
  assert.ok(r.similarity <= 100);
  assert.equal(r.sources.length, 1);
});

test("too-short input is rejected", async () => {
  await assert.rejects(offline("Too short.", []), /at least 15 words/);
});

test("sentence splitter keeps offsets", () => {
  const t = "First one here. Second one?  Third!\n\nFourth para";
  const s = splitSentences(t);
  assert.deepEqual(s.map((x) => x.text), ["First one here.", "Second one?", "Third!", "Fourth para"]);
  for (const x of s) assert.equal(t.slice(x.start, x.end), x.text);
});

test("curly quotes are excluded too", () => {
  const t = "He said “this whole bit is quoted” and left.";
  const toks = markExcluded(tokenize(t), excludedRanges(t));
  assert.deepEqual(toks.filter((x) => x.excluded).map((x) => x.norm), ["this", "whole", "bit", "is", "quoted"]);
});
