import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cuesToMake, layStretches, partKey, trackFilterGraph, trackSpans } from "../src/music.ts";
import type { MusicTools } from "../src/music.ts";
import { encodeWav } from "../src/geminiBatch.ts";
import { decodeWav } from "../src/geminiTts.ts";
import { audioFilterGraph, buildTimeline, musicInputs, stretchPlan } from "../src/video.ts";
import type { Timings } from "../src/video.ts";
import { creditPages } from "../src/titles.ts";
import { loadStoryFile } from "../src/make.ts";
import type { ArtManifest } from "../src/artist.ts";

// Issue #174: the author's own music, each piece over a stretch of the film.

test("part names put the film in order; a stretch is a range of them, checked", () => {
  const order = ["rating", "opening", "crawl", "card 1", "scene 1", "card 2", "scene 2", "end", "credits", "next"].map(partKey);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.equal(partKey("Scene 10"), partKey("scene10"));
  assert.throws(() => partKey("intermission"), /unknown part "intermission"/);
  assert.throws(() => trackSpans([{ file: "a.mp3", from: "scene 3", to: "scene 1" }]), /track 1 \(a.mp3\): "scene 1" comes before "scene 3"/);
  assert.throws(() => trackSpans([{ file: "a.mp3", from: "opening", to: "scene 1" }, { file: "b.mp3", from: "card 1" }]), /tracks 1 and 2 both cover the same part/);
  assert.deepEqual(trackSpans([{ file: "a.mp3", from: "credits" }]).map((s) => [s.from, s.to]), [[partKey("credits"), partKey("credits")]], "to defaults to from");
});

test("the author's tracks stand in for the cues they cover; generate: false makes none", () => {
  const cues = [{ id: "theme" }, { id: "scene-01" }, { id: "scene-02" }, { id: "scene-03" }];
  const tavern = { file: "t.mp3", from: "scene 2" };
  assert.deepEqual(cuesToMake(cues, { tracks: [tavern] }).map((q) => q.id), ["theme", "scene-01", "scene-03"]);
  // The opening alone keeps the theme for the ending; the opening and the ending both, and it's not made.
  assert.ok(cuesToMake(cues, { tracks: [{ file: "o.mp3", from: "rating", to: "crawl" }] }).some((q) => q.id === "theme"));
  assert.ok(!cuesToMake(cues, { tracks: [{ file: "o.mp3", from: "rating", to: "crawl" }, { file: "e.mp3", from: "end", to: "next" }] }).some((q) => q.id === "theme"));
  assert.deepEqual(cuesToMake(cues, { generate: false, tracks: [tavern] }), []);
});

const manifest: ArtManifest = {
  "scene-01-01": { file: "a.jpg", prompt: "a", finalPrompt: "a", attempts: 1, accepted: true, issues: [], sceneIndex: 0, startParagraph: 0 },
  "scene-02-01": { file: "b.jpg", prompt: "b", finalPrompt: "b", attempts: 1, accepted: true, issues: [], sceneIndex: 1, startParagraph: 0 },
  cover: { file: "c.jpg", prompt: "c", finalPrompt: "c", attempts: 1, accepted: true, issues: [] }
};
const timings: Timings = { sampleRate: 24000, scenes: [{ index: 0, file: "scene-01.wav", durationSec: 30, paragraphStarts: [0] }, { index: 1, file: "scene-02.wav", durationSec: 20, paragraphStarts: [0] }] };
const titles = { title: "T", sceneCards: true, sceneTitles: {}, ending: "The End", credits: [["x"]], font: "f", titleFont: "f", crawl: ["Once."] };

test("each track covers its parts of the film, with where the voice is in each", () => {
  const tracks = [{ file: "/m/overture.mp3", from: "opening", to: "card 1" }, { file: "/m/tavern.mp3", from: "scene 2" }, { file: "/m/fanfare.mp3", from: "rating" }];
  const tl = buildTimeline(manifest, timings, { titles: { ...titles, narration: "video/title.wav" }, narrationSec: 3, music: { beds: {}, duck: 19, tracks, voiceLufs: -24 } });
  assert.deepEqual(tl.parts.map((p) => p.kind), ["intro", "crawl", "card", "scene", "card", "scene", "end", "credits"]);
  const plan = stretchPlan(tl);
  assert.deepEqual(plan.stretches.map((s) => [s.index, s.from, s.to]), [[0, 0, 2], [1, 5, 5]], "opening, crawl and scene 1's card; scene 2");
  assert.deepEqual(plan.stretches[0].parts[0].windows, [[1.8, 4.8]], "the narrated title");
  assert.equal(plan.stretches[1].parts[0].speech, tl.scenes[1].audio, "the scene's narration");
  assert.match(plan.unused[0], /track 3 \(rating\) covers no part of this film/, "no rating card here");
});

test("in the mix, a laid stretch plays once across its parts; the score fills the rest", () => {
  const tl = buildTimeline(manifest, timings, { titles, music: { theme: "video/music/theme.wav", beds: { 0: "video/music/bed-01.wav", 1: "video/music/bed-02.wav" }, duck: 19 } });
  tl.music!.stretches = [{ file: "video/music/track-1-0.wav", from: 0, to: 2 }, { file: "video/music/track-2-5.wav", from: 5, to: 5 }];
  const inputs = musicInputs(tl);
  assert.deepEqual(inputs.map((i) => i.use), ["intro", "closing", 0, 1, "stretch0", "stretch1"]);
  const g = audioFilterGraph(tl);
  const first = tl.scenes.length + 1;  // the music inputs follow the scenes' WAVs
  const d = (tl.parts[0].frames + tl.parts[1].frames + tl.parts[2].frames) / 30;
  assert.ok(g.includes(`[${first + 4}:a]aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur=${d},atrim=end=${d}[m0]`), "opening, crawl and card: one stretch");
  assert.ok(g.includes(`[${first + 2}:a]`), "scene 1 keeps its bed");
  assert.ok(g.includes(`[${first + 5}:a]`) && !g.includes(`[${first + 3}:a]`), "scene 2 plays the author's track, not its bed");
  assert.ok(g.includes(`[${first + 1}:a]`), "the theme still closes");
});

test("laying a track: looped with crossfades to fill, level-matched to the voice, ducked under speech across the stretch", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-tracks-"));
  await mkdir(join(runDir, "audiobook"), { recursive: true });
  const speech = new Float32Array(24000 * 4);
  speech.fill(0.2, 24000, 72000);  // speech from 1s to 3s
  await writeFile(join(runDir, "audiobook", "scene-02.wav"), encodeWav(speech, 24000));
  const track = join(runDir, "tavern.mp3");
  await writeFile(track, "mp3");
  const renders: string[][] = [];
  const tools: MusicTools = {
    ffmpeg: async (args) => {
      if (args.includes("ebur128")) return "I:   -16 LUFS";
      const out = args[args.length - 1];
      if (out.includes("speech-")) { await writeFile(out, await readFile(args[args.indexOf("-i") + 1])); return ""; }
      renders.push(args);
      await writeFile(out, "wav");
      return "";
    },
    duration: async () => 25
  };
  // A card (4s), then the scene (60s): the speech sits 4s into the stretch.
  const laid = await layStretches(runDir, [{ track: { file: track, from: "card 2", to: "scene 2", start: 5, volume: -3 }, index: 1, from: 3, to: 4, parts: [{ seconds: 4 }, { seconds: 60, speech: "audiobook/scene-02.wav" }] }], { duck: 19, volume: -2, voiceLufs: -25 }, tools);
  assert.deepEqual(laid, [{ file: "video/music/track-2-3.wav", from: 3, to: 4 }]);
  const args = renders[0].join(" ");
  // 20s of music after the 5s start, for 64s: 4 copies crossfaded over 2s each; only the first starts at 5s.
  assert.equal(renders[0].filter((a) => a === track).length, 4);
  assert.equal(renders[0].filter((a) => a === "-ss").length, 1);
  assert.ok(args.includes("acrossfade=d=2"));
  // At the voice (-25) plus volume (-2) and the track's own (-3), from -16: -14 dB.
  assert.ok(args.includes("volume=-14.00dB"));
  const gains = decodeWav(await readFile(join(runDir, "video", "music", "duck-track-2-3.wav"))).samples;
  assert.ok(Math.abs(gains[3000] - 1) < 0.001, "the card: full");
  assert.ok(Math.abs(gains[6000] - 10 ** (-19 / 20)) < 0.001, "under the speech, 5s in: ducked");
  renders.length = 0;
  await layStretches(runDir, [{ track: { file: track, from: "card 2", to: "scene 2", start: 5, volume: -3 }, index: 1, from: 3, to: 4, parts: [{ seconds: 4 }, { seconds: 60, speech: "audiobook/scene-02.wav" }] }], { duck: 19, volume: -2, voiceLufs: -25 }, tools);
  assert.equal(renders.length, 0, "cached");
});

test("a track played once fades where it runs out", () => {
  const g = trackFilterGraph(1, 60, -3, 2, 30);
  assert.ok(g.includes("afade=t=out:st=27:d=3"));
  assert.ok(trackFilterGraph(1, 60, -3, 2).includes("afade=t=out:st=57:d=3"), "looped: at the stretch's end");
});

test("the author's tracks are credited, on a Music page before Scriptorium's", () => {
  const pages = creditPages([], undefined, { gemini: false, music: ["\"Overture\" by a friend", "\"The Howling Hen\" by a friend"] });
  assert.deepEqual(pages.at(-2), ["Music", "\"Overture\" by a friend", "\"The Howling Hen\" by a friend"]);
  assert.deepEqual(pages.at(-1), ["Written, illustrated and narrated", "with Scriptorium"]);
});

test("the story file: tracks resolve beside it, and a missing file or a bad part is caught on reading", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptorium-trackfile-"));
  await mkdir(join(dir, "music"));
  await writeFile(join(dir, "music", "tavern.mp3"), "mp3");
  const write = async (tracks: object[]) => {
    const file = join(dir, "story.json");
    await writeFile(file, JSON.stringify({ config: { providers: {}, roles: {} }, out: "run", scenes: 2, music: { generate: false, tracks } }));
    return file;
  };
  const story = await loadStoryFile(await write([{ file: "music/tavern.mp3", from: "scene 2", credit: "x" }]));
  assert.equal(story.music?.tracks?.[0].file, join(dir, "music", "tavern.mp3"));
  await assert.rejects(loadStoryFile(await write([{ file: "music/nope.mp3", from: "scene 2" }])), /music track 1: no file at music\/nope.mp3/);
  await assert.rejects(loadStoryFile(await write([{ file: "music/tavern.mp3", from: "the tavern" }])), /unknown part "the tavern"/);
});
