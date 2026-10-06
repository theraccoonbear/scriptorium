import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/eventlog.ts";
import { proseHash } from "../src/tagging.ts";
import { castVoiceRun, narratorReads } from "../src/casting.ts";
import { ttsSpeaker } from "../src/audiobook.ts";
import { renderVoiceSamples } from "../src/voiceSamples.ts";
import type { Role } from "../src/types.ts";

// Issue #105: walk-on parts are read by the narrator, in character; only
// speakers with enough to say (or the author's say-so) get a voice of their own.

const LONG = "I have walked this road for forty years and never once seen it so empty, not in plague years, not in war, not even the winter the river froze to the sea.";
const CHARS = {
  nell: { id: "nell", name: "Nell Ashby", traits: "midwife", goal: "", voice: "clipped", vocal: "thirty, firm", status: "active", gender: "female" },
  guard: { id: "guard", name: "Gate Guard", traits: "bored", goal: "", voice: "flat", vocal: "forties, flat", status: "active", gender: "male" },
  bard: { id: "bard", name: "Evard", traits: "showman", goal: "", voice: "grand", vocal: "forties, baritone", status: "active", gender: "male" },
  clerk: { id: "clerk", name: "Clerk", traits: "", goal: "", voice: "", vocal: "", status: "active" }
};

async function story(sheet?: Record<string, object>) {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-walkons-"));
  const log = new EventLog(runDir);
  await log.load();
  const prose = [`"${LONG}" Nell said.`, '"Halt."', '"A triumph."', '"Next."', "The gate creaked."].join("\n\n");
  await log.append("scene_committed", { index: 0, prose, bible: { tone: "wry fantasy", characters: CHARS } });
  await log.append("scene_tags", { version: 2, index: 0, source: proseHash(prose), tags: ["nell", "guard", "bard", "clerk", "narrator"], delivery: ["", "", "", "", ""], speakers: [] });
  if (sheet) await log.append("author_characters", { characters: sheet });
  return { runDir, log };
}

test("who the narrator reads: anyone with too little to say, unless the author says otherwise", async () => {
  const { log } = await story();
  assert.deepEqual(narratorReads(log.events), ["bard", "clerk", "guard"], "Nell says plenty; a vocal line alone doesn't cast anyone");
  assert.deepEqual(narratorReads(log.events, { min: 0 }), [], "a lower bar casts everyone");
  assert.deepEqual(narratorReads(log.events, { pinned: { guard: "orus" } }), ["bard", "clerk"], "a voice pinned in the story file is cast");

  const { log: authored } = await story({
    nell: { vocal: "thirty, firm", voiced: false },          // the author's word wins over how much she says
    guard: { vocal: "forties, flat, a lifetime of saying no" },  // a vocal line alone doesn't cast them
    bard: { voiced: true },
    clerk: { voiced: true }
  });
  assert.deepEqual(narratorReads(authored.events), ["guard", "nell"]);
});

test("casting skips walk-on parts, and a shared cast list's voice for one isn't used", async () => {
  const { runDir, log } = await story();
  const asked: string[] = [];
  const role: Role = { provider: { complete: async (req) => {
    asked.push(req.prompt);
    return JSON.stringify({ narrator: "storyteller", characters: { nell: "friend" }, reasons: {} });
  } } };
  const voices = await castVoiceRun({ events: log.events, role, runDir, library: async () => [
    { id: "storyteller", type: "prebuilt", language_code: "en-GB", gender: "male", description: "a storyteller" },
    { id: "friend", type: "prebuilt", language_code: "en-GB", gender: "female", description: "a friend" }
  ], log: () => {} });
  assert.deepEqual(voices, { nell: "friend", narrator: "storyteller" });
  assert.doesNotMatch(asked[0], /guard|clerk|bard/, "walk-on parts aren't put up for casting");
});

test("the narrator voices a walk-on part in their own voice, lightly in character", () => {
  const bible = { title: "", premise: "", tone: "wry fantasy", setting: "", characters: CHARS, locations: {}, threads: [], facts: [] } as never;
  const plain = ttsSpeaker(bible, "guard");
  assert.equal(plain.name, "Gate Guard");
  const walkOn = ttsSpeaker(bible, "guard", new Set(["guard"]));
  assert.equal(walkOn.name, "Narrator");
  assert.equal(walkOn.narrating, false, "a character's line, with its own delivery notes");
  assert.match(walkOn.profile, /^The narrator of a story\. Tone: wry fantasy\. Here the narrator voices a minor character, Gate Guard \(bored Voice: flat\): suggest them with a light shift in delivery, in the narrator's own voice\.$/);
});

test("the casting reel drops a speaker who's no longer cast and lists who the narrator reads", async () => {
  const { runDir, log } = await story();
  const speak = async () => ({ samples: new Float32Array(2400), sampleRate: 24000 });
  const auditions = { guard: "Halt, I said. State your business at the gate or turn that cart around and go home." };
  await renderVoiceSamples(log.events, { runDir, voices: { narrator: "storyteller", nell: "friend", guard: "orus" }, speak, auditions });
  await renderVoiceSamples(log.events, { runDir, voices: { narrator: "storyteller", nell: "friend" }, speak, narrated: ["guard"] });
  const dir = join(runDir, "audiobook", "samples");
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(dir, "samples.json"), "utf8"))).sort(), ["narrator", "nell"]);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "narrated.json"), "utf8")), [{ id: "guard", name: "Gate Guard" }]);
});
