// A/B experiment (#180): with writer's notes on (B) or off (A), does a loose
// end the writer leaves on purpose stay open, while a floating detail it never
// chose still gets caught? Two probes give the ground truth:
//   D — scene 2's writer is told to include a detail and never explain it;
//   F — a sentence the writer never wrote is spliced into every scene-2 draft.
// Each arm writes the same 3-scene story; the run's events, reviewers' threads,
// spend and a judge's read of the finished story are summarized per arm.
//
//   node --env-file=.env experiments/ambiguity-ab/run.ts [--arms A,B] [--runs 1] [--mock]
//
// Runs go under runs/_scratch/ab-ambiguity/, so their spend is tagged experiment.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { EventLog } from "../../src/eventlog.ts";
import { replay } from "../../src/bible.ts";
import { runStory, THREADS_DIR } from "../../src/engine.ts";
import { buildRoleProviders } from "../../src/providers.ts";
import { splitWriterNotes } from "../../src/roles.ts";
import { accounted } from "../../src/steps.ts";
import { readLedger } from "../../src/usage.ts";
import type { LooseEndsData, Patch, SceneCommittedData, StoryConfig } from "../../src/types.ts";

const { values } = parseArgs({ options: { arms: { type: "string", default: "A,B" }, runs: { type: "string", default: "1" }, mock: { type: "boolean", default: false }, resume: { type: "string" } } });
const ROOT = "runs/_scratch/ab-ambiguity";

export const PREMISE = "In a fog-bound fishing village, the harbourmaster's apprentice finds the village's only boat cut loose on the night before the herring run, and has until dawn to learn who did it and why.";
export const SETTING = "A cold northern fishing village, a single inn, a harbour, the shingle beach; an age of lanterns and sail.";
export const PROBE_D = {
  id: "D",
  what: "a church bell rings once at midnight, though the village has no church",
  match: /\bbell\b/i,
  instruction: "AUTHOR'S NOTE FOR THIS SCENE: include this detail, and never explain it — not in this scene, not later: a church bell rings once at midnight, though the village has no church. It is a mystery the story deliberately leaves open."
};
export const PROBE_F = {
  id: "F",
  what: "a muddy boot print on the ceiling above the bar",
  match: /boot ?print|ceiling/i,
  sentence: "Someone had left a muddy boot print on the ceiling above the bar."
};

// Splices the floating detail into a scene-2 draft (after its second paragraph), unless already there.
export function splice(draft: string): string {
  if (PROBE_F.match.test(draft)) return draft;
  const notesAt = draft.search(/^[ \t]*(?:#{1,6}[ \t]*|\*\*)?WRITER'?S?[ \t]+NOTES\b/im);
  const prose = notesAt >= 0 ? draft.slice(0, notesAt) : draft;
  const rest = notesAt >= 0 ? draft.slice(notesAt) : "";
  const paras = prose.trimEnd().split(/\n{2,}/);
  const at = Math.min(2, paras.length);
  paras.splice(at, 0, PROBE_F.sentence);
  return paras.join("\n\n") + (rest ? `\n\n${rest}` : "");
}

// A stopped run picks up where its log left off (runStory resumes).
async function runArm(arm: "A" | "B", n: number, base: StoryConfig, resumeDir?: string) {
  const runDir = resumeDir ?? join(ROOT, `${new Date().toISOString().replace(/[:.]/g, "-")}-${arm}${n}`);
  await mkdir(runDir, { recursive: true });
  const config: StoryConfig = { ...base, scenes: 3, premise: PREMISE, setting: SETTING, sceneWords: { min: 700, max: 1000 }, ambiguity: "some", writerNotes: arm === "B" };
  const roles = buildRoleProviders(config);
  const writer = roles.writer;
  const real = writer.provider.complete.bind(writer.provider);
  writer.provider = { complete: async (req) => {
    const scene = (req.ctx as { sceneIndex?: number } | undefined)?.sceneIndex;
    if (req.role !== "writer" || scene !== 1) return real(req);
    const out = await real({ ...req, prompt: `${req.prompt}\n\n${PROBE_D.instruction}` });
    return splice(String(out));
  } };
  const log = new EventLog(runDir);
  await accounted(runDir, config, "story", () => runStory({ config, log, roles, runDir }));
  return { arm, runDir, ...(await measure(runDir, log, roles)) };
}

// What happened to each probe, from the run's own record.
async function measure(runDir: string, log: EventLog, roles: ReturnType<typeof buildRoleProviders>) {
  const scenes = log.events.filter((e) => e.type === "scene_committed").map((e) => e.data as SceneCommittedData).sort((a, b) => a.index - b.index);
  const patches = scenes.map((s) => s.patch as Patch | undefined);
  const setups = patches.flatMap((p, i) => (p?.openSetups ?? []).map((o) => ({ ...o, openedIn: i + 1 })));
  const paid = new Set(patches.flatMap((p) => p?.paySetups ?? []));
  const bible = replay(log.events);
  const files = await readdir(join(runDir, THREADS_DIR)).catch(() => [] as string[]);
  const read = async (f: string) => readFile(join(runDir, THREADS_DIR, f), "utf8");
  const issueLines = async (who: RegExp) => (await Promise.all(files.filter((f) => who.test(f)).map(read))).flatMap((t) => t.split("\n").filter((l) => /^- \[?[A-Z_]{4,}/.test(l)));
  const gateIssues = [...(await issueLines(/continuist|critic/)), ...(await issueLines(/beatgate/))];
  // The writer's own reply only (its thread file also holds its instructions, which mention notes).
  const writerNotes = (await Promise.all(files.filter((f) => /writer-a/.test(f)).map(read)))
    .map((t) => splitWriterNotes(t.split("## Raw Response").at(-1) ?? "").notes).filter(Boolean) as string[];
  const story = scenes.map((s) => s.prose).join("\n\n");
  const loose = log.events.filter((e) => e.type === "loose_ends").map((e) => e.data as LooseEndsData).at(-1)?.ends ?? [];
  const probe = (p: typeof PROBE_D | typeof PROBE_F) => {
    const opened = setups.filter((s) => p.match.test(`${s.id} ${s.text ?? ""}`));
    return {
      inFinalProse: p.match.test(scenes.find((s) => s.index === 1)?.prose ?? ""),
      recordedAs: opened.map((s) => `${s.id}: ${s.kind ?? "promise"} (S${s.openedIn})`),
      paid: opened.some((s) => paid.has(s.id)),
      stillOpen: bible.ledger.filter((s) => p.match.test(`${s.id} ${s.text}`)).map((s) => s.id),
      gateIssues: gateIssues.filter((l) => p.match.test(l)).length,
      inWriterNotes: writerNotes.some((n) => p.match.test(n)),
      // The loose-ends check (#180): found it? judged it declared (left open) or owed (a promise)?
      looseEnd: (() => { const e = loose.find((x) => p.match.test(`${x.quote} ${x.detail}`)); return e ? (e.declared ? `declared (draft ${e.draft})` : "owed") : "not found"; })()
    };
  };
  const judged = await judge(roles, story);
  const ledger = readLedger(runDir);
  return {
    drafts: scenes.map((s) => s.attempts),
    usd: Math.round(ledger.reduce((a, e) => a + (e.usd ?? 0), 0) * 100) / 100,
    D: { ...probe(PROBE_D), judge: judged.D },
    F: { ...probe(PROBE_F), judge: judged.F },
    writerNotes
  };
}

// A separate read of the finished story: is each probe explained, left open, or dropped?
async function judge(roles: ReturnType<typeof buildRoleProviders>, story: string): Promise<Record<"D" | "F", string>> {
  const role = roles.continuist;
  const out = await role.provider.complete({
    role: "judge",
    system: `You read a finished story and report, for each DETAIL, what the story does with it: "explained" (the story gives it a cause, purpose or answer), "left_open" (it appears and is deliberately never explained), "dropped" (it appears and is simply never mentioned again), or "absent" (it never appears). Output ONLY JSON: {"D":{"status":string,"evidence":string},"F":{"status":string,"evidence":string}}`,
    prompt: `DETAILS:\nD: ${PROBE_D.what}\nF: ${PROBE_F.what}\n\nSTORY:\n${story}`,
    temperature: 0,
    ctx: { task: "judge" }
  });
  try {
    const j = JSON.parse(String(out).replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
    return { D: `${j.D?.status} — ${j.D?.evidence ?? ""}`, F: `${j.F?.status} — ${j.F?.evidence ?? ""}` };
  } catch { return { D: "unparsed", F: "unparsed" }; }
}

function report(results: Awaited<ReturnType<typeof runArm>>[]): string {
  const row = (r: (typeof results)[number], p: "D" | "F") => {
    const x = r[p];
    return `| ${r.arm} | ${p} | ${x.inFinalProse ? "yes" : "no"} | ${x.recordedAs.join("; ") || "—"} | ${x.looseEnd} | ${x.paid ? "yes" : "no"} | ${x.gateIssues} | ${x.inWriterNotes ? "yes" : "no"} | ${x.judge} |`;
  };
  return [
    `# Ambiguity A/B (#180)`,
    ``,
    `D = deliberate loose end (${PROBE_D.what}); F = floating detail (${PROBE_F.what}).`,
    `Hoped for (#180's loose-ends check): in B, D is declared on the draft that introduced it and left open; F is owed and the final scene pays it off. In A (no notes) both are owed.`,
    ``,
    `| arm | probe | in scene 2 | recorded as | loose-ends check | paid | reviewer issues | in writer's notes | judge |`,
    `|---|---|---|---|---|---|---|---|---|`,
    ...results.flatMap((r) => [row(r, "D"), row(r, "F")]),
    ``,
    `| arm | run | drafts per scene | spend |`,
    `|---|---|---|---|`,
    ...results.map((r) => `| ${r.arm} | ${r.runDir} | ${r.drafts.join(", ")} | $${r.usd.toFixed(2)} |`),
    ``,
    ...results.filter((r) => r.writerNotes.length).map((r) => `### Writer's notes, ${r.arm} (${r.runDir})\n\n${r.writerNotes.join("\n\n---\n\n")}\n`)
  ].join("\n");
}

if (import.meta.main) {
  const base = JSON.parse(await readFile(values.mock ? "story.config.json" : "story.recommended.config.json", "utf8")) as StoryConfig;
  const arms = values.arms!.split(",").map((a) => a.trim().toUpperCase()) as ("A" | "B")[];
  const results = [];
  if (values.resume) {
    // --resume dir1,dir2: finish (or just measure) earlier runs; the arm is the dir's suffix (…-A1, …-B1).
    for (const dir of values.resume.split(",").map((d) => d.trim()).filter(Boolean)) {
      const arm = (/-([AB])\d+$/.exec(dir)?.[1] ?? "A") as "A" | "B";
      results.push(await runArm(arm, 1, base, dir));
    }
  } else {
    for (let n = 1; n <= Number(values.runs); n++) for (const arm of arms) results.push(await runArm(arm, n, base));
  }
  const md = report(results);
  await mkdir(ROOT, { recursive: true });
  const file = join(ROOT, `report-${new Date().toISOString().replace(/[:.]/g, "-")}${values.mock ? "-mock" : ""}.md`);
  await writeFile(file, md);
  console.log(md);
  console.log(`\nreport: ${file}`);
}
