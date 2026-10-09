import { test } from "node:test";
import assert from "node:assert/strict";
import { buildArtJobs, withMoment } from "../src/artist.ts";
import { continuityAt, continuityConflicts, continuityLine, normalizeContinuity } from "../src/roles.ts";
import type { StoryEvent } from "../src/types.ts";

// Issue #140: Rantoul's fire-beetle fight happens at night, but some of its
// shots came out in daylight: nothing pinned a scene's physical facts. The
// art director now writes a continuity sheet, and every shot carries its moment.

const ev = (seq: number, type: string, data: unknown): StoryEvent => ({ seq, type, ts: `t${seq}`, data });
const raw = { continuity: [
  { from_paragraph: 12, time: "night, an hour after dusk", light: "the campfire only, darkness beyond", state: "the fire is lit", place: "a campsite hollow", indoors: false },
  { from_paragraph: 1, time: "dusk", light: "the last grey daylight", weather: "dry and still", place: "a campsite hollow", indoors: false },
  { from_paragraph: 20, time: "night", light: "moonlight only", state: "the fire is out" },
  { from_paragraph: 99, time: "noon" },
  { from_paragraph: 30 }
] };

test("the sheet: sorted, 0-based, in range, empty entries dropped, the first from the scene's start", () => {
  const sheet = normalizeContinuity(raw, 40);
  assert.deepEqual(sheet.map((e) => e.fromParagraph), [0, 11, 19]);
  assert.equal(continuityAt(sheet, 5)?.time, "dusk");
  assert.equal(continuityAt(sheet, 15)?.state, "the fire is lit");
  assert.equal(continuityAt(sheet, 25)?.light, "moonlight only");
  assert.equal(continuityLine(sheet[1]), "a campsite hollow (outdoors); time: night, an hour after dusk; light: the campfire only, darkness beyond; the fire is lit");
  assert.deepEqual(normalizeContinuity({}, 10), [], "an older art director's answer has none");
});

test("each shot carries its moment, stated to override the style's light; plans without a sheet are unchanged", () => {
  const sheet = normalizeContinuity(raw, 40);
  const events = [
    ev(0, "scene_committed", { index: 0 }),
    ev(1, "scene_art", { sceneIndex: 0, prompt: "a", continuity: sheet, shots: [{ startParagraph: 0, prompt: "a" }, { startParagraph: 21, prompt: "b" }] }),
    ev(2, "scene_committed", { index: 1 }),
    ev(3, "scene_art", { sceneIndex: 1, prompt: "old", shots: [{ startParagraph: 0, prompt: "old" }] })
  ];
  const jobs = buildArtJobs(events);
  assert.match(jobs.find((j) => j.key === "scene-01-02")!.prompt, /^b\n\nTHIS MOMENT \(overrides any time of day, light or weather in the style\): time: night; light: moonlight only; the fire is out\.$/);
  assert.match(jobs.find((j) => j.key === "scene-01-01")!.prompt, /time: dusk/);
  assert.equal(jobs.find((j) => j.key === "scene-02-01")!.prompt, "old", "a shot planned before sheets existed keeps its prompt, so it isn't redrawn");
  assert.equal(withMoment("p", undefined), "p");
});

test("a prompt that says daylight in a night stretch (or night in a day one) is caught", () => {
  const sheet = normalizeContinuity(raw, 40);
  const conflicts = continuityConflicts([
    { startParagraph: 0, prompt: "the company at dusk, the last grey light" },
    { startParagraph: 14, prompt: "beetles swarm the camp in bright afternoon sunlight" },
    { startParagraph: 25, prompt: "Ivana by the dead fire, moonlight on her face" },
    { startParagraph: 26, prompt: "a golden hour glow over the hollow" }
  ], sheet);
  assert.deepEqual(conflicts.map((c) => [c.shot, c.says.toLowerCase()]), [[2, "afternoon"], [4, "golden hour"]]);
  assert.deepEqual(continuityConflicts([{ startParagraph: 0, prompt: "noon sun" }], undefined), [], "no sheet, nothing to check");
  const style = "Natural light (overcast skies, low golden sun, firelight).";
  assert.deepEqual(continuityConflicts([{ startParagraph: 14, prompt: `beetles at the fire. ${style}` }], sheet, style), [], "the style paragraph's light isn't the shot's");
  assert.deepEqual(continuityConflicts([{ startParagraph: 2, prompt: "the moon rises over the road" }], sheet), [], "dusk isn't checked either way");
  assert.deepEqual(continuityConflicts([{ startParagraph: 0, prompt: "a golden hour glow" }], [{ fromParagraph: 0, time: "dusk, approaching night", light: "fading, darkness gathering" }]), [], "dusk turning to night is still dusk");
});
