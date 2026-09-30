import { test } from "node:test";
import assert from "node:assert/strict";
import { assignVoices, buildScenes, parseScene } from "../src/audiobook.ts";
import type { StoryEvent } from "../src/types.ts";

test("parseScene falls back to a single narrator segment when untagged", () => {
  const prose = "Osmagus climbed the ridge as dusk closed in.\n\n\"The horn needed seeing,\" he said.";
  const scene = parseScene(0, prose, new Set(["osmagus"]));
  assert.equal(scene.tagged, false);
  assert.equal(scene.segments.length, 1);
  assert.equal(scene.segments[0].speaker, "narrator");
  assert.ok(scene.segments[0].text.includes("The horn needed seeing"));
});

test("parseScene splits tagged paragraphs by speaker", () => {
  const prose = [
    "narrator: Osmagus climbed the ridge as dusk closed in.",
    "osmagus: \"The horn needed seeing.\"",
    "narrator: He turned toward the gate."
  ].join("\n\n");
  const scene = parseScene(0, prose, new Set(["osmagus"]));
  assert.equal(scene.tagged, true);
  assert.deepEqual(scene.segments.map((s) => s.speaker), ["narrator", "osmagus", "narrator"]);
  assert.equal(scene.segments[1].text, '"The horn needed seeing."');
});

test("parseScene merges consecutive same-speaker paragraphs", () => {
  const prose = [
    "narrator: The ridge was cold.",
    "narrator: Dusk had nearly closed.",
    "osmagus: \"Enough waiting.\""
  ].join("\n\n");
  const scene = parseScene(0, prose, new Set(["osmagus"]));
  assert.equal(scene.segments.length, 2);
  assert.ok(scene.segments[0].text.includes("The ridge was cold"));
  assert.ok(scene.segments[0].text.includes("Dusk had nearly closed"));
});

test("parseScene ignores tag-shaped text for unknown speakers", () => {
  // "note:" isn't narrator and isn't a known bible id — treat the whole
  // paragraph as narration rather than silently dropping the prefix as a cue.
  const prose = "note: this looks like a tag but isn't a real speaker.";
  const scene = parseScene(0, prose, new Set(["osmagus"]));
  assert.equal(scene.tagged, false);
  assert.equal(scene.segments[0].speaker, "narrator");
});

test("parseScene strips leading heading markup", () => {
  const prose = "# The Horn\n\nOsmagus climbed the ridge.";
  const scene = parseScene(0, prose, new Set());
  assert.ok(!scene.segments[0].text.startsWith("#"));
  assert.ok(scene.segments[0].text.includes("The Horn"));
});

test("assignVoices is deterministic across calls", () => {
  const voices = ["af_heart", "af_bella", "am_adam", "bf_emma"];
  const a = assignVoices(["osmagus", "mettka"], voices);
  const b = assignVoices(["osmagus", "mettka"], voices);
  assert.deepEqual(a, b);
});

test("assignVoices reserves the narrator voice for characters when others exist", () => {
  const voices = ["af_heart", "af_bella", "am_adam"];
  const { narrator, characters } = assignVoices(["osmagus"], voices, "af_heart");
  assert.equal(narrator, "af_heart");
  assert.notEqual(characters.osmagus, "af_heart");
});

test("assignVoices avoids collisions when enough voices exist", () => {
  const voices = ["af_heart", "af_bella", "am_adam", "bf_emma", "bm_george"];
  const { characters } = assignVoices(["a", "b", "c", "d"], voices, "af_heart");
  const assigned = Object.values(characters);
  assert.equal(new Set(assigned).size, assigned.length, "expected distinct voices per character");
});

test("assignVoices falls back to the full pool when only the narrator voice exists", () => {
  const { narrator, characters } = assignVoices(["osmagus"], ["af_heart"], "af_heart");
  assert.equal(narrator, "af_heart");
  assert.equal(characters.osmagus, "af_heart");
});

test("buildScenes replays the bible to resolve known speaker ids", () => {
  const events: StoryEvent[] = [
    {
      seq: 0,
      type: "scene_committed",
      ts: "t0",
      data: {
        index: 0,
        patch: { upsertCharacters: [{ id: "osmagus", name: "Osmagus" }] },
        prose: "osmagus: \"The horn needed seeing.\""
      }
    }
  ];
  const scenes = buildScenes(events);
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].tagged, true);
  assert.equal(scenes[0].segments[0].speaker, "osmagus");
});
