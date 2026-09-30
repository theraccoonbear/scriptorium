import { mkdir, readdir, writeFile } from "node:fs/promises";
import { applyPatch, replay } from "./bible.ts";
import { mulberry32, pick } from "./rng.ts";
import { direct, createAndDirect, buildWorld, write, checkContinuity, review, archive, reviewBeat, reviewPatch, reviewWorld, normalizeIssue, renderIssue } from "./roles.ts";
import { recordTiming } from "./providers.ts";
import { c } from "./colors.ts";
import { EventLog } from "./eventlog.ts";
import type {
  Beat,
  Bible,
  GateResult,
  Issue,
  RoleOutput,
  Roles,
  SceneCommittedData,
  StoryConfig,
  StoryEvent,
  Verdict,
  WorldOutput
} from "./types.ts";

export const COMPLICATIONS = [
  "An ally withholds a crucial fact.",
  "A resource runs out at the worst moment.",
  "Someone arrives who should not be here.",
  "A plan works, but with a cost nobody priced in.",
  "An old promise is called in.",
  "The environment turns hostile.",
  "A secret is exposed to the wrong person.",
  "Two goals collide and only one can be served."
];

// Rise to a peak around 75% of the story, then fall toward resolution. Returns 1..10.
export function tensionAt(index: number, total: number): number {
  const x = (index + 0.5) / total;
  const level = x < 0.75 ? x / 0.75 : 1 - ((x - 0.75) / 0.25) * 0.6;
  return Math.max(1, Math.round(1 + level * 9));
}

async function writeRoleOutput(runDir: string, seq: number, role: string, { prompt, system, raw }: { prompt: string; system: string; raw: string }): Promise<void> {
  const label = `${String(seq).padStart(3, "0")}-${role}`;
  const out = [
    `# ${role}`,
    ``,
    `## System Prompt`,
    ``,
    system,
    ``,
    `## Prompt`,
    ``,
    prompt,
    ``,
    `## Raw Response`,
    ``,
    raw
  ].join("\n");
  await writeFile(`${runDir}/${label}.md`, out, "utf8");
}

async function writeStoryIncremental(runDir: string, events: StoryEvent[]): Promise<void> {
  const md = events
    .filter((e) => e.type === "scene_committed")
    .map((e) => {
      const d = e.data as SceneCommittedData;
      return `## Scene ${d.index + 1}\n\n${d.prose}`;
    })
    .join("\n\n");
  await writeFile(`${runDir}/story.md`, md + "\n", "utf8");
}

// Stable key for an issue: type + constraint (falls back to entity). The constraint
// is the rule being violated and survives rewording across drafts, unlike entity
// quotes which change every rewrite.
function issueKey(issue: Issue | string): string {
  const i = normalizeIssue(issue);
  const stable = (i.constraint || i.entity).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 50);
  return `${i.type}:${stable}`;
}

// Deduplicate structured issues by issueKey.
function dedupIssues<T extends Issue | string>(issues: T[]): T[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = issueKey(issue);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface RunStoryOptions {
  config: StoryConfig;
  log: EventLog;
  roles: Roles;
  scenes?: number;
  onScene?: (data: SceneCommittedData, bible: Bible) => void;
  runDir?: string;
  maxAttempts?: number;
}

export async function runStory({ config, log, roles, scenes, onScene, runDir, maxAttempts: maxAttemptsOverride }: RunStoryOptions): Promise<Bible> {
  await log.load();
  let bible = replay(log.events);
  const total = scenes ?? config.scenes;
  if (total === undefined) throw new Error("scenes must be set via config or --scenes");
  const overdueAfter = config.overdueAfter ?? 3;
  // Scene word band: writer stays inside it; critic flags >2x as blocking PACE.
  const sceneWords = config.sceneWords ?? { min: 1200, max: 1800 };
  // maxAttempts = total drafts allowed. Infinity = unbounded until both reviewers approve.
  const defaultAttempts = (config.maxRevisions ?? 2) + 1;
  const maxAttempts = maxAttemptsOverride ?? defaultAttempts;

  if (runDir) {
    await mkdir(runDir, { recursive: true });
  }

  console.error(`[scriptorium] ${c.dim(`starting: ${total} scenes, resuming from scene ${bible.sceneCount + 1}`)}`);

  let seq = 0;
  if (runDir) {
    try {
      const files = await readdir(runDir);
      seq = files.filter((f) => f.endsWith(".md")).length;
    } catch { /* empty dir */ }
  }

  // Collect prose from committed scenes for cross-scene continuity checks.
  const previousScenes = log.events
    .filter((e) => e.type === "scene_committed")
    .map((e) => (e.data as SceneCommittedData).prose);

  while (bible.sceneCount < total) {
    const i = bible.sceneCount;
    const rng = mulberry32((config.rngSeed ?? 1) * 1000 + i);
    const isFinal = i === total - 1;
    const tension = tensionAt(i, total);
    const complication = isFinal
      ? "Resolve the central conflict. No new complications."
      : pick(COMPLICATIONS, rng);
    const overdue = isFinal
      ? bible.ledger
      : bible.ledger.filter((s) => i - s.openedAt >= overdueAfter);

    console.error(`[scriptorium] ${c.blue(c.bold(`scene ${i + 1}/${total}`))} tension=${c.yellow(String(tension))}`);
    let t0 = Date.now();
    let beat!: RoleOutput<Beat>;
    let createdBible: Bible | null = null;
    let world: WorldOutput = { characters: [], locations: [], setting_notes: "" };
    const bounded = maxAttempts !== Infinity;
    // Bible as of scene start — creator regenerations merge onto this, not onto
    // a half-applied previous creator bible.
    const baseBible = bible;
    try {
      // World + beat production, each behind its gate with a revision ladder:
      // up to 2 revisions with feedback, then a fresh regeneration; repeats forever.
      // Bounded mode gives up after 4 generations (initial + 2 feedback + 1 fresh).
      const gatedGenerate = async <T>(params: {
        label: string;
        gen: (issues: Array<Issue | string>, fresh: boolean, generation: number) => Promise<T>;
        gate: (out: T) => Promise<GateResult>;
        feedback?: ReadonlyArray<Issue | string>;
        startFresh?: boolean;
      }): Promise<T> => {
        const { label, gen, gate, feedback = [], startFresh = false } = params;
        let issues: Array<Issue | string> = [...feedback];
        let fresh = startFresh;
        let feedbackTries = 0;
        const historyKeys = new Set(issues.map(issueKey));
        for (let generation = 0; ; generation++) {
          const out = await gen(issues, fresh, generation);
          const gateOut = await gate(out);
          if (gateOut.ok) return out;
          // Repeat-only rejection: gate flagged nothing the creative hasn't already
          // been given. No new fix is possible — treat as approval (same rule as prose).
          const newIssues = gateOut.issueList.filter((i) => !historyKeys.has(issueKey(i)));
          if (newIssues.length === 0) {
            console.error(`[scriptorium]   ${c.dim(`${label} gate: only repeat issues — accepted`)}`);
            return out;
          }
          if (bounded && generation + 1 >= 4) {
            throw new Error(`${label} gate rejected after ${generation + 1} attempts: ${gateOut.issueList.map((i) => renderIssue(i)).join("; ")}`);
          }
          for (const i of gateOut.issueList) historyKeys.add(issueKey(i));
          issues = dedupIssues([...issues, ...gateOut.issueList]);
          if (feedbackTries >= 2) {
            fresh = true;
            feedbackTries = 0;
          } else {
            fresh = false;
            feedbackTries++;
          }
          console.error(`[scriptorium]   ${c.retry(`${label} gate rejected (${newIssues.length} new issue${newIssues.length === 1 ? "" : "s"}) — ${fresh ? "fresh regeneration" : `revision ${feedbackTries}`}`)}`);
        }
      };

      // Produce a beat spec that passes the beat gate. feedback = issues from a
      // failed prose ladder (stage 3: the spec itself is what needs rethinking).
      const beatGateRole = roles.beatgate || roles.continuist;
      const produceBeat = (feedback: Array<Issue | string> = [], startFresh = false): Promise<RoleOutput<Beat>> => gatedGenerate({
        label: "beat",
        feedback,
        startFresh,
        gen: async (issues, fresh, generation) => {
          t0 = Date.now();
          if (i === 0 && bible.sceneCount === 0) {
            const out = await createAndDirect(roles.director, { sceneIndex: i, total, tension, complication, world, premise: config.premise || undefined, context: config.context, issues, fresh });
            createdBible = out.bible;
            bible = { ...baseBible, ...createdBible };
            beat = { result: out.beat, prompt: out.prompt, system: out.system, raw: out.raw };
            recordTiming("director", Date.now() - t0);
            if (runDir) await writeRoleOutput(runDir, ++seq, generation === 0 ? "creator" : `creator-g${generation}`, beat);
          } else {
            beat = await direct(roles.director, { bible, sceneIndex: i, total, tension, complication, overdue, issues, fresh });
            recordTiming("director", Date.now() - t0);
            if (runDir) await writeRoleOutput(runDir, ++seq, generation === 0 ? "director" : `director-g${generation}`, beat);
          }
          return beat;
        },
        gate: async (beatOut) => {
          t0 = Date.now();
          const g = await reviewBeat(beatGateRole, { bible, beat: beatOut.result, sceneIndex: i, total, tension, complication, overdue, context: config.context });
          recordTiming("beatgate", Date.now() - t0);
          if (runDir) await writeRoleOutput(runDir, ++seq, "beatgate", g);
          return { ok: g.result.ok, issueList: g.result.issues };
        }
      });

      const worldbuilderRole = roles.worldbuilder;
      if (i === 0 && bible.sceneCount === 0 && worldbuilderRole) {
        const worldGateRole = roles.worldgate || roles.continuist;
        world = await gatedGenerate({
          label: "world",
          feedback: [],
          gen: async (issues, fresh, generation) => {
            t0 = Date.now();
            const worldOut = await buildWorld(worldbuilderRole, { setting: config.setting || undefined, premise: config.premise || undefined, context: config.context, issues, fresh });
            recordTiming("worldbuilder", Date.now() - t0);
            if (runDir) await writeRoleOutput(runDir, ++seq, generation === 0 ? "worldbuilder" : `worldbuilder-g${generation}`, worldOut);
            return worldOut.result;
          },
          gate: async (worldOut) => {
            t0 = Date.now();
            const g = await reviewWorld(worldGateRole, { world: worldOut, setting: config.setting || undefined, premise: config.premise || undefined, context: config.context });
            recordTiming("worldgate", Date.now() - t0);
            if (runDir) await writeRoleOutput(runDir, ++seq, "worldgate", g);
            return { ok: g.result.ok, issueList: g.result.issues };
          }
        });
      }
      await produceBeat();

      let prose = "";
      let verdict: Verdict = { ok: false, issues: [] };
      let attempt = 0;
      let stage = 1;          // 1 = surgical revisions, 2 = fresh stab
      let surgicalTries = 0;  // consecutive stage-1 failures
      const contHistory: Issue[] = [];   // issues flagged by continuist in previous attempts
      const criticHistory: Issue[] = []; // issues flagged by critic in previous attempts
      for (;;) {
        if (bounded && attempt >= maxAttempts) {
          console.error(`[scriptorium]   ${c.fail(`draft budget exhausted (${attempt}/${maxAttempts}) — committing as-is`)}`);
          break;
        }
        const fresh = stage === 2;
        t0 = Date.now();
        const writeOut = await write(roles.writer, { bible, beat: beat.result, sceneIndex: i, attempt, sceneWords, issues: verdict.issues, previousDraft: prose, previousScenes, fresh });
        recordTiming("writer", Date.now() - t0);
        if (runDir) await writeRoleOutput(runDir, ++seq, `writer-a${attempt}`, writeOut);
        prose = writeOut.result;
        attempt++;

        // Continuist and critic run in parallel — identical context, different prompts.
        t0 = Date.now();
        const gateCtx = {
          bible, beat: beat.result, prose, sceneIndex: i, attempt: attempt - 1, previousScenes, sceneWords,
          previousIssues: dedupIssues([...contHistory, ...criticHistory]),
          context: config.context
        };
        const [contOut, criticOut] = await Promise.all([
          checkContinuity(roles.continuist, gateCtx),
          roles.critic
            ? review(roles.critic, gateCtx)
            : Promise.resolve(null)
        ]);
        recordTiming("continuist", Date.now() - t0);

        if (runDir) {
          if (contOut) await writeRoleOutput(runDir, ++seq, `continuist-a${attempt - 1}`, contOut);
          if (criticOut) await writeRoleOutput(runDir, ++seq, `critic-a${attempt - 1}`, criticOut);
        }

        // Snapshot history keys before recording this round's issues.
        const historyKeys = new Set([...contHistory, ...criticHistory].map(issueKey));

        // Track gate issues for next round's context.
        if (contOut) contHistory.push(...contOut.result.issues);
        if (criticOut) criticHistory.push(...criticOut.result.issues);

        // Combined verdict: both must approve to proceed to archivist.
        // A gate that rejects with only already-flagged issues has nothing new to
        // fix — the writer has seen them all. Treat as approval so the loop converges.
        const isNew = (issue: Issue): boolean => !historyKeys.has(issueKey(issue));
        const contNew = contOut ? contOut.result.issues.filter(isNew) : [];
        const criticNew = criticOut ? criticOut.result.issues.filter(isNew) : [];
        const contOk = contOut ? (contOut.result.ok || contNew.length === 0) : true;
        const criticOk = criticOut ? (criticOut.result.ok || criticNew.length === 0) : true;
        const combined = [
          ...(contOut ? contOut.result.issues : []),
          ...(criticOut ? criticOut.result.issues : [])
        ];
        verdict = {
          ok: contOk && criticOk,
          issues: dedupIssues(combined).slice(0, 8)
        };
        if (verdict.ok) {
          const repeatOnly: string[] = [];
          if (contOut && !contOut.result.ok && contNew.length === 0) repeatOnly.push("continuist");
          if (criticOut && !criticOut.result.ok && criticNew.length === 0) repeatOnly.push("critic");
          if (repeatOnly.length) {
            console.error(`[scriptorium]   ${c.dim(`${repeatOnly.join(" + ")}: only repeat issues — accepted`)}`);
          }
          break;
        }

        // Log rejections with red X — count only new issues (what will actually be shown).
        const rejections: string[] = [];
        if (!contOk) rejections.push(`continuist (${contNew.length} new issue${contNew.length === 1 ? "" : "s"})`);
        if (!criticOk) rejections.push(`critic (${criticNew.length} new issue${criticNew.length === 1 ? "" : "s"})`);
        console.error(`[scriptorium]   ${c.fail(`${rejections.join(" + ")} rejected`)}`);

        // Escalation ladder: 3 surgical revisions → fresh stab → regenerate the
        // beat itself (the spec may be the problem) → back to surgical. Cycles
        // until both gates go green in inf mode.
        const budgetLeft = !bounded || attempt < maxAttempts;
        if (stage === 1) {
          surgicalTries++;
          if (surgicalTries >= 3 && budgetLeft) {
            stage = 2;
            console.error(`[scriptorium]   ${c.retry("stage 2/3: fresh stab — writer starts from scratch, issues as guidance")}`);
          } else if (budgetLeft) {
            console.error(`[scriptorium]   ${c.dim(`stage 1/3: surgical revision ${surgicalTries + 1} of 3`)}`);
          }
        } else if (budgetLeft) {
          console.error(`[scriptorium]   ${c.retry("stage 3/3: regenerating beat spec — the spec may be the problem")}`);
          beat = await produceBeat(verdict.issues);
          prose = "";
          verdict = { ok: false, issues: [] };
          contHistory.length = 0;
          criticHistory.length = 0;
          surgicalTries = 0;
          stage = 1;
        }
      }

      // Archivist writes the bible patch; the patch gate must approve before it applies.
      const patchGateRole = roles.patchgate || roles.critic || roles.continuist;
      const archOut = await gatedGenerate({
        label: "patch",
        feedback: [],
        gen: async (issues, fresh, generation) => {
          t0 = Date.now();
          const out = await archive(roles.archivist, { bible, beat: beat.result, prose, sceneIndex: i, isFinal, issues, fresh });
          recordTiming("archivist", Date.now() - t0);
          if (runDir) await writeRoleOutput(runDir, ++seq, generation === 0 ? "archivist" : `archivist-g${generation}`, out);
          return out;
        },
        gate: async (arch) => {
          t0 = Date.now();
          const g = await reviewPatch(patchGateRole, { bible, beat: beat.result, prose, sceneIndex: i, patch: arch.result });
          recordTiming("patchgate", Date.now() - t0);
          if (runDir) await writeRoleOutput(runDir, ++seq, "patchgate", g);
          return { ok: g.result.ok, issueList: g.result.issues };
        }
      });
      const data: SceneCommittedData = {
        index: i,
        tension,
        complication,
        beat: beat.result,
        prose,
        patch: archOut.result,
        verdict,
        attempts: attempt
      };
      if (createdBible) data.bible = createdBible;
      await log.append("scene_committed", data);
      bible = applyPatch(bible, archOut.result, i);
      console.error(`[scriptorium] ${c.ok(`scene ${i + 1} committed`)}`);
      previousScenes.push(prose);
      if (runDir) await writeStoryIncremental(runDir, log.events);

      if (onScene) {
        onScene(data, bible);
      }
    } catch (err) {
      console.error(`[scriptorium] ${c.fail(`scene ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`)}`);
      throw err;
    }
  }
  console.error(`[scriptorium] ${c.ok(`done — ${total} scenes`)}`);
  return bible;
}

export function renderStory(events: StoryEvent[]): string {
  return events
    .filter((e) => e.type === "scene_committed")
    .map((e) => {
      const d = e.data as SceneCommittedData;
      return `## Scene ${d.index + 1}\n\n${d.prose}`;
    })
    .join("\n\n");
}
