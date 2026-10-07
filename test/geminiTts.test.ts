import { test } from "node:test";
import assert from "node:assert/strict";
import { legacyPrompt } from "../src/geminiTts.ts";
import type { SpeechInput } from "../src/geminiTts.ts";
import { buildTtsPrompt, decodeWav, GEMINI_VOICES, speechAudio, speechRequest } from "../src/geminiTts.ts";
import { extractUsage } from "../src/usage.ts";
import { curateVoices, hybridVoicing, parseScene, resample, synthesizeScene } from "../src/audiobook.ts";
import type { Synthesize } from "../src/audiobook.ts";
import { emptyBible } from "../src/bible.ts";

function wav(samples: number[], rate = 24000, channels = 1): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.round(v * 32767), i * 2));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test("speech carries only the words as text; the direction rides separately as the style (#114)", () => {
  const p = buildTtsPrompt({ name: "Osmagus", profile: "Proud,\n honest.", scene: "A tavern.", notes: "wheezing", line: '"I came to work."' });
  assert.deepEqual(p, { text: '"I came to work."', style: "wheezing. Proud, honest" }, "no name, no scene, nothing to read aloud");
  assert.deepEqual(buildTtsPrompt({ name: "N", profile: "", line: " y " }), { text: "y" });
  const req = speechRequest(p, "en-us-neno", "gemini-3.8-flash-tts") as any;
  assert.deepEqual(req.input[0].content[0], { type: "text", text: '"I came to work."', annotations: [{ type: "speech_metadata", style: "wheezing. Proud, honest" }] });
  assert.deepEqual(req.generation_config, { speech_config: [{ voice: "en-us-neno" }] });
  assert.equal(legacyPrompt(p), `### DIRECTOR'S NOTES\nwheezing. Proud, honest\n\n#### TRANSCRIPT\n"I came to work."`, "Batch Mode's old single-text form");
  const audio = speechAudio({ status: "completed", steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/wav", data: wav([0, 0.5]).toString("base64") }] }] });
  assert.equal(audio.samples.length, 2);
  assert.throws(() => speechAudio({ status: "failed", steps: [] }), /no audio \(failed\)/);
  assert.deepEqual(extractUsage({ usage: { total_input_tokens: 987, total_cached_tokens: 0, total_output_tokens: 39, total_thought_tokens: 0 } }), { input: 987, output: 39, cacheRead: 0, cacheWrite: 0 }, "the ledger reads Interactions usage");
});

test("WAV decoding: 16-bit PCM to float samples, stereo averaged, junk rejected", () => {
  const mono = decodeWav(wav([0, 0.5, -0.5]));
  assert.equal(mono.sampleRate, 24000);
  assert.deepEqual([...mono.samples].map((v) => Math.round(v * 100) / 100), [0, 0.5, -0.5]);
  const stereo = decodeWav(wav([0.5, -0.5, 1, 1], 16000, 2));
  assert.equal(stereo.samples.length, 2);
  assert.equal(Math.round(stereo.samples[0] * 100), 0);
  assert.throws(() => decodeWav(Buffer.from("not a wav file at all")), /not a WAV/);
});

test("Kokoro voice curation and resampling", () => {
  assert.deepEqual(curateVoices(["af_heart", "af_bella", "am_adam"], { exclude: ["af_bella"] }), ["af_heart", "am_adam"]);
  assert.deepEqual(curateVoices(["af_heart", "af_bella", "am_adam"], { include: ["am_adam"], exclude: ["am_adam"] }), ["am_adam"]);
  assert.equal(resample(new Float32Array(100), 16000, 24000).length, 150);
  const same = new Float32Array(3);
  assert.equal(resample(same, 24000, 24000), same);
  assert.ok(Object.values(GEMINI_VOICES).filter((g) => g === "Female").length >= 10);
});

test("hybrid voicing: Kokoro narrates, Gemini acts characters with their bible profile, Kokoro on failure", async () => {
  const bible = emptyBible();
  bible.characters.osmagus = { id: "osmagus", name: "Osmagus", traits: "Proud mountain craftsman.", goal: "", voice: "Slow, plain-spoken.", status: "active", gender: "male" };
  const assignment = { narrator: "af_heart", characters: { osmagus: "am_adam" }, genders: {}, gemini: { narrator: "Charon", characters: { osmagus: "Fenrir" } } };
  const kokoroCalls: Array<[string, string]> = [];
  const kokoroSynth: Synthesize = async function* (text, voice) { kokoroCalls.push([text, voice]); yield { text, audio: new Float32Array(240) }; };
  const geminiCalls: Array<[string, string]> = [];
  let fail = false;
  const fallbacks: string[] = [];
  const { voiceFor, synth } = hybridVoicing({
    bible, assignment, narration: "kokoro", dialogue: "gemini", kokoroSynth,
    speak: async (prompt, voice) => { if (fail) throw new Error("quota"); geminiCalls.push([legacyPrompt(prompt), voice]); return { samples: new Float32Array(160), sampleRate: 16000 }; },
    onFallback: (speaker) => fallbacks.push(speaker)
  });
  assert.equal(voiceFor("narrator"), "af_heart");
  assert.equal(voiceFor("osmagus"), "gemini:Fenrir");

  const scene = parseScene(0, 'narrator: The guild men stared.\n\nosmagus: "I came to work," he said.', new Set(["osmagus"]));
  const out = await synthesizeScene(scene, voiceFor, synth);
  assert.equal(geminiCalls.length, 1);
  const [prompt, voice] = geminiCalls[0];
  assert.equal(voice, "Fenrir");
  assert.ok(prompt.includes("Proud mountain craftsman. Voice: Slow, plain-spoken"), "their profile is the style");
  assert.ok(!prompt.includes("The guild men stared"), "the scene isn't sent (no field for it; it would be read aloud)");
  assert.ok(prompt.endsWith('#### TRANSCRIPT\n"I came to work,"'));
  // Narration went to Kokoro; Gemini's 16 kHz line was resampled to 24 kHz (160 -> 240 samples).
  assert.deepEqual(kokoroCalls.map(([, v]) => v), ["af_heart", "af_heart"]);
  assert.equal(out.audio.length, 240 + 240 + 240);

  fail = true;
  kokoroCalls.length = 0;
  await synthesizeScene(scene, voiceFor, synth);
  assert.deepEqual(fallbacks, ["osmagus"]);
  assert.ok(kokoroCalls.some(([text, v]) => text === '"I came to work,"' && v === "am_adam"), "the failed line used Osmagus's Kokoro voice");
});

test("an inch mark is not a quote, and empty quotes are never voiced", () => {
  const known = new Set(["aldrich", "osmagus"]);
  // From Chapter 1: the 4'8" inch mark used to open a "line" that swallowed the narration.
  const s = parseScene(0, 'aldrich: Aldrich looked at Osmagus, taking in the 4\'8" frame and the case. "What\'s your trade?"\n\nosmagus: "" he said.', known);
  assert.deepEqual(s.segments.map((x) => [x.speaker, x.text]), [
    ["narrator", 'Aldrich looked at Osmagus, taking in the 4\'8" frame and the case.'],
    ["aldrich", '"What\'s your trade?"'],
    ["narrator", "he said."]
  ]);
});

test("scene context drops quoted dialogue; over-long replies are retried then fall back", async () => {
  const { sceneContext, maxLineSeconds } = await import("../src/audiobook.ts");
  assert.equal(sceneContext('"No. Looking for work." Marta appeared from behind the bar. "You want ale?"'), "Marta appeared from behind the bar.");
  assert.ok(sceneContext("x ".repeat(400)).length <= 302);
  assert.equal(maxLineSeconds('"Work first. Ale after, if I\'ve earned it."'), 11);

  const bible = emptyBible();
  bible.characters.osmagus = { id: "osmagus", name: "Osmagus", traits: "", goal: "", voice: "", status: "active" };
  const assignment = { narrator: "af_heart", characters: { osmagus: "am_adam" }, genders: {}, gemini: { narrator: "Charon", characters: { osmagus: "Fenrir" } } };
  const kokoro: string[] = [];
  const kokoroSynth: Synthesize = async function* (text, voice) { kokoro.push(voice); yield { text, audio: new Float32Array(1) }; };
  let calls = 0;
  const lengths = [60, 4];  // seconds: first reply read the context aloud, the retry is right
  const { synth } = hybridVoicing({
    bible, assignment, narration: "kokoro", dialogue: "gemini", kokoroSynth,
    speak: async () => ({ samples: new Float32Array(24000 * lengths[calls++ % 2]), sampleRate: 24000 })
  });
  const out: Float32Array[] = [];
  for await (const c of synth('"Work first."', "gemini:Fenrir", { speaker: "osmagus", context: "" })) out.push(c.audio);
  assert.equal(calls, 2);
  assert.equal(out[0].length, 24000 * 4);
  // Both attempts too long: Kokoro voices the line instead.
  calls = 0;
  lengths[1] = 60;
  for await (const _ of synth('"Work first."', "gemini:Fenrir", { speaker: "osmagus", context: "" })) { /* drain */ }
  assert.deepEqual(kokoro, ["am_adam"]);
});

test("a spent budget stops Gemini voicing instead of falling back to Kokoro", async () => {
  const { BudgetExceededError } = await import("../src/usage.ts");
  const bible = emptyBible();
  bible.characters.osmagus = { id: "osmagus", name: "Osmagus", traits: "", goal: "", voice: "", status: "active" };
  const assignment = { narrator: "af_heart", characters: { osmagus: "am_michael" }, genders: {}, gemini: { narrator: "Charon", characters: { osmagus: "Fenrir" } } };
  const kokoroCalls: string[] = [];
  const kokoroSynth: Synthesize = async function* (text, voice) { kokoroCalls.push(voice); yield { text, audio: new Float32Array(240) }; };
  const fallbacks: string[] = [];
  const { voiceFor, synth } = hybridVoicing({
    bible, assignment, narration: "kokoro", dialogue: "gemini", kokoroSynth,
    speak: async () => { throw new BudgetExceededError(5.01, 5); },
    onFallback: (speaker) => fallbacks.push(speaker)
  });
  const scene = parseScene(0, 'osmagus: "Up we go," he said.', new Set(["osmagus"]));
  await assert.rejects(synthesizeScene(scene, voiceFor, synth), /budget \$5\.00 reached/);
  assert.deepEqual(fallbacks, []);
  assert.deepEqual(kokoroCalls, []);
});
