import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/eventlog.ts";
import { TAGGER_SYSTEM, tagSpeakers, taggingProblem } from "../src/roles.ts";
import { applyTags, needsTagging, proseHash, sceneTags, tagRun } from "../src/tagging.ts";
import { buildScenes, hybridVoicing, sceneRenderKey, synthesizeScene, voicedBible } from "../src/audiobook.ts";
import type { Synthesize } from "../src/audiobook.ts";
import type { Role } from "../src/types.ts";

const PROSE = [
  "The inn was nearly empty.",
  "\"Go home, Nell,\" Corin said.",
  "\"Not without you.\"",
  "Something vast breathed in the dark. \"Small one,\" it said."
].join("\n\n");

const bibleWith = { characters: {
  corin: { id: "corin", name: "Corin Ashby", traits: "", goal: "", voice: "quick, charming", status: "active", gender: "male" },
  nell: { id: "nell", name: "Nell Ashby", traits: "", goal: "", voice: "stubborn", status: "active", gender: "female" }
} };

function fakeRole(...replies: unknown[]): Role & { prompts: string[] } {
  const prompts: string[] = [];
  let n = 0;
  return { prompts, provider: { complete: async (req) => { prompts.push(req.prompt); return JSON.stringify(replies[Math.min(n++, replies.length - 1)]); } } };
}

const GOOD = {
  paragraphs: [
    { n: 1, speaker: "narrator", delivery: "" },
    { n: 2, speaker: "corin", delivery: "tired, almost gentle" },
    { n: 3, speaker: "nell", delivery: "low and furious" },
    { n: 4, speaker: "old_one", delivery: "slow, vast, amused" }
  ],
  newSpeakers: [{ id: "old_one", name: "The Old One", description: "An ancient dragon; a voice like a file drawn across stone." }]
};

test("the tagger labels paragraphs without ever seeing them back, and is checked", async () => {
  assert.ok(TAGGER_SYSTEM.includes("You never change or repeat the text"));
  assert.equal(taggingProblem({ tags: ["narrator"], delivery: [""], newSpeakers: [] }, 2, []), "1 tags for 2 paragraphs");
  assert.match(taggingProblem({ tags: ["narrator", "bob"], delivery: [], newSpeakers: [] }, 2, ["corin"])!, /unknown speaker "bob"/);
  assert.match(taggingProblem({ tags: ["corin"], delivery: [], newSpeakers: [{ id: "corin", name: "x" }] }, 1, ["corin"])!, /must be a new snake_case id/);

  const cast = [{ id: "corin", name: "Corin Ashby" }, { id: "nell", name: "Nell Ashby" }];
  const paragraphs = PROSE.split("\n\n");
  const out = await tagSpeakers(fakeRole(GOOD), { paragraphs, cast });
  assert.deepEqual(out.result.tags, ["narrator", "corin", "nell", "old_one"]);
  assert.deepEqual(out.result.delivery, ["", "tired, almost gentle", "low and furious", "slow, vast, amused"]);

  // Entries are keyed by number: one skipped paragraph becomes narration, and the rest keep their speakers.
  const skipped = await tagSpeakers(fakeRole({ ...GOOD, paragraphs: GOOD.paragraphs.filter((p) => p.n !== 2) }), { paragraphs, cast });
  assert.deepEqual(skipped.result.tags, ["narrator", "narrator", "nell", "old_one"]);
  assert.equal(skipped.result.missing, 1);

  // Too many missing, or an unknown speaker, is retried with the problem named, then refused.
  const bad = fakeRole({ ...GOOD, paragraphs: GOOD.paragraphs.map((p) => (p.n === 2 ? { ...p, speaker: "bob" } : p)) }, GOOD);
  await tagSpeakers(bad, { paragraphs, cast });
  assert.match(bad.prompts[1], /unknown speaker "bob"/);
  const many = Array.from({ length: 40 }, (_, n) => `p${n}`);
  await assert.rejects(tagSpeakers(fakeRole({ paragraphs: [{ n: 1, speaker: "narrator" }] }), { paragraphs: many, cast: [] }), /39 of 40 paragraphs have no entry/);
});

test("tagging a run: plain-prose scenes get scene_tags once; the committed prose is untouched", async () => {
  const log = new EventLog(await mkdtemp(join(tmpdir(), "scriptorium-tag-")));
  await log.load();
  await log.append("scene_committed", { index: 0, prose: PROSE, bible: bibleWith });
  await log.append("scene_committed", { index: 1, prose: "narrator: Already tagged by the writer.\n\ncorin: \"Fine.\"" });
  const role = fakeRole(GOOD);
  assert.deepEqual(await tagRun(log, role), [0], "the writer-tagged scene is left alone");
  assert.deepEqual(await tagRun(log, role), [], "nothing left to tag");
  assert.equal(role.prompts.length, 1);
  const t = sceneTags(log.events).get(0)!;
  assert.equal(t.source, proseHash(PROSE));
  assert.equal(log.events[0].data && (log.events[0].data as { prose: string }).prose, PROSE);
  assert.ok(needsTagging(PROSE, new Set(["corin"])));
  assert.ok(!needsTagging("corin: \"Hi.\"", new Set(["corin"])));

  // The audiobook reads the tagged version, voices the new speaker, and carries each line's delivery.
  const [scene] = buildScenes(log.events);
  assert.ok(scene.tagged);
  assert.deepEqual([...new Set(scene.segments.map((s) => s.speaker))].sort(), ["corin", "narrator", "nell", "old_one"]);
  assert.equal(voicedBible(log.events).characters.old_one.name, "The Old One");
  assert.deepEqual(scene.delivery, { 1: { speaker: "corin", note: "tired, almost gentle" }, 2: { speaker: "nell", note: "low and furious" }, 3: { speaker: "old_one", note: "slow, vast, amused" } });
  assert.notEqual(sceneRenderKey(scene, {}), sceneRenderKey({ ...scene, delivery: undefined }, {}), "a new delivery re-renders the scene");

  // Tags made for different prose are ignored.
  await log.append("scene_tags", { index: 0, source: "stale", tags: ["narrator", "narrator", "narrator", "narrator"], delivery: [], speakers: [] });
  assert.equal(sceneTags(log.events).get(0)!.source, proseHash(PROSE));
  assert.equal(applyTags("a\n\nb", ["narrator", "nell"]), "narrator: a\n\nnell: b");
});

test("a line's delivery reaches its speaker's Gemini direction, and only its speaker", async () => {
  const log = new EventLog(await mkdtemp(join(tmpdir(), "scriptorium-tag-")));
  await log.load();
  await log.append("scene_committed", { index: 0, prose: PROSE, bible: bibleWith });
  await tagRun(log, fakeRole(GOOD));
  const [scene] = buildScenes(log.events);
  const seen: Array<[string, string | undefined]> = [];
  const synth: Synthesize = async function* (text, _voice, ctx) { seen.push([ctx!.speaker, ctx!.delivery]); yield { text, audio: new Float32Array(10) }; };
  await synthesizeScene(scene, () => "v", synth);
  assert.ok(seen.some(([s, d]) => s === "nell" && d === "low and furious"));
  assert.ok(seen.filter(([s]) => s === "narrator").every(([, d]) => d === undefined), "attribution around a quote doesn't take the character's delivery");

  const prompts: string[] = [];
  const bible = voicedBible(log.events);
  const assignment = { narrator: "af_heart", characters: { corin: "am_michael", nell: "af_bella", old_one: "bm_george" }, genders: {}, gemini: { narrator: "Charon", characters: { corin: "Puck", nell: "Kore", old_one: "Fenrir" } } };
  const kokoroSynth: Synthesize = async function* (text) { yield { text, audio: new Float32Array(10) }; };
  const { voiceFor, synth: hybrid } = hybridVoicing({ bible, assignment, narration: "kokoro", dialogue: "gemini", kokoroSynth, speak: async (prompt) => { prompts.push(prompt); return { samples: new Float32Array(100), sampleRate: 24000 }; } });
  await synthesizeScene(scene, voiceFor, hybrid);
  assert.ok(prompts.some((p) => p.includes("# AUDIO PROFILE: Nell Ashby") && p.includes("low and furious")));
  assert.ok(prompts.some((p) => p.includes("# AUDIO PROFILE: The Old One") && p.includes("slow, vast, amused")));
});

test("quote checks: no quotes means narrator, explicit attribution wins, pronouns are flagged", async () => {
  const { checkTags, splitSpeech, attributedSpeaker, renderScript } = await import("../src/tagging.ts");
  const { foldKnownSpeakers } = await import("../src/roles.ts");
  const cast = [
    { id: "corin", name: "Corin Ashby", gender: "male" },
    { id: "nell", name: "Nell Ashby", gender: "female" },
    { id: "edrick", name: "Edrick Vell", gender: "male" }
  ];
  assert.deepEqual(splitSpeech('"Nell Ashby." She did not sit. “Corin\'s sister.”'), { lines: ["Nell Ashby.", "Corin's sister."], narration: "  She did not sit.  " });
  assert.deepEqual(splitSpeech("He was 4'8\" tall.").lines, [], "an inch mark is not a quote");
  assert.equal(attributedSpeaker(" Edrick said quietly.", cast), "edrick");
  assert.equal(attributedSpeaker(" said Nell.", cast), "nell");
  assert.equal(attributedSpeaker(" Ashby said.", cast), undefined, "a surname two people share decides nothing");
  const paragraphs = [
    "Nell looked at her cup and did not lift it.",
    '"Go home," Corin said.',
    '"Not without you."',
    '"Fine," she said.'
  ];
  const r = checkTags(paragraphs, ["nell", "nell", "narrator", "edrick"], cast);
  assert.deepEqual(r.tags, ["narrator", "corin", "narrator", "edrick"]);
  assert.equal(r.dialogue, 3);
  assert.equal(r.unresolved, 1);
  assert.deepEqual(r.checks, ["¶1: nell → narrator (no dialogue)", "¶2: nell → corin (attributed)", '¶4: "she said" but tagged edrick (male) — check']);

  // One person, one voice: a "new" speaker who is already in the cast folds into their id.
  const folded = foldKnownSpeakers({ tags: ["hesketh_barkeep", "old_one"], delivery: ["", ""], newSpeakers: [{ id: "hesketh_barkeep", name: "Hesketh the barkeep" }, { id: "old_one", name: "The Old One" }] }, [{ id: "hesketh", name: "Hesketh" }]);
  assert.deepEqual(folded.tags, ["hesketh", "old_one"]);
  assert.deepEqual(folded.newSpeakers.map((s) => s.id), ["old_one"]);

  const script = renderScript([{ index: 0, segments: [
    { speaker: "nell", text: '"Nell Ashby."', paragraphs: [0] }, { speaker: "narrator", text: "She did not sit.", paragraphs: [0] }
  ], delivery: { 0: { speaker: "nell", note: "direct, clipped" } } }]);
  assert.match(script, /\*\*nell\*\* _\(direct, clipped\)_: "Nell Ashby\."\n\n\*\*narrator\*\*: She did not sit\./);
});
