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
  await log.append("scene_tags", { version: 2, index: 0, source: "stale", tags: ["narrator", "narrator", "narrator", "narrator"], delivery: [], speakers: [] });
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

test("quote checks: no quotes means narrator; everything else is a doubt for the model, never an override", async () => {
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
  assert.deepEqual(r.tags, ["narrator", "nell", "narrator", "edrick"], "only the structural fix is applied");
  assert.equal(r.dialogue, 3);
  assert.deepEqual(r.checks, ["¶1: nell → narrator (no dialogue)"]);
  assert.deepEqual(r.doubts.map((x) => [x.paragraph + 1, x.reason]), [
    [2, "you said nell, but the narration seems to attribute the line to corin"],
    [3, "it contains a spoken line in quotation marks, so it is not narrator"],
    [4, 'the narration says "she said", but you tagged edrick (male)']
  ]);
  // A brittle pattern can't overrule the model: "Nell said nothing" is not Nell's line.
  const quiet = checkTags(['Nell said nothing. "Go home," Corin muttered.'], ["corin"], cast);
  assert.deepEqual(quiet.tags, ["corin"]);

  // One person, one voice: a "new" speaker who is already in the cast folds into their id.
  const folded = foldKnownSpeakers({ tags: ["hesketh_barkeep", "old_one"], delivery: ["", ""], newSpeakers: [{ id: "hesketh_barkeep", name: "Hesketh the barkeep" }, { id: "old_one", name: "The Old One" }] }, [{ id: "hesketh", name: "Hesketh" }]);
  assert.deepEqual(folded.tags, ["hesketh", "old_one"]);
  assert.deepEqual(folded.newSpeakers.map((s) => s.id), ["old_one"]);

  const script = renderScript([{ index: 0, segments: [
    { speaker: "nell", text: '"Nell Ashby."', paragraphs: [0] }, { speaker: "narrator", text: "She did not sit.", paragraphs: [0] }
  ], delivery: { 0: { speaker: "nell", note: "direct, clipped" } } }]);
  assert.match(script, /\*\*nell\*\* _\(direct, clipped\)_: "Nell Ashby\."\n\n\*\*narrator\*\*: She did not sit\./);
});

// --- regressions: cases found by listening to Gallows Inn (exact text) ---
const GALLOWS = [
  "She stood in the doorway long enough to let the cold in. Hesketh, behind the bar, said, \"Door,\" and she shut it.",
  "\"Nell Ashby.\" She did not sit. Her boots were black to the shin with road mud, and her cloak had been mended at the hem in a thread that didn't match. \"Corin's sister.\"",
  "\"There are old ropes,\" she said. \"In every town. Ropes that have been out in the rain. Ropes the rats got at.\" Her voice was low and level, and each sentence came out finished, as though she had shaped them on the road and only had to set them down. \"If the rope breaks, he goes free. That's the law here. I asked three people to be sure.\"",
  "\"I'm a midwife,\" she said. \"I've had babies come wrong. Feet first, cord round the neck.\" She pushed the purse an inch toward him. \"Fourteen crowns.\"",
  "\"It was very pretty, Nell. You should have seen it. You hold it up to a candle and it throws the light all over the walls, little gold pieces of it, like\u2014\"",
  "\"I don't care what it looked like.\"",
  "Nell looked at her cup and did not lift it."
];
const GALLOWS_CAST = { characters: {
  nell: { id: "nell", name: "Nell Ashby", traits: "", goal: "", voice: "", status: "active", gender: "female" },
  corin: { id: "corin", name: "Corin Ashby", traits: "", goal: "", voice: "", status: "active", gender: "male" },
  edrick: { id: "edrick", name: "Edrick Vell", traits: "", goal: "", voice: "", status: "active", gender: "male" }
} };

test("regression: the narrator never reads a spoken line, and characters only read their quotes", async () => {
  const { voicingProblems } = await import("../src/tagging.ts");
  const log = new EventLog(await mkdtemp(join(tmpdir(), "scriptorium-tag-")));
  await log.load();
  await log.append("scene_committed", { index: 0, prose: GALLOWS.join("\n\n"), bible: GALLOWS_CAST });
  // The mistakes the tagger actually made: Hesketh's "Door" and two of Nell's lines tagged narrator,
  // a no-quote paragraph tagged nell. The targeted retry names the speakers.
  const role = fakeRole(
    { paragraphs: [
      { n: 1, speaker: "narrator" }, { n: 2, speaker: "nell", delivery: "direct, clipped" }, { n: 3, speaker: "nell", delivery: "low and level" },
      { n: 4, speaker: "narrator" }, { n: 5, speaker: "corin" }, { n: 6, speaker: "narrator" }, { n: 7, speaker: "nell" }
    ], newSpeakers: [] },
    { paragraphs: [{ n: 1, speaker: "hesketh" }, { n: 2, speaker: "nell" }, { n: 3, speaker: "nell" }], newSpeakers: [{ id: "hesketh", name: "Hesketh", description: "the innkeeper" }] }
  );
  await tagRun(log, role);
  assert.match(role.prompts[1], /a check doubted your first answer/, "doubtful paragraphs are asked about again");
  assert.match(role.prompts[1], /it contains a spoken line in quotation marks, so it is not narrator/);
  const t = sceneTags(log.events).get(0)!;
  assert.deepEqual(t.tags, ["hesketh", "nell", "nell", "nell", "corin", "nell", "narrator"]);
  assert.ok(t.checks!.includes("¶7: nell → narrator (no dialogue)"));
  const [scene] = buildScenes(log.events);
  assert.deepEqual(voicingProblems([scene]), [], "no narrator piece contains a quotation mark");
  for (const seg of scene.segments) {
    if (seg.speaker === "narrator") continue;
    for (const piece of seg.text.split("\n\n")) assert.match(piece, /^["\u201C][\s\S]*["\u201D\u2014]$|^["\u201C]/, `${seg.speaker} reads only quotes: ${piece}`);
  }
  // "Nell Ashby." She did not sit. ... "Corin's sister." — the narration between her lines is the narrator's.
  // Each voiced piece with its paragraph (consecutive pieces by one speaker are merged into a segment).
  const pieces = scene.segments.flatMap((s) => { const parts = s.text.split("\n\n"); return parts.map((text, k) => ({ speaker: s.speaker, text, paragraph: s.paragraphs[parts.length === s.paragraphs.length ? k : 0] })); });
  const p2 = pieces.filter((x) => x.paragraph === 1).map((x) => [x.speaker, x.text.slice(0, 20)]);
  assert.deepEqual(p2, [["nell", '"Nell Ashby."'], ["narrator", "She did not sit. Her"], ["nell", '"Corin\'s sister."']]);
  // "There are old ropes," she said. ... — "she said" and the description are the narrator's.
  const p3 = pieces.filter((x) => x.paragraph === 2).map((x) => x.speaker);
  assert.deepEqual(p3, ["nell", "narrator", "nell", "narrator", "nell"]);
});

test("regression: the attribution regex catches a name and its verb in one clause", async () => {
  const { attributedSpeaker } = await import("../src/tagging.ts");
  const cast = [{ id: "hesketh", name: "Hesketh" }, { id: "nell", name: "Nell Ashby" }];
  assert.equal(attributedSpeaker("She stood in the doorway long enough to let the cold in. Hesketh, behind the bar, said,  and she shut it.", cast), "hesketh");
  assert.equal(attributedSpeaker("Hesketh nodded. Then the door banged and someone said", cast), undefined, "a sentence break ends the clause");
});

test("regression: one barkeep, one voice (hesketh / hesketh_barkeep)", async () => {
  const log = new EventLog(await mkdtemp(join(tmpdir(), "scriptorium-tag-")));
  await log.load();
  const p1 = "\"Door,\" Hesketh said.";
  const p2 = "\"Last call,\" the barkeep said.";
  await log.append("scene_committed", { index: 0, prose: p1, bible: GALLOWS_CAST });
  await log.append("scene_committed", { index: 1, prose: p2 });
  await log.append("scene_tags", { version: 2, index: 0, source: proseHash(p1), tags: ["hesketh"], delivery: [""], speakers: [{ id: "hesketh", name: "Hesketh" }] });
  await log.append("scene_tags", { version: 2, index: 1, source: proseHash(p2), tags: ["hesketh_barkeep"], delivery: [""], speakers: [{ id: "hesketh_barkeep", name: "Hesketh" }] });
  const speakers = buildScenes(log.events).flatMap((s) => s.segments.map((x) => x.speaker));
  assert.deepEqual([...new Set(speakers)].sort(), ["hesketh", "narrator"]);
  assert.ok(!("hesketh_barkeep" in voicedBible(log.events).characters));
});

test("regression: a 52-paragraph scene tagged with one entry missing keeps every other label in place", async () => {
  const paragraphs = Array.from({ length: 52 }, (_, n) => (n % 2 ? `"Line ${n}," Nell said.` : `Narration ${n}.`));
  const entries = paragraphs.map((_, n) => ({ n: n + 1, speaker: n % 2 ? "nell" : "narrator" })).filter((e) => e.n !== 30);
  const out = await tagSpeakers(fakeRole({ paragraphs: entries, newSpeakers: [] }), { paragraphs, cast: [{ id: "nell", name: "Nell Ashby" }] });
  assert.equal(out.result.missing, 1);
  assert.equal(out.result.tags[29], "narrator");
  assert.equal(out.result.tags[30], "narrator");
  assert.equal(out.result.tags[31], "nell", "labels after the gap are not shifted");
});

test("tags made by an older tagger are redone", async () => {
  const log = new EventLog(await mkdtemp(join(tmpdir(), "scriptorium-tag-")));
  await log.load();
  await log.append("scene_committed", { index: 0, prose: PROSE, bible: bibleWith });
  await log.append("scene_tags", { index: 0, source: proseHash(PROSE), tags: ["narrator", "narrator", "narrator", "narrator"], delivery: [], speakers: [] });
  assert.equal(sceneTags(log.events).size, 0, "version-1 tags are stale");
  assert.deepEqual(await tagRun(log, fakeRole(GOOD)), [0]);
});
