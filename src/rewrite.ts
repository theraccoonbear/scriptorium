import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readApprovals } from "./approvals.ts";
import { formatFindings } from "./canon.ts";
import type { CanonFinding, CanonRound } from "./canon.ts";
import { renderStory, runStory } from "./engine.ts";
import { EventLog } from "./eventlog.ts";
import { buildRoleProviders } from "./providers.ts";
import { checkCanon } from "./roles.ts";
import { newRound } from "./rounds.ts";
import type { Round } from "./rounds.ts";
import type { Bible, Roles, SceneArtData, SceneCommittedData, StoryConfig, StoryEvent } from "./types.ts";

// Rewriting one scene with the author's note (#184): the story as it stood
// before that scene is replayed into a scratch log, the usual planner, writer
// and reviewers write just that scene again (the note riding as direction),
// and the new version replaces the old in the event log, backed up first. The
// scenes after it are then read against the new one, like the canon check, and
// what no longer fits is offered as fixes in a review round — never applied
// silently. The scene's shots are re-planned on the next art run; its lines
// re-voiced on the next audiobook run (changed paragraphs only).

export interface RewriteResult {
  scene: number;          // 0-based
  backup: string;
  round?: Round;          // later scenes' fixes, if any
  findings: CanonFinding[];
  approvedShots: string[];  // the scene's approved shots, to revoke so the new plan is drawn
  scratch: string;        // where the rewrite's own threads are
}

const pad = (n: number) => String(n).padStart(2, "0");

// The direction a rewrite adds to the director and the writer.
export function rewriteDirection(o: { scene: number; note: string; old: SceneCommittedData; next?: SceneCommittedData }): { director: string; writer: string } {
  const handOff = o.next ? ` The scene after it is written and stays: ${[o.next.beat?.title, o.next.beat?.goal].filter(Boolean).join(" — ")}. Keep the hand-off into it (where people are, what they know) unless the note changes it.` : "";
  return {
    director: `REWRITING SCENE ${o.scene + 1} — THE AUTHOR'S NOTE: ${o.note}\nPlan this scene again so it does what the note asks. Its previous beat, for reference: ${JSON.stringify({ title: o.old.beat?.title, turn: o.old.beat?.turn, goal: o.old.beat?.goal, mustReveal: o.old.beat?.mustReveal })}.${handOff}`,
    writer: `REWRITING THIS SCENE — THE AUTHOR'S NOTE: ${o.note}\nThe previous version follows for reference: keep what works and the note doesn't touch, change what it asks.\n<<<PREVIOUS VERSION\n${o.old.prose}\nPREVIOUS VERSION>>>`
  };
}

export const rewriteConfig = (config: StoryConfig, extra: { director: string; writer: string }): StoryConfig => ({
  ...config,
  direction: {
    ...config.direction,
    director: [config.direction?.director, extra.director].filter(Boolean).join("\n\n"),
    writer: [config.direction?.writer, extra.writer].filter(Boolean).join("\n\n")
  }
});

export async function rewriteScene(o: {
  runDir: string;
  config: StoryConfig;
  scene: number;          // 1-based, as the author says it
  note: string;
  total?: number;         // the story's planned scene count
  wrapRoles?: (roles: Roles) => Roles;  // tests: wrap the roles built with the rewrite's direction
  log?: (m: string) => void;
}): Promise<RewriteResult> {
  const say = o.log ?? (() => {});
  const k = o.scene - 1;
  if (!o.note.trim()) throw new Error("--redo scene:N on the story step needs a --note saying what should change");
  const real = new EventLog(o.runDir);
  const events = await real.load();
  const committed = events.filter((e) => e.type === "scene_committed");
  const target = [...committed].reverse().find((e) => (e.data as SceneCommittedData).index === k);
  if (!target) throw new Error(`scene ${o.scene} isn't written yet — write it with --only story first`);
  const old = target.data as SceneCommittedData;
  const next = [...committed].reverse().find((e) => (e.data as SceneCommittedData).index === k + 1)?.data as SceneCommittedData | undefined;
  const total = o.total ?? Math.max(...committed.map((e) => (e.data as SceneCommittedData).index)) + 1;

  // The story as it stood before this scene, in a scratch log of its own.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const scratch = join(o.runDir, "rewrites", `scene-${pad(o.scene)}-${stamp}`);
  const tmp = new EventLog(scratch);
  await mkdir(scratch, { recursive: true });
  await tmp.load();
  for (const e of events) {
    if (e.seq >= target.seq) break;
    await tmp.append(e.type, e.data);
  }
  const config = rewriteConfig(o.config, rewriteDirection({ scene: k, note: o.note, old, ...(next ? { next } : {}) }));
  const built = buildRoleProviders(config);
  const roles = o.wrapRoles ? o.wrapRoles(built) : built;
  const scratchRoles: Roles = { ...roles, artdirector: undefined } as Roles;  // shots are re-planned by the next art run
  say(`rewriting scene ${o.scene} with the note: ${o.note}`);
  await runStory({ config, log: tmp, roles: scratchRoles, runDir: scratch, scenes: total, stopAt: k + 1, ...(k === 0 && old.bible ? { foundation: old.bible as Bible } : {}) });
  const fresh = [...tmp.events].reverse().find((e) => e.type === "scene_committed" && (e.data as SceneCommittedData).index === k)?.data as SceneCommittedData | undefined;
  if (!fresh) throw new Error(`the rewrite of scene ${o.scene} didn't commit — see ${scratch}`);

  // The new version replaces the old in place; the scene's shot plan goes, so the next art run plans it anew.
  const file = join(o.runDir, "events.jsonl");
  const backup = join(o.runDir, "backups", `events.jsonl.before-rewrite-scene-${pad(o.scene)}-${stamp}`);
  await mkdir(join(o.runDir, "backups"), { recursive: true });
  await copyFile(file, backup);
  const lines: StoryEvent[] = (await readFile(file, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const replaced = lines
    .filter((e) => !(e.type === "scene_art" && (e.data as SceneArtData).sceneIndex === k))
    .map((e) => (e.seq === target.seq ? { ...e, data: { ...fresh, rewrite: { note: o.note, at: new Date().toISOString(), previousAttempts: old.attempts } } } : e));
  await writeFile(file, replaced.map((e) => JSON.stringify(e)).join("\n") + "\n");
  await writeFile(join(o.runDir, "story.md"), renderStory(replaced) + "\n");
  say(`scene ${o.scene} replaced (event log backed up: ${backup})`);

  // The scenes after it, read against the new one.
  const findings: CanonFinding[] = [];
  const role = roles.canon ?? roles.editor ?? roles.continuist;
  const canon = `THE REWRITTEN SCENE ${o.scene} (now canon — later scenes must agree with it):\n${fresh.prose}\n\nTHE AUTHOR'S NOTE FOR THE REWRITE: ${o.note}`;
  const art = new Map(replaced.filter((e) => e.type === "scene_art").map((e) => [(e.data as SceneArtData).sceneIndex, e.data as SceneArtData]));
  const later = new Map(replaced.filter((e) => e.type === "scene_committed").map((e) => [(e.data as SceneCommittedData).index, e.data as SceneCommittedData]));
  for (const [index, d] of [...later.entries()].filter(([i]) => i > k).sort((a, b) => a[0] - b[0])) {
    const shots = (art.get(index)?.shots ?? []).map((s, n) => ({ key: `scene-${pad(index + 1)}-${pad(n + 1)}`, prompt: s.prompt }));
    const out = await checkCanon(role, { canon, prose: d.prose, shots });
    for (const issue of out.result) findings.push({ n: findings.length + 1, scene: index, ...issue });
    say(`scene ${index + 1}: ${out.result.length ? `${out.result.length} place${out.result.length === 1 ? "" : "s"} no longer fit` : "still fits"}`);
  }
  let round: Round | undefined;
  if (findings.length) {
    round = await newRound(o.runDir, { kind: "canon", subject: "check", findings } satisfies CanonRound);
    const legend = formatFindings(findings, o.runDir, round)
      .replace(/^Canon check: .*$/m, `After rewriting scene ${o.scene}: ${findings.length} place${findings.length === 1 ? "" : "s"} in later scenes no longer fit (the run: ${o.runDir})`);
    await writeFile(join(round.dir, "legend.txt"), legend + "\n");
  }
  const approved = (await readApprovals(o.runDir)).art.filter((key) => key.startsWith(`scene-${pad(o.scene)}-`));
  return { scene: k, backup, ...(round ? { round } : {}), findings, approvedShots: approved, scratch };
}
