import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/eventlog.ts";
import { buildRoleProviders, withRating } from "../src/providers.ts";
import { runStory } from "../src/engine.ts";
import { policyText, ratingCard, ratingReport, resolveRating, visualLimits } from "../src/ratings.ts";
import { artistDirection } from "../src/steps.ts";
import { buildTimeline, cardFilterGraph, cardSpec } from "../src/video.ts";
import type { CompletionRequest, StoryConfig } from "../src/types.ts";
import type { TitleCards } from "../src/titles.ts";

// Issue #88: a story held to an audience rating — a hard-blocking censor, a
// refusal for a story that can't be told at the rating at all, every creative
// role told the limits, a report, and a rating card at the start of the film.

test("a rating in the story file: a level, a TV rating, an age; lists; no advisory mode", () => {
  assert.equal(resolveRating("PG")!.base, "PG");
  assert.deepEqual([resolveRating("TV-Y7")!.base, resolveRating("TV-Y7")!.label], ["G", "TV-Y7"]);
  assert.equal(resolveRating({ age: 6 })!.base, "G", "a 6-year-old's story is G");
  assert.equal(resolveRating({ age: 10 })!.base, "PG");
  const p = resolveRating({ base: "PG", age: 8, forbid: ["spiders"], flag: ["mild peril"], allow: ["slapstick"] })!;
  assert.deepEqual([p.forbid, p.flag, p.allow, p.card], [["spiders"], ["mild peril"], ["slapstick"], true]);
  assert.throws(() => resolveRating({ base: "PG", mode: "advisory" }), /always blocks/);
  assert.throws(() => resolveRating("XXX"), /unknown rating/);
  assert.throws(() => resolveRating({ forbid: ["x"] }), /base rating or an age/);
  assert.equal(resolveRating(undefined), undefined, "off unless asked for");
});

test("the policy in words, the pictures' limits, and only the creative roles get them", async () => {
  const p = resolveRating({ base: "G", age: 6, forbid: ["spiders"] })!;
  const text = policyText(p);
  assert.match(text, /AUDIENCE RATING: G, for readers aged 6/);
  assert.match(text, /- gore: none: no blood, no wounds/);
  assert.match(text, /NEVER, whatever the rating allows: spiders/);
  assert.match(text, /READING LEVEL: words and sentences a 6-year-old/);
  assert.match(visualLimits(p), /Rated G: pictures show violence .*Never show: spiders/);
  assert.equal(artistDirection({ providers: {}, roles: {} } as unknown as StoryConfig), undefined, "an unrated story's images aren't redrawn");
  assert.match(artistDirection({ providers: {}, roles: {}, rating: p } as unknown as StoryConfig)!, /^Rated G/);
  const seen: Record<string, string> = {};
  const rated = withRating({ complete: async (req: CompletionRequest) => { seen[req.role] = req.prompt; return "{}"; } }, p);
  for (const role of ["writer", "director", "artdirector", "continuist", "archivist"]) await rated.complete({ role, system: "", prompt: role.toUpperCase() } as CompletionRequest);
  for (const role of ["writer", "director", "artdirector"]) assert.match(seen[role], /AUDIENCE RATING: G/, `${role} is told`);
  for (const role of ["continuist", "archivist"]) assert.equal(seen[role], role.toUpperCase(), `${role} isn't`);
});

async function ratedStory(rating: object | string, censor: (req: CompletionRequest, n: number) => string | undefined) {
  const base = JSON.parse(await readFile(new URL("../story.config.json", import.meta.url), "utf8"));
  const config = { ...base, scenes: 1, premise: "A gentle tale of a lost kitten.", rating: resolveRating(rating as never) } as StoryConfig;
  const roles = buildRoleProviders(config);
  const real = roles.continuist.provider.complete.bind(roles.continuist.provider);
  let calls = 0;
  const prompts: string[] = [];
  roles.continuist.provider = { complete: async (req) => {
    if (req.role === "censor") { prompts.push(req.prompt); const out = censor(req, calls++); if (out !== undefined) return out; }
    return real(req);
  } };
  roles.censor = roles.continuist;  // a story's own censor role takes both checks
  const dir = await mkdtemp(join(tmpdir(), "scriptorium-rated-"));
  const log = new EventLog(dir);
  return { config, roles, log, dir, prompts, calls: () => calls };
}

test("a story that can't be told at the rating is refused before a word is written", async () => {
  const s = await ratedStory({ age: 4 }, (req) => (req.ctx as { task?: string }).task === "ratingplan" ? JSON.stringify({ feasible: false, reason: "a slasher's whole point is gruesome killing", conflicts: [] }) : undefined);
  await assert.rejects(runStory({ config: s.config, log: s.log, roles: s.roles, runDir: s.dir }), /can't be told at that rating — a slasher's whole point is gruesome killing\. Nothing was written/);
  assert.equal(s.log.events.filter((e) => e.type === "scene_committed").length, 0);
  assert.match(await readFile(join(s.dir, "rating.md"), "utf8"), /\*\*Refused:\*\*/);
});

test("the censor is a hard block: a scene past the rating is rewritten until it isn't, then reported", async () => {
  let scene = 0;
  const s = await ratedStory("PG", (req) => {
    if ((req.ctx as { task?: string }).task === "ratingplan") return JSON.stringify({ feasible: true, reason: "", conflicts: [] });
    scene++;
    // The first draft goes past the rating; the same complaint again on the second is still a block.
    return scene <= 2
      ? JSON.stringify({ ok: false, issues: [{ type: "RATING", entity: "blood pooled", constraint: "PG: no gore", detail: "cut away before the wound" }], flags: [] })
      : JSON.stringify({ ok: true, issues: [], flags: ["a tense chase"] });
  });
  await runStory({ config: s.config, log: s.log, roles: s.roles, runDir: s.dir, maxAttemptsOverride: 5 } as never);
  assert.ok(scene >= 3, "a repeat of the same complaint wasn't accepted");
  assert.match(s.prompts.at(-1)!, /AUDIENCE RATING: PG/);
  const report = await readFile(join(s.dir, "rating.md"), "utf8");
  assert.match(report, /## Scene 1\nChanged for the rating:\n- \[RATING\] blood pooled/);
  assert.match(report, /Worth a parent knowing:\n- a tense chase/);
});

test("the rating card opens the film: the rating in a frame, its tagline, why, for whom, and whose rating it is", () => {
  const card = ratingCard(resolveRating({ base: "PG", age: 8, flag: ["mild peril", "rude humor"] })!);
  assert.deepEqual(card, { rating: "PG", tagline: "Parental guidance suggested", reasons: "Rated PG for mild peril, rude humor", age: "Written for ages 8 and up", note: "Rated by the author: not an MPA or broadcaster rating" });
  const titles: TitleCards = { title: "T", sceneCards: false, sceneTitles: {}, credits: [], font: "/f.ttf", titleFont: "/t.ttf", rating: card };
  const entry = (file: string, sceneIndex?: number, startParagraph?: number) => ({ file, prompt: file, finalPrompt: file, attempts: 1, accepted: true, issues: [], sceneIndex, startParagraph });
  const tl = buildTimeline({ "scene-01-01": entry("a.jpg", 0, 0), cover: entry("c.jpg") }, { sampleRate: 24000, scenes: [{ index: 0, file: "s.wav", durationSec: 10, paragraphStarts: [0] }] }, { titles });
  assert.deepEqual(tl.parts.slice(0, 2).map((p) => p.kind), ["rating", "intro"]);
  const spec = cardSpec(tl.parts[0], tl, titles);
  assert.deepEqual(spec.texts.map((t) => t.text), ["PG", "Parental guidance suggested", "Rated PG for mild peril, rude humor", "Written for ages 8 and up", "Rated by the author: not an MPA or broadcaster rating"]);
  const graph = cardFilterGraph(spec, tl.parts[0].frames, (t) => `/${t.length}`);
  assert.match(graph, /drawbox=x=760:y=230:w=400:h=200:color=0xF2E8D5:t=6/);
  assert.match(graph, /^color=0x1B5E33:/, "on the rating screen's familiar green");
});

test("the report lists the plan check and each scene", () => {
  const p = resolveRating({ base: "G", forbid: ["spiders"] })!;
  const md = ratingReport([
    { seq: 0, ts: "t", type: "rating_plan_check", data: { feasible: true, conflicts: [{ item: "the goblin war", why: "battle deaths", options: "make it a contest" }] } },
    { seq: 1, ts: "t", type: "rating_report", data: { index: 0, changed: ["[RATING] the cut"], flags: [] } }
  ], p);
  assert.match(md, /^# Rating report: G\n\nNever allowed: spiders\./);
  assert.match(md, /- \*\*the goblin war\*\*: battle deaths\. make it a contest/);
  assert.match(md, /## Scene 1\nChanged for the rating:\n- \[RATING\] the cut/);
});
