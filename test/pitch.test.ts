import { test } from "node:test";
import assert from "node:assert/strict";
import { pitch, formatPitch, TYPICAL } from "../src/pitch.ts";
import { proseHash } from "../src/tagging.ts";
import type { StoryEvent } from "../src/types.ts";

function ev(seq: number, type: string, data: unknown): StoryEvent { return { seq, type, ts: `t${seq}`, data }; }

test("before the story exists, the pitch estimates from scenes and length", () => {
  const p = pitch({ events: [], scenes: 3, audio: { narration: "gemini", dialogue: "gemini", geminiMode: "palette" }, budgetUsd: 5 });
  assert.equal(p.story.scenesToWrite, 3);
  assert.ok(Math.abs(p.story.usd - 3 * TYPICAL.storyUsdPerScene) < 1e-9);
  assert.equal(p.images.shots, 3 * Math.round(1500 / 110));
  assert.ok(p.images.generations > p.images.shots, "references, cover and retakes too");
  assert.equal(p.exact.shots, false);
  assert.ok(p.audio.geminiRequests > 0 && p.audio.geminiRequests < 100, "palette fits in a day");
  assert.match(formatPitch(p, 5), /images \(estimated\)/);
});

test("with the story written, tagged and directed, counts are exact — and rendered work is skipped", () => {
  const prose = ['"Go home," Nell said.', "The fire hissed.", '"No," Corin said.', "Rain."].join("\n\n");
  const events = [
    ev(0, "scene_committed", { index: 0, prose, bible: { characters: { nell: { id: "nell", name: "Nell" }, corin: { id: "corin", name: "Corin" } } } }),
    ev(1, "scene_tags", { version: 2, index: 0, source: proseHash(prose), tags: ["nell", "narrator", "corin", "narrator"], delivery: ["", "", "", ""], speakers: [] }),
    ev(2, "visual_ref", { kind: "character", id: "nell", appearance: "a", prompt: "portrait nell" }),
    ev(3, "scene_art", { sceneIndex: 0, prompt: "s1", shots: [{ startParagraph: 0, prompt: "s1" }, { startParagraph: 2, prompt: "s2" }] }),
    ev(4, "cover_art", { sceneCount: 1, prompt: "cover" })
  ];
  const line = pitch({ events, scenes: 1, audio: { dialogue: "gemini", narration: "kokoro", geminiMode: "line" } });
  assert.equal(line.exact.voicing, true);
  assert.equal(line.audio.geminiRequests, Math.round(2 * 1.2), "two dialogue lines, one request each (plus retake allowance)");
  assert.deepEqual([line.images.references, line.images.shots, line.images.cover], [1, 2, 1]);
  const rendered = pitch({ events, scenes: 1, artManifest: { "character-nell": { prompt: "portrait nell" }, "scene-01-01": { prompt: "s1" } }, scenesVoiced: 1, audio: { dialogue: "gemini" } });
  assert.deepEqual([rendered.images.references, rendered.images.shots, rendered.images.cover], [0, 1, 1], "only s2 and the cover are left");
  assert.equal(rendered.audio.seconds, 0, "the scene is already voiced");
  const changed = pitch({ events, scenes: 1, artManifest: { "character-nell": { prompt: "an older prompt" } } });
  assert.equal(changed.images.references, 1, "a changed prompt is redone");
});

test("the pitch warns about multi-day voicing and blown budgets, and uses the run's own costs", () => {
  const many = pitch({ events: [], scenes: 6, audio: { narration: "gemini", dialogue: "gemini", geminiMode: "line" }, budgetUsd: 1 });
  assert.ok(many.audio.days > 1);
  assert.ok(many.warnings.some((w) => /days of the 100-a-day cap/.test(w)));
  assert.ok(many.warnings.some((w) => /over the \$1\.00 budget/.test(w)));
  const ledger = Array.from({ length: 5 }, (_, i) => ({ ts: `${i}`, step: "art", role: "artist", model: "gemini-3.1-flash-image", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0.2 }));
  const pricey = pitch({ events: [], scenes: 1, ledger, art: { retakes: 0 }, audio: { skip: true } });
  const cheap = pitch({ events: [], scenes: 1, art: { retakes: 0 }, audio: { skip: true } });
  assert.ok(pricey.images.usd > cheap.images.usd * 2, "this run's images cost more, so the pitch says so");
  assert.equal(pricey.spentUsd, 1);
  const none = pitch({ events: [], scenes: 1, art: { skip: true }, audio: { skip: true } });
  assert.match(formatPitch(none), /images: nothing to render\nvoice: nothing to voice/);
});

test("Batch Mode halves the voicing only for models that take direction in the text; 3.8 TTS is voiced live (#114)", async () => {
  const { readsVerbatim } = await import("../src/geminiTts.ts");
  assert.equal(readsVerbatim("gemini-3.8-flash-tts"), true);
  assert.equal(readsVerbatim(), true, "the default model");
  assert.equal(readsVerbatim("gemini-2.5-flash-preview-tts"), false);
  const at = (geminiModel?: string, geminiBatch = true) => pitch({ events: [], scenes: 3, audio: { narration: "gemini", dialogue: "gemini", geminiMode: "palette", geminiBatch, ...(geminiModel ? { geminiModel } : {}) } }).audio.usd;
  assert.equal(at(undefined), at(undefined, false), "3.8: full price, batch or not");
  assert.ok(Math.abs(at("gemini-2.5-flash-preview-tts") - at("gemini-2.5-flash-preview-tts", false) / 2) < 1e-9, "an older model in Batch Mode: half");
});
