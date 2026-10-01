import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audioFilterGraph, buildSrt, buildTimeline, kenBurnsFilter, moveFor, renderVideo, sceneFilterGraph } from "../src/video.ts";
import type { Timings } from "../src/video.ts";
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
  const result = await renderVideo(events, { runDir, run });
  assert.equal(result.durationSec, (180 + 1800 + 45 + 600) / 30);
  const outputs = calls.map((a) => a[a.length - 1].split("/").pop());
  assert.deepEqual(outputs, ["intro.mp4", "scene-01.mp4", "gap-45.mp4", "scene-02.mp4", "story.mp4", "thumbnail.jpg"]);
  assert.equal(await readFile(join(runDir, "video", "parts", "parts.txt"), "utf8"), "file 'intro.mp4'\nfile 'scene-01.mp4'\nfile 'gap-45.mp4'\nfile 'scene-02.mp4'\n");
  assert.ok((await readFile(join(runDir, "video", "story.srt"), "utf8")).includes("Three."));
  assert.equal(JSON.parse(await readFile(join(runDir, "video", "timeline.json"), "utf8")).scenes.length, 2);

  // Second render: intro, gap and scenes are cached; only the final mux and thumbnail rerun.
  calls.length = 0;
  await renderVideo(events, { runDir, run });
  assert.deepEqual(calls.map((a) => a[a.length - 1].split("/").pop()), ["story.mp4", "thumbnail.jpg"]);
});
