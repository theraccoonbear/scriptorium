import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAST_SHEET_LABEL, MockImageBackend, PORTRAIT_LABEL, magickCastSheet, renderArt } from "../src/artist.ts";
import type { ArtProgress } from "../src/artist.ts";
import { checkShotCast, mergeShotCast } from "../src/roles.ts";
import { inScene } from "../src/engine.ts";
import type { Role, StoryEvent } from "../src/types.ts";

// Issue #143: a character described in a shot but missing from its tags, or
// past the three-portrait cap, was drawn without their portrait — a stranger.

const ev = (seq: number, type: string, data: unknown): StoryEvent => ({ seq, type, ts: `t${seq}`, data });
const reply = (body: object): Role => ({ provider: { complete: async () => JSON.stringify(body) } } as unknown as Role);

test("the cast check names who each prompt describes, only known ids; merging keeps the art director's tags", async () => {
  const out = await checkShotCast(reply({ shots: [{ n: 1, characters: ["lemuel", "elf_woman", "nobody"] }, { n: 2, characters: [] }] }), {
    cast: [{ id: "lemuel", look: "stout ginger-bearded halfling" }, { id: "ivana", look: "wood elf in green" }, { id: "elf_woman", look: "silver-haired elf" }],
    shots: [{ n: 1, prompt: "a wood elf at the door; a ginger-bearded halfling dances with a silver-haired elf" }, { n: 2, prompt: "an empty road" }]
  });
  assert.deepEqual(out.result, { 1: ["lemuel", "elf_woman"], 2: [] });
  assert.deepEqual(mergeShotCast(["ivana"], out.result[1]), ["lemuel", "elf_woman", "ivana"], "who the prompt describes, then the tagged ones it didn't list");
  assert.deepEqual(mergeShotCast(["a", "b"], undefined), ["a", "b"], "no answer for a shot: its tags stand");
  assert.deepEqual(mergeShotCast([], ["a", "b", "c", "d", "e", "f", "g", "h", "i"]), ["a", "b", "c", "d", "e", "f", "g", "h"], "eight at most (they share a contact sheet)");
});

const fourPeople = (): StoryEvent[] => [
  ...["hellga", "riann", "osmagus", "lemuel"].map((id, k) => ev(k, "visual_ref", { kind: "character", id, appearance: id, prompt: `portrait ${id}` })),
  ev(4, "scene_art", { sceneIndex: 0, prompt: "x", shots: [{ startParagraph: 0, prompt: "breakfast", characters: ["hellga", "riann", "osmagus", "lemuel"] }] })
];

test("past the portrait limit, every character's portrait goes in one contact sheet", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-cast-"));
  const sheets: number[] = [];
  const backend = new MockImageBackend();
  await renderArt(fourPeople(), { runDir, backend, shrink: async (i) => i, castSheet: async (portraits) => { sheets.push(portraits.length); return { data: Buffer.from("sheet"), mimeType: "image/jpeg" }; } });
  const shot = backend.calls.find((c) => c.prompt === "breakfast")!;
  assert.deepEqual(sheets, [4], "all four portraits, on one sheet");
  assert.deepEqual(shot.references.filter((r) => r.label === CAST_SHEET_LABEL).length, 1);
  assert.equal(shot.references.filter((r) => r.label === PORTRAIT_LABEL).length, 0);
});

test("no sheet: the first three portraits, and a warning naming who was left out", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-cast-"));
  const events: ArtProgress[] = [];
  const backend = new MockImageBackend();
  await renderArt(fourPeople(), { runDir, backend, shrink: async (i) => i, castSheet: async () => { throw new Error("no magick"); }, onProgress: (e) => events.push(e) });
  const shot = backend.calls.find((c) => c.prompt === "breakfast")!;
  assert.equal(shot.references.filter((r) => r.label === PORTRAIT_LABEL).length, 3);
  assert.deepEqual(events.filter((e) => e.type === "portraits_dropped"), [{ type: "portraits_dropped", key: "scene-01-01", dropped: ["lemuel"] }]);
});

test("the ImageMagick contact sheet is one image of the portraits", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-cast-"));
  const { MockImageBackend: M } = await import("../src/artist.ts");
  const png = await new M().generate({ prompt: "p", references: [] });
  try {
    const sheet = await magickCastSheet([png, png, png, png], join(runDir, "art", ".sheets"));
    assert.equal(sheet.mimeType, "image/jpeg");
    assert.ok(sheet.data.length > 0);
  } catch (err) {
    if (/ENOENT/.test(String(err))) return;  // no ImageMagick here: covered by the fallback test
    throw err;
  }
});

test("only characters the scene's prose mentions can be added to its shots", () => {
  const prose = "Lemuel danced. The elf woman laughed. A half-orc woman watched from the bar.";
  assert.equal(inScene(prose, "lemuel", "Lemuel Braunschweiger"), true, "by first name");
  assert.equal(inScene(prose, "elf_woman", "Unknown Elf Woman"), true, "an unnamed part by its words");
  assert.equal(inScene(prose, "half_orc_woman", "Unknown Half-Orc Woman"), true);
  assert.equal(inScene(prose, "rebert", "Rebert Kyraus"), false, "a lookalike from another scene isn't added");
  assert.equal(inScene("Lemuelson spoke.", "lemuel", "Lemuel"), false, "whole words only");
});
