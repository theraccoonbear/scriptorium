import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPatch, emptyBible, renderBible, replay } from "../src/bible.ts";
import type { StoryEvent } from "../src/types.ts";

test("applyPatch records and dedupes resolved decisions", () => {
  const b1 = applyPatch(emptyBible(), { resolveDecisions: ["Osmagus stops playing"] }, 0);
  assert.deepEqual(b1.resolvedDecisions, ["Osmagus stops playing"]);
  const b2 = applyPatch(b1, { resolveDecisions: ["Osmagus stops playing", "Mettka commits to silence"] }, 1);
  assert.deepEqual(b2.resolvedDecisions, ["Osmagus stops playing", "Mettka commits to silence"]);
});

test("applyPatch ignores missing or empty decisions", () => {
  const b = applyPatch(emptyBible(), { timeline: "x" }, 0);
  assert.deepEqual(b.resolvedDecisions, []);
  const b2 = applyPatch(b, { resolveDecisions: ["", "settled"] }, 1);
  assert.deepEqual(b2.resolvedDecisions, ["settled"]);
});

test("replay preserves resolved decisions across scenes", () => {
  const events: StoryEvent[] = [
    { seq: 0, type: "scene_committed", ts: "t0", data: { index: 0, patch: { resolveDecisions: ["choice A"] } } },
    { seq: 1, type: "scene_committed", ts: "t1", data: { index: 1, patch: { resolveDecisions: ["choice B"] } } }
  ];
  const b = replay(events);
  assert.deepEqual(b.resolvedDecisions, ["choice A", "choice B"]);
});

test("renderBible surfaces resolved decisions for the director", () => {
  const text = renderBible(emptyBible());
  assert.ok(text.includes("RESOLVED DECISIONS"), "missing RESOLVED DECISIONS section");
  assert.ok(text.includes("(none)"));
  const b = applyPatch(emptyBible(), { resolveDecisions: ["he chooses not to play"] }, 0);
  const withDecision = renderBible(b);
  assert.ok(withDecision.includes("he chooses not to play"));
  assert.ok(withDecision.includes("do not re-litigate"), "missing anti-rehash guidance");
});

test("a recorded gender shows in the bible and can't be changed or erased by a later patch", () => {
  let b = emptyBible();
  b = applyPatch(b, { upsertCharacters: [{ id: "merta", name: "Merta", gender: "female" }] }, 0);
  assert.ok(renderBible(b).includes("- merta (Merta, female,"));
  b = applyPatch(b, { upsertCharacters: [{ id: "merta", gender: "male", status: "teaching" }] }, 1);
  b = applyPatch(b, { upsertCharacters: [{ id: "merta", gender: "" }] }, 2);
  assert.equal(b.characters.merta.gender, "female");
  assert.equal(b.characters.merta.status, "teaching");
  // An unknown gender can be filled in later.
  b = applyPatch(b, { upsertCharacters: [{ id: "krell", name: "Krell" }] }, 3);
  b = applyPatch(b, { upsertCharacters: [{ id: "krell", gender: "male" }] }, 4);
  assert.equal(b.characters.krell.gender, "male");
});

test("key objects are canon: shown in the bible, and a recorded description can't be rewritten", () => {
  let b = emptyBible();
  b = applyPatch(b, { upsertObjects: [{ id: "horn", name: "the alpenhorn", description: "Five feet long, an inch across at the mouthpiece." }] }, 0);
  assert.ok(renderBible(b).includes("KEY OBJECTS (physical descriptions are canon):\n- horn: the alpenhorn. Five feet long"));
  b = applyPatch(b, { upsertObjects: [{ id: "horn", description: "A short brass trumpet.", owner: "osmagus" }] }, 1);
  assert.equal(b.objects.horn.description, "Five feet long, an inch across at the mouthpiece.");
  assert.equal(b.objects.horn.owner, "osmagus");
  // Bibles from before objects existed replay with an empty set.
  const legacy = replay([{ seq: 0, type: "scene_committed", ts: "t", data: { index: 0, bible: { premise: "p", characters: {}, locations: {} }, patch: {} } }]);
  assert.deepEqual(legacy.objects, {});
});

test("the art style shows in the bible next to the tone", () => {
  const b = emptyBible();
  b.tone = "wry";
  assert.ok(!renderBible(b).includes("ART STYLE"));
  b.artStyle = "Ink and wash.";
  assert.ok(renderBible(b).includes("TONE: wry\n\nART STYLE: Ink and wash."));
});
