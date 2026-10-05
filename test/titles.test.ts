import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoSceneTitles, beatSceneTitles, BUNDLED_FONTS, creditPages, mergeTitlesSheet, narrateTitle, planSceneTitles, prepareTitles, romanNumeral, trimSilence, voiceCredit } from "../src/titles.ts";
import { decodeWav } from "../src/geminiTts.ts";
import type { StoryEvent } from "../src/types.ts";

// Issue #78: the words on the video's cards.

const CHARS = {
  lemuel: { id: "lemuel", name: "Lemuel Braunschweiger", traits: "", goal: "", voice: "", status: "active" },
  ivana: { id: "ivana", name: "Ivana de Donder", traits: "", goal: "", voice: "", status: "active" },
  rantoul: { id: "rantoul", name: "Rantoul Hayworth", traits: "", goal: "", voice: "", status: "active" }
};
const events: StoryEvent[] = [
  { seq: 0, type: "scene_committed", ts: "t", data: { index: 0, prose: 'ivana: "Quiet," said Ivana.\n\nlemuel: "Up!"', beat: { title: "Into the Ditch" }, bible: { characters: CHARS } } },
  { seq: 1, type: "scene_committed", ts: "t", data: { index: 1, prose: 'rantoul: "Wine?"\n\nlemuel: "Yes."', beat: {} } }
];

test("scene titles from the author's plan: the name between the dash and the parenthesis", () => {
  const plan = [
    "Rantoul's Mushrooms — Part 1 Direction",
    "Scene 1 — The ditch (a back road in the Gran March, before dawn)",
    "* Lemuel wakes first.",
    "Scene 2 — The Howling Hen (Tankard, that night)",
    "## Scene 3: The road west",
    "Scene 5 — The troll and the gnacien (the road to Gralston, the next day)"
  ].join("\n");
  assert.deepEqual(planSceneTitles(plan), { 0: "The ditch", 1: "The Howling Hen", 2: "The road west", 4: "The troll and the gnacien" });
  assert.deepEqual(planSceneTitles("The scene was quiet.\nScenes 1-3 are long."), {});
});

test("scene title sources: the story file's list, then the plan, then the director's beat, else the numeral", () => {
  assert.deepEqual(beatSceneTitles(events), { 0: "Into the Ditch" });
  const auto = autoSceneTitles([0, 1, 2], { list: ["", "Wine"], plan: { 0: "The ditch" }, beats: { 0: "Into the Ditch", 2: "Onward" } });
  assert.deepEqual(auto, { 0: "The ditch", 1: "Wine", 2: "Onward" });
  assert.deepEqual(autoSceneTitles([0], {}), { 0: "" });
});

test("titles.json keeps the author's edits and lets untouched titles follow their sources", () => {
  const first = mergeTitlesSheet(undefined, { 0: "The ditch", 1: "" });
  assert.deepEqual(first.scenes, [{ scene: 1, title: "The ditch", auto: "The ditch" }, { scene: 2, title: "", auto: "" }]);
  first.scenes[1].title = "The Howling Hen"; // the author fills in scene 2
  const next = mergeTitlesSheet(first, { 0: "Into the ditch", 1: "Tankard" });
  assert.deepEqual(next.scenes, [{ scene: 1, title: "Into the ditch", auto: "Into the ditch" }, { scene: 2, title: "The Howling Hen", auto: "Tankard" }]);
});

test("roman numerals", () => {
  assert.deepEqual([1, 2, 4, 9, 14, 40, 1999].map(romanNumeral), ["I", "II", "IV", "IX", "XIV", "XL", "MCMXCIX"]);
});

test("credits: who speaks, in order of appearance, with their voice; narrator first, Scriptorium last", () => {
  assert.equal(voiceCredit("en-us-storyteller-13", { gemini: true, displayNames: { "en-us-storyteller-13": "Storyteller 13" } }), "Storyteller 13");
  assert.equal(voiceCredit("algenib", { gemini: true }), "Algenib");
  assert.equal(voiceCredit("voice_lhyk6vziocjn", { gemini: true }), "a designed voice");
  assert.equal(voiceCredit("Achird", { gemini: true, designed: true }), "a designed voice");
  assert.equal(voiceCredit("bm_george", { gemini: false }), "George (Kokoro)");

  const voices = { narrator: "af_heart", characters: { ivana: "bf_alice", lemuel: "am_eric" }, gemini: { narrator: "en-us-storyteller-13", characters: { ivana: "voice_x", lemuel: "algenib", rantoul: "achird" } } };
  const pages = creditPages(events, voices, { gemini: true, displayNames: { "en-us-storyteller-13": "Storyteller 13", achird: "Achird" }, perPage: 3 });
  assert.deepEqual(pages, [
    ["Narrated by Storyteller 13", "Ivana de Donder — voiced by a designed voice", "Lemuel Braunschweiger — voiced by Algenib"],
    ["Rantoul Hayworth — voiced by Achird"],
    ["Written, illustrated and narrated", "with Scriptorium"]
  ]);
  assert.equal(creditPages(events, voices, { gemini: false })[0][0], "Narrated by Heart (Kokoro)");
  // No voice map (no audiobook yet): the names alone.
  assert.equal(creditPages(events, undefined, { gemini: true })[0][0], "Ivana de Donder");
});

test("the narrated title: silence trimmed, cached by words and voice", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-titles-"));
  const rate = 24000;
  const tone = new Float32Array(rate).map((_, i) => (i > rate / 4 && i < rate / 2 ? 0.5 : 0)); // 0.25s of sound in 1s
  const said: string[] = [];
  const speak = async (prompt: string, voice: string) => { said.push(`${voice}:${prompt}`); return { samples: tone, sampleRate: rate }; };
  const first = await narrateTitle(runDir, "Rantoul's Mushrooms. Part 1.", "algenib", speak);
  assert.equal(first.made, true);
  const wav = decodeWav(await readFile(join(runDir, first.file)));
  assert.ok(Math.abs(wav.samples.length / rate - 0.35) < 0.01, "0.25s of voice plus 50ms either side");
  assert.equal((await narrateTitle(runDir, "Rantoul's Mushrooms. Part 1.", "algenib", speak)).made, false);
  assert.equal((await narrateTitle(runDir, "Rantoul's Mushrooms. Part 1.", "achird", speak)).made, true);
  assert.equal(said.length, 2);
  assert.equal(trimSilence(new Float32Array(10), rate).length, 0);
});

test("prepareTitles: plan titles into titles.json, the ending by series, bundled fonts, cards off", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-prepare-"));
  const plan = join(runDir, "plan.md");
  await writeFile(plan, "Scene 2 — The Howling Hen (Tankard)\n");
  await mkdir(join(runDir, "audiobook"), { recursive: true });
  await writeFile(join(runDir, "audiobook", "voices.json"), JSON.stringify({ narrator: "af_heart", characters: {}, gemini: { narrator: "algenib", characters: {} } }));

  const notes: string[] = [];
  const cards = await prepareTitles(events, { runDir, title: "Rantoul's Mushrooms", subtitle: "Part 1", series: { next: "Part 2" }, contextPaths: [plan], settings: { narrate: true }, onNote: (m) => notes.push(m) });
  assert.deepEqual(cards.sceneTitles, { 0: "Into the Ditch", 1: "The Howling Hen" });
  assert.equal(cards.ending, "To be continued");
  assert.equal(cards.next, "Next: Part 2");
  assert.equal(cards.font, BUNDLED_FONTS["eb garamond"]);
  assert.equal(cards.titleFont, BUNDLED_FONTS["cinzel"]);
  assert.equal(cards.narration, undefined);
  assert.ok(notes.some((n) => n.includes("narrated title")), "no speaker: skipped, with a note");
  const sheet = JSON.parse(await readFile(join(runDir, "video", "titles.json"), "utf8"));
  assert.equal(sheet.scenes[1].title, "The Howling Hen");

  const plain = await prepareTitles(events, { runDir, settings: { sceneTitles: false, credits: false, ending: false } });
  assert.equal(plain.title, undefined);
  assert.equal(plain.sceneCards, false);
  assert.deepEqual(plain.credits, []);
  assert.equal(plain.ending, undefined);
  assert.equal((await prepareTitles(events, { runDir })).ending, "The End");
});
