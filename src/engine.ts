import { createHash } from "node:crypto";
import { join } from "node:path";
import { policyText, writeRatingReport } from "./ratings.ts";
import { checkPlanRating, rate } from "./roles.ts";
import type { RatingConflict } from "./roles.ts";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { applyPatch, replay } from "./bible.ts";
import type { ArtDirection } from "./roles.ts";
import { shotCountFor, direct, createAndDirect, buildWorld, write, edit, checkContinuity, review, archive, reviewBeat, reviewPatch, reviewWorld, reviewContext, normalizeIssue, renderIssue, artDirect, checkShotCast, mergeShotCast, blockGroupPicture, checkLengthFit } from "./roles.ts";
import { findUntaggedParagraphs, sceneParagraphs, stripSpeakerTags } from "./audiobook.ts";
import { recordTiming } from "./providers.ts";
import { c } from "./colors.ts";
import { EventLog } from "./eventlog.ts";
import { isBudgetError } from "./usage.ts";
import { storedContext } from "./context.ts";
import { continuistLane, dedupIssues, sameIssue, stuckIssues } from "./review.ts";
import { readVisualRefs, refAppearances, storyArtStyle } from "./visualrefs.ts";
import { lookOf, portraitIds, recordedSheet } from "./characterSheet.ts";
import type { RefAppearances } from "./visualrefs.ts";
import type {
  Ambiguity,
  Beat,
  Bible,
  CoverArtData,
  GateResult,
  Issue,
  Patch,
  RoleOutput,
  Role,
  Roles,
  SceneArtData,
  SceneCommittedData,
  Setup,
  StoryConfig,
  StoryEvent,
  Verdict,
  VisualRefData,
  WorldOutput
} from "./types.ts";
import { CRITIC_MODES } from "./types.ts";
import { fitMessage, measuredPace, overBudget, resolveLength, sceneBudgets, tooLong, tooThin, underBudget, wordCount } from "./length.ts";
import type { LengthFit } from "./length.ts";
import { castCharacters } from "./cast.ts";

// The fallback arc, used only where neither the author nor the creator set a
// scene's tension: rise to a peak around 75% of the story, then fall. 1..10.
export function tensionAt(index: number, total: number): number {
  const x = (index + 0.5) / total;
  const level = x < 0.75 ? x / 0.75 : 1 - ((x - 0.75) / 0.25) * 0.6;
  return Math.max(1, Math.round(1 + level * 9));
}

// Which open setups fall due in scene i (#93). Only promises are ever overdue
// mid-story; a red herring, an open question or a motif stands by its kind.
// The final scene pays every promise, and by ambiguity: "tidy" also settles red
// herrings and open questions; "some" lets the two newest open questions stand;
// "lots" leaves them all. Motifs never fall due. `standing`: what the final
// scene may leave as it is, for the director to know.
export const OPEN_QUESTIONS_SURVIVING: Record<Ambiguity, number> = { tidy: 0, some: 2, lots: Infinity };
export function dueSetups(ledger: Setup[], i: number, isFinal: boolean, overdueAfter: number, ambiguity: Ambiguity = "some"): { due: Setup[]; standing: Setup[] } {
  const kind = (s: Setup) => s.kind ?? "promise";
  if (!isFinal) return { due: ledger.filter((s) => kind(s) === "promise" && i - s.openedAt >= overdueAfter), standing: [] };
  const questions = ledger.filter((s) => kind(s) === "open_question").sort((a, b) => b.openedAt - a.openedAt);
  const keep = new Set(questions.slice(0, OPEN_QUESTIONS_SURVIVING[ambiguity]).map((s) => s.id));
  const due = ledger.filter((s) => kind(s) === "promise" || (ambiguity === "tidy" && kind(s) === "red_herring") || (kind(s) === "open_question" && !keep.has(s.id)));
  return { due, standing: ledger.filter((s) => !due.includes(s)) };
}

// What the director planted on purpose goes into the ledger with its kind,
// whether or not the archivist recorded it; the plant's kind wins (#93).
export function withPlants(patch: Patch, beat: Beat, ledger: Setup[]): Patch {
  const plants = (beat.plants ?? []).filter((p) => p?.id && !ledger.some((s) => s.id === p.id));
  if (plants.length === 0) return patch;
  const open = [...(patch.openSetups ?? [])];
  for (const p of plants) {
    const k = open.findIndex((s) => s.id === p.id);
    const entry = { id: p.id, text: open[k]?.text || p.text, kind: p.kind, ...(p.purpose ? { purpose: p.purpose } : {}) };
    if (k >= 0) open[k] = entry; else open.push(entry);
  }
  return { ...patch, openSetups: open };
}

// Each scene's tension target: the author's pin, else the creator's arc, else the fallback.
export function planArc(total: number, pins: ReadonlyArray<number | null> | undefined, planned: ReadonlyArray<number | null> | undefined): number[] {
  return Array.from({ length: total }, (_, i) => pins?.[i] ?? planned?.[i] ?? tensionAt(i, total));
}

// The turns the story has already made, scene by scene (a run written before
// turns has the complication each scene was given instead).
export function storyTurns(events: StoryEvent[]): string[] {
  return events
    .filter((e) => e.type === "scene_committed")
    .map((e) => e.data as SceneCommittedData)
    .sort((a, b) => a.index - b.index)
    .map((d) => d.beat?.turn?.trim() || d.complication || "")
    .filter(Boolean);
}

// Each role's prompt and response, numbered in order, go in the run's threads/
// folder, so story.md and the other outputs stay easy to find.
export const THREADS_DIR = "threads";

async function nextThreadSeq(runDir: string): Promise<number> {
  try {
    return (await readdir(`${runDir}/${THREADS_DIR}`)).filter((f) => f.endsWith(".md")).length;
  } catch {
    return 0;  // no threads yet
  }
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
  await mkdir(`${runDir}/${THREADS_DIR}`, { recursive: true });
  await writeFile(`${runDir}/${THREADS_DIR}/${label}.md`, out, "utf8");
}

async function writeStoryIncremental(runDir: string, events: StoryEvent[]): Promise<void> {
  const knownSpeakers = new Set(Object.keys(replay(events).characters));
  const md = events
    .filter((e) => e.type === "scene_committed")
    .map((e) => {
      const d = e.data as SceneCommittedData;
      return `## Scene ${d.index + 1}\n\n${stripSpeakerTags(d.prose, knownSpeakers)}`;
    })
    .join("\n\n");
  await writeFile(`${runDir}/story.md`, md + "\n", "utf8");
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

// An author-set art style (config.artStyle) overrides the Creator's: record it
// once, or again when it changes, so art direction and the artist use it.
async function applyAuthorArtStyle(config: StoryConfig, log: EventLog): Promise<void> {
  const style = config.artStyle?.trim();
  if (style && storyArtStyle(log.events) !== style) await log.append("art_style", { style, source: "author" });
}

export async function runStory({ config, log, roles, scenes, onScene, runDir, maxAttempts: maxAttemptsOverride }: RunStoryOptions): Promise<Bible> {
  await log.load();
  await applyAuthorArtStyle(config, log);
  let bible = replay(log.events);
  const total = scenes ?? config.scenes;
  if (total === undefined) throw new Error("scenes must be set via config or --scenes");
  const overdueAfter = config.overdueAfter ?? 3;
  const ambiguity = config.ambiguity ?? "some";
  // Scene word band: writer stays inside it; critic flags >2x as blocking PACE.
  // A running time (#170) sets it instead, each scene's share weighted by the
  // arc; an explicit sceneWords still wins.
  const length = config.length ? resolveLength(config.length, { scenes: total, ...(runDir ? { measuredWpm: measuredPace(runDir, log.events) } : {}) }) : undefined;
  const wordsFor = (i: number, arc?: ReadonlyArray<number | null>) =>
    config.sceneWords ?? (length ? sceneBudgets(length.totalWords, planArc(total, config.tension, arc ?? bible.arc))[i] : { min: 1200, max: 1800 });
  let sceneWords = wordsFor(bible.sceneCount);
  // maxAttempts = total drafts allowed. Infinity = unbounded until both reviewers approve.
  const defaultAttempts = (config.maxRevisions ?? 2) + 1;
  const maxAttempts = maxAttemptsOverride ?? defaultAttempts;
  // The critic's say over a scene: blocking (default), advisory, or off (never called).
  const criticMode = config.critic ?? "blocking";
  if (!(CRITIC_MODES as readonly string[]).includes(criticMode)) {
    throw new Error(`critic must be one of ${CRITIC_MODES.join(", ")} (got "${criticMode}")`);
  }
  const critic = criticMode === "off" ? undefined : roles.critic;
  const advisory = criticMode === "advisory";
  // A rated story's censor (#88): its own role, else the continuist's model.
  const rating = config.rating;
  const censor = rating ? roles.censor ?? roles.continuist : undefined;
  const policy = rating ? policyText(rating) : "";

  if (runDir) {
    await mkdir(runDir, { recursive: true });
  }

  console.error(`[scriptorium] ${c.dim(`starting: ${total} scenes, resuming from scene ${bible.sceneCount + 1}`)}`);

  let seq = runDir ? await nextThreadSeq(runDir) : 0;

  // Author context: what this run was given, or — resuming without --context —
  // what it was started with.
  const stored = storedContext(log.events);
  if (config.context && config.context !== stored?.text) {
    await log.append("run_context", { files: config.contextFiles ?? [], text: config.context });
  } else if (!config.context && stored) {
    config = { ...config, context: stored.text, contextFiles: stored.files };
    console.error(`[scriptorium] ${c.dim(`using this run's context${stored.files.length ? ` (${stored.files.join(", ")})` : ""}`)}`);
  }

  // Context gate: once, before anything is generated. Contradictions between
  // the author's files stop the run here, at no cost, with both sides quoted —
  // the models don't get to silently pick a winner between files the author wrote.
  if (config.context && bible.sceneCount === 0) {
    const gateRole = roles.contextgate || roles.continuist;
    const t0 = Date.now();
    const g = await reviewContext(gateRole, { context: config.context, premise: config.premise || undefined, setting: config.setting || undefined });
    recordTiming("contextgate", Date.now() - t0);
    if (runDir) await writeRoleOutput(runDir, ++seq, "contextgate", g);
    if (!g.result.ok && g.result.issues.length > 0) {
      throw new Error(`context gate: the author context contradicts itself — fix the files and run again:\n${g.result.issues.map((x) => `  - ${renderIssue(x)}`).join("\n")}`);
    }
    console.error(`[scriptorium] ${c.ok(`context gate: ${config.contextFiles?.length ?? 1} context file${(config.contextFiles?.length ?? 1) === 1 ? "" : "s"} consistent`)}`);
  }

  // The story against the rating (#88), once, before anything is written.
  // A story that can't be told at the rating at all (a slasher for small
  // children) is refused outright: no setting overrides that, only a different
  // rating or premise. Plan items past the rating stop the run so the author
  // decides (allow it, raise the rating, soften the plan, or acceptPlan to have
  // the censor soften them scene by scene). The plan is never quietly rewritten.
  const storyText = [config.premise && `PREMISE: ${config.premise}`, config.setting && `SETTING: ${config.setting}`, config.context && `AUTHOR'S PLAN:\n${config.context}`].filter(Boolean).join("\n\n");
  if (rating && censor && storyText && bible.sceneCount === 0) {
    const source = createHash("sha1").update(JSON.stringify({ policy, story: storyText })).digest("hex");
    let check = log.events.filter((e) => e.type === "rating_plan_check").map((e) => e.data as { source: string; feasible?: boolean; reason?: string; conflicts: RatingConflict[] }).find((d) => d.source === source);
    if (!check) {
      // One call that decides whether the story may be written at all: the best
      // writer's model (a cheap one refused a gentle story over one changeable event).
      const out = await checkPlanRating(roles.censor ?? roles.editor ?? roles.writer ?? censor, { policy, plan: storyText });
      if (runDir) await writeRoleOutput(runDir, ++seq, "censor-plan", out);
      check = { source, ...out.result };
      await log.append("rating_plan_check", check);
      if (runDir) await writeRatingReport(runDir, log.events, rating);
    }
    if (check.feasible === false) {
      throw new Error(`rating ${rating.label}: this story can't be told at that rating — ${check.reason || "its premise is past it"}. Nothing was written. Change the rating or the premise.`);
    }
    if (check.conflicts.length && !rating.acceptPlan) {
      throw new Error(`rating ${rating.label}: the author's plan asks for things the rating can't show — choose for each (add it to rating.allow, raise the rating, soften the plan, or set rating.acceptPlan to let the censor soften it scene by scene):\n${check.conflicts.map((x) => `  - ${x.item}: ${x.why} (${x.options})`).join("\n")}${runDir ? `\n(also in ${join(runDir, "rating.md")})` : ""}`);
    }
    console.error(`[scriptorium] ${c.ok(`rating ${rating.label}: ${check.conflicts.length ? `${check.conflicts.length} plan item${check.conflicts.length === 1 ? "" : "s"} past the rating — accepted; the censor softens them` : "the story fits"}`)}`);
  }

  // The plan against its running time (#170), once, before anything is written:
  // a plan that needs far more time than it's given stops here with the
  // options (stretch, cut, split, or compress), never quietly crammed in.
  let lengthNote: string | undefined;
  if (length && length.fit !== "off" && storyText && bible.sceneCount === 0) {
    const source = createHash("sha1").update(JSON.stringify({ story: storyText, minutes: length.minutes, scenes: length.scenes })).digest("hex");
    let fit = log.events.filter((e) => e.type === "length_check").map((e) => e.data as LengthFit & { source: string }).find((d) => d.source === source);
    if (!fit) {
      const out = await checkLengthFit(roles.editor ?? roles.writer ?? roles.director, { story: storyText, minutes: length.minutes, scenes: length.scenes, words: length.totalWords });
      if (runDir) await writeRoleOutput(runDir, ++seq, "lengthfit", out);
      fit = { source, ...out.result };
      await log.append("length_check", fit);
    }
    if (runDir) await writeFile(join(runDir, "length.md"), lengthMarkdown(fit, length));
    if (tooLong(fit, length.minutes)) {
      if (length.fit === "check") throw new Error(`${fitMessage(fit, length)}${runDir ? `\n(also in ${join(runDir, "length.md")})` : ""}`);
      lengthNote = (fit.cuts.length ? fit.cuts : fit.items).map((x) => x.item).join("; ");
      console.error(`[scriptorium] ${c.retry(`length: the plan wants ~${Math.round(fit.needMinutes)} min for ${length.minutes} — compressing, as the author chose`)}`);
    } else {
      if (tooThin(fit, length.minutes)) console.error(`[scriptorium] ${c.retry(`length: the plan needs only ~${Math.round(fit.needMinutes)} of ${length.minutes} minutes — the scenes will have room to breathe, or ask for less`)}`);
      else console.error(`[scriptorium] ${c.ok(`length: the plan fits ${length.minutes} minutes (~${Math.round(fit.needMinutes)} needed)`)}`);
    }
  }

  // Collect prose from committed scenes for cross-scene continuity checks.
  const previousScenes = log.events
    .filter((e) => e.type === "scene_committed")
    .map((e) => (e.data as SceneCommittedData).prose);

  while (bible.sceneCount < total) {
    const i = bible.sceneCount;
    const isFinal = i === total - 1;
    // Scene 1's tension comes from the arc the creator is about to plan (unless the author pinned it).
    const creating = i === 0 && bible.sceneCount === 0;
    let tension = planArc(total, config.tension, bible.arc)[i];
    sceneWords = wordsFor(i);
    const turn = config.turns?.[i]?.trim() || undefined;
    const earlierTurns = storyTurns(log.events);
    // With an author's plan, setups are paid where the plan pays them: an
    // unexplained detail may stay unexplained on purpose, so none is overdue.
    // Otherwise only promises fall due (#93); the rest stand by their kind.
    const { due: overdue, standing } = config.context
      ? { due: [], standing: [] }
      : dueSetups(bible.ledger, i, isFinal, overdueAfter, ambiguity);

    console.error(`[scriptorium] ${c.blue(c.bold(`scene ${i + 1}/${total}`))} tension=${c.yellow(creating && config.tension?.[0] == null ? "from the creator's arc" : String(tension))}${turn ? c.dim(` · the author's turn: ${turn}`) : ""}`);
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
        const history: Array<Issue | string> = [...issues];
        for (let generation = 0; ; generation++) {
          const out = await gen(issues, fresh, generation);
          const gateOut = await gate(out);
          if (gateOut.ok) return out;
          // Repeat-only rejection: gate flagged nothing the creative hasn't already
          // been given. No new fix is possible — treat as approval (same rule as prose).
          const newIssues = gateOut.issueList.filter((i) => !history.some((h) => sameIssue(h, i)));
          if (newIssues.length === 0) {
            console.error(`[scriptorium]   ${c.dim(`${label} gate: only repeat issues — accepted`)}`);
            return out;
          }
          if (bounded && generation + 1 >= 4) {
            throw new Error(`${label} gate rejected after ${generation + 1} attempts: ${gateOut.issueList.map((i) => renderIssue(i)).join("; ")}`);
          }
          history.push(...gateOut.issueList);
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
            const out = await createAndDirect(roles.director, { sceneIndex: i, total, arc: config.tension, turn, world, premise: config.premise || undefined, context: config.context, issues, fresh, ambiguity, ...(length ? { sceneWords: length.sceneWords } : {}), ...(lengthNote ? { lengthNote } : {}) });
            createdBible = out.bible;
            bible = { ...baseBible, ...createdBible };
            const arc = planArc(total, config.tension, createdBible.arc);
            tension = arc[0];
            sceneWords = wordsFor(0, createdBible.arc);
            console.error(`[scriptorium]   ${c.dim(`arc: ${arc.join(" ")}`)}`);
            beat = { result: out.beat, prompt: out.prompt, system: out.system, raw: out.raw };
            recordTiming("director", Date.now() - t0);
            if (runDir) await writeRoleOutput(runDir, ++seq, generation === 0 ? "creator" : `creator-g${generation}`, beat);
          } else {
            beat = await direct(roles.director, { bible, sceneIndex: i, total, tension, turn, earlierTurns, overdue, context: config.context, issues, fresh, ambiguity, ...(standing.length ? { standing } : {}), ...(length ? { sceneWords } : {}), ...(lengthNote ? { lengthNote } : {}) });
            recordTiming("director", Date.now() - t0);
            if (runDir) await writeRoleOutput(runDir, ++seq, generation === 0 ? "director" : `director-g${generation}`, beat);
          }
          return beat;
        },
        gate: async (beatOut) => {
          t0 = Date.now();
          const g = await reviewBeat(beatGateRole, { bible, beat: beatOut.result, sceneIndex: i, total, tension, turn, earlierTurns, overdue, context: config.context });
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
      let suggestions: Issue[] = [];   // advisory critic's notes for the next draft
      let attempt = 0;
      let stage = 1;          // 1 = surgical revisions, 2 = fresh stab
      let surgicalTries = 0;  // consecutive stage-1 failures
      const contHistory: Issue[] = [];   // issues flagged by continuist in previous attempts
      const censorHistory: Issue[] = []; // the censor's, across this scene's drafts (#88)
      let ratingFlags: string[] = [];    // the censor's notes on the latest draft, for the report
      const criticHistory: Issue[] = []; // issues flagged by critic in previous attempts
      const rounds: Issue[][] = [];      // every round's issues (both reviewers), for stuck-passage detection
      for (;;) {
        if (bounded && attempt >= maxAttempts) {
          console.error(`[scriptorium]   ${c.fail(`draft budget exhausted (${attempt}/${maxAttempts}) — committing as-is`)}`);
          break;
        }
        // Hard stop for a scene that won't settle, whatever maxAttempts says.
        // Unbounded mode never commits a rejected scene, so this ends the run.
        const draftCap = config.maxDraftsPerScene ?? 20;
        if (attempt >= draftCap) {
          throw new Error(`scene ${i + 1} is stuck: ${attempt} drafts without both reviewers approving (maxDraftsPerScene ${draftCap}) — check the run's reviewer output, then raise maxDraftsPerScene or adjust direction and re-run`);
        }
        const fresh = stage === 2;
        t0 = Date.now();
        const writeOut = await write(roles.writer, { bible, beat: beat.result, sceneIndex: i, attempt, sceneWords, issues: verdict.issues, suggestions, previousDraft: prose, previousScenes, fresh, speakerTags: config.speakerTags });
        recordTiming("writer", Date.now() - t0);
        if (runDir) await writeRoleOutput(runDir, ++seq, `writer-a${attempt}`, writeOut);
        prose = writeOut.result;
        attempt++;

        // Line editor (optional): polishes the draft before review. An edit
        // that cuts too much, pads, or loses speaker tags is discarded.
        if (roles.editor) {
          t0 = Date.now();
          const editor = roles.editor;
          const edited = await nonFatalValue(`scene ${i + 1} line edit`, () => edit(editor, { bible, prose, sceneIndex: i, previousScene: previousScenes.at(-1), sceneWords }));
          recordTiming("editor", Date.now() - t0);
          if (edited) {
            if (runDir) await writeRoleOutput(runDir, ++seq, `editor-a${attempt - 1}`, edited);
            const problem = editProblem(prose, edited.result, config.speakerTags ? new Set(Object.keys(bible.characters)) : undefined);
            if (problem) console.error(`[scriptorium]   ${c.retry(`editor: ${problem} — keeping the unedited draft`)}`);
            else prose = edited.result;
          }
          // Held to its budget (#170): a draft well past it is trimmed once.
          const words = wordCount(prose);
          if (overBudget(words, sceneWords)) {
            console.error(`[scriptorium]   ${c.retry(`scene ${i + 1} runs ${words} words, over its ${sceneWords.min}-${sceneWords.max} — trimming`)}`);
            const trimmed = await nonFatalValue(`scene ${i + 1} trim`, () => edit(editor, { bible, prose, sceneIndex: i, previousScene: previousScenes.at(-1), sceneWords, trim: true }));
            if (trimmed) {
              if (runDir) await writeRoleOutput(runDir, ++seq, `editor-trim-a${attempt - 1}`, trimmed);
              const problem = editProblem(prose, trimmed.result, config.speakerTags ? new Set(Object.keys(bible.characters)) : undefined, sceneWords.min * 0.85);
              if (problem) console.error(`[scriptorium]   ${c.retry(`trim: ${problem} — keeping the longer draft`)}`);
              else prose = trimmed.result;
            }
          }
        }
        if (underBudget(wordCount(prose), sceneWords)) console.error(`[scriptorium]   ${c.retry(`scene ${i + 1} runs ${wordCount(prose)} words, short of its ${sceneWords.min}-${sceneWords.max}`)}`);

        // Non-blocking compliance check: parseScene already falls back an
        // untagged paragraph to narrator, so this can't break the run — it's
        // a quality signal (the writer skipped a tag) worth surfacing, not a
        // reason to burn a revision attempt on.
        if (config.speakerTags) {
          const untagged = findUntaggedParagraphs(prose, new Set(Object.keys(bible.characters)));
          if (untagged.length > 0) {
            console.error(`[scriptorium]   ${c.retry(`${untagged.length} paragraph${untagged.length === 1 ? "" : "s"} missing a speaker tag — falling back to narrator`)}`);
          }
        }

        // Continuist and critic run in parallel — identical context, different prompts.
        t0 = Date.now();
        const gateCtx = {
          bible, beat: beat.result, prose, sceneIndex: i, attempt: attempt - 1, previousScenes, sceneWords,
          previousIssues: dedupIssues([...contHistory, ...criticHistory]),
          context: config.context
        };
        const [contRaw, criticOut, censorOut] = await Promise.all([
          checkContinuity(roles.continuist, gateCtx),
          critic
            ? review(critic, gateCtx)
            : Promise.resolve(null),
          censor ? rate(censor, { ...gateCtx, policy }) : Promise.resolve(null)
        ]);
        recordTiming("continuist", Date.now() - t0);
        // Craft flags are the critic's lane; drop them from the continuist's verdict.
        let contOut = contRaw;
        if (contRaw) {
          const lane = continuistLane(contRaw.result);
          if (lane.dropped.length > 0) {
            console.error(`[scriptorium]   ${c.dim(`continuist: ignored ${lane.dropped.length} craft issue${lane.dropped.length === 1 ? "" : "s"} (critic's lane)`)}`);
          }
          contOut = { ...contRaw, result: lane.verdict };
        }

        if (runDir) {
          if (contOut) await writeRoleOutput(runDir, ++seq, `continuist-a${attempt - 1}`, contOut);
          if (criticOut) await writeRoleOutput(runDir, ++seq, `critic-a${attempt - 1}`, criticOut);
          if (censorOut) await writeRoleOutput(runDir, ++seq, `censor-a${attempt - 1}`, censorOut);
        }

        // Snapshot history before recording this round's issues.
        const history = [...contHistory, ...criticHistory, ...censorHistory];

        // Track gate issues for next round's context.
        if (contOut) contHistory.push(...contOut.result.issues);
        if (criticOut) criticHistory.push(...criticOut.result.issues);
        if (censorOut) { censorHistory.push(...censorOut.result.issues); ratingFlags = censorOut.result.flags; }

        // Combined verdict: both must approve to proceed to archivist.
        // A gate that rejects with only already-flagged issues has nothing new to
        // fix — the writer has seen them all. Treat as approval so the loop converges.
        // "Already flagged" means the same complaint however it's reworded (sameIssue),
        // not just an identical key.
        const isNew = (issue: Issue): boolean => !history.some((h) => sameIssue(h, issue));
        const contNew = contOut ? contOut.result.issues.filter(isNew) : [];
        const criticNew = criticOut ? criticOut.result.issues.filter(isNew) : [];
        const contOk = contOut ? (contOut.result.ok || contNew.length === 0) : true;
        // An advisory critic never blocks: its notes go to the writer as optional
        // suggestions, and only when the continuist sends the draft back anyway.
        const criticOk = advisory || (criticOut ? (criticOut.result.ok || criticNew.length === 0) : true);
        // The censor is a hard block (#88): a passage past the rating is never
        // let through, not even as a repeat the writer has already seen.
        const censorBlocks = censorOut && !censorOut.result.ok ? censorOut.result.issues : [];
        const censorOk = censorBlocks.length === 0;
        const combined = [
          ...censorBlocks,
          ...(contOut ? contOut.result.issues : []),
          ...(criticOut && !advisory ? criticOut.result.issues : [])
        ];
        verdict = {
          ok: contOk && criticOk && censorOk,
          issues: dedupIssues(combined).slice(0, 8)
        };
        suggestions = advisory && criticOut ? dedupIssues(criticOut.result.issues).slice(0, 5) : [];
        if (verdict.ok) {
          if (suggestions.length > 0) {
            console.error(`[scriptorium]   ${c.dim(`critic (advisory): ${suggestions.length} note${suggestions.length === 1 ? "" : "s"} not applied — continuity is clean`)}`);
          }
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
        if (!censorOk) rejections.push(`censor (${censorBlocks.length} past the ${rating!.label} rating)`);
        console.error(`[scriptorium]   ${c.fail(`${rejections.join(" + ")} rejected`)}`);

        // Escalation ladder: 3 surgical revisions → fresh stab → regenerate the
        // beat itself (the spec may be the problem) → back to surgical. Cycles
        // until both gates go green in inf mode. A passage flagged in 3 drafts
        // (reworded repeats, or reviewers demanding opposite fixes) skips
        // straight to the beat: another draft won't settle it.
        const budgetLeft = !bounded || attempt < maxAttempts;
        rounds.push(combined.map(normalizeIssue));
        const stuck = stuckIssues(rounds);
        if (stuck.length > 0 && budgetLeft) {
          console.error(`[scriptorium]   ${c.retry(`stuck: ${stuck.length} passage${stuck.length === 1 ? "" : "s"} flagged in 3+ drafts — regenerating beat spec`)}`);
          beat = await produceBeat(dedupIssues(stuck));
          prose = "";
          verdict = { ok: false, issues: [] };
          suggestions = [];
          contHistory.length = 0;
          criticHistory.length = 0;
          rounds.length = 0;
          surgicalTries = 0;
          stage = 1;
          continue;
        }
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
          suggestions = [];
          contHistory.length = 0;
          criticHistory.length = 0;
          rounds.length = 0;
          surgicalTries = 0;
          stage = 1;
        }
      }

      // Archivist writes the bible patch; the patch gate must approve before it applies.
      const patchGateRole = roles.patchgate || critic || roles.continuist;
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
        beat: beat.result,
        prose,
        patch: archOut.result,
        verdict,
        attempts: attempt
      };
      if (createdBible) data.bible = createdBible;
      data.patch = withPlants(data.patch, beat.result, bible.ledger);
      await log.append("scene_committed", data);
      if (rating) {
        // What the censor changed on the way (#88), and what a parent should know.
        await log.append("rating_report", { index: i, changed: dedupIssues(censorHistory).map(renderIssue), flags: ratingFlags });
        if (runDir) await writeRatingReport(runDir, log.events, rating);
      }
      bible = applyPatch(bible, data.patch, i);
      console.error(`[scriptorium] ${c.ok(`scene ${i + 1} committed`)}`);
      previousScenes.push(prose);
      if (runDir) await writeStoryIncremental(runDir, log.events);

      // Art Director: canonical props first (canon key objects, and key props
      // the scene shows — shots can only name known props), then a sequence of
      // shots for this scene, each anchored to the paragraph where it comes on
      // screen, with character and location references made for whoever and
      // wherever those shots show. The scene is already canon, so failures only warn.
      if (roles.artdirector) {
        const artRole = roles.artdirector;
        const recordRefs = async (out: RoleOutput<ArtDirection>) => {
          if (runDir && (out.result.references ?? []).length > 0) await writeRoleOutput(runDir, ++seq, "artdirector-references", out);
        };
        await nonFatal(`scene ${i + 1} visual references`, async () => {
          const known = new Set(Object.keys(bible.characters));
          await directReferences(artRole, bible, log, sceneParagraphs(prose, known), recordRefs, new Set(), undefined, { characterIds: [], locationIds: [] });
        });
        await nonFatal(`scene ${i + 1} art prompts`, async () => {
          const { drafts } = await directSceneShots(artRole, config, bible, beat.result, prose, i, sceneArtPrompts(log.events), log, recordRefs);
          for (const d of drafts) if (runDir) await writeRoleOutput(runDir, ++seq, "artdirector", d);
          const out = drafts.at(-1)!;
          const art: SceneArtData = { sceneIndex: i, prompt: out.result.prompt, shots: out.result.shots, ...(out.result.continuity ? { continuity: out.result.continuity } : {}) };
          await log.append("scene_art", art);
        });
      }

      if (onScene) {
        onScene(data, bible);
      }
    } catch (err) {
      console.error(`[scriptorium] ${c.fail(`scene ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`)}`);
      throw err;
    }
  }

  // Cover art: one montage prompt once the story is complete. Skipped if the
  // log already has a cover for exactly this many scenes (e.g. a resumed run).
  const committed = log.events.filter((e) => e.type === "scene_committed").map((e) => e.data as SceneCommittedData);
  const lastCover = log.events.filter((e) => e.type === "cover_art").at(-1)?.data as CoverArtData | undefined;
  if (roles.artdirector && committed.length > 0 && lastCover?.sceneCount !== committed.length) {
    const artRole = roles.artdirector;
    await nonFatal("cover art prompt", async () => {
      const { out, characters } = await directCoverArt(artRole, bible, committed, sceneArtPrompts(log.events), refAppearances(log.events), storyArtStyle(log.events), coverLeads(log.events, bible, config.title));
      if (runDir) await writeRoleOutput(runDir, ++seq, "artdirector-cover", out);
      const cover: CoverArtData = { sceneCount: committed.length, prompt: out.result.prompt, ...(characters ? { characters } : {}) };
      await log.append("cover_art", cover);
    });
  }

  console.error(`[scriptorium] ${c.ok(`done — ${total} scenes`)}`);
  return bible;
}

// Why a line edit can't be used, or undefined when it's fine: the editor
// trims, it doesn't gut or pad a scene, and it keeps the speaker tags.
// The fit check, for the author to read (length.md).
function lengthMarkdown(fit: LengthFit, len: { minutes: number; scenes: number; totalWords: number; wordsPerMinute: number }): string {
  return [
    `# Length`,
    ``,
    `Asked: **${len.minutes} minutes** in ${len.scenes} scene${len.scenes === 1 ? "" : "s"} (~${len.totalWords} words at ${len.wordsPerMinute} a minute). The plan needs **about ${Math.round(fit.needMinutes * 10) / 10} minutes**.`,
    ``,
    `## What the plan asks for`,
    ...fit.items.map((x) => `- ${x.item} (${x.minutes} min)`),
    ...(fit.cuts.length ? [``, `## To fit, cut first`, ...fit.cuts.map((x) => `- ${x.item} (saves ${x.saves} min)`)] : []),
    ...(fit.split ? [``, `## To split it`, fit.split] : []),
    ``
  ].join("\n");
}

// `floor`: a trim to budget may cut more than an edit, down to this many words.
export function editProblem(original: string, edited: string, tagIds?: ReadonlySet<string>, floor?: number): string | undefined {
  const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
  const before = words(original);
  const after = words(edited);
  if (after === 0) return "empty edit";
  if (floor !== undefined ? after < floor : after < before * 0.75) return `edit cut ${Math.round(100 - (after / before) * 100)}% of the scene`;
  if (after > before * 1.1) return `edit grew the scene by ${Math.round((after / before) * 100 - 100)}%`;
  if (tagIds && findUntaggedParagraphs(edited, tagIds).length > findUntaggedParagraphs(original, tagIds).length) return "edit lost speaker tags";
  return undefined;
}

// Up to `limit` paragraphs of committed prose that mention each character or
// location by any part of its name — where the story establishes pronouns and looks.
export function storyMentions(bible: Bible, events: StoryEvent[], ids: string[], limit = 4, maxChars = 400): Record<string, string[]> {
  const known = new Set(Object.keys(bible.characters));
  const paragraphs = events
    .filter((e) => e.type === "scene_committed")
    .flatMap((e) => sceneParagraphs((e.data as SceneCommittedData).prose, known));
  const out: Record<string, string[]> = {};
  for (const id of ids) {
    const name = bible.characters[id]?.name ?? bible.locations[id]?.name ?? bible.objects?.[id]?.name ?? id;
    const names = name.split(/\s+/).map((w) => w.replace(/[^\p{L}'-]/gu, "")).filter((w) => w.length >= 3 && !/^(the|of|and)$/i.test(w));
    if (names.length === 0) continue;
    const pattern = new RegExp(`\\b(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`);
    const hits = paragraphs.filter((p) => pattern.test(p)).slice(0, limit);
    if (hits.length > 0) out[id] = hits.map((p) => (p.length > maxChars ? `${p.slice(0, maxChars)}…` : p));
  }
  return out;
}

// References for characters and locations in the bible that have none yet,
// plus any new key props found in `storyText`. `redo` ("kind:id") forces a
// fresh reference for ones that exist but came out wrong.
//
// Batched so no single reply grows with the cast (one call for a whole cast
// overran the model's output limit): up to 3 characters per call, then up to
// 3 locations, then one call for props. Each batch is recorded as soon as it
// returns, so later batches see the looks already set and a failure keeps them.
const REF_BATCH = 3;

// Canonical looks minus the references being remade ("kind:id" in redo).
export function withoutRemade(looks: RefAppearances, redo: ReadonlySet<string>): RefAppearances {
  const drop = (kind: string, rec: Record<string, unknown>) => Object.fromEntries(Object.entries(rec).filter(([id]) => !redo.has(`${kind}:${id}`)));
  return {
    characters: drop("character", looks.characters) as RefAppearances["characters"],
    locations: drop("location", looks.locations) as RefAppearances["locations"],
    props: drop("prop", looks.props) as RefAppearances["props"]
  };
}

async function directReferences(
  role: Role,
  bible: Bible,
  log: EventLog,
  storyText: string[],
  record: (out: RoleOutput<ArtDirection>, batch: number) => Promise<void>,
  redo: ReadonlySet<string> = new Set(),
  notes?: string,
  // Which characters and locations to consider (default: every one in the
  // bible), and whether to run the props batch (default: yes).
  scope: { characterIds?: string[]; locationIds?: string[]; props?: boolean } = {}
): Promise<VisualRefData[]> {
  const start = refAppearances(log.events);
  const characterIds = (scope.characterIds ?? Object.keys(bible.characters))
    .filter((id) => bible.characters[id] && (!start.characters[id] || redo.has(`character:${id}`))).sort();
  const locationIds = (scope.locationIds ?? Object.keys(bible.locations))
    .filter((id) => bible.locations[id] && (!start.locations[id] || redo.has(`location:${id}`))).sort();
  const redoProps = Object.keys(start.props).filter((id) => redo.has(`prop:${id}`));
  // Canon key objects are props whose look comes from the bible.
  const objectIds = Object.keys(bible.objects ?? {}).filter((id) => (!start.props[id] || redo.has(`prop:${id}`)) && !redoProps.includes(id)).sort();
  const chunk = (ids: string[]) => Array.from({ length: Math.ceil(ids.length / REF_BATCH) }, (_, k) => ids.slice(k * REF_BATCH, (k + 1) * REF_BATCH));
  const batches: Array<{ characterIds?: string[]; locationIds?: string[]; props?: true }> = [
    ...chunk(characterIds).map((ids) => ({ characterIds: ids })),
    ...chunk(locationIds).map((ids) => ({ locationIds: ids })),
    ...(scope.props === false ? [] : [{ props: true as const }])  // canon objects, recreated props, and discovery of new ones
  ];
  const made: VisualRefData[] = [];
  for (const [n, b] of batches.entries()) {
    const t0 = Date.now();
    const ids = [...(b.characterIds ?? []), ...(b.locationIds ?? []), ...(b.props ? objectIds : [])];
    const out = await artDirect(role, {
      bible,
      mode: "references",
      characterIds: b.characterIds ?? [],
      locationIds: b.locationIds ?? [],
      objectIds: b.props ? objectIds : [],
      redoProps: b.props ? redoProps : [],
      discoverProps: Boolean(b.props),
      notes,
      mentions: storyMentions(bible, log.events, ids),
      // The full text is only needed to find props; the other batches get mentions.
      storyText: b.props ? storyText : [],
      // A reference being remade is not held to its old look: the author's sheet
      // (and the story) decide it now, or a sheet edit could never change a face.
      appearances: withoutRemade(refAppearances(log.events), redo),
      cast: castCharacters(log.events),
      artStyle: storyArtStyle(log.events)
    });
    recordTiming("artdirector", Date.now() - t0);
    if (out.result.artStyle && !storyArtStyle(log.events)) await log.append("art_style", { style: out.result.artStyle });
    for (const r of out.result.references ?? []) {
      // A portrait remembers the author's sheet entry it was drawn from.
      const sheet = r.kind === "character" ? lookOf(bible.characters[r.id]) : undefined;
      await log.append("visual_ref", (sheet ? { ...r, sheet } : r) satisfies VisualRefData);
      made.push(r);
    }
    await record(out, n);
  }
  return made;
}

async function directSceneArt(role: Role, config: StoryConfig, bible: Bible, beat: Beat, prose: string, sceneIndex: number, previousPrompts: string[], appearances: RefAppearances, artStyle?: string) {
  const t0 = Date.now();
  // Same paragraph numbering as the audiobook's timings.json.
  const paragraphs = sceneParagraphs(prose, new Set(Object.keys(bible.characters)));
  const out = await artDirect(role, {
    bible,
    mode: "scene",
    beat,
    paragraphs,
    shots: shotCountFor(paragraphs, config.artWordsPerShot),
    sceneIndex,
    appearances,
    artStyle,
    previousPrompts
  });
  // A shot with no location of its own is set where the scene's beat is.
  if (bible.locations[beat.location]) {
    for (const shot of out.result.shots ?? []) shot.location ??= beat.location;
  }
  recordTiming("artdirector", Date.now() - t0);
  return out;
}

// A scene's shots, with character and location references made just in time:
// only for what a shot actually shows, so someone the story merely mentions
// (a remembered grandmother, a figure in a mural) never gets a portrait. When
// new references are made, the shots are directed again so their prompts use
// the new canonical appearances. Returns every draft, the last one final.
async function directSceneShots(
  role: Role, config: StoryConfig, bible: Bible, beat: Beat, prose: string, sceneIndex: number,
  previousPrompts: string[], log: EventLog,
  recordRefs: (out: RoleOutput<ArtDirection>, batch: number) => Promise<void>
): Promise<{ drafts: RoleOutput<ArtDirection>[]; made: VisualRefData[] }> {
  const first = await castCheck(role, bible, log, await directSceneArt(role, config, bible, beat, prose, sceneIndex, previousPrompts, refAppearances(log.events), storyArtStyle(log.events)), sceneIndex, prose);
  const have = refAppearances(log.events);
  const shots = first.result.shots ?? [];
  // The author's "portrait": false holds here too: those characters are drawn from their description alone.
  const wanted = new Set(portraitIds(log.events));
  const characterIds = [...new Set(shots.flatMap((s) => s.characters ?? []))].filter((id) => !have.characters[id] && wanted.has(id));
  const locationIds = [...new Set(shots.flatMap((s) => (s.location ? [s.location] : [])))].filter((id) => !have.locations[id]);
  if (characterIds.length + locationIds.length === 0) return { drafts: [first], made: [] };
  const known = new Set(Object.keys(bible.characters));
  let made: VisualRefData[];
  try {
    made = await directReferences(role, bible, log, sceneParagraphs(prose, known), recordRefs, new Set(), undefined, { characterIds, locationIds, props: false });
  } catch (err) {
    // The shots are still good without these references; keep them.
    if (isBudgetError(err)) throw err;
    console.error(`[scriptorium]   ${c.retry(`scene ${sceneIndex + 1} references failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)}`);
    return { drafts: [first], made: [] };
  }
  if (made.length === 0) return { drafts: [first], made };
  const final = await castCheck(role, bible, log, await directSceneArt(role, config, bible, beat, prose, sceneIndex, previousPrompts, refAppearances(log.events), storyArtStyle(log.events)), sceneIndex, prose);
  return { drafts: [first, final], made };
}

// A character is in a scene when its prose names them: their name or first
// name, or (for an unnamed part) their id's words ("elf woman").
export function inScene(prose: string, id: string, name?: string): boolean {
  const text = prose.toLowerCase();
  const words = (name ?? "").replace(/^unknown\s+/i, "").toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const candidates = [words.join(" "), words[0], id.replace(/_/g, " ").toLowerCase()].filter(Boolean) as string[];
  return candidates.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text));
}

// The cast check (#143): every character a shot's prompt describes is tagged,
// so their portrait goes with it. Looks come from their reference portrait's
// description, else the author's sheet, else the bible. A failed check keeps
// the shots as the art director tagged them.
async function castCheck(role: Role, bible: Bible, log: EventLog, out: RoleOutput<ArtDirection>, sceneIndex: number, prose: string): Promise<RoleOutput<ArtDirection>> {
  const shots = out.result.shots ?? [];
  if (shots.length === 0) return out;
  const looks = refAppearances(log.events).characters;
  const sheet = recordedSheet(log.events) ?? {};
  // Only who this scene's prose mentions can be in its shots: someone who
  // merely looks alike (another story's barkeep) isn't added.
  const cast = Object.entries(bible.characters).filter(([id, ch]) => inScene(prose, id, ch.name))
    .map(([id, ch]) => ({ id, look: looks[id] || sheet[id]?.appearance || [ch.name, (ch as { traits?: string }).traits].filter(Boolean).join(": ") })).filter((c) => c.look);
  if (cast.length === 0) return out;
  try {
    const checked = await checkShotCast(role, { cast, shots: shots.map((s, k) => ({ n: k + 1, prompt: s.prompt })) });
    const added: string[] = [];
    const next = shots.map((s, k) => {
      const characters = mergeShotCast(s.characters ?? [], checked.result[k + 1]);
      const missing = characters.filter((id) => !(s.characters ?? []).includes(id));
      if (missing.length) added.push(`${k + 1}: +${missing.join(", +")}`);
      return characters.length ? { ...s, characters } : s;
    });
    if (added.length) console.error(`[scriptorium]   ${c.dim(`scene ${sceneIndex + 1} cast check: tagged ${added.join("; ")}`)}`);
    // A shot of more than three named people is blocked out like the cast photo.
    const style = storyArtStyle(log.events);
    const looks = Object.fromEntries(cast.map((x) => [x.id, x.look]));
    const blocked = await Promise.all(next.map(async (s) => ((s.characters?.length ?? 0) > 3 ? { ...s, prompt: await blockIfCrowded(role, s.prompt, s.characters!, looks, style) } : s)));
    return { ...out, result: { ...out.result, shots: blocked, prompt: blocked[0]?.prompt ?? out.result.prompt } };
  } catch (err) {
    if (isBudgetError(err)) throw err;
    console.error(`[scriptorium]   ${c.retry(`scene ${sceneIndex + 1} cast check failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)}`);
    return out;
  }
}

// The cover's prompt, and who it shows: the cast check (#143) reads the prompt
// against every character's look, so each one it describes gets their
// portrait. Picking the most-shown characters instead gave the cover three
// portraits for a company of ten, and strangers for the rest.
// The cover: the art director's prompt, centred on the story's leads (#164) —
// the title character, then the most present — at most COVER_LEADS of them
// with portraits (Google documents 4 characters held consistent; a moving
// group of ten came out with people doubled and missing). Everyone else the
// prompt describes stays as background figures. Blocked out like the cast photo.
export const COVER_LEADS = 4;
async function directCoverArt(role: Role, bible: Bible, committed: SceneCommittedData[], previousPrompts: string[], appearances: RefAppearances, artStyle?: string, leads: string[] = []) {
  const t0 = Date.now();
  const out = await artDirect(role, { bible, mode: "cover", beats: committed.map((d) => d.beat), appearances, artStyle, previousPrompts });
  recordTiming("artdirector", Date.now() - t0);
  const characters = leads.filter((id) => appearances.characters[id]).slice(0, COVER_LEADS);
  if (characters.length === 0) return { out, characters: undefined };
  console.error(`[scriptorium]   ${c.dim(`cover leads: ${characters.join(", ")}; anyone else in the background`)}`);
  const prompt = await blockCover(role, out.result.prompt, characters, castLooks(bible, appearances), artStyle);
  return { out: { ...out, result: { ...out.result, prompt } }, characters };
}

function castLooks(bible: Bible, appearances: RefAppearances): Record<string, string> {
  return Object.fromEntries(Object.entries(appearances.characters).filter(([id, look]) => bible.characters[id] && look));
}

// The cover's blocking, checked (#164): every lead must be in the prompt and the
// first (the title character) must lead it. The cast check reads the rewrite
// against the whole cast; a miss goes back once with what was wrong. A second
// miss keeps whichever version missed less, with a warning — never fatal.
export async function blockCover(role: Role, prompt: string, leads: string[], looks: Record<string, string>, artStyle?: string): Promise<string> {
  const people = leads.filter((id) => looks[id]).map((id) => ({ id, look: looks[id] }));
  if (people.length === 0) return prompt;
  const body = artStyle ? prompt.split(artStyle).join(" ").trim() : prompt;
  const withStyle = (p: string) => (artStyle ? `${p} ${artStyle}` : p);
  const cast = Object.entries(looks).map(([id, look]) => ({ id, look }));
  const problems = async (p: string): Promise<string[] | undefined> => {
    try {
      const seen = (await checkShotCast(role, { cast, shots: [{ n: 1, prompt: p }] })).result[1] ?? [];
      const missing = people.filter((x) => !seen.includes(x.id));
      return [
        ...missing.map((x) => `left out: ${x.look}`),
        ...(seen[0] !== people[0].id && !missing.includes(people[0]) ? [`the lead (${people[0].look}) isn't the main figure — put them in the foreground, at the centre`] : [])
      ];
    } catch (err) {
      if (isBudgetError(err)) throw err;
      console.error(`[scriptorium]   ${c.retry(`cover cast check failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)}`);
      return undefined;
    }
  };
  let best: { prompt: string; misses: number } | undefined;
  let note: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let blocked: string;
    try {
      blocked = (await blockGroupPicture(role, { prompt: body, people, lead: true, ...(note ? { note } : {}) })).result;
    } catch (err) {
      if (isBudgetError(err)) throw err;
      console.error(`[scriptorium]   ${c.retry(`blocking pass failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)}`);
      continue;
    }
    if (!blocked) continue;
    const found = await problems(blocked);
    if (found === undefined) return withStyle(blocked);
    if (found.length === 0) return withStyle(blocked);
    if (!best || found.length < best.misses) best = { prompt: blocked, misses: found.length };
    note = found.join("; ");
    console.error(`[scriptorium]   ${c.retry(`cover blocking ${attempt === 1 ? "sent back" : "still off"}: ${note}`)}`);
  }
  return best ? withStyle(best.prompt) : prompt;
}

// Who leads the cover (#164): the title character (one the title names), then
// the characters most present across the story's shots.
export function coverLeads(events: StoryEvent[], bible: Bible, storyTitle?: string, count = COVER_LEADS): string[] {
  const title = (storyTitle ?? "").toLowerCase();
  const named = Object.entries(bible.characters).filter(([, ch]) => {
    const first = (ch.name ?? "").split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9]/g, "");
    return Boolean(first && first.length > 2 && new RegExp(`\\b${first}`).test(title));
  }).map(([id]) => id);
  const art = new Map<number, SceneArtData>();
  for (const e of events) if (e.type === "scene_art") art.set((e.data as SceneArtData).sceneIndex, e.data as SceneArtData);
  const counts = new Map<string, number>();
  for (const a of art.values()) for (const shot of a.shots ?? []) for (const id of shot.characters ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  const most = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id).filter((id) => !named.includes(id));
  return [...named, ...most].slice(0, count);
}

// A picture of several named people, rewritten as blocking (the cast photo's
// recipe): a head count, each person in their place. Only above `from` people
// (shots: more than three). The style paragraph is set aside and put back
// verbatim; a failed or empty rewrite keeps the original.
async function blockIfCrowded(role: Role, prompt: string, ids: string[], looks: Record<string, string>, artStyle?: string, from = 3): Promise<string> {
  const people = ids.filter((id) => looks[id]).map((id) => ({ id, look: looks[id] }));
  if (people.length <= from) return prompt;
  const body = artStyle ? prompt.split(artStyle).join(" ").trim() : prompt;
  try {
    const out = await blockGroupPicture(role, { prompt: body, people });
    return out.result ? (artStyle ? `${out.result} ${artStyle}` : out.result) : prompt;
  } catch (err) {
    if (isBudgetError(err)) throw err;
    console.error(`[scriptorium]   ${c.retry(`blocking pass failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)}`);
    return prompt;
  }
}

// Re-runs the Art Director over an existing run: references for any character
// or location without one and any key props not yet captured (existing
// references are kept so looks stay stable), then fresh
// scene_art / cover_art events (the newest per scene wins).
// For runs made before shots existed, or to re-shoot after a prompt change.
// Story canon is untouched. Fails fast: unlike a live run there is no scene to protect.
export async function redirectArt({ config, log, roles, runDir, onScene, onReferences, redo = [], notes }: {
  config: StoryConfig;
  log: EventLog;
  roles: Roles;
  runDir?: string;
  onScene?: (sceneIndex: number, shots: number) => void;
  onReferences?: (refs: string[]) => void;  // "kind:id" of each new reference
  redo?: string[];                          // "kind:id" references to recreate
  notes?: string;                           // author corrections for the recreated references
}): Promise<number> {
  const artRole = roles.artdirector;
  if (!artRole) throw new Error("config has no artdirector role");
  await log.load();
  await applyAuthorArtStyle(config, log);
  let seq = runDir ? await nextThreadSeq(runDir) : 0;
  const finalBible = replay(log.events);
  const known = new Set(Object.keys(finalBible.characters));
  const storyText = log.events
    .filter((e) => e.type === "scene_committed")
    .flatMap((e) => sceneParagraphs((e.data as SceneCommittedData).prose, known));
  const have = refAppearances(log.events);
  for (const r of redo) {
    const [kind, id] = r.split(":");
    const exists = kind === "character" ? have.characters[id] : kind === "location" ? have.locations[id] : kind === "prop" ? have.props[id] : undefined;
    if (!exists) throw new Error(`--redo ${r}: no such reference (use character:<id>, location:<id> or prop:<id>)`);
  }
  if (notes && redo.length === 0) throw new Error("--note only applies with --redo");
  const recordRefs = async (out: RoleOutput<ArtDirection>) => {
    if (runDir) await writeRoleOutput(runDir, ++seq, "artdirector-references-redo", out);
  };
  // Recreate what was asked for, and any missing props; characters and places
  // get references as the re-shot scenes show them.
  const redoIds = (kind: string) => redo.filter((r) => r.startsWith(`${kind}:`)).map((r) => r.slice(kind.length + 1));
  const made = await directReferences(artRole, finalBible, log, storyText, recordRefs, new Set(redo), notes,
    { characterIds: redoIds("character"), locationIds: redoIds("location") });
  const events = [...log.events];
  const committed: SceneCommittedData[] = [];
  const prompts: string[] = [];
  for (const [n, e] of events.entries()) {
    if (e.type !== "scene_committed") continue;
    const d = e.data as SceneCommittedData;
    committed.push(d);
    // The bible as it stood right after this scene committed — what the live run saw.
    const bible = replay(events.slice(0, n + 1));
    const shot = await directSceneShots(artRole, config, bible, d.beat, d.prose, d.index, prompts, log, recordRefs);
    made.push(...shot.made);
    for (const draft of shot.drafts) if (runDir) await writeRoleOutput(runDir, ++seq, "artdirector-redo", draft);
    const out = shot.drafts.at(-1)!;
    const art: SceneArtData = { sceneIndex: d.index, prompt: out.result.prompt, shots: out.result.shots, ...(out.result.continuity ? { continuity: out.result.continuity } : {}) };
    await log.append("scene_art", art);
    prompts.push(...(out.result.shots ?? []).map((s) => s.prompt));
    onScene?.(d.index, out.result.shots?.length ?? 1);
  }
  onReferences?.(made.map((r) => `${r.kind}:${r.id}`));
  if (committed.length > 0) {
    const { out, characters } = await directCoverArt(artRole, replay(events), committed, prompts, refAppearances(log.events), storyArtStyle(log.events), coverLeads(log.events, replay(events), config.title));
    if (runDir) await writeRoleOutput(runDir, ++seq, "artdirector-cover-redo", out);
    const cover: CoverArtData = { sceneCount: committed.length, prompt: out.result.prompt, ...(characters ? { characters } : {}) };
    await log.append("cover_art", cover);
  }
  return committed.length;
}

// Portraits whose author sheet entry changed since they were made (or, for
// ones made before the sheet, whose look the author has since rewritten).
export function staleCharacterRefs(events: StoryEvent[]): string[] {
  const bible = replay(events);
  return readVisualRefs(events)
    .filter((r) => r.kind === "character" && bible.characters[r.id])
    .filter((r) => {
      const c = bible.characters[r.id];
      const now = lookOf(c);
      if (!now) return false;
      return r.sheet ? r.sheet !== now : c.appearance !== r.appearance || Boolean(c.background);
    })
    .map((r) => r.id)
    .sort();
}

// The references phase: a portrait for every character on the author's sheet
// (except portrait: false), every location, and the story's key props — made
// where missing, remade where the sheet changed or the author asked (redo,
// with notes), never touching what the author approved.
export async function planReferences({ config, log, roles, runDir, redo = [], notes, approved = new Set() }: {
  config: StoryConfig;
  log: EventLog;
  roles: Roles;
  runDir?: string;
  redo?: string[];                    // "kind:id" references to remake
  notes?: string;                     // author corrections for those
  approved?: ReadonlySet<string>;     // art keys the author signed off on
}): Promise<{ made: string[]; stale: string[] }> {
  const artRole = roles.artdirector;
  if (!artRole) throw new Error("config has no artdirector role");
  await log.load();
  await applyAuthorArtStyle(config, log);
  let seq = runDir ? await nextThreadSeq(runDir) : 0;
  const isApproved = (r: string) => approved.has(r.replace(":", "-"));
  for (const r of redo) if (isApproved(r)) throw new Error(`${r} is approved — revoke the approval before remaking it`);
  if (notes && redo.length === 0) throw new Error("--note only applies with --redo");
  const changed = staleCharacterRefs(log.events).map((id) => `character:${id}`);
  // An approved portrait stays as it is, even when its sheet entry changes: say so.
  for (const r of changed.filter(isApproved)) console.error(`[scriptorium] ${c.retry(`${r}'s sheet entry changed, but its portrait is approved and stays — revoke the approval to remake it`)}`);
  const stale = changed.filter((r) => !isApproved(r) && !redo.includes(r));
  const bible = replay(log.events);
  const known = new Set(Object.keys(bible.characters));
  const storyText = log.events.filter((e) => e.type === "scene_committed").flatMap((e) => sceneParagraphs((e.data as SceneCommittedData).prose, known));
  const record = async (out: RoleOutput<ArtDirection>) => {
    if (runDir) await writeRoleOutput(runDir, ++seq, "artdirector-references", out);
  };
  const ids = (list: string[], kind: string) => list.filter((r) => r.startsWith(`${kind}:`)).map((r) => r.slice(kind.length + 1));
  const made: VisualRefData[] = [];
  // The author's redo notes go only to what they're about.
  if (redo.length > 0) {
    made.push(...await directReferences(artRole, bible, log, storyText, record, new Set(redo), notes,
      { characterIds: ids(redo, "character"), locationIds: ids(redo, "location"), props: ids(redo, "prop").length > 0 }));
  }
  made.push(...await directReferences(artRole, replay(log.events), log, storyText, record, new Set(stale), undefined,
    { characterIds: portraitIds(log.events), locationIds: Object.keys(bible.locations) }));
  return { made: made.map((r) => `${r.kind}:${r.id}`), stale: stale.map((r) => r.slice("character:".length)) };
}

// The shots phase's planning: shots for every scene that has none yet, and the
// cover when it's missing or out of date. Directed shots are kept as they are.
// The extras (#49): key art and a cast photo, directed once from the whole
// story; redo directs them again. Their images render like the cover's.
export async function planExtras({ config, log, roles, runDir, redo = false }: { config: StoryConfig; log: EventLog; roles: Roles; runDir?: string; redo?: boolean }): Promise<boolean> {
  const artRole = roles.artdirector;
  if (!artRole) throw new Error("config has no artdirector role");
  await log.load();
  await applyAuthorArtStyle(config, log);
  if (!redo && log.events.some((e) => e.type === "extras_art")) return false;
  const committed = log.events.filter((e) => e.type === "scene_committed").map((e) => e.data as SceneCommittedData);
  if (committed.length === 0) throw new Error("no committed scenes — run the story step first");
  const t0 = Date.now();
  const out = await artDirect(artRole, { bible: replay(log.events), mode: "extras", beats: committed.map((d) => d.beat), appearances: refAppearances(log.events), artStyle: storyArtStyle(log.events), previousPrompts: sceneArtPrompts(log.events) });
  recordTiming("artdirector", Date.now() - t0);
  if (runDir) await writeRoleOutput(runDir, (await nextThreadSeq(runDir)) + 1, "artdirector-extras", out);
  await log.append("extras_art", out.result.extras!);
  return true;
}

export async function planShots({ config, log, roles, runDir, replan = [], redirectCover = false }: { config: StoryConfig; log: EventLog; roles: Roles; runDir?: string; replan?: number[]; redirectCover?: boolean }): Promise<number> {
  const artRole = roles.artdirector;
  if (!artRole) throw new Error("config has no artdirector role");
  await log.load();
  await applyAuthorArtStyle(config, log);
  let seq = runDir ? await nextThreadSeq(runDir) : 0;
  const recordRefs = async (out: RoleOutput<ArtDirection>) => {
    if (runDir) await writeRoleOutput(runDir, ++seq, "artdirector-references", out);
  };
  // replan: scene indexes whose shots are planned again (the newest scene_art wins).
  const directed = new Set(log.events.filter((e) => e.type === "scene_art").map((e) => (e.data as SceneArtData).sceneIndex).filter((i) => !replan.includes(i)));
  const events = [...log.events];
  let planned = 0;
  for (const [n, e] of events.entries()) {
    if (e.type !== "scene_committed") continue;
    const d = e.data as SceneCommittedData;
    if (directed.has(d.index)) continue;
    const bible = replay(events.slice(0, n + 1));
    const shot = await directSceneShots(artRole, config, bible, d.beat, d.prose, d.index, sceneArtPrompts(log.events), log, recordRefs);
    for (const draft of shot.drafts) if (runDir) await writeRoleOutput(runDir, ++seq, "artdirector", draft);
    const out = shot.drafts.at(-1)!;
    await log.append("scene_art", { sceneIndex: d.index, prompt: out.result.prompt, shots: out.result.shots, ...(out.result.continuity ? { continuity: out.result.continuity } : {}) } satisfies SceneArtData);
    planned++;
  }
  const committed = log.events.filter((e) => e.type === "scene_committed").map((e) => e.data as SceneCommittedData);
  const lastCover = log.events.filter((e) => e.type === "cover_art").at(-1)?.data as CoverArtData | undefined;
  if (committed.length > 0 && (planned > 0 || redirectCover || lastCover?.sceneCount !== committed.length)) {
    const { out, characters } = await directCoverArt(artRole, replay(log.events), committed, sceneArtPrompts(log.events), refAppearances(log.events), storyArtStyle(log.events), coverLeads(log.events, replay(log.events), config.title));
    if (runDir) await writeRoleOutput(runDir, ++seq, "artdirector-cover", out);
    await log.append("cover_art", { sceneCount: committed.length, prompt: out.result.prompt, ...(characters ? { characters } : {}) } satisfies CoverArtData);
  }
  return planned;
}

function sceneArtPrompts(events: StoryEvent[]): string[] {
  return events
    .filter((e) => e.type === "scene_art")
    .flatMap((e) => {
      const d = e.data as SceneArtData;
      return d.shots ? d.shots.map((s) => s.prompt) : [d.prompt];
    });
}

// Runs presentation-only work (e.g. art prompts) whose failure must never fail the run.
async function nonFatal(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (isBudgetError(err)) throw err;  // a spent budget stops the run, never a warning
    console.error(`[scriptorium]   ${c.retry(`${what} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)}`);
  }
}

// The same, for work that returns a value: undefined when it failed.
async function nonFatalValue<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
  let out: T | undefined;
  await nonFatal(what, async () => { out = await fn(); });
  return out;
}

export function renderStory(events: StoryEvent[]): string {
  const knownSpeakers = new Set(Object.keys(replay(events).characters));
  return events
    .filter((e) => e.type === "scene_committed")
    .map((e) => {
      const d = e.data as SceneCommittedData;
      return `## Scene ${d.index + 1}\n\n${stripSpeakerTags(d.prose, knownSpeakers)}`;
    })
    .join("\n\n");
}
