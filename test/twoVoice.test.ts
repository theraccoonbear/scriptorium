import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScene, scenePieces, twoVoiceGroups, voiceConversations } from "../src/audiobook.ts";
import { speechRequest, withPronunciations } from "../src/geminiTts.ts";
import type { SpeechInput } from "../src/geminiTts.ts";
import type { BatchCache } from "../src/geminiBatch.ts";
import type { Bible } from "../src/types.ts";

// Issue #124: a dialogue tag voiced on its own ("he said.") gets its missing
// quote invented ("How do you do? he said"). A quote and its tag are voiced
// together instead, as one two-voice request.

const scene = parseScene(0, [
  'riann: "Good sirs," he said, an octave above his own voice. "I find myself upon the road without escort—"',
  "narrator: The nearer guard looked down at him, which did not take long.",
  'guard: "You\'re a halfling," he said.'
].join("\n\n"), new Set(["riann", "guard"]));

const bible = {
  title: "", premise: "", tone: "wry fantasy", setting: "", threads: [], facts: [], locations: {}, objects: {},
  characters: { riann: { id: "riann", name: "Riann", traits: "a bard", goal: "", voice: "", vocal: "thin nasal tenor", status: "active" } }
} as unknown as Bible;

test("a quote and its short narrator pieces are one group; narration on its own isn't", () => {
  assert.deepEqual(twoVoiceGroups(scene), [[0, 1, 2], [4, 5]]);
  assert.equal(scenePieces(scene)[1].text, "he said, an octave above his own voice.", "the tag that used to go out alone");
});

test("a two-voice request: each part in its speaker's voice, labelled per voice; one voice is a plain request", () => {
  const two = speechRequest({ text: "", parts: [{ speaker: "Riann", voice: "umbriel", text: '"Good sirs,"', style: "grand" }, { speaker: "Narrator", voice: "algenib", text: "he said." }] }, "", "m") as any;
  assert.deepEqual(two.generation_config.speech_config, { mode: "conversational", speakers: [{ speaker: "Riann", voice: "umbriel" }, { speaker: "Narrator", voice: "algenib" }] });
  assert.deepEqual(two.input[0].content.map((c: any) => [c.text, c.annotations[0].speaker, c.annotations[0].style]), [['"Good sirs,"', "Riann", "grand"], ["he said.", "Narrator", undefined]]);
  const one = speechRequest({ text: "", parts: [{ speaker: "Guard", voice: "algenib", text: '"You\'re a halfling,"' }, { speaker: "Narrator", voice: "algenib", text: "he said." }] }, "", "m") as any;
  assert.deepEqual(one.generation_config.speech_config, [{ voice: "algenib" }], "a walk-on read by the narrator: one voice");
});

test("pronunciations apply to each part", () => {
  const out = withPronunciations({ text: "", parts: [{ speaker: "N", voice: "v", text: "Riann said." }] }, { Riann: { say: "Ryan" } });
  assert.equal(out.parts![0].text, "Ryan said.");
  assert.equal(out.text, "Ryan said.", "the check hears against what was asked for");
});

test("each group is voiced once, on its first piece; the rest are silent; a re-run comes from the cache", async () => {
  const asked: SpeechInput[] = [];
  const store = new Map<string, Float32Array>();
  const cache: BatchCache = { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, v); } };
  const voiceFor = (s: string) => (s === "riann" ? "gemini:umbriel" : "gemini:algenib");
  const speak = async (input: SpeechInput) => { asked.push(input); return { samples: new Float32Array(2400), sampleRate: 24000 }; };
  const out = await voiceConversations(scene, { bible, voiceFor, speak, byNarrator: new Set(["guard"]), cache, model: "m" });
  assert.equal(asked.length, 2);
  assert.deepEqual(asked[0].parts!.map((p) => [p.speaker, p.voice, p.text]), [
    ["Riann", "umbriel", '"Good sirs,"'], ["Narrator", "algenib", "he said, an octave above his own voice."], ["Riann", "umbriel", '"I find myself upon the road without escort—"']
  ]);
  assert.equal(asked[0].text, '"Good sirs," he said, an octave above his own voice. "I find myself upon the road without escort—"', "the whole paragraph is the script the check hears against");
  assert.equal(out.get(0)!.length, 2400);
  assert.deepEqual([out.get(1)!.length, out.get(2)!.length], [0, 0]);
  assert.ok(!out.has(3), "plain narration is left to the batches");
  await voiceConversations(scene, { bible, voiceFor, speak, byNarrator: new Set(["guard"]), cache, model: "m" });
  assert.equal(asked.length, 2, "cached: nothing asked again");
});
