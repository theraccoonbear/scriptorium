import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bedFilterGraph, cuePrompt, cueSheetFor, cuesFromSheet, duckEnvelope, generateCues, prepareMusic, speechSpans } from "../src/music.ts";
import type { MusicTools } from "../src/music.ts";
import { directMusic, voiceWords } from "../src/roles.ts";
import type { CueSheet } from "../src/roles.ts";
import { EventLog } from "../src/eventlog.ts";
import { encodeWav } from "../src/geminiBatch.ts";
import { Accountant } from "../src/usage.ts";
import { pitch } from "../src/pitch.ts";
import { audioFilterGraph, buildTimeline, musicInputs } from "../src/video.ts";
import type { Timings } from "../src/video.ts";
import type { ArtManifest } from "../src/artist.ts";
import type { Role, StoryEvent } from "../src/types.ts";

// Issue #79: the score.

const sheet: CueSheet = {
  style: "Intimate chamber ensemble: solo cello, low strings, felt piano",
  theme: "A mournful five-note cello motif, 60 BPM, D minor",
  scenes: [{ scene: 1, music: "Near-still low strings, 56 BPM" }, { scene: 2, music: null }, { scene: 3, music: "Restless pizzicato, 72 BPM" }]
};

test("cue prompts are music only: words that invite a voice are refused", () => {
  assert.deepEqual(voiceWords("Underscore beneath spoken narration, no vocals or choir"), ["spoken", "narration", "vocals", "choir"]);
  assert.deepEqual(voiceWords("Instrumental. Solo cello, low strings, single felt-piano notes, a distant bell"), [], "\"single\" is not singing");
  const p = cuePrompt(sheet.style, "Sparse strings", 150);
  assert.ok(p.startsWith("Instrumental. A purely instrumental piece, about 2 minutes 30 seconds long."));
  assert.throws(() => cuePrompt(sheet.style, "A soft hummed melody", 60), /hummed/);
});

test("cues from the sheet: a 40 s theme, a bed per scene with music (none for a silent one), lengths capped", () => {
  const cues = cuesFromSheet(sheet, { 0: 61, 1: 300, 2: 480 });
  assert.deepEqual(cues.map((c) => [c.id, c.seconds]), [["theme", 40], ["scene-01", 60], ["scene-03", 150]]);
  assert.ok(cues[2].fallbackPrompt.includes("about 30 seconds long"));
});

function fakeRole(replies: unknown[]): Role & { prompts: string[] } {
  const prompts: string[] = [];
  return { prompts, provider: { complete: async (req: { prompt: string }) => { prompts.push(req.prompt); return JSON.stringify(replies[Math.min(prompts.length - 1, replies.length - 1)]); } } } as Role & { prompts: string[] };
}

test("the music director's sheet is checked: every scene answered, no voices or story in it", async () => {
  const scenes = [{ scene: 1, tension: 3, mood: "a hangman waits", seconds: 500 }, { scene: 2, tension: 8, mood: "the rope", seconds: 400 }];
  const bad = { style: "Strings", theme: "Cello motif", scenes: [{ scene: 1, music: "A choir sings softly" }, { scene: 2, music: "Pulsing cellos" }] };
  const good = { style: "Strings", theme: "Cello motif", scenes: [{ scene: 1, music: "Still strings" }, { scene: 2, music: null }] };
  const role = fakeRole([bad, good]);
  const out = await directMusic(role, { tone: "solemn", scenes });
  assert.deepEqual(out.result.scenes, [{ scene: 1, music: "Still strings" }, { scene: 2, music: null }]);
  assert.match(role.prompts[1], /unusable: it uses "choir", "sings"/);
  // The author's style is used verbatim.
  assert.equal((await directMusic(fakeRole([good]), { tone: "solemn", style: "Solo harp", scenes })).result.style, "Solo harp");
  await assert.rejects(directMusic(fakeRole([{ style: "x", theme: "y", scenes: [] }]), { tone: "t", scenes }), /no entry for scene 1, 2/);
});

test("the cue sheet is written once and kept in the event log until its inputs change", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-music-sheet-"));
  const log = new EventLog(runDir);
  await log.load();
  await log.append("scene_committed", { index: 0, tension: 4, prose: "x", beat: { goal: "wait", conflict: "dread" }, bible: { tone: "solemn", characters: {} } });
  const role = fakeRole([{ style: "Strings", theme: "Cello", scenes: [{ scene: 1, music: "Still strings" }] }]);
  assert.equal((await cueSheetFor(log, role, {}, { 0: 300 })).made, true);
  assert.equal((await cueSheetFor(log, role, {}, { 0: 310 })).made, false, "a few seconds' difference keeps the sheet");
  assert.equal(role.prompts.length, 1);
  assert.equal((await cueSheetFor(log, role, { style: "Solo harp" }, { 0: 300 })).made, true, "a new author style writes a new sheet");
  await assert.rejects(cueSheetFor(log, undefined, { style: "Lute" }, { 0: 300 }), /no musicdirector/);
});

test("cues: a take with a voice is set aside and retaken, then the 30-second model; failures stay failed; prompt changes remake", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-music-cues-"));
  const cues = cuesFromSheet(sheet, { 0: 200, 2: 200 });
  const composed: string[] = [];
  const compose = async (prompt: string, model: string) => { composed.push(model); return Buffer.from(`${model}:${prompt.length}:${composed.length}`); };
  // scene-01: voices on the first take. scene-03: voices on every Lyria 3.5 take, clean on the clip model.
  let n = 0;
  const check = async (file: string) => {
    n++;
    const body = await readFile(file, "utf8");
    if (file.includes("scene-01") && n === 2) return ["0:36+ whispered speech"];
    if (file.includes("scene-03") && body.startsWith("lyria-3.5")) return ["0:00+ humming"];
    return [];
  };
  const index = await generateCues(runDir, cues, { compose, check, maxTakes: 2 });
  assert.deepEqual(Object.fromEntries(Object.entries(index).map(([id, r]) => [id, [r.clean, r.model, r.takes]])), {
    theme: [true, "lyria-3.5", 1],
    "scene-01": [true, "lyria-3.5", 2],
    "scene-03": [true, "lyria-3-clip-preview", 3]
  });
  assert.deepEqual(composed, ["lyria-3.5", "lyria-3.5", "lyria-3.5", "lyria-3.5", "lyria-3.5", "lyria-3-clip-preview"]);
  assert.deepEqual((await readdir(join(runDir, "music", "rejected"))).sort(), ["scene-01-1.mp3", "scene-03-1.mp3", "scene-03-2.mp3"]);
  assert.ok(index["scene-03"].findings[0].startsWith("take 1: 0:00+ humming"));

  // Re-run: everything kept, nothing composed.
  composed.length = 0;
  await generateCues(runDir, cues, { compose, check, maxTakes: 2 });
  assert.deepEqual(composed, []);

  // A cue whose every take has a voice is left out, and isn't retried on the next run.
  const always = async () => ["0:00+ singing"];
  const failed = await generateCues(runDir, [{ ...cues[0], prompt: `${cues[0].prompt} Darker.` }], { compose, check: always, maxTakes: 1 });
  assert.equal(failed.theme.clean, false);
  composed.length = 0;
  await generateCues(runDir, [{ ...cues[0], prompt: `${cues[0].prompt} Darker.` }], { compose, check: always, maxTakes: 1 });
  assert.deepEqual(composed, [], "a failed cue costs nothing until its prompt changes or --force");
});

test("ducking: speech found in the narration, the music dipped under it with ramps, joined across short pauses", () => {
  const rate = 1000;
  const samples = new Float32Array(10 * rate);
  for (const [s, e] of [[2, 4], [4.5, 5], [8, 9]]) for (let i = s * rate; i < e * rate; i++) samples[i] = 0.2;
  const spans = speechSpans(samples, rate);
  assert.deepEqual(spans.map(([s, e]) => [+s.toFixed(2), +e.toFixed(2)]), [[2, 5], [8, 9]], "the 0.5 s pause is joined; the 3 s gap isn't");
  const env = duckEnvelope(spans, 10, 20, 100);
  const low = 10 ** (-20 / 20);
  assert.equal(env[100], 1, "full level before speech");
  assert.ok(Math.abs(env[300] - low) < 1e-6, "20 dB down while speaking");
  assert.ok(env[180] > low && env[180] < 1, "ramping down just before");
  assert.ok(env[540] > low && env[540] < 1, "ramping back up after");
  assert.equal(env[700], 1, "up again between lines");
});

test("a bed: the cue looped with crossfades, set to level, faded in, multiplied by the duck envelope", () => {
  const g = bedFilterGraph(3, 400, -4.5);
  assert.ok(g.startsWith("[0:a][1:a]acrossfade=d=3[x1];[x1][2:a]acrossfade=d=3[x2];[x2]aformat="));
  assert.ok(g.includes("apad=whole_dur=400,atrim=0:400,volume=-4.50dB,afade=t=in:d=2[m]"));
  assert.ok(g.endsWith("[3:a]aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo[e];[m][e]amultiply,atrim=0:400[out]"));
  assert.ok(bedFilterGraph(1, 100, 0).startsWith("[0:a]aformat="));
});

test("prepareMusic: under speech the music sits `duck` dB below the narrator's measured voice; cached until something changes", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-music-mix-"));
  await mkdir(join(runDir, "music"), { recursive: true });
  await mkdir(join(runDir, "audiobook"), { recursive: true });
  await writeFile(join(runDir, "music", "theme.mp3"), "theme");
  await writeFile(join(runDir, "music", "scene-01.mp3"), "bed");
  await writeFile(join(runDir, "music", "cues.json"), JSON.stringify({
    theme: { prompt: "p", model: "lyria-3.5", file: "music/theme.mp3", takes: 1, clean: true, findings: [] },
    "scene-01": { prompt: "p", model: "lyria-3.5", file: "music/scene-01.mp3", takes: 1, clean: true, findings: [] }
  }));
  const speech = new Float32Array(24000 * 4);
  speech.fill(0.2, 24000, 72000);
  await writeFile(join(runDir, "audiobook", "scene-01.wav"), encodeWav(speech, 24000));
  await writeFile(join(runDir, "audiobook", "scene-02.wav"), encodeWav(speech, 24000));
  const levels: Record<string, number> = { "scene-01.wav": -25, "scene-02.wav": -27, "theme.mp3": -18, "scene-01.mp3": -20 };
  const renders: string[][] = [];
  const tools: MusicTools = {
    ffmpeg: async (args) => {
      if (args.includes("ebur128")) return `Summary:\n  Integrated loudness:\n    I:         ${levels[args[1].split("/").pop()!]} LUFS`;
      const out = args[args.length - 1];
      // The speech copy: pass the narration through as it is.
      if (out.includes("speech-")) { await writeFile(out, await readFile(args[args.indexOf("-i") + 1])); return ""; }
      renders.push(args);
      await writeFile(out, "wav");
      return "";
    },
    duration: async () => 60
  };
  const scenes = [{ index: 0, audio: "audiobook/scene-01.wav", seconds: 100 }, { index: 1, audio: "audiobook/scene-02.wav", seconds: 50 }];
  const mix = await prepareMusic(runDir, scenes, { duck: 19, volume: -2 }, tools);
  assert.deepEqual(mix, { theme: "video/music/theme.wav", beds: { 0: "video/music/bed-01.wav" }, duck: 19 }, "scene 2 has no cue: no bed");
  const [bed, theme] = renders;
  // The bed: 103 s of a 60 s cue = 2 loops; at the voice's level (-25) plus volume (-2), from -20: -7 dB.
  assert.equal(bed.filter((a) => a.endsWith("scene-01.mp3")).length, 2);
  assert.ok(bed.join(" ").includes("volume=-7.00dB"));
  // Its envelope cuts duck + volume = 17 dB more, so under speech: -25 - 2 - 17 = -44 = the voice (-25) less 19.
  const env = await readFile(join(runDir, "video", "music", "duck-01.wav"));
  const { decodeWav } = await import("../src/geminiTts.ts");
  const gains = decodeWav(env).samples;
  assert.ok(Math.abs(gains[2000] - 10 ** (-17 / 20)) < 0.001);
  assert.ok(Math.abs(gains[100] - 1) < 0.001);
  // The theme: the average voice (-26) plus volume, from -18: -10 dB.
  assert.ok(theme.join(" ").includes("volume=-10.00dB"));

  renders.length = 0;
  await prepareMusic(runDir, scenes, { duck: 19, volume: -2 }, tools);
  assert.equal(renders.length, 0, "nothing changed: nothing re-rendered");
  await prepareMusic(runDir, scenes, { duck: 22, volume: -2 }, tools);
  assert.equal(renders.length, 1, "a new duck depth redoes the bed, not the theme");
});

const manifest: ArtManifest = {
  "scene-01-01": { file: "a.jpg", prompt: "a", finalPrompt: "a", attempts: 1, accepted: true, issues: [], sceneIndex: 0, startParagraph: 0 },
  "scene-02-01": { file: "b.jpg", prompt: "b", finalPrompt: "b", attempts: 1, accepted: true, issues: [], sceneIndex: 1, startParagraph: 0 },
  cover: { file: "c.jpg", prompt: "c", finalPrompt: "c", attempts: 1, accepted: true, issues: [] }
};
const timings: Timings = { sampleRate: 24000, scenes: [{ index: 0, file: "scene-01.wav", durationSec: 30, paragraphStarts: [0] }, { index: 1, file: "scene-02.wav", durationSec: 20, paragraphStarts: [0] }] };
const titles = { title: "T", sceneCards: true, sceneTitles: {}, ending: "The End", credits: [["x"]], font: "f", titleFont: "f" };

test("the video lays the theme under the opening and the closing, each bed under its scene, silence under the cards", () => {
  const tl = buildTimeline(manifest, timings, { titles, music: { theme: "video/music/theme.wav", beds: { 1: "video/music/bed-02.wav" }, duck: 19 } });
  assert.deepEqual(musicInputs(tl), [{ file: "video/music/theme.wav", use: "intro" }, { file: "video/music/theme.wav", use: "closing" }, { file: "video/music/bed-02.wav", use: 1 }]);
  const g = audioFilterGraph(tl);
  // Inputs: 1-2 scene WAVs, then 3 theme (opening), 4 theme (closing), 5 scene 2's bed.
  assert.ok(g.includes("concat=n=7:v=0:a=1[voice]"));
  assert.ok(g.includes("[3:a]aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur=8,atrim=end=8,afade=t=in:d=0.5,afade=t=out:st=6.5:d=1.5[m0]"));
  assert.ok(g.includes("anullsrc=r=48000:cl=stereo,atrim=end=4[m1]"), "the card is silent");
  assert.ok(g.includes("anullsrc=r=48000:cl=stereo,atrim=end=30.766666666666666[m2]"), "scene 1 has no bed");
  assert.ok(g.includes("[5:a]aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur=22.766666666666666"), "scene 2's bed, to the scene's full length");
  assert.ok(g.includes("[4:a]aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur=9,atrim=end=9,afade=t=in:d=1,afade=t=out:st=6:d=3[m5]"), "one stretch of theme under The End and the credits");
  assert.ok(g.endsWith("[m0][m1][m2][m3][m4][m5]concat=n=6:v=0:a=1[music];\n[voice][music]amix=inputs=2:normalize=0:duration=first[aout]"));
  // A narrated title dips the theme under it.
  const narrated = buildTimeline(manifest, timings, { titles: { ...titles, narration: "video/title.wav" }, narrationSec: 3, music: { theme: "t.wav", beds: {}, duck: 19 } });
  assert.ok(audioFilterGraph(narrated).includes("volume=-19dB:enable='between(t,1.5,5.3)'"));
  // No music: exactly the old graph.
  assert.ok(audioFilterGraph(buildTimeline(manifest, timings, { titles })).endsWith("concat=n=7:v=0:a=1[aout]"));
});

test("Lyria is logged at its flat price per cue, whether or not the response reports tokens", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-music-spend-"));
  const a = new Accountant(runDir, {});
  const entry = a.record("composer", "lyria-3.5", { steps: [] });
  assert.equal(entry?.usd, 0.08);
  assert.equal(a.record("composer", "lyria-3-clip-preview", {})?.usd, 0.04);
  assert.ok(Math.abs(a.spent - 0.12) < 1e-9);
});

test("the pitch prices the cues still to make", () => {
  const events: StoryEvent[] = [];
  const p = pitch({ events, scenes: 6, art: { skip: true }, audio: { skip: true }, music: { cues: 7, made: 2 } });
  assert.equal(p.music.cues, 5);
  assert.ok(Math.abs(p.music.usd - 5 * 2 * (0.08 + 0.009)) < 1e-9);
  assert.equal(p.totalUsd, p.music.usd + p.story.usd);
  assert.equal(pitch({ events, scenes: 6, art: { skip: true }, audio: { skip: true } }).music.usd, 0, "no music block: nothing");
});

test("a refused brief is never resent: the plain style next, then the 30-second model; refusals cost nothing", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-music-refused-"));
  const [theme] = cuesFromSheet(sheet, {});
  const sent: string[] = [];
  const compose = async (prompt: string, model: string) => {
    sent.push(`${model}:${prompt === theme.prompt ? "brief" : prompt === theme.plainPrompt ? "plain" : "clip"}`);
    if (prompt === theme.prompt) throw new Error('HTTP 400: {"error":{"message":"Input blocked","code":"prohibited_content"}}');
    return Buffer.from("audio");
  };
  const index = await generateCues(runDir, [theme], { compose, check: async () => [], maxTakes: 3 });
  assert.deepEqual(sent, ["lyria-3.5:brief", "lyria-3.5:plain"], "one refusal, then the plain style — not three refusals");
  assert.deepEqual([index.theme.clean, index.theme.takes], [true, 2]);
  assert.ok(index.theme.findings[0].includes("refused the prompt"));
  // Any other error still stops the run.
  await assert.rejects(generateCues(runDir, [{ ...theme, prompt: `${theme.prompt} x`, id: "other" }], { compose: async () => { throw new Error("HTTP 500"); }, check: async () => [] }), /HTTP 500/);
});
