import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/eventlog.ts";
import { buildRoleProviders } from "../src/providers.ts";
import { runStory } from "../src/engine.ts";
import { checkLengthFit } from "../src/roles.ts";
import { fitMessage, lengthReport, measuredPace, resolveLength, sceneBudgets, tooLong, tooThin, wavSeconds } from "../src/length.ts";
import { formatPitch, pitch } from "../src/pitch.ts";
import { encodeWav } from "../src/geminiBatch.ts";
import type { CompletionRequest, Role, StoryConfig, StoryEvent } from "../src/types.ts";

// Issue #170: a story's length as a running time — word budgets at the
// narrator's pace, a fit check of the plan before anything is written, beats
// sized to each scene's share, and the pitch saying how long it runs.

test("a running time becomes word budgets: 12 minutes in 3 scenes, or the scene count chosen to fit", () => {
  const l = resolveLength({ minutes: 12, scenes: 3 });
  assert.equal(l.totalWords, 12 * 156);
  assert.deepEqual(l.sceneWords, { min: Math.round(624 * 0.85), max: Math.round(624 * 1.15) });
  assert.equal(resolveLength({ minutes: 60 }).scenes, 6, "about ten minutes a scene");
  assert.equal(resolveLength({ minutes: 2 }).scenes, 1);
  assert.equal(resolveLength({ minutes: 12, scenes: 3 }, { scenes: 4 }).scenes, 4, "the story file's scene count wins");
  assert.equal(resolveLength({ minutes: 10 }, { measuredWpm: 140 }).totalWords, 1400, "the narrator's measured pace");
  assert.equal(resolveLength({ minutes: 10, wordsPerMinute: 120 }, { measuredWpm: 140 }).totalWords, 1200, "the author's pace wins");
  assert.throws(() => resolveLength({ minutes: 0 }), /positive/);
  assert.throws(() => resolveLength({ minutes: 5, fit: "cram" as never }), /check/);
});

test("each scene's share follows the arc: the climax runs long, the whole adds up", () => {
  const b = sceneBudgets(3000, [3, 9, 5]);
  const mids = b.map((x) => (x.min + x.max) / 2);
  assert.ok(mids[1] > mids[2] && mids[2] > mids[0]);
  assert.ok(Math.abs(mids.reduce((a, x) => a + x, 0) - 3000) < 3);
});

const reply = (body: object): Role => ({ provider: { complete: async () => JSON.stringify(body) } } as unknown as Role);

test("the fit check: what the plan needs, what to cut, where to split; too long stops with the options", async () => {
  const out = await checkLengthFit(reply({
    items: [{ item: "the robbery", minutes: 2 }, { item: "the long argument at the inn", minutes: 4 }, { item: "", minutes: 1 }],
    needMinutes: 9, cuts: [{ item: "the long argument at the inn", saves: 3.5 }], split: "Part 1 ends at the inn"
  }), { story: "PREMISE: …", minutes: 3, scenes: 1, words: 468 });
  assert.equal(out.result.items.length, 2, "blank items dropped");
  const len = resolveLength({ minutes: 3, scenes: 1 });
  assert.ok(tooLong(out.result, 3));
  const msg = fitMessage(out.result, len);
  assert.match(msg, /needs about 9 minutes; you asked for 3/);
  assert.match(msg, /stretch: set "length": \{ "minutes": 9 \}/);
  assert.match(msg, /the long argument at the inn \(saves ~3.5 min\)/);
  assert.match(msg, /split: make it a series; Part 1 ends at the inn/);
  assert.match(msg, /"fit": "compress"/);
  assert.ok(!tooLong({ needMinutes: 3.5, items: [], cuts: [] }, 3), "a little over is the writing's to tighten");
  assert.ok(tooThin({ needMinutes: 2, items: [], cuts: [] }, 12));
  // No needMinutes: the items' sum, plus a tenth for the joins.
  const sum = await checkLengthFit(reply({ items: [{ item: "a", minutes: 2 }, { item: "b", minutes: 3 }] }), { story: "", minutes: 3, scenes: 1, words: 0 });
  assert.ok(Math.abs(sum.result.needMinutes - 5.5) < 1e-9);
});

async function timedStory(length: object, fit: (req: CompletionRequest) => string | undefined) {
  const base = JSON.parse(await readFile(new URL("../story.config.json", import.meta.url), "utf8"));
  const config = { ...base, scenes: 1, premise: "A wagon of friars, a stolen horn, a long road west.", length } as StoryConfig;
  const roles = buildRoleProviders(config);
  const prompts: Record<string, string[]> = {};
  for (const name of ["editor", "writer", "director"] as const) {
    const role = roles[name];
    if (!role) continue;
    const real = role.provider.complete.bind(role.provider);
    role.provider = { complete: async (req) => {
      (prompts[req.role] ??= []).push(req.prompt);
      if (req.role === "lengthfit") { const out = fit(req); if (out !== undefined) return out; }
      return real(req);
    } };
  }
  const dir = await mkdtemp(join(tmpdir(), "scriptorium-length-"));
  return { config, roles, log: new EventLog(dir), dir, prompts };
}

test("a plan far past its running time stops before a word is written, with the options in length.md", async () => {
  const s = await timedStory({ minutes: 3 }, () => JSON.stringify({ items: [{ item: "fifteen plot points", minutes: 9 }], needMinutes: 9, cuts: [{ item: "the inn", saves: 4 }], split: "" }));
  await assert.rejects(runStory({ config: s.config, log: s.log, roles: s.roles, runDir: s.dir }), /needs about 9 minutes; you asked for 3[\s\S]*compress/);
  assert.equal(s.log.events.filter((e) => e.type === "scene_committed").length, 0);
  assert.match(await readFile(join(s.dir, "length.md"), "utf8"), /## To fit, cut first\n- the inn/);
});

test("compress: the story goes ahead, the director told the scene's budget and what to tighten", async () => {
  const s = await timedStory({ minutes: 3, fit: "compress" }, () => JSON.stringify({ items: [{ item: "fifteen plot points", minutes: 9 }], needMinutes: 9, cuts: [{ item: "the inn", saves: 4 }], split: "" }));
  await runStory({ config: s.config, log: s.log, roles: s.roles, runDir: s.dir });
  assert.equal(s.log.events.filter((e) => e.type === "scene_committed").length, 1);
  const director = [...(s.prompts.creator ?? []), ...(s.prompts.director ?? [])].join("\n");
  assert.match(director, /LENGTH: this scene is \d+-\d+ words \(about 3 minutes read aloud\)/);
  assert.match(director, /chose to compress it: tighten, merge and summarize these first — the inn/);
  // Checked once: the run's log keeps the verdict.
  assert.equal(s.log.events.filter((e) => e.type === "length_check").length, 1);
});

test("the pitch says how long the story runs; the review, each scene against its budget", () => {
  const events: StoryEvent[] = [{ seq: 1, type: "scene_committed", ts: "t", data: { index: 0, prose: "narrator: " + "word ".repeat(1000) } } as StoryEvent];
  const p = pitch({ events, scenes: 3, wordsPerScene: 624, wordsPerMinute: 156, askedMinutes: 12, art: { skip: true }, audio: { skip: true } } as never);
  assert.equal(p.length.words, 1001 + 2 * 624, "a rough count: tags and all");
  assert.match(formatPitch(p), /~14 min read aloud \(asked 12\)/);
  const r = lengthReport(events, [{ min: 530, max: 718 }]);
  assert.deepEqual([r[0].words, r[0].off], [1000, "long"], "the speaker tag isn't a word");
});

test("the narrator's measured pace, from this run's voiced scenes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptorium-pace-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "audiobook"));
  // 120 seconds of silence for a 300-word scene: 150 words a minute.
  await writeFile(join(dir, "audiobook", "scene-01.wav"), encodeWav(new Float32Array(24000 * 120), 24000));
  assert.ok(Math.abs(wavSeconds(join(dir, "audiobook", "scene-01.wav"))! - 120) < 0.01);
  const events = [{ seq: 1, type: "scene_committed", ts: "t", data: { index: 0, prose: "word ".repeat(300) } }] as StoryEvent[];
  assert.equal(measuredPace(dir, events), 150);
  assert.equal(measuredPace(dir, []), undefined, "no scene, no pace");
});
