import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockImageBackend, buildArtJobs, formatReshoot, renderArt, staleShots } from "../src/artist.ts";
import type { ArtManifest } from "../src/artist.ts";
import type { StoryEvent } from "../src/types.ts";

// Issue #100: reshoots. A shot remembers the reference images it was drawn
// from; when one changes, that shot (and only it) is out of date.

const ev = (seq: number, type: string, data: unknown): StoryEvent => ({ seq, type, ts: `t${seq}`, data });
const events: StoryEvent[] = [
  ev(0, "visual_ref", { kind: "character", id: "ada", appearance: "a", prompt: "portrait ada" }),
  ev(1, "visual_ref", { kind: "character", id: "bo", appearance: "b", prompt: "portrait bo" }),
  ev(2, "scene_art", { sceneIndex: 0, prompt: "s1", shots: [
    { startParagraph: 0, prompt: "ada alone", characters: ["ada"] },
    { startParagraph: 3, prompt: "bo alone", characters: ["bo"] },
    { startParagraph: 6, prompt: "nobody", characters: [] }
  ] })
];
const run = (backend: MockImageBackend, runDir: string, extra: object = {}, evs = events) => renderArt(evs, { runDir, backend, ...extra });
const manifestOf = async (runDir: string): Promise<ArtManifest> => JSON.parse(await readFile(join(runDir, "art", "art.json"), "utf8"));

test("a shot records the reference images it was drawn from", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-reshoot-"));
  await run(new MockImageBackend(), runDir);
  const m = await manifestOf(runDir);
  assert.deepEqual(Object.keys(m["scene-01-01"].refs ?? {}), ["character-ada"]);
  assert.deepEqual(Object.keys(m["scene-01-02"].refs ?? {}), ["character-bo"]);
  assert.deepEqual(m["scene-01-03"].refs, {}, "a shot with no references records none");
  assert.equal(m["character-ada"].refs, undefined, "references themselves don't");
});

test("a changed reference makes only the shots drawn from it out of date; the next art run reshoots them, approved ones stay with a warning", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-reshoot-"));
  await run(new MockImageBackend(), runDir);
  assert.deepEqual(await staleShots(events, runDir), []);
  // Ada's portrait is remade (a new image at the same file).
  const m = await manifestOf(runDir);
  await writeFile(join(runDir, "art", m["character-ada"].file), "a new ada");
  assert.deepEqual(await staleShots(events, runDir), [{ key: "scene-01-01", refs: ["character-ada"], approved: false }]);
  assert.match(formatReshoot(await staleShots(events, runDir), true), /scene-01: 01 ← character-ada\n1 shot to reshoot, ~\$0\.0\d \(batch\)/);

  const again = new MockImageBackend();
  await run(again, runDir, { approved: new Set(["character-ada"]) });
  assert.deepEqual(again.calls.map((c) => c.prompt), ["ada alone"], "only the shot drawn from her");
  assert.deepEqual(await staleShots(events, runDir), [], "and it's current again");

  // Approved shots stay, and say so.
  await writeFile(join(runDir, "art", m["character-bo"].file), "a new bo");
  const warned: string[] = [];
  const locked = new MockImageBackend();
  await run(locked, runDir, { approved: new Set(["character-ada", "character-bo", "scene-01-02"]), onProgress: (e: { type: string; key?: string }) => { if (e.type === "stale_approved") warned.push(e.key!); } });
  assert.deepEqual(locked.calls, []);
  assert.deepEqual(warned, ["scene-01-02"]);
  assert.match(formatReshoot(await staleShots(events, runDir, new Set(["scene-01-02"])), false), /02 \(approved — stays\) ← character-bo[\s\S]*0 shots to reshoot[\s\S]*1 approved stay/);
});

test("a re-planned shot that uses different references is a new prompt, not a reshoot", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-reshoot-"));
  await run(new MockImageBackend(), runDir);
  const replanned = [...events, ev(3, "scene_art", { sceneIndex: 0, prompt: "s1", shots: [{ startParagraph: 0, prompt: "ada alone", characters: ["bo"] }, { startParagraph: 3, prompt: "bo alone", characters: ["bo"] }] })];
  assert.deepEqual(await staleShots(replanned, runDir), [], "its old reference didn't change");
});

test("shots made before inputs were recorded take today's references as their baseline", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-reshoot-"));
  await run(new MockImageBackend(), runDir);
  const m = await manifestOf(runDir);
  delete m["scene-01-01"].refs;
  await writeFile(join(runDir, "art", "art.json"), JSON.stringify(m));
  const quiet = new MockImageBackend();
  await run(quiet, runDir);
  assert.deepEqual(quiet.calls, [], "nothing re-rendered");
  assert.deepEqual(Object.keys((await manifestOf(runDir))["scene-01-01"].refs ?? {}), ["character-ada"], "baseline recorded");
});

test("a shot can be redone by key, and the author's note rides with its prompt", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-reshoot-"));
  await run(new MockImageBackend(), runDir);
  const forced = new MockImageBackend();
  await run(forced, runDir, { redoKeys: ["scene-01-03"] });
  assert.deepEqual(forced.calls.map((c) => c.prompt), ["nobody"]);
  const noted = [...events, ev(3, "shot_note", { key: "scene-01-02", note: "Lying flat, seen from above." })];
  assert.match(buildArtJobs(noted).find((j) => j.key === "scene-01-02")!.prompt, /bo alone\n\nAUTHOR NOTE — a correction for this shot: Lying flat, seen from above\./);
  const again = new MockImageBackend();
  await run(again, runDir, {}, noted);
  assert.deepEqual(again.calls.map((c) => c.prompt.split("\n")[0]), ["bo alone"], "a new note is a new prompt: that shot is redone");
});
