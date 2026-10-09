import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EDIT_LABEL, EDIT_WITH_LABEL, MockImageBackend, renderArt } from "../src/artist.ts";
import { make } from "../src/make.ts";
import type { StoryEvent } from "../src/types.ts";

// Issue #150: the key art (and cast photo) can be edited in place like a shot:
// Rantoul's key art shows a bald, bearded stranger where Rantoul should be.

const ev = (seq: number, type: string, data: unknown): StoryEvent => ({ seq, type, ts: `t${seq}`, data });
const events: StoryEvent[] = [
  ev(0, "visual_ref", { kind: "character", id: "rantoul", appearance: "vast monk", prompt: "portrait rantoul" }),
  ev(1, "scene_committed", { index: 0 }),
  ev(2, "scene_art", { sceneIndex: 0, prompt: "s1", shots: [{ startParagraph: 0, prompt: "s1" }] }),
  ev(3, "cover_art", { sceneCount: 1, prompt: "cover" }),
  ev(4, "extras_art", { keyArt: "the company on the road", castPhoto: "the cast", castCharacters: ["rantoul"] })
];
const same = async <T>(img: T) => img;

test("a key-art image is edited in place, with a portrait for the likeness", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-editx-"));
  const extras = ["extra-keyart-2x3", "extra-keyart-16x9", "extra-keyart-1x1", "extra-cast"];
  await renderArt(events, { runDir, backend: new MockImageBackend(), shrink: same, keys: extras });
  const backend = new MockImageBackend();
  const note = "Make the monk on the right enormously fat and clean-shaven, as in the reference portrait.";
  await renderArt(events, { runDir, backend, shrink: same, keys: extras, edits: { "extra-keyart-16x9": { note, with: ["character-rantoul"] } } });
  assert.equal(backend.calls.length, 1, "only the edited image");
  assert.equal(backend.calls[0].prompt, note);
  assert.deepEqual(backend.calls[0].references.map((r) => r.label), [EDIT_LABEL, EDIT_WITH_LABEL]);
});

test("make --edit takes the key art and cast photo in the extras phase, not mixed with shots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptorium-editx-"));
  const file = join(dir, "story.json");
  await writeFile(join(dir, "ctx.md"), "A road.");
  await writeFile(file, JSON.stringify({ config: join(new URL("..", import.meta.url).pathname, "story.config.json"), out: "run", context: "ctx.md", scenes: 1 }));
  await assert.rejects(make(file, { only: "art", edit: ["extra-keyart-16x9"], notes: "x" }), /extras phase \(--only extras\)/);
  await assert.rejects(make(file, { only: "extras", edit: ["extra-keyart-16x9", "scene-01-01"], notes: "x" }), /separate runs/);
  await assert.rejects(make(file, { only: "extras", edit: ["extra-logo"], notes: "x" }), /can be edited/);
});
