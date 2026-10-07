import { test } from "node:test";
import assert from "node:assert/strict";
import { checkedSpeaker, parseHeard } from "../src/speechCheck.ts";
import type { CheckReport, Heard } from "../src/speechCheck.ts";

// The speech check: a take that says a different word than its script
// ("Liam McPoyle" → "Liam McCord") is redone; one still wrong is kept, reported.

const take = (n: number) => ({ samples: new Float32Array(n), sampleRate: 24000 });

test("the check's reply: problems listed, or a pass; an unreadable reply never passes", () => {
  assert.deepEqual(parseHeard('{"heard":"Liam McCord.","problems":[{"script":"McPoyle","heard":"McCord"}]}'), { ok: false, heard: "Liam McCord.", problems: ['"McPoyle" → "McCord"'] });
  assert.deepEqual(parseHeard('{"heard":"Liam McPoyle.","problems":[]}'), { ok: true, heard: "Liam McPoyle.", problems: [] });
  assert.equal(parseHeard("not json").ok, false);
  assert.equal(parseHeard('{"heard":"x"}').ok, false);
});

test("a flagged take is redone; the line is reported with every take, the clean one kept", async () => {
  const verdicts: Heard[] = [
    { ok: false, heard: "Liam McCord.", problems: ['"McPoyle" → "McCord"'] },
    { ok: true, heard: "Liam McPoyle.", problems: [] }
  ];
  let takes = 0;
  const retakes: string[][] = [];
  const reports: CheckReport[] = [];
  const speak = checkedSpeaker(async () => take(++takes), async (_a, script) => { assert.equal(script, "Liam McPoyle."); return verdicts.shift()!; }, { onRetake: (p) => retakes.push(p), onReport: (r) => reports.push(r) });
  const audio = await speak({ text: "Liam McPoyle." }, "algenib");
  assert.equal(audio.samples.length, 2, "the second, clean take");
  assert.deepEqual(retakes, [['"McPoyle" → "McCord"']]);
  assert.equal(reports.length, 1);
  assert.deepEqual({ ok: reports[0].ok, kept: reports[0].kept, heard: reports[0].takes.map((t) => t.heard), sizes: reports[0].takes.map((t) => t.audio.samples.length) }, { ok: true, kept: 1, heard: ["Liam McCord.", "Liam McPoyle."], sizes: [1, 2] }, "the rejected take is kept for the author to hear");
});

test("a clean first take reports nothing", async () => {
  const reports: CheckReport[] = [];
  await checkedSpeaker(async () => take(1), async () => ({ ok: true, heard: "Up.", problems: [] }), { onReport: (r) => reports.push(r) })({ text: "Up." }, "v");
  assert.deepEqual(reports, []);
});

test("still flagged after three takes: the closest is kept, all three reported", async () => {
  const problems = [["a", "b"], ["a"], ["a", "b", "c"]];
  let takes = 0;
  const reports: CheckReport[] = [];
  const speak = checkedSpeaker(async () => take(++takes), async () => { const p = problems.shift()!; return { ok: false, heard: `heard ${p.length}`, problems: p }; }, { onReport: (r) => reports.push(r) });
  const audio = await speak({ text: "Report, Habenero." }, "v");
  assert.equal(takes, 3);
  assert.equal(audio.samples.length, 2, "the take with the fewest problems");
  assert.deepEqual({ ok: reports[0].ok, kept: reports[0].kept, n: reports[0].takes.length }, { ok: false, kept: 1, n: 3 });
});

test("a check that fails to run counts as a failed check, not a pass", async () => {
  const reports: CheckReport[] = [];
  const speak = checkedSpeaker(async () => take(1), async () => { throw new Error("HTTP 500"); }, { tries: 2, onReport: (r) => reports.push(r) });
  await speak({ text: "Up." }, "v");
  assert.match(reports[0].takes[0].problems[0], /check failed: HTTP 500/);
});

test("the check is told to flag only real mistakes", async () => {
  const { CHECK_SYSTEM } = await import("../src/speechCheck.ts");
  assert.match(CHECK_SYSTEM, /A name said as a different name/);
  assert.match(CHECK_SYSTEM, /NOT mistakes, never report them: a small word swapped/);
  assert.match(CHECK_SYSTEM, /When unsure, it's not a mistake/);
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
