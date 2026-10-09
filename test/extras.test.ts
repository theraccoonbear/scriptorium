import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArtJobs, CAST_PHOTO_KEY, imageRequest, KEY_ART, MockImageBackend, renderArt } from "../src/artist.ts";
import { artDirect } from "../src/roles.ts";
import { contactSheets } from "../src/reviewSheets.ts";
import { pitch } from "../src/pitch.ts";
import { replay } from "../src/bible.ts";
import type { ArtManifest } from "../src/artist.ts";
import type { Bible, Role, StoryEvent } from "../src/types.ts";

// Issue #49: the extras — key art in three shapes and a cast photo, in the
// story's art style, at 2K, directed once and rendered like the cover.

const ev = (seq: number, type: string, data: unknown): StoryEvent => ({ seq, type, ts: `t${seq}`, data });
const ref = (seq: number, kind: string, id: string) => ev(seq, "visual_ref", { kind, id, appearance: id, prompt: `portrait ${id}` });
const events: StoryEvent[] = [
  ref(0, "character", "ada"), ref(1, "character", "bo"), ref(2, "character", "cy"), ref(3, "character", "dee"), ref(4, "location", "keep"),
  ev(5, "scene_art", { sceneIndex: 0, prompt: "s1", shots: [{ startParagraph: 0, prompt: "ada in the keep", characters: ["ada"], location: "keep" }, { startParagraph: 3, prompt: "bo", characters: ["bo"] }] }),
  ev(6, "cover_art", { sceneCount: 1, prompt: "cover" }),
  ev(6.5, "art_style", { style: "Gritty live-action film still.", source: "author" }),
  ev(7, "extras_art", { keyArt: "a lone figure on the ramparts", castPhoto: "the cast posing on set", castCharacters: ["ada", "bo", "cy", "dee", "ghost"] })
];

test("the extras are key art in three shapes and a cast photo of everyone in it, all at 2K", () => {
  const jobs = buildArtJobs(events).filter((j) => j.key.startsWith("extra-"));
  assert.deepEqual(jobs.map((j) => [j.key, j.aspectRatio, j.imageSize, j.prompt]), [
    ["extra-keyart-2x3", "2:3", "2K", "cover Gritty live-action film still."],
    ["extra-keyart-16x9", "16:9", "2K", "cover Gritty live-action film still."],
    ["extra-keyart-1x1", "1:1", "2K", "cover Gritty live-action film still."],
    ["extra-cast", "3:2", "2K", "the cast posing on set Gritty live-action film still."]
  ]);
  assert.equal(jobs[0].from, "cover", "key art is the cover, reframed to each shape");
  const noCover = buildArtJobs(events.filter((e) => e.type !== "cover_art")).find((j) => j.key === "extra-keyart-2x3")!;
  assert.deepEqual([noCover.from, noCover.characters, noCover.location], [undefined, ["ada", "bo"], "keep"], "with no cover, the art director's own key art, featuring the most-shown characters");
  const cast = jobs.find((j) => j.key === CAST_PHOTO_KEY)!;
  assert.deepEqual(cast.characters, ["ada", "bo", "cy", "dee"], "everyone with a portrait; an unknown id dropped");
  assert.ok((cast.maxPortraits ?? 0) >= 4, "and all their portraits are passed, not just three");
});

test("the image request carries each extra's shape and size", () => {
  const body = imageRequest({ type: "gemini", model: "m" }, { prompt: "p", references: [], aspectRatio: "2:3", imageSize: "2K" }) as any;
  assert.deepEqual(body.generationConfig.imageConfig, { aspectRatio: "2:3", imageSize: "2K" });
  assert.deepEqual((imageRequest({ type: "gemini", model: "m" }, { prompt: "p", references: [] }) as any).generationConfig.imageConfig, { aspectRatio: "16:9" }, "others unchanged");
});

test("rendering just the extras: each in its shape, the cast photo with every cast portrait", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-extras-"));
  const backend = new MockImageBackend();
  await renderArt(events, { runDir, backend, keys: [...Object.keys(KEY_ART), CAST_PHOTO_KEY] });
  const extras = backend.calls.filter((c) => c.imageSize === "2K");
  assert.deepEqual(extras.map((c) => c.aspectRatio).sort(), ["16:9", "1:1", "2:3", "3:2"]);
  const cast = extras.find((c) => c.prompt.includes("the cast posing"))!;
  assert.equal(cast.references.filter((r) => /Canonical look of a character/.test(r.label ?? "")).length, 4);
  assert.ok(!backend.calls.some((c) => c.prompt === "bo"), "shots not asked for aren't rendered");
});

test("key art renders after the cover it's drawn from, in the same run", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-extras-"));
  const backend = new MockImageBackend();
  await renderArt(events, { runDir, backend, keys: ["cover", ...Object.keys(KEY_ART)] });
  const order = backend.calls.filter((c) => c.prompt.startsWith("cover")).map((c) => (c.imageSize === "2K" ? "key" : "cover"));
  assert.deepEqual(order, ["cover", "key", "key", "key"]);
  assert.ok(backend.calls.filter((c) => c.imageSize === "2K").every((c) => /^THE image to reproduce/.test(c.references[0]?.label ?? "")), "each from the new cover");
});

test("key art is drawn from the rendered cover: that image is its one reference", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-extras-"));
  await renderArt(events, { runDir, backend: new MockImageBackend(), keys: ["cover"] });
  const backend = new MockImageBackend();
  await renderArt(events, { runDir, backend, keys: Object.keys(KEY_ART) });
  assert.equal(backend.calls.length, 3);
  assert.ok(backend.calls.every((c) => c.references.length === 1 && /^THE image to reproduce/.test(c.references[0].label ?? "")));
});

test("the art director's extras mode: both prompts, and only known characters in the cast", async () => {
  const bible: Bible = replay([]);
  bible.characters.ada = { id: "ada", name: "Ada", traits: "", goal: "", voice: "", status: "active" };
  let asked = "";
  const role: Role = { provider: { complete: async (req) => { asked = req.prompt; return JSON.stringify({ keyArt: " k ", castPhoto: "c", castCharacters: ["ada", "zed", "ada"] }); } } };
  const out = await artDirect(role, { bible, mode: "extras", beats: [{ location: "keep", goal: "hold", conflict: "siege" } as never], previousPrompts: [] });
  assert.deepEqual(out.result.extras, { keyArt: "k", castPhoto: "c", castCharacters: ["ada"] });
  assert.match(asked, /MODE: EXTRAS/);
  const bad: Role = { provider: { complete: async () => JSON.stringify({ keyArt: "k" }) } };
  await assert.rejects(artDirect(bad, { bible, mode: "extras", beats: [], previousPrompts: [] }), /no key art or cast photo/);
});

test("the extras get their own contact sheet, and the pitch counts four images until they're made", () => {
  const manifest = { "extra-keyart-2x3": { file: "a.png" }, "extra-cast": { file: "b.png" }, "scene-01-01": { file: "c.png" } } as unknown as ArtManifest;
  assert.deepEqual([...contactSheets(manifest, "extras", new Set(["extra-cast"]), "/art").entries()].map(([n, t]) => [n, t.map((x) => x.label)]), [["extras", ["✓ extra-cast", "extra-keyart-2x3"]]]);
  assert.ok(![...contactSheets(manifest, "shots", new Set(), "/art").keys()].includes("extras"), "not on the shots sheets");
  const before = pitch({ events: events.filter((e) => e.type !== "extras_art"), scenes: 1, art: { extrasOnly: true } });
  assert.equal(before.images.shots, 4);
  assert.equal(before.images.references, 0);
  // Rendered for their prompts: nothing to do, unless some are redone.
  const done = buildArtJobs(events).filter((j) => j.key.startsWith("extra-"));
  const artManifest = Object.fromEntries(done.map((j) => [j.key, { prompt: j.prompt }]));
  assert.equal(pitch({ events, scenes: 1, art: { extrasOnly: true }, artManifest }).images.shots, 0);
  assert.equal(pitch({ events, scenes: 1, art: { extrasOnly: true }, artManifest, redo: ["extra-keyart-2x3", "extra-keyart-16x9"] }).images.shots, 2, "a redo of two key-art shapes pitches two");
  assert.equal(pitch({ events, scenes: 1, art: { extrasOnly: true }, artManifest, redo: ["extras"] }).images.shots, 4);
});

test("the extras render only in their phase, and can override the story's look", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-extras-"));
  const plain = new MockImageBackend();
  await renderArt(events, { runDir, backend: plain });
  assert.ok(!plain.calls.some((c) => c.imageSize === "2K"), "a plain art run leaves the extras alone");
  const backend = new MockImageBackend();
  await renderArt(events, { runDir, backend, keys: [...Object.keys(KEY_ART), CAST_PHOTO_KEY], overrides: { [CAST_PHOTO_KEY]: { style: "A candid on-set photograph.", direction: "Everyone laughing." } } });
  const cast = backend.calls.find((c) => c.prompt.includes("the cast posing"))!;
  assert.equal(cast.style, "A candid on-set photograph.");
  assert.equal(cast.direction, "Everyone laughing.");
  assert.ok(cast.prompt.endsWith("A candid on-set photograph.") && !cast.prompt.includes("Gritty live-action"), "the story's style in the prompt is swapped for the override");
  const key = backend.calls.find((c) => c.aspectRatio === "2:3")!;
  assert.equal(key.style, "Gritty live-action film still.", "no override: the story's look");
  const again = new MockImageBackend();
  await renderArt(events, { runDir, backend: again, keys: [CAST_PHOTO_KEY], overrides: { [CAST_PHOTO_KEY]: { style: "A candid on-set photograph.", direction: "Everyone laughing." } } });
  assert.deepEqual(again.calls.filter((c) => c.imageSize === "2K"), [], "unchanged override: nothing redone");
});
