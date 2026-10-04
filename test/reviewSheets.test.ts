import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReel, contactSheets, formatLegend, montageArgs } from "../src/reviewSheets.ts";
import type { ArtManifest } from "../src/artist.ts";

// Issue #84 part B: review files the author can look at on a phone.

const entry = (file: string, extra: object = {}) => ({ file, prompt: "p", finalPrompt: "p", attempts: 1, accepted: true, issues: [], ...extra });
const manifest = {
  "scene-02-01": entry("scene-02-01.png", { sceneIndex: 1 }),
  "location-ditch": entry("location-ditch.png", { refKind: "location", refId: "ditch" }),
  "character-lemuel": entry("character-lemuel.png", { refKind: "character", refId: "lemuel" }),
  "scene-01-02": entry("scene-01-02.png", { sceneIndex: 0 }),
  "scene-01-01": entry("scene-01-01.png", { sceneIndex: 0 }),
  cover: entry("cover.png")
} as ArtManifest;

test("contact sheets: references (characters first) in one, shots one per scene, the cover on its own; approved marked", () => {
  const refs = contactSheets(manifest, "refs", new Set(["character-lemuel"]), "/run/art");
  assert.deepEqual([...refs.keys()], ["refs"]);
  assert.deepEqual(refs.get("refs")!.map((t) => t.label), ["✓ character-lemuel", "location-ditch"]);
  assert.equal(refs.get("refs")![0].file, "/run/art/character-lemuel.png");
  const shots = contactSheets(manifest, "shots", new Set(), "/run/art");
  assert.deepEqual([...shots.keys()], ["shots-scene-01", "shots-scene-02", "cover"]);
  assert.deepEqual(shots.get("shots-scene-01")!.map((t) => t.label), ["scene-01-01", "scene-01-02"]);
  const args = montageArgs(refs.get("refs")!, "/run/review/refs.jpg");
  assert.deepEqual(args.slice(0, 4), ["montage", "-label", "✓ character-lemuel", "/run/art/character-lemuel.png"]);
  assert.equal(args.at(-1), "/run/review/refs.jpg");
  assert.ok(args.includes("2x"), "no wider than the tiles");
});

test("the voice reel puts every sample in one file, a second apart, with a legend of who speaks when", () => {
  const audio = (secs: number) => ({ samples: new Float32Array(10 * secs), sampleRate: 10 });
  const reel = buildReel([{ id: "narrator", voice: "storyteller", audio: audio(3) }, { id: "lemuel", voice: "algenib", audio: audio(2) }], new Set(["lemuel"]));
  assert.equal(reel.audio.length, 10 * (3 + 1 + 2));
  assert.deepEqual(reel.legend.map((e) => [e.id, e.start, e.seconds, e.approved]), [["narrator", 0, 3, false], ["lemuel", 4, 2, true]]);
  assert.equal(formatLegend(reel.legend, { lemuel: "Lemuel" }), "0:00  narrator — storyteller\n0:04  ✓ Lemuel — algenib");
});
