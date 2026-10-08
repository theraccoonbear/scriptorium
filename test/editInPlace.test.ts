import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EDIT_LABEL, EDIT_WITH_LABEL, MockImageBackend, renderArt } from "../src/artist.ts";
import type { ArtManifest } from "../src/artist.ts";
import { make } from "../src/make.ts";
import type { StoryEvent } from "../src/types.ts";

// Issue #141: a shot that's right but for one detail is edited in place — the
// image itself is the only reference and the note the only instruction —
// instead of redrawn from its prompt, which re-rolls everything else.

const ev = (seq: number, type: string, data: unknown): StoryEvent => ({ seq, type, ts: `t${seq}`, data });
const events = [
  ev(0, "scene_committed", { index: 0 }),
  ev(1, "scene_art", { sceneIndex: 0, prompt: "x", shots: [{ startParagraph: 0, prompt: "a halfling on a table, high-fiving his ghost" }] }),
  ev(2, "cover_art", { sceneCount: 1, prompt: "a montage" })
];
const same = async <T>(img: T) => img;
const manifestOf = async (runDir: string): Promise<ArtManifest> => JSON.parse(await readFile(join(runDir, "art", "art.json"), "utf8"));

test("an edit sends the image as the only reference with the note; the old image is kept and the prompt stays", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-edit-"));
  await renderArt(events, { runDir, backend: new MockImageBackend(), shrink: same });
  const before = await readFile(join(runDir, "art", "scene", "01", "01.png"));
  const backend = new MockImageBackend();
  const note = "move him down from the table onto the floor among the crowd";
  const out = await renderArt(events, { runDir, backend, shrink: same, keys: ["scene-01-01"], edits: { "scene-01-01": { note } } });
  assert.equal(out.rendered, 1);
  assert.equal(backend.calls.length, 1, "just the edit");
  const call = backend.calls[0];
  assert.equal(call.prompt, note);
  assert.equal(call.style, undefined, "the image carries the look; the style isn't restated");
  assert.deepEqual(call.references.map((r) => r.label), [EDIT_LABEL]);
  assert.deepEqual(Buffer.from(call.references[0].data), before, "the current image is what's edited");
  const kept = await readdir(join(runDir, "art", "previous", "scene-01-01"));
  assert.equal(kept.length, 1, "the image it replaced is kept");
  const m = await manifestOf(runDir);
  assert.equal(m["scene-01-01"].prompt, "a halfling on a table, high-fiving his ghost", "the shot's prompt is kept");
  assert.deepEqual(m["scene-01-01"].edits!.map((e) => e.note), [note]);
  const again = new MockImageBackend();
  await renderArt(events, { runDir, backend: again, shrink: same });
  assert.equal(again.calls.length, 0, "an edited image isn't seen as out of date");
});

test("--source edits an earlier take instead of the current image", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-edit-"));
  await renderArt(events, { runDir, backend: new MockImageBackend(), shrink: same });
  await mkdir(join(runDir, "art", "previous", "scene-01-01"), { recursive: true });
  const source = join("art", "previous", "scene-01-01", "first-take.png");
  await writeFile(join(runDir, source), "the take the author liked");
  const backend = new MockImageBackend();
  await renderArt(events, { runDir, backend, shrink: same, keys: ["scene-01-01"], edits: { "scene-01-01": { note: "move him onto the floor", source } } });
  assert.equal(String(backend.calls[0].references[0].data), "the take the author liked");
  assert.equal((await manifestOf(runDir))["scene-01-01"].edits![0].source, source);
});

test("--with passes other images (a portrait, another shot) as likeness references after the image", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-edit-"));
  await renderArt(events, { runDir, backend: new MockImageBackend(), shrink: same });
  const backend = new MockImageBackend();
  await renderArt(events, { runDir, backend, shrink: same, keys: ["scene-01-01"], edits: { "scene-01-01": { note: "dress him as on the cover", with: ["cover"] } } });
  assert.deepEqual(backend.calls[0].references.map((r) => r.label), [EDIT_LABEL, EDIT_WITH_LABEL]);
  assert.deepEqual((await manifestOf(runDir))["scene-01-01"].edits![0].with, ["cover"]);
  await assert.rejects(renderArt(events, { runDir, backend: new MockImageBackend(), shrink: same, keys: ["scene-01-01"], edits: { "scene-01-01": { note: "x", with: ["character-nobody"] } } }), /no such image/);
});

test("an approved image isn't edited until the approval is revoked", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-edit-"));
  await renderArt(events, { runDir, backend: new MockImageBackend(), shrink: same });
  await assert.rejects(renderArt(events, { runDir, backend: new MockImageBackend(), shrink: same, approved: new Set(["scene-01-01"]), keys: ["scene-01-01"], edits: { "scene-01-01": { note: "x" } } }), /approved/);
});

test("make --edit needs a note, a shot or the cover, the art step, and its own run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptorium-edit-"));
  const file = join(dir, "story.json");
  await writeFile(join(dir, "ctx.md"), "A tavern.");
  await writeFile(file, JSON.stringify({ config: join(new URL("..", import.meta.url).pathname, "story.config.json"), out: "run", context: "ctx.md", scenes: 1 }));
  await assert.rejects(make(file, { only: "art", edit: ["scene-01-01"] }), /--edit needs --note/);
  await assert.rejects(make(file, { only: "art", edit: ["character:nell"], notes: "x" }), /only shots/);
  await assert.rejects(make(file, { only: "audiobook", edit: ["scene-01-01"], notes: "x" }), /art step/);
  await assert.rejects(make(file, { only: "art", edit: ["scene-01-01"], redo: ["scene-01-02"], notes: "x" }), /separate runs/);
  await assert.rejects(make(file, { only: "art", source: "art/previous/x.jpg" }), /--source goes with --edit/);
  await assert.rejects(make(file, { only: "art", with: ["character-nell"] }), /--with goes with --edit/);
});
