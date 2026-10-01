import { mkdir, readdir, writeFile } from "node:fs/promises";
import { applyPatch, replay } from "./bible.ts";
import { mulberry32, pick } from "./rng.ts";
import { shotCountFor, direct, createAndDirect, buildWorld, write, checkContinuity, review, archive, reviewBeat, reviewPatch, reviewWorld, normalizeIssue, renderIssue, artDirect } from "./roles.ts";
import { findUntaggedParagraphs, sceneParagraphs, stripSpeakerTags } from "./audiobook.ts";
import { recordTiming } from "./providers.ts";
import { c } from "./colors.ts";
import { EventLog } from "./eventlog.ts";
import { continuistLane, dedupIssues, sameIssue, stuckIssues } from "./review.ts";
import { refAppearances, storyArtStyle } from "./visualrefs.ts";
import type { RefAppearances } from "./visualrefs.ts";
import type {
  Beat,
  Bible,
  CoverArtData,
  GateResult,
  Issue,
  RoleOutput,
  Role,
  Roles,
  SceneArtData,
  SceneCommittedData,
  StoryConfig,
  StoryEvent,
  Verdict,
  VisualRefData,
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
      const rounds: Issue[][] = [];      // every round's issues (both reviewers), for stuck-passage detection
      for (;;) {
        if (bounded && attempt >= maxAttempts) {
          console.error(`[scriptorium]   ${c.fail(`draft budget exhausted (${attempt}/${maxAttempts}) — committing as-is`)}`);
          break;
        }
        const fresh = stage === 2;
        t0 = Date.now();
        const writeOut = await write(roles.writer, { bible, beat: beat.result, sceneIndex: i, attempt, sceneWords, issues: verdict.issues, previousDraft: prose, previousScenes, fresh, speakerTags: config.speakerTags });
        recordTiming("writer", Date.now() - t0);
        if (runDir) await writeRoleOutput(runDir, ++seq, `writer-a${attempt}`, writeOut);
        prose = writeOut.result;
        attempt++;

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
        const [contRaw, criticOut] = await Promise.all([
          checkContinuity(roles.continuist, gateCtx),
          roles.critic
            ? review(roles.critic, gateCtx)
            : Promise.resolve(null)
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
        }

        // Snapshot history before recording this round's issues.
        const history = [...contHistory, ...criticHistory];

        // Track gate issues for next round's context.
        if (contOut) contHistory.push(...contOut.result.issues);
        if (criticOut) criticHistory.push(...criticOut.result.issues);

        // Combined verdict: both must approve to proceed to archivist.
        // A gate that rejects with only already-flagged issues has nothing new to
        // fix — the writer has seen them all. Treat as approval so the loop converges.
        // "Already flagged" means the same complaint however it's reworded (sameIssue),
        // not just an identical key.
        const isNew = (issue: Issue): boolean => !history.some((h) => sameIssue(h, issue));
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
          contHistory.length = 0;
          criticHistory.length = 0;
          rounds.length = 0;
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

      // Art Director: canonical visual references for whatever just entered the
      // story — the Creator's cast and places with scene 1, the Archivist's
      // additions later, and key props the scene shows — then a sequence of
      // shots for this scene, each anchored to the paragraph where it comes on
      // screen. The scene is already canon, so failures only warn.
      if (roles.artdirector) {
        const artRole = roles.artdirector;
        await nonFatal(`scene ${i + 1} visual references`, async () => {
          const known = new Set(Object.keys(bible.characters));
          const out = await directReferences(artRole, bible, log.events, sceneParagraphs(prose, known));
          if (runDir && (out.result.references ?? []).length > 0) await writeRoleOutput(runDir, ++seq, "artdirector-references", out);
          if (out.result.artStyle) await log.append("art_style", { style: out.result.artStyle });
          for (const r of out.result.references ?? []) await log.append("visual_ref", r satisfies VisualRefData);
        });
        await nonFatal(`scene ${i + 1} art prompts`, async () => {
          const out = await directSceneArt(artRole, config, bible, beat.result, prose, i, sceneArtPrompts(log.events), refAppearances(log.events), storyArtStyle(log.events));
          if (runDir) await writeRoleOutput(runDir, ++seq, "artdirector", out);
          const art: SceneArtData = { sceneIndex: i, prompt: out.result.prompt, shots: out.result.shots };
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
      const out = await directCoverArt(artRole, bible, committed, sceneArtPrompts(log.events), refAppearances(log.events), storyArtStyle(log.events));
      if (runDir) await writeRoleOutput(runDir, ++seq, "artdirector-cover", out);
      const cover: CoverArtData = { sceneCount: committed.length, prompt: out.result.prompt };
      await log.append("cover_art", cover);
    });
  }

  console.error(`[scriptorium] ${c.ok(`done — ${total} scenes`)}`);
  return bible;
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
async function directReferences(role: Role, bible: Bible, events: StoryEvent[], storyText: string[], redo: ReadonlySet<string> = new Set(), notes?: string) {
  const have = refAppearances(events);
  const characterIds = Object.keys(bible.characters).filter((id) => !have.characters[id] || redo.has(`character:${id}`)).sort();
  const locationIds = Object.keys(bible.locations).filter((id) => !have.locations[id] || redo.has(`location:${id}`)).sort();
  const redoProps = Object.keys(have.props).filter((id) => redo.has(`prop:${id}`));
  // Canon key objects are props whose look comes from the bible.
  const objectIds = Object.keys(bible.objects ?? {}).filter((id) => (!have.props[id] || redo.has(`prop:${id}`)) && !redoProps.includes(id)).sort();
  const t0 = Date.now();
  const mentions = storyMentions(bible, events, [...characterIds, ...locationIds, ...objectIds]);
  const out = await artDirect(role, { bible, mode: "references", characterIds, locationIds, objectIds, redoProps, notes, mentions, storyText, appearances: have, artStyle: storyArtStyle(events) });
  recordTiming("artdirector", Date.now() - t0);
  return out;
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

async function directCoverArt(role: Role, bible: Bible, committed: SceneCommittedData[], previousPrompts: string[], appearances: RefAppearances, artStyle?: string) {
  const t0 = Date.now();
  const out = await artDirect(role, { bible, mode: "cover", beats: committed.map((d) => d.beat), appearances, artStyle, previousPrompts });
  recordTiming("artdirector", Date.now() - t0);
  return out;
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
  let seq = 0;
  if (runDir) {
    try {
      seq = (await readdir(runDir)).filter((f) => f.endsWith(".md")).length;
    } catch { /* empty dir */ }
  }
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
  const refs = await directReferences(artRole, finalBible, log.events, storyText, new Set(redo), notes);
  if (runDir) await writeRoleOutput(runDir, ++seq, "artdirector-references-redo", refs);
  if (refs.result.artStyle) await log.append("art_style", { style: refs.result.artStyle });
  for (const r of refs.result.references ?? []) await log.append("visual_ref", r satisfies VisualRefData);
  onReferences?.((refs.result.references ?? []).map((r) => `${r.kind}:${r.id}`));
  const appearances = refAppearances(log.events);
  const artStyle = storyArtStyle(log.events);
  const events = [...log.events];
  const committed: SceneCommittedData[] = [];
  const prompts: string[] = [];
  for (const [n, e] of events.entries()) {
    if (e.type !== "scene_committed") continue;
    const d = e.data as SceneCommittedData;
    committed.push(d);
    // The bible as it stood right after this scene committed — what the live run saw.
    const bible = replay(events.slice(0, n + 1));
    const out = await directSceneArt(artRole, config, bible, d.beat, d.prose, d.index, prompts, appearances, artStyle);
    if (runDir) await writeRoleOutput(runDir, ++seq, "artdirector-redo", out);
    const art: SceneArtData = { sceneIndex: d.index, prompt: out.result.prompt, shots: out.result.shots };
    await log.append("scene_art", art);
    prompts.push(...(out.result.shots ?? []).map((s) => s.prompt));
    onScene?.(d.index, out.result.shots?.length ?? 1);
  }
  if (committed.length > 0) {
    const out = await directCoverArt(artRole, replay(events), committed, prompts, appearances, artStyle);
    if (runDir) await writeRoleOutput(runDir, ++seq, "artdirector-cover-redo", out);
    const cover: CoverArtData = { sceneCount: committed.length, prompt: out.result.prompt };
    await log.append("cover_art", cover);
  }
  return committed.length;
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
    console.error(`[scriptorium]   ${c.retry(`${what} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)}`);
  }
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
