import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStoryFile, make, planSteps, settingChanges } from "../src/make.ts";
import { buildScenes, generateAudiobook, sceneFile, sceneRenderKey } from "../src/audiobook.ts";
import type { StoryEvent } from "../src/types.ts";

const repo = new URL("..", import.meta.url).pathname;

async function storyDir(story: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "scriptorium-make-"));
  await writeFile(join(dir, "ctx.md"), "A remote lighthouse on a rocky coast.");
  const file = join(dir, "story.json");
  await writeFile(file, JSON.stringify({ config: join(repo, "story.config.json"), out: "run", context: "ctx.md", scenes: 2, ...story }));
  return { dir, file };
}

test("story files resolve paths from their own directory and normalize options", async () => {
  const { dir, file } = await storyDir({ maxAttempts: "unlimited" });
  const s = await loadStoryFile(file);
  assert.equal(s.runDir, join(dir, "run"));
  assert.deepEqual(s.contextPaths, [join(dir, "ctx.md")]);
  assert.equal(s.maxAttempts, Infinity);
  assert.equal(s.config.providers.mock.type, "mock");
  const inline = await storyDir({ config: { providers: { mock: { type: "mock" } }, roles: {} } });
  assert.deepEqual((await loadStoryFile(inline.file)).config.roles, {});
  const bad = await storyDir({ maxAttempts: 0 });
  await assert.rejects(loadStoryFile(bad.file), /maxAttempts/);
  const noOut = await storyDir({ out: "" });
  await assert.rejects(loadStoryFile(noOut.file), /"out"/);
});

test("steps: all by default, --only picks, --from continues", () => {
  assert.deepEqual(planSteps(), ["story", "art", "audiobook", "music", "video"]);
  assert.deepEqual(planSteps("video,art"), ["art", "video"]);
  assert.deepEqual(planSteps(undefined, "audiobook"), ["audiobook", "music", "video"]);
  assert.throws(() => planSteps("art,dance"), /unknown step "dance"/);
  assert.throws(() => planSteps("art", "video"), /not both/);
});

test("settingChanges names what changed", () => {
  const base = { premise: "a", setting: null, context: "h1", contextFiles: ["x.md"], speakerTags: true };
  assert.deepEqual(settingChanges(base, { ...base }), []);
  assert.deepEqual(settingChanges(base, { ...base, premise: "b", speakerTags: false }), ["premise", "speakerTags"]);
  assert.match(settingChanges(base, { ...base, context: "h2", contextFiles: ["y.md"] })[0], /context \(x\.md → y\.md/);
});

test("make runs the pipeline into the fixed run dir; re-running finishes only what's missing", async () => {
  const { dir, file } = await storyDir({});
  const calls: string[] = [];
  const steps = {
    audiobook: async () => { calls.push("audiobook"); },
    video: async () => { calls.push("video"); }
  };
  assert.deepEqual(await make(file, { steps }), ["story", "art", "audiobook", "music", "video"]);
  const runDir = join(dir, "run");
  const events = (await readFile(join(runDir, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(events.filter((e: StoryEvent) => e.type === "scene_committed").length, 2);
  assert.equal(events.filter((e: StoryEvent) => e.type === "run_context").length, 1);
  const art = JSON.parse(await readFile(join(runDir, "art", "art.json"), "utf8"));
  assert.ok(Object.keys(art).length > 0);
  assert.deepEqual(calls, ["audiobook", "video"]);

  // Re-run: same directory, nothing new committed, art all skipped.
  const before = await readFile(join(runDir, "events.jsonl"), "utf8");
  await make(file, { steps });
  const after = await readFile(join(runDir, "events.jsonl"), "utf8");
  assert.equal(after.split("\n").filter((l) => l.includes('"scene_committed"')).length, 2);
  assert.equal(after.length, before.length, "no new events: the story was already finished");

  // --only / --from
  calls.length = 0;
  await make(file, { steps, only: "video" });
  assert.deepEqual(calls, ["video"]);
});

test("make refuses changed story settings for a story in progress unless forced", async () => {
  const { file } = await storyDir({ premise: "a lighthouse" });
  const steps = { art: async () => {}, audiobook: async () => {}, video: async () => {} };
  await make(file, { steps, only: "story" });
  const changed = JSON.parse(await readFile(file, "utf8"));
  changed.premise = "a submarine";
  await writeFile(file, JSON.stringify(changed));
  await assert.rejects(make(file, { steps }), /changes premise for a story already in progress/);
  await make(file, { steps, force: true });
});

test("the audiobook skips unchanged scenes without loading the model, and adopts pre-manifest audiobooks", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-audio-"));
  const events: StoryEvent[] = [
    { seq: 0, type: "scene_committed", ts: "t", data: { index: 0, prose: "narrator: The ridge was cold." } }
  ];
  const out = join(runDir, "audiobook");
  await mkdir(out, { recursive: true });
  await writeFile(join(out, sceneFile(0)), "RIFF");
  await writeFile(join(out, "timings.json"), JSON.stringify({ sampleRate: 24000, scenes: [{ index: 0, file: sceneFile(0), durationSec: 2, paragraphStarts: [0] }] }));
  const voices = { narrator: "af_heart", characters: {}, genders: {} };
  // Made before audio.json existed: WAV + timing + voices.json are adopted as current.
  await writeFile(join(out, "voices.json"), JSON.stringify(voices));
  const adopted = await generateAudiobook(events, { runDir });
  assert.equal(adopted.rendered, 0);
  assert.equal(adopted.skipped, 1);
  const manifest = JSON.parse(await readFile(join(out, "audio.json"), "utf8"));
  const settings = { narratorVoice: null, language: "en", genders: {}, modelId: "onnx-community/Kokoro-82M-v1.0-ONNX", dtype: "q8" };
  assert.equal(manifest.scenes[sceneFile(0)], sceneRenderKey(buildScenes(events)[0], settings));
  // Next run skips via the manifest; a changed setting would not match.
  assert.equal((await generateAudiobook(events, { runDir })).rendered, 0);
  assert.notEqual(sceneRenderKey(buildScenes(events)[0], { ...settings, narratorVoice: "am_adam" }), manifest.scenes[sceneFile(0)]);
});

test("story files layer direction and art style over the config, and reject unknown layers", async () => {
  const { file } = await storyDir({ artStyle: "Photorealistic.", direction: { artdirector: "Low angles.", artist: "Film grain." } });
  const s = await loadStoryFile(file);
  assert.equal(s.config.artStyle, "Photorealistic.");
  assert.deepEqual(s.config.direction, { artdirector: "Low angles.", artist: "Film grain." });
  const typo = await storyDir({ direction: { artdirectr: "x" } });
  await assert.rejects(loadStoryFile(typo.file), /unknown layer "artdirectr"/);
});

test("story files carry a budget, a draft cap and pricing; a malformed budget is rejected", async () => {
  const { file } = await storyDir({ budget: { usd: 5 }, maxDraftsPerScene: 12, pricing: { "my-model": { input: 1, output: 2 } } });
  const s = await loadStoryFile(file);
  assert.deepEqual(s.config.budget, { usd: 5 });
  assert.equal(s.config.maxDraftsPerScene, 12);
  assert.deepEqual(s.config.pricing, { "my-model": { input: 1, output: 2 } });
  const bad = await storyDir({ budget: 5 });
  await assert.rejects(loadStoryFile(bad.file), /"budget" must look like/);
});

test("story files set the critic mode and reject unknown ones", async () => {
  const { file } = await storyDir({ critic: "advisory" });
  assert.equal((await loadStoryFile(file)).config.critic, "advisory");
  const bad = await storyDir({ critic: "polite" });
  await assert.rejects(loadStoryFile(bad.file), /"critic" must be one of blocking, advisory, off/);
});

test("story files list a cast with photos relative to the file; a changed cast is a changed story", async () => {
  const { dir, file } = await storyDir({ cast: [{ name: "Don", photos: ["cast/don.jpg", "/abs/don2.jpg"], notes: "he/him" }, { name: "Biscuit", photos: "biscuit.png" }] });
  const s = await loadStoryFile(file);
  assert.deepEqual(s.cast, [
    { name: "Don", photos: [join(dir, "cast/don.jpg"), "/abs/don2.jpg"], notes: "he/him" },
    { name: "Biscuit", photos: [join(dir, "biscuit.png")] }
  ]);
  const bad = await storyDir({ cast: [{ name: "Don" }] });
  await assert.rejects(loadStoryFile(bad.file), /needs a "name" and at least one photo/);
  const base = { premise: "a", setting: null, context: "h", contextFiles: ["x.md"], speakerTags: true };
  assert.deepEqual(settingChanges({ ...base }, { ...base, cast: null }), [], "stories made before casts stay valid");
  assert.deepEqual(settingChanges({ ...base, cast: "h1" }, { ...base, cast: "h2" }), ["cast"]);
});

test("a story file's shared cast list is found relative to the story file", async () => {
  const { dir, file } = await storyDir({ audiobook: { castingFile: "../casts/osmagus.json", designVoices: ["osmagus"] } });
  const s = await loadStoryFile(file);
  assert.equal(s.audiobook.castingFile, join(dir, "../casts/osmagus.json"));
  assert.deepEqual(s.audiobook.designVoices, ["osmagus"]);
});

test("in parallel, make runs art and audio at the same time; the video waits for both, and a failure lets the other finish", async () => {
  const { file, dir } = await storyDir({});
  await make(file, { only: "story" });
  const log: string[] = [];
  const slow = (name: string, ms: number, fail = false) => async () => {
    log.push(`${name} start`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`${name} end`);
    if (fail) throw new Error(`${name} broke`);
  };
  await make(file, { from: "art", stepOrder: "parallel", steps: { art: slow("art", 30), audiobook: slow("audiobook", 10), video: slow("video", 1) } });
  assert.deepEqual(log, ["art start", "audiobook start", "audiobook end", "art end", "video start", "video end"]);
  log.length = 0;
  await assert.rejects(make(file, { from: "art", stepOrder: "parallel", steps: { art: slow("art", 5, true), audiobook: slow("audiobook", 20), video: slow("video", 1) } }), /art broke/);
  assert.deepEqual(log, ["art start", "audiobook start", "art end", "audiobook end"], "audio finished; the video never started");
  void dir;
});

test("by default audio runs before art (cheap first: a rewrite costs no images); art-first and the story file can change it", async () => {
  const { file } = await storyDir({});
  await make(file, { only: "story" });
  const order: string[] = [];
  const steps = { art: async () => { order.push("art"); }, audiobook: async () => { order.push("audiobook"); }, video: async () => { order.push("video"); } };
  await make(file, { from: "art", steps });
  assert.deepEqual(order, ["audiobook", "art", "video"]);
  order.length = 0;
  await make(file, { from: "art", stepOrder: "art-first", steps });
  assert.deepEqual(order, ["art", "audiobook", "video"]);
  const parallel = await storyDir({ stepOrder: "parallel" });
  assert.equal((await loadStoryFile(parallel.file)).stepOrder, "parallel");
  const bad = await storyDir({ stepOrder: "sideways" });
  await assert.rejects(loadStoryFile(bad.file), /"stepOrder" must be one of audio-first, art-first, parallel/);
});

test("a story file's art settings layer over the config's", async () => {
  const { file } = await storyDir({ artist: { batch: true, retakes: 0.5 } });
  const s = await loadStoryFile(file);
  assert.equal(s.config.artist?.batch, true);
  assert.equal(s.config.artist?.retakes, 0.5);
});

// Issue #84: review phases through make, with redo routed to the right phase.
test("make runs a review phase on its own, routing --redo to it", async () => {
  const { file } = await storyDir({});
  await make(file, { only: "story" });
  const calls: string[] = [];
  const steps = {
    characters: async () => { calls.push("characters"); },
    refs: async (_s: unknown, _e: unknown, redo: string[], notes?: string) => { calls.push(`refs ${redo.join(",")} ${notes ?? ""}`.trim()); },
    voices: async (_s: unknown, _e: unknown, redo: string[]) => { calls.push(`voices ${redo.join(",")}`.trim()); }
  };
  await make(file, { only: "refs,characters", steps });
  await make(file, { only: "refs", redo: ["character:nell"], notes: "older", steps });
  await make(file, { only: "voices", redo: ["voice:nell"], steps });
  assert.deepEqual(calls, ["characters", "refs", "refs character:nell older", "voices nell"]);
  await assert.rejects(make(file, { only: "art", redo: ["character:nell"], steps }), /refs phase/);
  await assert.rejects(make(file, { only: "refs", notes: "x", steps }), /--note goes with --redo/);

  // Shots (#100): one by key with the author's note, or a scene re-planned; only in the art step.
  const shots: unknown[] = [];
  const art = { ...steps, art: async (_s: unknown, _e: unknown, redo?: unknown) => { shots.push(redo); } };
  await make(file, { only: "art", redo: ["scene-04-07", "scene:5"], notes: "seven legs", steps: art });
  assert.deepEqual(shots, [{ redo: ["scene-04-07"], replan: [4], note: "seven legs" }]);
  await assert.rejects(make(file, { only: "refs", redo: ["scene-04-07"], steps: art }), /shots are redone in the art step/);
});

test("story files carry a title, subtitle and series, and video titles settings; malformed ones are rejected", async () => {
  const { file } = await storyDir({ title: "Rantoul's Mushrooms", subtitle: "Part 1", series: { next: "Part 2" }, video: { titles: { narrate: true, sceneTitles: ["The ditch"], ending: "The End" } } });
  const s = await loadStoryFile(file);
  assert.equal(s.title, "Rantoul's Mushrooms");
  assert.equal(s.subtitle, "Part 1");
  assert.deepEqual(s.series, { next: "Part 2" });
  assert.deepEqual(s.video.titles, { narrate: true, sceneTitles: ["The ditch"], ending: "The End" });
  assert.equal((await loadStoryFile((await storyDir({ video: { titles: false } })).file)).video.titles, false);
  await assert.rejects(loadStoryFile((await storyDir({ video: { titles: { sceneTitles: "yes" } } })).file), /"sceneTitles" must be/);
  await assert.rejects(loadStoryFile((await storyDir({ video: { titles: { narrate: "on" } } })).file), /"narrate" must be true or false/);
  await assert.rejects(loadStoryFile((await storyDir({ series: "Part 2" })).file), /"series" must look like/);
});

test("story files can pin each scene's tension and turn (null leaves it to the models); malformed pins are rejected", async () => {
  const { file } = await storyDir({ tension: [3, null, 9], turns: [null, "The rope breaks."] });
  const s = await loadStoryFile(file);
  assert.deepEqual(s.config.tension, [3, null, 9]);
  assert.deepEqual(s.config.turns, [null, "The rope breaks."]);
  await assert.rejects(loadStoryFile((await storyDir({ tension: [11] })).file), /"tension" must be a list of tension targets 1-10/);
  await assert.rejects(loadStoryFile((await storyDir({ tension: "rising" })).file), /"tension" must be/);
  await assert.rejects(loadStoryFile((await storyDir({ turns: [3] })).file), /"turns" must be a list/);
});
