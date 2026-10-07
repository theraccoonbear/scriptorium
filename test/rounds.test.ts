import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedKeys, findRound, imageRound, listRounds, newRound, snapshotArt } from "../src/rounds.ts";
import { formatAudition, pickAudition, runAudition } from "../src/auditions.ts";
import { formatShareList } from "../src/reviewSheets.ts";
import { EventLog } from "../src/eventlog.ts";
import type { Role } from "../src/types.ts";
import type { SpeechInput } from "../src/geminiTts.ts";
import { legacyPrompt } from "../src/geminiTts.ts";

// Review rounds: every audition, redo and retake lands in its own numbered
// folder under review/rounds/, so review/ itself holds only the current state.

const tmp = () => mkdtemp(join(tmpdir(), "scriptorium-rounds-"));

test("rounds are numbered in order, named by kind and subject; the newest of a kind is found", async () => {
  const runDir = await tmp();
  const a = await newRound(runDir, { kind: "auditions", subject: "hellga" });
  const b = await newRound(runDir, { kind: "redo", subject: "character-rantoul" });
  const c = await newRound(runDir, { kind: "auditions", subject: "hellga" });
  assert.deepEqual([a.name, b.name, c.name], ["01-auditions-hellga", "02-redo-character-rantoul", "03-auditions-hellga"]);
  assert.equal((await findRound(runDir, "auditions", "hellga"))?.number, 3);
  assert.equal((await findRound(runDir, "auditions", "hell")), undefined, "a whole subject, not a prefix");
  assert.equal((await findRound(runDir, "auditions", "hellga", 1))?.name, "01-auditions-hellga");
  assert.equal((await listRounds(runDir)).length, 3);
});

test("an image round holds just the images an art run changed, with a legend", async () => {
  const runDir = await tmp();
  await mkdir(join(runDir, "art"), { recursive: true });
  const manifest = { "scene-01-01": { file: "s1.png", prompt: "p", finalPrompt: "p", attempts: 1, accepted: true }, "scene-01-02": { file: "s2.png", prompt: "p", finalPrompt: "p", attempts: 3, accepted: false } };
  await writeFile(join(runDir, "art", "art.json"), JSON.stringify(manifest));
  await writeFile(join(runDir, "art", "s1.png"), "one");
  await writeFile(join(runDir, "art", "s2.png"), "two");
  const before = await snapshotArt(runDir);
  await writeFile(join(runDir, "art", "s2.png"), "two, redone");
  const keys = changedKeys(before, await snapshotArt(runDir));
  assert.deepEqual(keys, ["scene-01-02"]);
  const round = await imageRound(runDir, keys, { kind: "redo", subject: "scene-01-02", note: "lying flat" });
  assert.equal(round?.name, "01-redo-scene-01-02");
  assert.equal(await readFile(join(round!.dir, "legend.txt"), "utf8"), "redo: scene-01-02 — 1 image (changed.jpg)\nnote: lying flat\n\nscene-01-02  (kept after its retries ran out)\n\nThe images these replaced are kept in art/previous/<key>/.\n");
});

async function cast() {
  const runDir = await tmp();
  const log = new EventLog(runDir);
  await log.load();
  await log.append("scene_committed", { index: 0, prose: '"Report," Hellga said.', bible: { tone: "wry", characters: { hellga: { id: "hellga", name: "Hellga Habenero", traits: "tiefling", goal: "", voice: "dry", vocal: "contralto, sardonic", status: "active", gender: "female" } } } });
  await mkdir(join(runDir, "audiobook", "samples"), { recursive: true });
  await writeFile(join(runDir, "audiobook", "samples", "samples.json"), JSON.stringify({
    narrator: { voice: "algenib", text: "The road was empty." },
    hellga: { voice: "sulafat", text: "I counted eight, and then I stopped counting." }
  }));
  await writeFile(join(runDir, "characters.json"), JSON.stringify({ characters: { hellga: { name: "Hellga Habenero", vocal: "contralto, sardonic" } } }));
  const storyFile = join(runDir, "story.json");
  await writeFile(storyFile, JSON.stringify({ out: ".", config: {}, audiobook: { narration: "gemini", geminiVoices: { rantoul: "en-gb-storyteller-4" } } }));
  return { runDir, storyFile, events: log.events };
}

const speak = async (_input: SpeechInput, voice: string) => ({ samples: new Float32Array(24000 * (voice === "sulafat" ? 3 : 4)), sampleRate: 24000 });
const encodeMp3 = async (_wav: string, mp3: string) => { await writeFile(mp3, "mp3"); };

test("an audition: the current voice first, then the candidates, each reading the reel line under the new direction", async () => {
  const { runDir, events } = await cast();
  const prompts: string[] = [];
  const { round, info } = await runAudition({ runDir, events, id: "hellga", direction: "a deep, low contralto", voices: ["en-us-csagent-5", "sulafat", "en-us-tova"], encodeMp3, speak: async (p, v) => { prompts.push(`${v}: ${legacyPrompt(p)}`); return speak(p, v); } });
  assert.equal(round.name, "01-auditions-hellga");
  assert.deepEqual(info.candidates.map((c) => [c.n, c.voice, c.start]), [[1, "sulafat", 0], [2, "en-us-csagent-5", 5], [3, "en-us-tova", 11]], "current first, not twice; 2 s between");
  assert.ok(prompts.every((p) => p.includes("a deep, low contralto") && p.includes("I counted eight")));
  assert.match(formatAudition(info, 1), /^Round 1: auditions for Hellga Habenero[\s\S]*Directed as: a deep, low contralto\n\n0:00  1  sulafat: current voice\n0:05  2  en-us-csagent-5\n0:11  3  en-us-tova\n\nPick one: npm run audition -- <story\.json> hellga --pick <n>$/);
  for (const f of ["all.mp3", "1-sulafat.mp3", "2-en-us-csagent-5.mp3", "legend.txt", "round.json"]) await readFile(join(round.dir, f));
});

test("with no voices given, the voice director suggests some from the library, never one already cast", async () => {
  const { runDir, events } = await cast();
  let asked = "";
  const role: Role = { provider: { complete: async (req) => { asked = req.prompt; return JSON.stringify({ voices: [{ id: "en-us-tova", reason: "resonant" }, { id: "algenib", reason: "taken" }, { id: "nope" }] }); } } };
  const library = async () => [
    { id: "en-us-tova", type: "prebuilt", language_code: "en-US", gender: "female", description: "resonant" },
    { id: "algenib", type: "prebuilt", language_code: "en-US", gender: "male", description: "gravelly" },
    { id: "en-us-x", type: "prebuilt", language_code: "en-US", gender: "female", description: "x" }
  ];
  const { info } = await runAudition({ runDir, events, id: "hellga", count: 1, role, library, speak, encodeMp3 });
  assert.deepEqual(info.candidates.map((c) => c.voice), ["sulafat", "en-us-tova"]);
  assert.equal(info.direction, "contralto, sardonic", "no new direction: their vocal line");
  assert.doesNotMatch(asked.split("VOICE LIBRARY")[1], /algenib/, "the narrator's voice (and men's voices) aren't offered for her");
  assert.match(asked, /NOT THESE: sulafat, algenib/);
});

test("picking a candidate pins the voice in the story file and makes the direction their vocal line", async () => {
  const { runDir, events, storyFile } = await cast();
  await runAudition({ runDir, events, id: "hellga", direction: "a deep, low contralto", voices: ["en-us-csagent-5"], speak, encodeMp3 });
  const picked = await pickAudition({ storyFile, runDir, id: "hellga", pick: 2 });
  assert.equal(picked.voice, "en-us-csagent-5");
  const story = JSON.parse(await readFile(storyFile, "utf8"));
  assert.deepEqual(story.audiobook.geminiVoices, { rantoul: "en-gb-storyteller-4", hellga: "en-us-csagent-5" }, "other pins kept");
  assert.equal(JSON.parse(await readFile(join(runDir, "characters.json"), "utf8")).characters.hellga.vocal, "a deep, low contralto");
  await assert.rejects(pickAudition({ storyFile, runDir, id: "hellga", pick: 9 }), /candidates 1-2/);
  await assert.rejects(pickAudition({ storyFile, runDir, id: "lemuel", pick: 1 }), /no auditions for "lemuel"/);
});

test("the reel's share list: names and times only", () => {
  const text = formatShareList([
    { id: "narrator", start: 0, seconds: 12, voice: "algenib", approved: false, name: "The narrator", source: "story" },
    { id: "evard", start: 75, seconds: 9, voice: "rasalgethi", approved: true, name: "Evard", source: "audition" }
  ], ["Guard One"]);
  assert.equal(text, "Voice casting\n\n0:00  The narrator\n1:15  Evard (a test line, not from the story)\n\nRead by the narrator, in character: Guard One");
});
