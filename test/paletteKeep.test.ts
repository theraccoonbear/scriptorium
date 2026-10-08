import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/eventlog.ts";
import { changedShare, designRun, paletteToneFor, sceneTags, tagRun } from "../src/tagging.ts";
import type { Role } from "../src/types.ts";

// Issue #135: in palette mode a one-line edit re-designed every speaker's
// tones, re-tagged every scene and re-voiced the whole book. Now the palette
// stays, only edited scenes are re-tagged, and their untouched paragraphs keep
// their tags and tones, so only the edited lines are voiced again.

const cast = { characters: { nell: { id: "nell", name: "Nell", traits: "", goal: "", voice: "clipped", status: "active" }, corin: { id: "corin", name: "Corin", traits: "", goal: "", voice: "light", status: "active" } } };
const scene1 = ['"Go home," Corin said.', '"Not without you," Nell said.', "The fire hissed."].join("\n\n");
const scene2 = ['"Please," Nell said.'].join("\n\n");

async function setup() {
  const log = new EventLog(await mkdtemp(join(tmpdir(), "scriptorium-keep-")));
  await log.load();
  await log.append("scene_committed", { index: 0, prose: scene1, bible: cast });
  await log.append("scene_committed", { index: 1, prose: scene2 });
  const calls = { palette: [] as string[][], tag: [] as number[] };
  // The voice director answers each paragraph by its text; `drift` changes its
  // mind about Corin's tone, as a model asked again may.
  let drift = false;
  const role: Role = { provider: { complete: async (req) => {
    const ctx = req.ctx as { task: string; castIds?: string[]; paragraphs?: string[] };
    if (ctx.task === "palette") {
      calls.palette.push(ctx.castIds ?? []);
      const all: Record<string, string[]> = { narrator: ["dry", "low"], nell: ["furious", "pleading"], corin: ["bright", "flat"], guard: ["bored"] };
      return JSON.stringify({ palettes: Object.fromEntries(["narrator", ...(ctx.castIds ?? [])].filter((id) => all[id]).map((id) => [id, all[id]])) });
    }
    calls.tag.push(ctx.paragraphs!.length);
    return JSON.stringify({ paragraphs: ctx.paragraphs!.map((p, k) => {
      const speaker = /Corin said/.test(p) ? "corin" : /Nell said/.test(p) ? "nell" : /guard said/.test(p) ? "guard" : "narrator";
      return { n: k + 1, speaker, tone: speaker === "corin" ? (drift ? 1 : 0) : speaker === "nell" ? 1 : 0 };
    }), newSpeakers: /guard said/.test(ctx.paragraphs!.join(" ")) ? [{ id: "guard", name: "Guard" }] : [] });
  } } } as Role;
  const palette = await designRun(log, role, 2);
  await tagRun(log, role, () => {}, palette);
  return { log, role, palette, calls, setDrift: (v: boolean) => { drift = v; } };
}

test("a prose edit keeps the palette; only the edited scene is tagged again, and its untouched lines keep their tones", async () => {
  const { log, role, palette, calls, setDrift } = await setup();
  assert.equal(calls.palette.length, 1);
  assert.deepEqual(calls.tag, [3, 1]);
  const tone = paletteToneFor(log.events, palette);
  assert.equal(tone(0, 0, "corin"), "bright");

  // Edit the narration in scene 1 only; the model, asked again, drifts on Corin's tone.
  await log.append("scene_committed", { index: 0, prose: scene1.replace("The fire hissed.", "The fire spat."), bible: cast });
  setDrift(true);
  const again = await designRun(log, role, 2);
  assert.equal(calls.palette.length, 1, "no new palette for a prose edit");
  assert.equal(again.source, palette.source);
  assert.deepEqual(await tagRun(log, role, () => {}, again), [0], "only the edited scene");
  assert.equal(paletteToneFor(log.events, again)(0, 0, "corin"), "bright", "Corin's unchanged line keeps its tone, whatever the model said this time");
  assert.equal(sceneTags(log.events).get(1)!.palette, palette.source, "scene 2's tags still stand");
});

test("a new speaker gets tones of their own under the same palette; --redo palette designs anew", async () => {
  const { log, role, palette, calls } = await setup();
  await log.append("scene_committed", { index: 1, prose: [scene2, '"Move along," the guard said.'].join("\n\n") });
  await tagRun(log, role, () => {}, palette);
  const grown = await designRun(log, role, 2);
  assert.deepEqual(calls.palette.at(-1), ["guard"], "designed for the newcomer only");
  assert.equal(grown.source, palette.source, "same palette, so other scenes' tags stay valid");
  assert.deepEqual(grown.speakers.nell, palette.speakers.nell);
  assert.deepEqual(grown.speakers.guard, { tones: ["bored"] });
  await designRun(log, role, 2, { fresh: true });
  assert.ok(calls.palette.at(-1)!.length > 1, "a fresh palette covers everyone");
});

test("the share of the book to voice again: the words of new or edited paragraphs (#149)", async () => {
  const { log } = await setup();
  assert.equal(changedShare(log.events), 0, "all tagged for the current prose");
  await log.append("scene_committed", { index: 0, prose: scene1.replace("The fire hissed.", "The fire spat and hissed."), bible: cast });
  const words = (s: string) => s.split(/\s+/).length;
  const total = words(scene1.replace("The fire hissed.", "The fire spat and hissed.").replace(/\n\n/g, " ")) + words(scene2);
  assert.equal(changedShare(log.events), words("The fire spat and hissed.") / total);
});
