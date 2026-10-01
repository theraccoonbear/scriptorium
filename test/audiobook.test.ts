import { test } from "node:test";
import assert from "node:assert/strict";
import { assignVoices, normalizeGender, parseVoiceGenders, buildScenes, filterVoicesByLanguage, findUntaggedParagraphs, parseScene, sceneParagraphs, stripSpeakerTags, synthesizeScene } from "../src/audiobook.ts";
import type { Synthesize } from "../src/audiobook.ts";
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

test("parseScene routes attribution and action inside a character paragraph to the narrator", () => {
  // The exact bug this guards against: a character-tagged paragraph that
  // mixes narration ("he called", action beats) with their actual quoted
  // words. Only the quoted text should be voiced as that character —
  // attribution is never inside the quote marks in standard prose, so the
  // narrator/dialogue boundary is mechanical, not a judgment call.
  const prose = 'riggins: "Mango," he called. "Stop."';
  const scene = parseScene(0, prose, new Set(["riggins"]));
  assert.deepEqual(
    scene.segments.map((s) => [s.speaker, s.text]),
    [
      ["riggins", '"Mango,"'],
      ["narrator", "he called."],
      ["riggins", '"Stop."']
    ]
  );
});

test("parseScene keeps a pure-dialogue character paragraph as one segment", () => {
  const prose = 'mango: "What? Did you see something?"';
  const scene = parseScene(0, prose, new Set(["mango"]));
  assert.deepEqual(scene.segments, [{ speaker: "mango", text: '"What? Did you see something?"', paragraphs: [0] }]);
});

test("parseScene sends a narrator-tagged paragraph entirely to narrator even if it contains quotes", () => {
  const prose = 'narrator: The sign read "No Entry" above the door.';
  const scene = parseScene(0, prose, new Set());
  assert.deepEqual(scene.segments, [{ speaker: "narrator", text: 'The sign read "No Entry" above the door.', paragraphs: [0] }]);
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

test("filterVoicesByLanguage keeps only matching-language voices", () => {
  const voices = {
    af_heart: { language: "en-us" },
    bf_emma: { language: "en-gb" },
    jf_alpha: { language: "ja" },
    zf_xiaobei: { language: "zh" }
  };
  assert.deepEqual(filterVoicesByLanguage(voices, "en"), ["af_heart", "bf_emma"]);
  assert.deepEqual(filterVoicesByLanguage(voices, "ja"), ["jf_alpha"]);
});

test("filterVoicesByLanguage returns empty for an unmatched prefix", () => {
  const voices = { af_heart: { language: "en-us" } };
  assert.deepEqual(filterVoicesByLanguage(voices, "fr"), []);
});

test("stripSpeakerTags recovers plain book prose from tagged paragraphs", () => {
  const prose = [
    'narrator: Osmagus climbed the ridge as dusk closed in.',
    'osmagus: "The horn needed seeing," he said. "Stop."',
    "narrator: He turned toward the gate."
  ].join("\n\n");
  const clean = stripSpeakerTags(prose, new Set(["osmagus"]));
  assert.equal(
    clean,
    [
      "Osmagus climbed the ridge as dusk closed in.",
      '"The horn needed seeing," he said. "Stop."',
      "He turned toward the gate."
    ].join("\n\n")
  );
});

test("stripSpeakerTags passes untagged prose through unchanged", () => {
  const prose = "Just an ordinary paragraph.\n\nAnother one.";
  assert.equal(stripSpeakerTags(prose, new Set()), prose);
});

test("findUntaggedParagraphs flags paragraphs without a known tag", () => {
  const prose = [
    "narrator: Fine, tagged.",
    "This paragraph has no tag at all.",
    "osmagus: Also fine."
  ].join("\n\n");
  const untagged = findUntaggedParagraphs(prose, new Set(["osmagus"]));
  assert.deepEqual(untagged, ["This paragraph has no tag at all."]);
});

test("findUntaggedParagraphs returns nothing when every paragraph is tagged", () => {
  const prose = ["narrator: Fine.", "osmagus: Also fine."].join("\n\n");
  assert.deepEqual(findUntaggedParagraphs(prose, new Set(["osmagus"])), []);
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

// --- issue #23: paragraph numbering shared with the art director, and timings ---
test("segments record which scene paragraphs they cover, through merges and quote splits", () => {
  const known = new Set(["osmagus"]);
  const prose = [
    "narrator: The ridge was cold.",
    'osmagus: "Hold," he said.',
    "narrator: Dusk had nearly closed.",
    'osmagus: "Now."'
  ].join("\n\n");
  const scene = parseScene(0, prose, known);
  assert.deepEqual(scene.segments.map((s) => [s.speaker, s.paragraphs]), [
    ["narrator", [0]],
    ["osmagus", [1]],
    ["narrator", [1, 2]],
    ["osmagus", [3]]
  ]);
  const untagged = parseScene(0, "One.\n\nTwo.\n\nThree.", known);
  assert.deepEqual(untagged.segments[0].paragraphs, [0, 1, 2]);
});

test("sceneParagraphs numbers paragraphs the way the audiobook reads them", () => {
  const known = new Set(["osmagus"]);
  const prose = '# The Horn\n\nnarrator: The ridge was cold.\n\nosmagus: "Hold," he said.\n\nunknown: stays as-is';
  assert.deepEqual(sceneParagraphs(prose, known), ["The Horn", "The ridge was cold.", '"Hold," he said.', "unknown: stays as-is"]);
  assert.equal(sceneParagraphs(prose, known).length, parseScene(0, prose, known).segments.flatMap((s) => s.paragraphs).at(-1)! + 1);
});

test("synthesizeScene reports each paragraph's start time in the scene audio", async () => {
  const known = new Set(["osmagus"]);
  const prose = ["narrator: One two.", 'osmagus: "Three," he said.', "narrator: Four."].join("\n\n");
  const scene = parseScene(0, prose, known);
  // Fake TTS: 0.1s of audio (2400 samples at 24kHz) per character.
  const voices: string[] = [];
  const synth: Synthesize = async function* (text, voice) {
    voices.push(voice);
    yield { text, audio: new Float32Array(text.length * 2400) };
  };
  const { audio, paragraphStarts } = await synthesizeScene(scene, (s) => (s === "narrator" ? "n" : "o"), synth);
  // Pieces: "One two." (8) | '"Three,"' (8) | "he said." (8) | "Four." (5)
  assert.deepEqual(paragraphStarts, [0, 0.8, 2.4]);
  assert.equal(audio.length, (8 + 8 + 8 + 5) * 2400);
  assert.deepEqual(voices, ["n", "o", "n", "n"]);
});

// --- issue #27: voices match a character's known gender ---
const VOICE_GENDERS = { af_heart: "Female", af_bella: "Female", af_nicole: "Female", am_adam: "Male", am_michael: "Male", bm_george: "Male" };
const ALL_VOICES = Object.keys(VOICE_GENDERS);

test("a character with a known gender gets a voice of that gender", () => {
  for (const id of ["osmagus", "merta", "krell", "a", "bb", "ccc"]) {
    for (const g of ["female", "male"] as const) {
      const { characters, genders } = assignVoices([id], ALL_VOICES, "af_heart", { genders: { [id]: g }, voiceGenders: VOICE_GENDERS });
      assert.equal(normalizeGender(VOICE_GENDERS[characters[id] as keyof typeof VOICE_GENDERS]), g, `${id} (${g}) got ${characters[id]}`);
      assert.equal(genders[id], g);
    }
  }
});

test("known genders pick first, so unspecified characters can't take the last same-gender voice", () => {
  // Narrator takes af_heart, leaving two female voices; three characters are female.
  const genders = { merta: "female", ada: "female", zed: undefined };
  const { characters } = assignVoices(["zed", "merta", "ada"], ALL_VOICES, "af_heart", { genders, voiceGenders: VOICE_GENDERS });
  assert.ok(characters.merta.startsWith("af_") && characters.ada.startsWith("af_"));
  assert.notEqual(characters.merta, characters.ada);
});

test("when the gender pool runs out, characters share a same-gender voice rather than switch gender", () => {
  const genders = { a: "male", b: "male", c: "male", d: "male" };
  const { characters } = assignVoices(["a", "b", "c", "d"], ALL_VOICES, "af_heart", { genders, voiceGenders: VOICE_GENDERS });
  assert.ok(Object.values(characters).every((v) => v.startsWith("am_") || v.startsWith("bm_")), JSON.stringify(characters));
  assert.equal(new Set(Object.values(characters)).size, 3);
});

test("unknown gender or no voice of that gender falls back to any voice", () => {
  const onlyFemale = { af_heart: "Female", af_bella: "Female" };
  const { characters, genders } = assignVoices(["osmagus", "x"], Object.keys(onlyFemale), "af_heart", { genders: { osmagus: "male", x: "nonbinary" }, voiceGenders: onlyFemale });
  assert.equal(characters.osmagus, "af_bella");
  assert.deepEqual(genders, {});
  // Without any gender info, assignment is unchanged from before (deterministic, distinct).
  const plain = assignVoices(["a", "b"], ALL_VOICES, "af_heart");
  assert.deepEqual(plain.genders, {});
  assert.notEqual(plain.characters.a, plain.characters.b);
});

test("normalizeGender and --voice-gender parsing", () => {
  assert.equal(normalizeGender("Female"), "female");
  assert.equal(normalizeGender(" MAN "), "male");
  assert.equal(normalizeGender("nonbinary"), undefined);
  assert.equal(normalizeGender(""), undefined);
  assert.deepEqual(parseVoiceGenders("osmagus=male, merta=female"), { osmagus: "male", merta: "female" });
  assert.deepEqual(parseVoiceGenders(undefined), {});
  assert.throws(() => parseVoiceGenders("osmagus"), /id=gender/);
  assert.throws(() => parseVoiceGenders("osmagus=tall"), /not female or male/);
});

test("the TTS model cache is shared outside the repo, overridable", async () => {
  const { modelCacheDir } = await import("../src/audiobook.ts");
  assert.equal(modelCacheDir({ SCRIPTORIUM_MODEL_CACHE: "/models" }), "/models");
  assert.equal(modelCacheDir({ XDG_CACHE_HOME: "/xdg" }), "/xdg/scriptorium/models");
  assert.ok(modelCacheDir({}).endsWith("/.cache/scriptorium/models"));
  assert.ok(!modelCacheDir({}).includes("node_modules"));
});
