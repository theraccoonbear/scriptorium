import { test } from "node:test";
import assert from "node:assert/strict";
import { checkedSpeaker, parseHeard } from "../src/speechCheck.ts";
import type { Heard, Unverified } from "../src/speechCheck.ts";

// The speech check: a take that says a different word than its script
// ("Liam McPoyle" → "Liam McCord") is redone; one still wrong is kept, reported.

const take = (n: number) => ({ samples: new Float32Array(n), sampleRate: 24000 });

test("the check's reply: problems listed, or a pass; an unreadable reply never passes", () => {
  assert.deepEqual(parseHeard('{"heard":"Liam McCord.","problems":[{"script":"McPoyle","heard":"McCord"}]}'), { ok: false, heard: "Liam McCord.", problems: ['"McPoyle" → "McCord"'] });
  assert.deepEqual(parseHeard('{"heard":"Liam McPoyle.","problems":[]}'), { ok: true, heard: "Liam McPoyle.", problems: [] });
  assert.equal(parseHeard("not json").ok, false);
  assert.equal(parseHeard('{"heard":"x"}').ok, false);
});

test("a wrong take is redone until one comes out right", async () => {
  const verdicts: Heard[] = [
    { ok: false, heard: "Liam McCord.", problems: ['"McPoyle" → "McCord"'] },
    { ok: true, heard: "Liam McPoyle.", problems: [] }
  ];
  let takes = 0;
  const retakes: string[][] = [];
  const unverified: Unverified[] = [];
  const speak = checkedSpeaker(async () => take(++takes), async (_a, script) => { assert.equal(script, "Liam McPoyle."); return verdicts.shift()!; }, { onRetake: (p) => retakes.push(p), onUnverified: (u) => unverified.push(u) });
  const audio = await speak({ text: "Liam McPoyle." }, "algenib");
  assert.equal(audio.samples.length, 2, "the second, clean take");
  assert.deepEqual(retakes, [['"McPoyle" → "McCord"']]);
  assert.deepEqual(unverified, []);
});

test("still wrong after three takes: the closest is kept, and reported", async () => {
  const problems = [["a", "b"], ["a"], ["a", "b", "c"]];
  let takes = 0;
  const unverified: Unverified[] = [];
  const speak = checkedSpeaker(async () => take(++takes), async () => { const p = problems.shift()!; return { ok: false, heard: `heard ${p.length}`, problems: p }; }, { onUnverified: (u) => unverified.push(u) });
  const audio = await speak({ text: "Report, Habenero." }, "v");
  assert.equal(takes, 3);
  assert.equal(audio.samples.length, 2, "the take with the fewest problems");
  assert.deepEqual(unverified, [{ script: "Report, Habenero.", heard: "heard 1", problems: ["a"] }]);
});

test("a check that fails to run counts as a failed check, not a pass", async () => {
  const unverified: Unverified[] = [];
  const speak = checkedSpeaker(async () => take(1), async () => { throw new Error("HTTP 500"); }, { tries: 2, onUnverified: (u) => unverified.push(u) });
  await speak({ text: "Up." }, "v");
  assert.match(unverified[0].problems[0], /check failed: HTTP 500/);
});

test("a line with a hard word gets its pronunciation in the direction; the words stay as written", async () => {
  const { withPronunciations } = await import("../src/geminiTts.ts");
  const guide = { McPoyle: "mick-POYL (rhymes with boil)", Riann: "REE-ann" } as Record<string, string | { say: string }>;
  assert.deepEqual(withPronunciations({ text: "Liam McPoyle.", style: "plainly" }, guide), { text: "Liam McPoyle.", style: "plainly. Pronounce McPoyle as mick-POYL (rhymes with boil)" });
  assert.match(withPronunciations({ text: "The McPoyles came; McPoyle's cart too." }, guide).style!, /^Pronounce McPoyle as/, "plurals and possessives");
  assert.equal(withPronunciations({ text: "Brianna said." }, guide).style, undefined, "a whole word, not part of one");
  assert.equal(withPronunciations({ text: "riann!" }, guide).style, "Pronounce Riann as REE-ann", "any case");
});

test("a word the model reads by its spelling is said as written in the guide; only what's spoken changes", async () => {
  const { withPronunciations } = await import("../src/geminiTts.ts");
  const guide = { Riann: { say: "Ryan" }, McPoyle: "mick-POYL" };
  assert.deepEqual(withPronunciations({ text: "Riann McPoyle, and Riann's cart.", style: "plainly" }, guide), { text: "Ryan McPoyle, and Ryan's cart.", style: "plainly. Pronounce McPoyle as mick-POYL" });
  assert.deepEqual(withPronunciations({ text: "Brianna." }, guide), { text: "Brianna." });
});
