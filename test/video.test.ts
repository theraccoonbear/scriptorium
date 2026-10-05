import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audioFilterGraph, buildSrt, buildTimeline, cardFilterGraph, cardSpec, fitSize, kenBurnsFilter, moveFor, renderVideo, sceneFilterGraph } from "../src/video.ts";
import type { Timeline, Timings } from "../src/video.ts";
import type { TitleCards } from "../src/titles.ts";
import type { ArtManifest, ManifestEntry } from "../src/artist.ts";
import type { StoryEvent } from "../src/types.ts";

function entry(file: string, sceneIndex: number | undefined, startParagraph: number | undefined, accepted = true): ManifestEntry {
  return { file, prompt: file, finalPrompt: file, attempts: 1, accepted, issues: accepted ? [] : ["extra finger"], sceneIndex, startParagraph };
}

// Scene 1: 60s, paragraphs at 0/10/12/30/58s. Scene 2: 20s, one shot.
const manifest: ArtManifest = {
  "scene-01-01": entry("scene-01-01.jpg", 0, 0),
  "scene-01-02": entry("scene-01-02.jpg", 0, 1),
  "scene-01-03": entry("scene-01-03.jpg", 0, 2, false),
  "scene-01-04": entry("scene-01-04.jpg", 0, 3),
  "scene-01-05": entry("scene-01-05.jpg", 0, 4),
  "scene-02-01": entry("scene-02-01.jpg", 1, 0),
  cover: entry("cover.jpg", undefined, undefined)
};
const timings: Timings = {
  sampleRate: 24000,
  scenes: [
    { index: 0, file: "scene-01.wav", durationSec: 60.01, paragraphStarts: [0, 10, 12, 30, 58] },
    { index: 1, file: "scene-02.wav", durationSec: 20, paragraphStarts: [0, 5] }
  ]
};

test("shots come on screen at their paragraph's start, frame-exact, covering the whole scene", () => {
  const tl = buildTimeline(manifest, timings);
  const s = tl.scenes[0];
  assert.equal(s.frames, 1800); // 60.01s rounds to 1800 frames
  // 01-03 starts 2s after 01-02 and 01-05 is 2s from the end: both too short (< 6s) and dropped.
  // 01-04 is held 30s (> 25s), so its image gets two 15s camera moves.
  assert.deepEqual(s.shots.map((x) => [x.key, x.file, x.startFrame, x.slotFrames]), [
    ["scene-01-01", "art/scene-01-01.jpg", 0, 300],
    ["scene-01-02", "art/scene-01-02.jpg", 300, 600],
    ["scene-01-04", "art/scene-01-04.jpg", 900, 450],
    ["scene-01-04#2", "art/scene-01-04.jpg", 1350, 450]
  ]);
  assert.equal(s.shots.reduce((n, x) => n + x.slotFrames, 0), s.frames);
  // Every clip but the last carries the crossfade into the next shot.
  assert.deepEqual(s.shots.map((x) => x.clipFrames), [345, 645, 495, 450]);
  assert.equal(tl.totalFrames, 180 + 1800 + 45 + 600);
  assert.ok(tl.warnings.some((w) => w.startsWith("scene-01-03") && w.includes("never accepted")));
  assert.ok(tl.warnings.some((w) => w.startsWith("scene-01-05 dropped")));
});

test("long holds split into moves no longer than maxMoveSec; short ones don't", () => {
  const tl = buildTimeline(manifest, timings, { maxMoveSec: 8 });
  const s = tl.scenes[0];
  // 10s -> 2 moves, 20s -> 3, 30s -> 4; every move <= 8s and the scene still adds up.
  assert.equal(s.shots.length, 2 + 3 + 4);
  assert.ok(s.shots.every((x) => x.slotFrames <= 240));
  assert.equal(s.shots.reduce((n, x) => n + x.slotFrames, 0), s.frames);
  assert.equal(buildTimeline(manifest, timings, { maxMoveSec: 100 }).scenes[0].shots.length, 3);
});

test("moves are deterministic and never repeat back to back", () => {
  assert.equal(moveFor("scene-01-01"), moveFor("scene-01-01"));
  const tl = buildTimeline(manifest, timings);
  const moves = tl.scenes.flatMap((s) => s.shots.map((x) => x.move));
  for (let k = 1; k < moves.length; k++) assert.notEqual(moves[k], moves[k - 1]);
});

test("a scene without art falls back to the cover; no cover and no art is an error", () => {
  const noScene2: ArtManifest = { ...manifest };
  delete noScene2["scene-02-01"];
  const tl = buildTimeline(noScene2, timings);
  assert.equal(tl.scenes[1].shots[0].file, "art/cover.jpg");
  const { cover: _, ...bare } = noScene2;
  assert.throws(() => buildTimeline(bare, timings), /no art and there is no cover/);
});

test("scene filter graph chains xfades at each shot's start and trims to the scene length", () => {
  const tl = buildTimeline(manifest, timings);
  const graph = sceneFilterGraph(tl.scenes[0], tl.fadeFrames);
  assert.ok(graph.includes("[v0][v1]xfade=transition=fade:duration=1.5:offset=10[x1]"));
  assert.ok(graph.includes("[x1][v2]xfade=transition=fade:duration=1.5:offset=30[x2]"));
  assert.ok(graph.includes("trim=end_frame=1800[out]"));
  assert.ok(graph.includes("[x2][v3]xfade=transition=fade:duration=1.5:offset=45[x3]"));
  assert.ok(kenBurnsFilter("pan_left", 300).includes("d=300:s=1920x1080:fps=30"));
  // Pronounced, eased motion: zooms reach 1.35x along a smoothstep curve.
  assert.ok(kenBurnsFilter("zoom_in", 300).includes("z='1+0.35*((on/299)*(on/299)*(3-2*(on/299)))'"));
});

test("audio graph puts silence under the intro and gaps and pads each scene to its frame length", () => {
  const tl = buildTimeline(manifest, timings);
  const graph = audioFilterGraph(tl);
  assert.ok(graph.includes("anullsrc=r=48000:cl=stereo,atrim=end=6[intro]"));
  assert.ok(graph.includes("[1:a]aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur=60,atrim=end=60[a0]"));
  assert.ok(graph.includes("atrim=end=1.5[gap1]"));
  assert.ok(graph.endsWith("[intro][a0][gap1][a1]concat=n=4:v=0:a=1[aout]"));
});

test("subtitles split each paragraph's window across its sentences, offset by intro and gaps", () => {
  const tl = buildTimeline(manifest, timings);
  const srt = buildSrt(tl, timings, new Map([[0, ["One. Two!", "Three.", "x", "y", "z"]], [1, ["Later.", "End."]]]));
  const cues = srt.trim().split("\n\n");
  assert.equal(cues[0], "1\n00:00:06,000 --> 00:00:11,000\nOne.");
  assert.equal(cues[1], "2\n00:00:11,000 --> 00:00:16,000\nTwo!");
  assert.equal(cues[2], "3\n00:00:16,000 --> 00:00:18,000\nThree.");
  // Scene 2 starts after intro (6) + scene 1 (60) + gap (1.5).
  assert.ok(cues.some((c) => c.includes("00:01:07,500 --> 00:01:12,500\nLater.")));
});

test("renderVideo writes the timeline, caches scene parts, and errors clearly without audio", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-video-"));
  await mkdir(join(runDir, "art"), { recursive: true });
  await writeFile(join(runDir, "art", "art.json"), JSON.stringify(manifest));
  for (const e of Object.values(manifest)) await writeFile(join(runDir, "art", e.file), "img");
  const events: StoryEvent[] = [
    { seq: 0, type: "scene_committed", ts: "t", data: { index: 0, prose: "One. Two!\n\nThree." } },
    { seq: 1, type: "scene_committed", ts: "t", data: { index: 1, prose: "Later." } }
  ];
  await assert.rejects(renderVideo(events, { runDir, run: async () => {} }), /audiobook\/timings\.json/);

  await mkdir(join(runDir, "audiobook"), { recursive: true });
  await writeFile(join(runDir, "audiobook", "timings.json"), JSON.stringify(timings));
  const calls: string[][] = [];
  // Fake ffmpeg: record the call and create its output file (the last arg).
  const run = async (args: string[]) => { calls.push(args); await writeFile(args[args.length - 1], "out"); };
  const result = await renderVideo(events, { runDir, run, encoder: "x264", parallel: 1 });
  assert.equal(result.durationSec, (180 + 1800 + 45 + 600) / 30);
  const outputs = calls.map((a) => a[a.length - 1].split("/").pop());
  assert.deepEqual(outputs, ["intro.mp4", "gap-45-x264.mp4", "scene-01.mp4", "scene-02.mp4", "story.mp4", "thumbnail.jpg"]);
  assert.equal(await readFile(join(runDir, "video", "parts", "parts.txt"), "utf8"), "file 'intro.mp4'\nfile 'scene-01.mp4'\nfile 'gap-45-x264.mp4'\nfile 'scene-02.mp4'\n");
  assert.ok((await readFile(join(runDir, "video", "story.srt"), "utf8")).includes("Three."));
  assert.equal(JSON.parse(await readFile(join(runDir, "video", "timeline.json"), "utf8")).scenes.length, 2);

  // Second render: intro, gap and scenes are cached; only the final mux and thumbnail rerun.
  calls.length = 0;
  await renderVideo(events, { runDir, run, encoder: "x264", parallel: 1 });
  assert.deepEqual(calls.map((a) => a[a.length - 1].split("/").pop()), ["story.mp4", "thumbnail.jpg"]);
});

test("encoder: auto picks NVENC when a test encode works, x264 when it doesn't; args per encoder", async () => {
  const { resolveEncoder, encodeArgs } = await import("../src/video.ts");
  const probes: string[][] = [];
  assert.equal(await resolveEncoder("auto", async (args) => { probes.push(args); }), "nvenc");
  assert.ok(probes[0].includes("h264_nvenc") && probes[0].at(-1) === "-");
  assert.equal(await resolveEncoder("auto", async () => { throw new Error("no nvenc"); }), "x264");
  assert.equal(await resolveEncoder("x264", async () => { throw new Error("never called"); }), "x264");
  assert.ok(encodeArgs("nvenc").join(" ").includes("-c:v h264_nvenc -preset p5 -tune hq -rc vbr -cq 26"));
  assert.ok(encodeArgs("x264").join(" ").includes("-c:v libx264 -preset medium -crf 18"));
});

test("scenes render in parallel up to the limit, keep their order, and re-render when the encoder changes", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-video-par-"));
  await mkdir(join(runDir, "art"), { recursive: true });
  const many: ArtManifest = { cover: entry("cover.jpg", undefined, undefined) };
  const sceneTimings: Timings = { sampleRate: 24000, scenes: [] };
  const events: StoryEvent[] = [];
  for (let i = 0; i < 5; i++) {
    many[`scene-0${i + 1}-01`] = entry(`scene-0${i + 1}-01.jpg`, i, 0);
    sceneTimings.scenes.push({ index: i, file: `scene-0${i + 1}.wav`, durationSec: 10, paragraphStarts: [0] });
    events.push({ seq: i, type: "scene_committed", ts: "t", data: { index: i, prose: "Words." } });
  }
  await writeFile(join(runDir, "art", "art.json"), JSON.stringify(many));
  for (const e of Object.values(many)) await writeFile(join(runDir, "art", e.file), "img");
  await mkdir(join(runDir, "audiobook"), { recursive: true });
  await writeFile(join(runDir, "audiobook", "timings.json"), JSON.stringify(sceneTimings));

  let inFlight = 0;
  let peak = 0;
  const quietFlags: boolean[] = [];
  const run = async (args: string[], o?: { quiet?: boolean }) => {
    const out = args[args.length - 1];
    if (out.includes("scene-")) {
      quietFlags.push(Boolean(o?.quiet));
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
    }
    await writeFile(out, "out");
  };
  await renderVideo(events, { runDir, run, encoder: "nvenc", parallel: 3 });
  assert.equal(peak, 3);
  assert.ok(quietFlags.every(Boolean), "parallel renders run without live progress");
  const order = (await readFile(join(runDir, "video", "parts", "parts.txt"), "utf8")).match(/scene-\d+/g);
  assert.deepEqual(order, ["scene-01", "scene-02", "scene-03", "scene-04", "scene-05"]);

  // Same encoder: all cached. Different encoder: all scenes redone, new gap clip.
  const outputs: string[] = [];
  const recording = async (args: string[]) => { outputs.push(args[args.length - 1].split("/").pop()!); await writeFile(args[args.length - 1], "out"); };
  await renderVideo(events, { runDir, run: recording, encoder: "nvenc", parallel: 3 });
  assert.deepEqual(outputs.filter((o) => o.startsWith("scene-")), []);
  outputs.length = 0;
  await renderVideo(events, { runDir, run: recording, encoder: "x264", parallel: 3 });
  assert.equal(outputs.filter((o) => o.startsWith("scene-")).length, 5);
  assert.ok(outputs.includes("gap-45-x264.mp4"));
});

// ---- issue #78: cards ----

const titles: TitleCards = {
  title: "Rantoul's Mushrooms",
  subtitle: "Part 1",
  sceneCards: true,
  sceneTitles: { 0: "The Ditch", 1: "" },
  ending: "To be continued",
  credits: [["Narrated by Algenib", "Lemuel — voiced by Achird"], ["Written, illustrated and narrated", "with Scriptorium"]],
  next: "Next: Part 2",
  font: "/fonts/EBGaramond.ttf",
  titleFont: "/fonts/Cinzel.ttf"
};

test("with cards: opening, a card before each scene, a pad and a final hold, then ending, credits and next", () => {
  const tl = buildTimeline(manifest, timings, { titles });
  assert.deepEqual(tl.parts.map((p) => [p.kind, p.file, p.frames]), [
    ["intro", "intro.mp4", 240],
    ["card", "card-01.mp4", 120],
    ["scene", "scene-01.mp4", 1800 + 23],
    ["card", "card-02.mp4", 120],
    ["scene", "scene-02.mp4", 600 + 23 + 60],
    ["end", "end.mp4", 120],
    ["credits", "credits-1.mp4", 150],
    ["credits", "credits-2.mp4", 150],
    ["next", "next.mp4", 105]
  ]);
  assert.equal(tl.totalFrames, tl.parts.reduce((n, p) => n + p.frames, 0));
  // Every part is whole frames, and the shots still fill each scene exactly.
  assert.ok(tl.parts.every((p) => Number.isInteger(p.frames)));
  for (const s of tl.scenes) assert.equal(s.shots.reduce((n, x) => n + x.slotFrames, 0), s.frames);
  assert.deepEqual(tl.scenes.map((s) => s.audioFrames), [1800, 600]);
  // Scene cards off: the old black gap between scenes.
  const noCards = buildTimeline(manifest, timings, { titles: { ...titles, sceneCards: false } });
  assert.deepEqual(noCards.parts.slice(0, 4).map((p) => p.kind), ["intro", "scene", "gap", "scene"]);
});

// Where each scene's sound starts in the joined track: the frames of every part before it.
function audioStarts(tl: Timeline): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const p of tl.parts) {
    if (p.kind === "scene") starts.push(at / 30);
    at += p.frames;
  }
  return starts;
}

test("sync: each scene's first caption starts exactly where its sound does, and captions end with the narration", () => {
  const tl = buildTimeline(manifest, timings, { titles });
  const srt = buildSrt(tl, timings, new Map([[0, ["One.", "a", "b", "c", "Last words."]], [1, ["Later.", "End."]]]));
  const cues = srt.trim().split("\n\n").map((c) => c.split("\n")[1].split(" --> "));
  const seconds = (t: string) => { const [h, m, rest] = t.split(":"); const [s, ms] = rest.split(","); return +h * 3600 + +m * 60 + +s + +ms / 1000; };
  const [s1, s2] = audioStarts(tl);
  // SRT keeps milliseconds: equal to within rounding.
  const near = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) <= 0.0005, msg ?? `${a} != ${b}`);
  near(seconds(cues[0][0]), s1);                 // 8 + 4
  near(seconds(cues[5][0]), s2);                 // "Later."
  assert.equal(s2, (240 + 120 + 1823 + 120) / 30);
  near(seconds(cues[4][1]), s1 + 60, "scene 1's last caption ends with its narration, not the fade pad");
  near(seconds(cues[6][1]), s2 + 20, "the last scene's captions end before the hold");

  // The audio graph lays the same parts end to end, in the same order and lengths.
  const graph = audioFilterGraph(tl);
  assert.ok(graph.endsWith("[intro][card0][a0][card1][a1][end][credits1][credits2][next]concat=n=9:v=0:a=1[aout]"));
  assert.ok(graph.includes("anullsrc=r=48000:cl=stereo,atrim=end=8[intro]"));
  assert.ok(graph.includes("anullsrc=r=48000:cl=stereo,atrim=end=4[card1]"));
  assert.ok(graph.includes(`[1:a]aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur=${1823 / 30},atrim=end=${1823 / 30}[a0]`));
});

test("a narrated title lengthens the opening to fit and plays under it, after the scenes' inputs", () => {
  const narrated = { ...titles, narration: "video/title.wav" };
  const short = buildTimeline(manifest, timings, { titles: narrated, narrationSec: 2 });
  assert.equal(short.introFrames, 240, "a short reading fits the usual 8s");
  const long = buildTimeline(manifest, timings, { titles: narrated, narrationSec: 6.1 });
  assert.equal(long.introFrames, Math.ceil((1.8 + 6.1 + 2) * 30));
  assert.equal(long.narration, "video/title.wav");
  assert.ok(audioFilterGraph(long).includes(`[3:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=1800|1800,apad=whole_dur=${long.introFrames / 30}`));
  // Without the WAV's length the opening stays silent.
  assert.equal(buildTimeline(manifest, timings, { titles: narrated }).narration, undefined);
});

test("cards: what each says and when, drawn from text files, fading in and out", () => {
  const tl = buildTimeline(manifest, timings, { titles });
  const [intro, card1, , card2] = tl.parts;
  const opening = cardSpec(intro, tl, titles);
  assert.equal(opening.cover, true);
  assert.deepEqual(opening.texts.map((t) => [t.text, t.font, t.in, t.out]), [["Rantoul's Mushrooms", "/fonts/Cinzel.ttf", 1.2, 6.8], ["Part 1", "/fonts/EBGaramond.ttf", 1.9, 6.8]]);
  assert.deepEqual(cardSpec(card1, tl, titles).texts.map((t) => t.text), ["I", "The Ditch"]);
  assert.deepEqual(cardSpec(card2, tl, titles).texts.map((t) => [t.text, t.y]), [["II", 540]], "no title: the numeral alone, centered");
  const credits = cardSpec(tl.parts[6], tl, titles);
  assert.deepEqual(credits.texts.map((t) => t.y), [500, 580]);

  const files: string[] = [];
  const graph = cardFilterGraph(opening, intro.frames, (text) => { files.push(text); return `/tmp/t/${files.length}.txt`; });
  assert.deepEqual(files, ["Rantoul's Mushrooms", "Part 1"]);
  assert.ok(graph.startsWith("[0:v]crop="), "the cover, pushing in");
  assert.ok(graph.includes("drawbox=x=0:y=0:w=iw:h=ih:color=black@0.4:t=fill"), "dimmed under the title");
  assert.ok(graph.includes("fontfile='/fonts/Cinzel.ttf':textfile='/tmp/t/1.txt':expansion=none"));
  assert.ok(graph.includes("alpha='if(lt(t,1.2),0,if(lt(t,1.9),(t-1.2)/0.7,if(lt(t,6.1),1,if(lt(t,6.8),(6.8-t)/0.7,0))))'"));
  assert.ok(graph.endsWith("fade=t=in:d=0.75,fade=t=out:st=7.25:d=0.75,trim=end_frame=240[out]"));
  const black = cardFilterGraph(cardSpec(card1, tl, titles), card1.frames, () => "/tmp/x.txt");
  assert.ok(black.startsWith("color=black:s=1920x1080:r=30:d=4,format=yuv420p,drawtext="));
  // Long lines shrink to fit the frame.
  assert.equal(fitSize("Short", 84, false), 84);
  assert.ok(fitSize("Unknown Mathematics Student from Carem University — voiced by Authoritative Advisor 7", 52, false) < 52);
});

test("renderVideo with cards: renders them, joins every part in order, and checks every part's length", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-video-cards-"));
  await mkdir(join(runDir, "art"), { recursive: true });
  await writeFile(join(runDir, "art", "art.json"), JSON.stringify(manifest));
  for (const e of Object.values(manifest)) await writeFile(join(runDir, "art", e.file), "img");
  await mkdir(join(runDir, "audiobook"), { recursive: true });
  await writeFile(join(runDir, "audiobook", "timings.json"), JSON.stringify(timings));
  const events: StoryEvent[] = [
    { seq: 0, type: "scene_committed", ts: "t", data: { index: 0, prose: "One." } },
    { seq: 1, type: "scene_committed", ts: "t", data: { index: 1, prose: "Later." } }
  ];
  const tl = buildTimeline(manifest, timings, { titles });
  const expected = new Map(tl.parts.map((p) => [p.file, p.frames]));
  const outputs: string[] = [];
  const run = async (args: string[]) => { outputs.push(args[args.length - 1].split("/").pop()!); await writeFile(args[args.length - 1], "out"); };
  let short: string | undefined;
  const probe = async (file: string) => {
    const name = file.split("/").pop()!;
    if (name === "story.mp4") return { frames: tl.totalFrames, audioSec: tl.totalFrames / 30 };
    return { frames: expected.get(name)! - (name === short ? 1 : 0) };
  };
  await renderVideo(events, { runDir, run, probe, encoder: "x264", parallel: 1, titles });
  assert.deepEqual(outputs.slice(0, 7), ["intro.mp4", "card-01.mp4", "card-02.mp4", "end.mp4", "credits-1.mp4", "credits-2.mp4", "next.mp4"]);
  assert.equal(await readFile(join(runDir, "video", "parts", "parts.txt"), "utf8"),
    ["intro", "card-01", "scene-01", "card-02", "scene-02", "end", "credits-1", "credits-2", "next"].map((p) => `file '${p}.mp4'`).join("\n") + "\n");
  const textFiles = await readdir(join(runDir, "video", "parts", "text"));
  assert.ok(textFiles.length >= 9);

  // A changed scene title re-renders that one card; everything else is cached.
  outputs.length = 0;
  await renderVideo(events, { runDir, run, probe, encoder: "x264", parallel: 1, titles: { ...titles, sceneTitles: { 0: "The Ditch", 1: "The Howling Hen" } } });
  assert.deepEqual(outputs, ["card-02.mp4", "story.mp4", "thumbnail.jpg"]);

  // A part a frame short stops the join, and is redone next time.
  short = "scene-02.mp4";
  outputs.length = 0;
  await assert.rejects(renderVideo(events, { runDir, run, probe, encoder: "x264", parallel: 1, titles }), /scene-02\.mp4 has 682 frames where the timeline needs 683/);
  assert.ok(!outputs.includes("story.mp4"));
  short = undefined;
  outputs.length = 0;
  await renderVideo(events, { runDir, run, probe, encoder: "x264", parallel: 1, titles });
  assert.ok(outputs.includes("scene-02.mp4"));

  // Picture and sound that don't end together are reported.
  const warnings: string[] = [];
  const drifting = async (file: string) => (file.endsWith("story.mp4") ? { frames: tl.totalFrames, audioSec: tl.totalFrames / 30 + 0.5 } : probe(file));
  await renderVideo(events, { runDir, run, probe: drifting, encoder: "x264", parallel: 1, titles, onProgress: (e) => { if (e.type === "warning") warnings.push(e.message); } });
  assert.ok(warnings.some((w) => w.includes("drifted apart")));
});
