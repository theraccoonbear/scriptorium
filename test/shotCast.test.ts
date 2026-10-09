import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockImageBackend, PORTRAIT_LABEL, renderArt } from "../src/artist.ts";
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

const people = (n: number): StoryEvent[] => {
  const ids = Array.from({ length: n }, (_, k) => `p${k + 1}`);
  return [
    ...ids.map((id, k) => ev(k, "visual_ref", { kind: "character", id, appearance: id, prompt: `portrait ${id}` })),
    ev(n, "scene_art", { sceneIndex: 0, prompt: "x", shots: [{ startParagraph: 0, prompt: "the company", characters: ids }] })
  ];
};

test("each character's own portrait, as the cast photo does: four people, four portraits", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-cast-"));
  const backend = new MockImageBackend();
  await renderArt(people(4), { runDir, backend, shrink: async (i) => i });
  assert.equal(backend.calls.find((c) => c.prompt === "the company")!.references.filter((r) => r.label === PORTRAIT_LABEL).length, 4);
});

test("past 8 people, the 8 most prominent get portraits and the rest are named in a warning", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-cast-"));
  const events: ArtProgress[] = [];
  const backend = new MockImageBackend();
  await renderArt(people(10), { runDir, backend, shrink: async (i) => i, onProgress: (e) => events.push(e) });
  assert.equal(backend.calls.find((c) => c.prompt === "the company")!.references.filter((r) => r.label === PORTRAIT_LABEL).length, 8);
  assert.deepEqual(events.filter((e) => e.type === "portraits_dropped"), [{ type: "portraits_dropped", key: "scene-01-01", dropped: ["p9", "p10"] }]);
});

test("only characters the scene's prose mentions can be added to its shots", () => {
  const prose = "Lemuel danced. The elf woman laughed. A half-orc woman watched from the bar.";
  assert.equal(inScene(prose, "lemuel", "Lemuel Braunschweiger"), true, "by first name");
  assert.equal(inScene(prose, "elf_woman", "Unknown Elf Woman"), true, "an unnamed part by its words");
  assert.equal(inScene(prose, "half_orc_woman", "Unknown Half-Orc Woman"), true);
  assert.equal(inScene(prose, "rebert", "Rebert Kyraus"), false, "a lookalike from another scene isn't added");
  assert.equal(inScene("Lemuelson spoke.", "lemuel", "Lemuel"), false, "whole words only");
});

test("the cover shows who its prompt describes (the cast check), all of them, and no most-used place", async () => {
  const { buildArtJobs } = await import("../src/artist.ts");
  const refs = ["lemuel", "hellga", "ivana", "riann", "liam", "rantoul", "oglesby"].map((id, k) => ev(k, "visual_ref", { kind: "character", id, appearance: id, prompt: `portrait ${id}` }));
  const base = [...refs, ev(10, "visual_ref", { kind: "location", id: "tavern", appearance: "a tavern", prompt: "tavern" }),
    ev(11, "scene_art", { sceneIndex: 0, prompt: "x", shots: [{ startParagraph: 0, prompt: "x", characters: ["ivana"], location: "tavern" }] })];
  const old = buildArtJobs([...base, ev(12, "cover_art", { sceneCount: 1, prompt: "the company on the road" })]).find((j) => j.key === "cover")!;
  assert.equal(old.location, "tavern", "a cover planned before the check keeps the old picks");
  const cover = buildArtJobs([...base, ev(12, "cover_art", { sceneCount: 1, prompt: "the company on the road", characters: ["lemuel", "hellga", "ivana", "riann", "liam", "rantoul", "oglesby"] })]).find((j) => j.key === "cover")!;
  assert.deepEqual([cover.characters, cover.location, cover.maxPortraits], [["lemuel", "hellga", "ivana", "riann", "liam", "rantoul", "oglesby"], undefined, 8]);
});

test("the cover's leads: the title character first, then the most present; four at most", async () => {
  const { coverLeads } = await import("../src/engine.ts");
  const bible = { characters: { rantoul: { name: "Rantoul Hayworth" }, lemuel: { name: "Lemuel" }, hellga: { name: "Hellga" }, ivana: { name: "Ivana" }, riann: { name: "Riann" } } } as never;
  const events: StoryEvent[] = [ev(0, "scene_art", { sceneIndex: 0, prompt: "x", shots: [
    { startParagraph: 0, prompt: "a", characters: ["lemuel", "hellga"] }, { startParagraph: 1, prompt: "b", characters: ["lemuel", "ivana"] },
    { startParagraph: 2, prompt: "c", characters: ["lemuel", "hellga", "riann"] }, { startParagraph: 3, prompt: "d", characters: ["ivana", "rantoul"] }
  ] })];
  assert.deepEqual(coverLeads(events, bible, "Rantoul's Mushrooms"), ["rantoul", "lemuel", "hellga", "ivana"]);
  assert.deepEqual(coverLeads(events, bible), ["lemuel", "hellga", "ivana", "rantoul"], "no title: the most present");
});

test("the blocking brief: a head count, each person once and placed, no names; the people go most important first", async () => {
  const { BLOCKING_SYSTEM, blockGroupPicture } = await import("../src/roles.ts");
  assert.match(BLOCKING_SYSTEM, /head count, first/);
  assert.match(BLOCKING_SYSTEM, /appears once/);
  assert.match(BLOCKING_SYSTEM, /Never use names/);
  const out = await blockGroupPicture(reply({ prompt: " Four figures: … " }) as never, { prompt: "the company on the road", people: [{ id: "a", look: "a vast monk" }, { id: "b", look: "a ginger halfling" }] });
  assert.equal(out.result, "Four figures: …");
});

test("the cover's blocking is checked: a lead left out, or the lead not leading, goes back once with the note", async () => {
  const { blockCover } = await import("../src/engine.ts");
  const looks = { rantoul: "a vast monk", lemuel: "a ginger halfling", ivana: "a wood elf", oglesby: "a lanky friar" };
  // Replies in order: blocking, cast check, blocking, cast check.
  const scripted = (replies: object[]) => {
    const prompts: string[] = [];
    const role = { provider: { complete: async (req: { prompt?: string; messages?: { content: string }[] }) => {
      prompts.push(JSON.stringify(req));
      return JSON.stringify(replies.shift());
    } } } as unknown as Role;
    return { role, prompts };
  };
  // First try leaves the monk on the bench behind the halfling: sent back, then right.
  const a = scripted([{ prompt: "v1" }, { shots: [{ n: 1, characters: ["lemuel", "rantoul", "ivana"] }] }, { prompt: "v2" }, { shots: [{ n: 1, characters: ["rantoul", "lemuel", "ivana"] }] }]);
  assert.equal(await blockCover(a.role, "the road. STYLE", ["rantoul", "lemuel", "ivana"], looks, "STYLE"), "v2 STYLE");
  assert.match(a.prompts[2], /LEAD: the first person/);
  assert.match(a.prompts[2], /YOUR LAST VERSION: the lead \(a vast monk\) isn't the main figure/);
  // Right first time: one blocking pass, one check.
  const b = scripted([{ prompt: "v1" }, { shots: [{ n: 1, characters: ["rantoul", "lemuel", "ivana", "oglesby"] }] }]);
  assert.equal(await blockCover(b.role, "the road", ["rantoul", "lemuel", "ivana"], looks), "v1");
  assert.equal(b.prompts.length, 2);
  // Wrong twice: keep the version that missed less.
  const c = scripted([{ prompt: "v1" }, { shots: [{ n: 1, characters: ["lemuel"] }] }, { prompt: "v2" }, { shots: [{ n: 1, characters: ["rantoul", "lemuel"] }] }]);
  assert.equal(await blockCover(c.role, "the road", ["rantoul", "lemuel", "ivana"], looks), "v2");
  assert.match(c.prompts[2], /left out: a vast monk; left out: a wood elf/);
});
