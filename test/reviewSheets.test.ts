import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReel, contactSheets, formatCharacters, formatLegend, montageArgs } from "../src/reviewSheets.ts";
import { emptyBible } from "../src/bible.ts";
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

test("contact sheets: references split into characters, locations and props; shots one per scene, the cover on its own; approved marked", () => {
  const refs = contactSheets(manifest, "refs", new Set(["character-lemuel"]), "/run/art");
  assert.deepEqual([...refs.keys()], ["refs-characters", "refs-locations"]);
  assert.deepEqual(refs.get("refs-characters")!.map((t) => t.label), ["✓ character-lemuel"]);
  assert.deepEqual(refs.get("refs-locations")!.map((t) => t.label), ["location-ditch"]);
  assert.equal(refs.get("refs-characters")![0].file, "/run/art/character-lemuel.png");
  const shots = contactSheets(manifest, "shots", new Set(), "/run/art");
  assert.deepEqual([...shots.keys()], ["shots-scene-01", "shots-scene-02", "cover"]);
  assert.deepEqual(shots.get("shots-scene-01")!.map((t) => t.label), ["scene-01-01", "scene-01-02"]);
  const two = [...refs.get("refs-characters")!, ...refs.get("refs-locations")!];
  const args = montageArgs(two, "/run/review/refs-characters.jpg");
  assert.deepEqual(args.slice(0, 4), ["montage", "-label", "✓ character-lemuel", "/run/art/character-lemuel.png"]);
  assert.equal(args.at(-1), "/run/review/refs-characters.jpg");
  assert.ok(args.includes("2x"), "no wider than the tiles");
  assert.ok(args.includes("960x960>+12+12"), "tiles big enough to judge on a phone");
});

test("the voice reel: each voice announced, then its sample, two seconds apart; the legend names, voices and describes them", () => {
  const audio = (secs: number) => ({ samples: new Float32Array(10 * secs), sampleRate: 10 });
  const reel = buildReel([
    { id: "narrator", voice: "storyteller", audio: audio(3), slate: audio(1), name: "The narrator" },
    { id: "lemuel", voice: "algenib", audio: audio(2), slate: audio(1), name: "Lemuel Braunschweiger", source: "audition", description: "Early twenties, high rasping tenor" }
  ], new Set(["lemuel"]));
  // slate 1 + 0.6 + sample 3, gap 2, slate 1 + 0.6 + sample 2
  assert.equal(reel.audio.length, 10 * (1 + 0.6 + 3 + 2 + 1 + 0.6 + 2));
  assert.deepEqual(reel.legend.map((e) => [e.id, e.start, e.seconds, e.approved]), [["narrator", 0, 3, false], ["lemuel", 6.6, 2, true]]);
  assert.equal(formatLegend(reel.legend), "0:00  The narrator (voice:narrator) — storyteller\n0:06  ✓ Lemuel Braunschweiger (voice:lemuel) — algenib — audition line, not from the story\n       Early twenties, high rasping tenor");
});

test("the character sheet reads as one block per character: their words marked, the story's noted, blanks explained", () => {
  const bible = emptyBible();
  bible.characters.dookie = { id: "dookie", name: "Dookie", traits: "a lazy orange tabby", goal: "the catnip toy", voice: "", status: "active" };
  bible.characters.thief = { id: "thief", name: "The Thief", traits: "a raccoon in the rafters", goal: "", voice: "", status: "active" };
  const md = formatCharacters({ dookie: { appearance: "very round, heavy belly, orange tabby", vocal: "slow, grand, put-upon", voiced: true, reference: "drawings/dookie.png" } }, bible, "The Case of the Catnip Squeaker");
  assert.match(md, /^# The characters: The Case of the Catnip Squeaker/);
  assert.match(md, /## Dookie\n- \*\*Look:\*\* very round, heavy belly, orange tabby\n/);
  assert.match(md, /- \*\*Background:\*\* wants: the catnip toy \*\(from the story; fill it in to change it\)\*/);
  assert.match(md, /- \*\*Pictures and voice:\*\* a portrait; their own voice; drawn from your art: drawings\/dookie\.png/);
  assert.match(md, /## The Thief\n- \*\*Look:\*\* a raccoon in the rafters \*\(from the story/);
  assert.match(md, /- \*\*Sounds like:\*\* \*\(empty: the story decides\)\*/);
  assert.doesNotMatch(md, /[{}"]/, "no JSON in sight");
});
