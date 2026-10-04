import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/eventlog.ts";
import { proseHash } from "../src/tagging.ts";
import { castVoiceRun } from "../src/casting.ts";
import { castingProblem } from "../src/roles.ts";
import { applyGeminiVoices } from "../src/audiobook.ts";
import { fetchLibrary, voiceLine } from "../src/voiceLibrary.ts";
import type { LibraryVoice } from "../src/voiceLibrary.ts";
import type { Role } from "../src/types.ts";

const LIB: LibraryVoice[] = [
  { id: "en-gb-storyteller-1", type: "prebuilt", language_code: "en-GB", gender: "male", pitch: "low", accent: "Winchester English", persona: "Storyteller & Narrator", description: "57-year-old storyteller." },
  { id: "en-gb-advisor-9", type: "prebuilt", language_code: "en-GB", gender: "male", pitch: "low", accent: "Glasgow English", persona: "Lawyer", description: "50-year-old lawyer from Glasgow." },
  { id: "en-ie-friend-2", type: "prebuilt", language_code: "en-IE", gender: "female", pitch: "medium", accent: "Dublin English", persona: "Friend", description: "30-year-old friend from Dublin." },
  { id: "en-ie-tutor-1", type: "prebuilt", language_code: "en-IE", gender: "female", pitch: "high", accent: "Dublin English", persona: "Tutor", description: "24-year-old tutor." },
  { id: "kore", type: "prebuilt", language_code: "en-US", gender: "female", pitch: "medium", description: "Firm." },
  { id: "fr-fr-x", type: "prebuilt", language_code: "fr-FR", gender: "male", pitch: "low", description: "French." }
];

async function storyLog(prose: string, tags: string[], characters: Record<string, object>) {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-cast-"));
  const log = new EventLog(runDir);
  await log.load();
  await log.append("scene_committed", { index: 0, prose, bible: { tone: "gritty fantasy", characters } });
  await log.append("scene_tags", { version: 2, index: 0, source: proseHash(prose), tags, delivery: tags.map(() => ""), speakers: [] });
  return { runDir, log };
}

const CHARS = {
  nell: { id: "nell", name: "Nell Ashby", traits: "midwife", goal: "", voice: "clipped", vocal: "thirty, firm, Dublin", status: "active", gender: "female" },
  edrick: { id: "edrick", name: "Edrick Vell", traits: "hangman", goal: "", voice: "sparse", vocal: "fifties, low, gravelly", status: "active", gender: "male" },
  kelsa: { id: "kelsa", name: "Kelsa", traits: "remembered grandmother", goal: "", voice: "", status: "active", gender: "female" }
};

test("casting picks a library voice for each speaker (not for characters who never speak) and the narrator, and keeps the cast list", async () => {
  const prose = ['"You\'re him," Nell said.', '"Edrick Vell."', "The fire hissed."].join("\n\n");
  const { runDir, log } = await storyLog(prose, ["nell", "edrick", "narrator"], CHARS);
  const prompts: string[] = [];
  const role: Role = { provider: { complete: async (req) => {
    prompts.push(req.prompt);
    return JSON.stringify({ narrator: "en-gb-storyteller-1", characters: { nell: "en-ie-friend-2", edrick: "en-gb-advisor-9" }, reasons: { nell: "Dublin, firm", edrick: "low, older", narrator: "storyteller" } });
  } } };
  const voices = await castVoiceRun({ events: log.events, role, runDir, library: async () => LIB, log: () => {} });
  assert.deepEqual(voices, { nell: "en-ie-friend-2", edrick: "en-gb-advisor-9", narrator: "en-gb-storyteller-1" });
  assert.ok(!prompts[0].includes("kelsa"), "Kelsa never speaks, so she isn't cast");
  assert.match(prompts[0], /nell \(Nell Ashby, female\): sounds: thirty, firm, Dublin/);
  assert.ok(!prompts[0].includes("fr-fr-x"), "only voices in the story's language");
  const sheet = JSON.parse(await readFile(join(runDir, "audiobook", "casting.json"), "utf8"));
  assert.equal(sheet.characters.nell.reason, "Dublin, firm");

  // Again: everyone is already cast, so nobody is asked.
  await castVoiceRun({ events: log.events, role, runDir, library: async () => LIB, log: () => {} });
  assert.equal(prompts.length, 1);
});

test("a shared cast list carries voices across chapters; only new speakers are cast, and pinned voices win", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptorium-series-"));
  const castingFile = join(dir, "osmagus-cast.json");
  await writeFile(castingFile, JSON.stringify({ narrator: { voice: "en-gb-storyteller-1" }, characters: { nell: { voice: "en-ie-friend-2" } } }));
  const prose = ['"Again?" Nell said.', '"Again," Edrick said.'].join("\n\n");
  const { runDir, log } = await storyLog(prose, ["nell", "edrick"], CHARS);
  const asked: string[][] = [];
  const role: Role = { provider: { complete: async (req) => {
    asked.push((req.ctx as { characterIds: string[] }).characterIds);
    assert.match(req.prompt, /ALREADY TAKEN \(don't reuse\): en-ie-friend-2, en-gb-storyteller-1/);
    return JSON.stringify({ narrator: null, characters: { edrick: "en-gb-advisor-9" }, reasons: {} });
  } } };
  const voices = await castVoiceRun({ events: log.events, role, runDir, castingFile, library: async () => LIB, log: () => {} });
  assert.deepEqual(asked, [["edrick"]]);
  assert.equal(voices.nell, "en-ie-friend-2", "kept from the earlier chapter");
  assert.equal(JSON.parse(await readFile(castingFile, "utf8")).characters.edrick.voice, "en-gb-advisor-9");
  const pinned = await castVoiceRun({ events: log.events, role, runDir, castingFile, pinned: { edrick: "Algenib" }, library: async () => LIB, log: () => {} });
  assert.equal(pinned.edrick, "Algenib");
});

test("a lead can get a designed voice, made once from their vocal description", async () => {
  const prose = ['"Up we go," Edrick said.'].join("\n\n");
  const { runDir, log } = await storyLog(prose, ["edrick"], CHARS);
  const designs: { name: string; description: string }[] = [];
  const design = async (spec: { name: string; description: string }) => { designs.push(spec); return { id: "voice_abc123", preview: Buffer.from("RIFF") }; };
  const role: Role = { provider: { complete: async () => JSON.stringify({ narrator: "en-gb-storyteller-1", characters: {}, reasons: {} }) } };
  const voices = await castVoiceRun({ events: log.events, role, runDir, designVoices: ["edrick"], design, library: async () => LIB, log: () => {} });
  assert.equal(voices.edrick, "voice_abc123");
  assert.match(designs[0].description, /fifties, low, gravelly\. male voice\. Speaks: sparse/);
  assert.equal((await readFile(join(runDir, "audiobook", "voices", "edrick.wav"))).toString(), "RIFF");
  await castVoiceRun({ events: log.events, role, runDir, designVoices: ["edrick"], design, library: async () => LIB, log: () => {} });
  assert.equal(designs.length, 1, "designed once");
});

test("every pick is checked: in the library, right gender, never twice", () => {
  const lib = new Map(LIB.map((v) => [v.id, v]));
  const chars = [{ id: "nell", gender: "female" }, { id: "edrick", gender: "male" }];
  const ok = { narrator: "en-gb-storyteller-1", characters: { nell: "kore", edrick: "en-gb-advisor-9" }, reasons: {} };
  assert.equal(castingProblem(ok, chars, true, lib, new Set()), undefined);
  assert.match(castingProblem({ ...ok, characters: { nell: "en-gb-advisor-9", edrick: "en-gb-advisor-9" } }, chars, true, lib, new Set())!, /nell is female/);
  assert.match(castingProblem({ ...ok, characters: { nell: "kore", edrick: "en-gb-storyteller-1" } }, chars, true, lib, new Set())!, /used twice/);
  assert.match(castingProblem({ ...ok, characters: { nell: "made-up", edrick: "en-gb-advisor-9" } }, chars, true, lib, new Set())!, /not in the library/);
  assert.match(castingProblem({ characters: ok.characters, reasons: {} }, chars, true, lib, new Set())!, /no narrator/);
  assert.match(castingProblem(ok, chars, true, lib, new Set(["kore"]))!, /already taken/);
});

test("cast and chosen voices override the automatic ones, whatever kind of id", () => {
  const auto = { narrator: "Charon", characters: { nell: "Kore", edrick: "Orus" } };
  assert.deepEqual(applyGeminiVoices(auto, { nell: "en-ie-friend-2", edrick: "voice_abc123", narrator: "en-gb-storyteller-1" }),
    { narrator: "en-gb-storyteller-1", characters: { nell: "en-ie-friend-2", edrick: "voice_abc123" } });
  assert.deepEqual(applyGeminiVoices(auto, {}), auto);
});

test("the voice library is fetched per region, paged, and cached for a week", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "scriptorium-lib-"));
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    const page2 = url.includes("page_token=p2");
    const code = new URL(url).searchParams.get("language_code")!;
    const voices = code === "en-US" ? (page2 ? [LIB[4]] : [LIB[0]]) : [];
    return { ok: true, status: 200, json: async () => ({ voices, ...(code === "en-US" && !page2 ? { nextPageToken: "p2" } : {}) }) };
  };
  const first = await fetchLibrary("en", { apiKey: "k", cacheDir, fetch, now: 1000 });
  assert.deepEqual(first.map((v) => v.id), ["en-gb-storyteller-1", "kore"]);
  assert.equal(urls.filter((u) => u.includes("en-US")).length, 2, "followed the page token");
  const n = urls.length;
  await fetchLibrary("en", { apiKey: "k", cacheDir, fetch, now: 2000 });
  assert.equal(urls.length, n, "served from the cache");
  await fetchLibrary("en", { apiKey: "k", cacheDir, fetch, now: 1000 + 8 * 24 * 3600 * 1000 });
  assert.ok(urls.length > n, "refetched after a week");
  assert.match(voiceLine(LIB[1]), /^en-gb-advisor-9 \| male \| pitch low \| Glasgow English \| Lawyer \| 50-year-old lawyer/);
});

test("a designed voice is requested as voiceConfig.voice; prebuilt and library voices by name", async () => {
  const { speechConfigFor } = await import("../src/geminiTts.ts");
  assert.deepEqual(speechConfigFor("voice_lhyk6vziocjn"), { voiceConfig: { voice: "voice_lhyk6vziocjn" } });
  assert.deepEqual(speechConfigFor("en-gb-advisor-9"), { voiceConfig: { prebuiltVoiceConfig: { voiceName: "en-gb-advisor-9" } } });
  assert.deepEqual(speechConfigFor("Kore"), { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } });
});

// Issue #84: recasting a voice the author didn't like, from their edited vocal description.
test("a recast speaker is cast afresh from their current vocal description; the rest keep their voices", async () => {
  const prose = ['"You\'re him," Nell said.', '"Edrick Vell."', "The fire hissed."].join("\n\n");
  const { runDir, log } = await storyLog(prose, ["nell", "edrick", "narrator"], CHARS);
  const prompts: string[] = [];
  let pick = { narrator: "en-gb-storyteller-1", characters: { nell: "en-ie-friend-2", edrick: "en-gb-advisor-9" } as Record<string, string> };
  const role: Role = { provider: { complete: async (req) => { prompts.push(req.prompt); return JSON.stringify({ ...pick, reasons: {} }); } } };
  await castVoiceRun({ events: log.events, role, runDir, library: async () => LIB, log: () => {} });
  pick = { narrator: "", characters: { nell: "kore" } } as typeof pick;
  const voices = await castVoiceRun({ events: log.events, role, runDir, recast: ["nell"], library: async () => LIB, log: () => {} });
  assert.equal(voices.nell, "kore");
  assert.equal(voices.edrick, "en-gb-advisor-9");
  assert.match(prompts[1], /nell \(Nell Ashby/);
  assert.ok(!/edrick \(Edrick/.test(prompts[1]), "only Nell is recast");
});
