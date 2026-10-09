import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkVocals, performed, proseHash, TAGGER_VERSION, vocalRun, vocalTags, VOCAL_TAGS } from "../src/tagging.ts";
import { buildScenes, performedPiece, sceneRenderKey, scenePieces } from "../src/audiobook.ts";
import { batchPrompt } from "../src/geminiBatch.ts";
import { checkedSpeaker, plainScript } from "../src/speechCheck.ts";
import { resolveAudioTags } from "../src/steps.ts";
import { EventLog } from "../src/eventlog.ts";
import type { Role } from "../src/types.ts";

// Issue #71: sounds the prose calls for — a laugh mid-line, a sigh, a pause —
// performed by Gemini TTS from inline tags, never in the story's text.

const paragraphs = [
  "The road ran west.",
  "\"Several of them,\" Lemuel said, and laughed. \"Soaked through, every one.\"",
  "Hellga sighed. \"Fine. We walk.\""
];
const speakers = ["narrator", "lemuel", "hellga"];

test("each mark is checked: an allowed sound, words really in the paragraph, inside the character's own words, pauses for the narrator, two at most", () => {
  const { vocal, dropped } = checkVocals(paragraphs, speakers, [
    { n: 2, tag: "laugh", before: "Soaked through" },        // in Lemuel's words: kept
    { n: 3, tag: "sigh", before: "Fine. We walk." },          // kept
    { n: 1, tag: "long pause", after: "The road ran west." }, // the narrator may pause: kept
    { n: 1, tag: "laugh", after: "The road" },               // the narrator doesn't laugh
    { n: 2, tag: "chuckle", after: "Lemuel said" },          // in the narration around the quote
    { n: 3, tag: "yodel", before: "Fine." },                 // not an allowed sound
    { n: 3, tag: "gasp", before: "We run." },                // words not in the paragraph
    { n: 9, tag: "sigh", before: "x" },
    { n: 3, tag: "groan", after: "Fine." },
    { n: 3, tag: "sob", after: "We walk" }                   // a third in one paragraph
  ], VOCAL_TAGS);
  assert.deepEqual(vocal, [[{ tag: "long pause", after: "The road ran west." }], [{ tag: "laugh", before: "Soaked through" }], [{ tag: "sigh", before: "Fine. We walk." }, { tag: "groan", after: "Fine." }]]);
  assert.equal(dropped.length, 6);
  assert.match(dropped.join("\n"), /¶1 <laugh>: the narrator only pauses or breathes/);
  assert.match(dropped.join("\n"), /¶2 <chuckle>: outside the character's own words/);
  assert.match(dropped.join("\n"), /¶3 <yodel>: not an allowed tag/);
  assert.match(dropped.join("\n"), /¶3 <sob>: more than two in a paragraph/);
});

test("a tag goes in at its words, only in the speaker's own piece; everything else stays plain", () => {
  assert.equal(performed("Soaked through, every one.", [{ tag: "laugh", before: "Soaked through" }]), "<laugh> Soaked through, every one.");
  assert.equal(performed("Hold on, let me think...", [{ tag: "short pause", after: "let me think..." }]), "Hold on, let me think... <short pause>");
  assert.equal(performed("Lemuel said, and laughed.", [{ tag: "laugh", before: "Soaked through" }]), "Lemuel said, and laughed.", "not this piece's words");
  const scene = {
    index: 0, tagged: true,
    segments: [{ speaker: "lemuel", text: "Soaked through, every one.", paragraphs: [1] }, { speaker: "narrator", text: "Lemuel said, and laughed.", paragraphs: [1] }],
    vocal: { 1: { speaker: "lemuel", tags: [{ tag: "laugh", after: "Soaked through," }, { tag: "sigh", before: "Lemuel said" }] } }
  };
  const [quote, narration] = scenePieces(scene);
  assert.equal(performedPiece(scene, quote), "Soaked through, <laugh> every one.");
  assert.equal(performedPiece(scene, narration), "Lemuel said, and laughed.", "the narration around a quote never gets a character's sound");
  // The take changes with the sounds, so changing them re-voices the scene.
  assert.notEqual(sceneRenderKey(scene, {}), sceneRenderKey({ ...scene, vocal: undefined }, {}));
  // A batch sends the performed text and keeps the plain text for the cut.
  const prompt = batchPrompt({ speaker: "lemuel", pieces: [{ order: 0, speaker: "lemuel", text: "Soaked through, every one.", performed: "Soaked through, <laugh> every one." }] }, { name: "Lemuel", profile: "" });
  assert.match(prompt.text, /<laugh>/);
});

test("the speech check hears against the words alone, so a tag read aloud is caught", async () => {
  assert.equal(plainScript("Soaked through, <laugh> every one. <long pause>"), "Soaked through, every one.");
  const scripts: string[] = [];
  const speak = checkedSpeaker(async () => ({ samples: new Float32Array(10), sampleRate: 24000 }), async (_a, script) => { scripts.push(script); return { ok: true, heard: script, problems: [] }; });
  await speak({ text: "<sigh> Fine. We walk." }, "v");
  assert.deepEqual(scripts, ["Fine. We walk."]);
});

test("the voice director marks each scene once, its marks checked and kept with the scene; stale when the prose or speakers change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptorium-vocal-"));
  const log = new EventLog(dir);
  await log.load();
  const prose = paragraphs.join("\n\n");
  await log.append("scene_committed", { index: 0, prose, beat: {}, tension: 1, attempts: 1 });
  await log.append("scene_tags", { version: TAGGER_VERSION, index: 0, source: proseHash(prose), tags: speakers, delivery: ["", "", ""], speakers: [] });
  let calls = 0;
  const role = { provider: { complete: async () => { calls++; return JSON.stringify({ marks: [{ n: 2, tag: "laugh", before: "Soaked through" }, { n: 2, tag: "laugh", after: "Lemuel said" }] }); } } } as unknown as Role;
  const seen: Array<[number, number, string[]]> = [];
  assert.deepEqual(await vocalRun(log, role, VOCAL_TAGS, (i, n, dropped) => seen.push([i, n, dropped])), [0]);
  assert.deepEqual(seen.map(([i, n, d]) => [i, n, d.length]), [[0, 1, 1]], "one kept, one set aside");
  assert.deepEqual(await vocalRun(log, role, VOCAL_TAGS), [], "done: not asked again");
  assert.equal(calls, 1);
  // The voiced scene carries them; without audioTags it doesn't.
  const [scene] = buildScenes(log.events, { vocal: VOCAL_TAGS });
  assert.deepEqual(scene.vocal?.[1], { speaker: "lemuel", tags: [{ tag: "laugh", before: "Soaked through" }] });
  assert.equal(buildScenes(log.events)[0].vocal, undefined);
  // Another list of tags, or rewritten prose: stale, asked again.
  assert.equal(vocalTags(log.events, ["sigh"]).size, 0);
  await log.append("scene_committed", { index: 0, prose: prose.replace("We walk", "We ride"), beat: {}, tension: 1, attempts: 1 });
  assert.equal(vocalTags(log.events).size, 0);
});

test("audioTags in the story file: off, true for the standard list, or a list of its sounds", () => {
  assert.equal(resolveAudioTags(undefined), undefined);
  assert.equal(resolveAudioTags(false), undefined);
  assert.equal(resolveAudioTags(true), VOCAL_TAGS);
  assert.deepEqual(resolveAudioTags(["laugh", "short pause"]), ["laugh", "short pause"]);
  assert.throws(() => resolveAudioTags(["laugh", "applause"]), /unknown tag applause/);
});
