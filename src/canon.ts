import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readApprovals } from "./approvals.ts";
import { recordedSheet } from "./characterSheet.ts";
import { renderStory } from "./engine.ts";
import { checkCanon } from "./roles.ts";
import type { CanonIssue } from "./roles.ts";
import { findRound, newRound, readRound } from "./rounds.ts";
import type { Round, RoundInfo } from "./rounds.ts";
import type { Role, SceneArtData, SceneCommittedData, StoryEvent } from "./types.ts";

// The canon re-check (#133). The continuist checks each scene as it's written,
// against the canon of that moment; canon that arrives later (the author's
// character sheet, drawings, answers) never reached the prose. This re-reads
// every written scene and its shot prompts against today's canon, and lists
// each contradiction with a proposed fix as a review round; applying the
// fixes the author accepts rewrites the prose and prompts (event log backed up).

export interface CanonFinding extends CanonIssue { n: number; scene: number }
export interface CanonRound extends RoundInfo { kind: "canon"; findings: CanonFinding[] }

// What counts as canon: the author's character sheet and their notes.
export function canonText(events: StoryEvent[], contexts: string[]): string {
  const sheet = recordedSheet(events) ?? {};
  const people = Object.entries(sheet).map(([id, c]) => {
    const fields = [c.name && `name: ${c.name}`, c.gender && `gender: ${c.gender}`, c.appearance && `appearance: ${c.appearance}`, c.background && `background: ${c.background}`].filter(Boolean);
    return fields.length ? `- ${id}: ${fields.join("; ")}` : "";
  }).filter(Boolean);
  return [people.length ? `THE AUTHOR'S CHARACTER SHEET (canon):\n${people.join("\n")}` : "", ...contexts.map((c) => `THE AUTHOR'S NOTES (canon):\n${c}`)].filter(Boolean).join("\n\n");
}

function latest(events: StoryEvent[]) {
  const scenes = new Map<number, { seq: number; data: SceneCommittedData }>();
  const art = new Map<number, { seq: number; data: SceneArtData }>();
  for (const e of events) {
    if (e.type === "scene_committed") scenes.set((e.data as SceneCommittedData).index, { seq: e.seq, data: e.data as SceneCommittedData });
    if (e.type === "scene_art") art.set((e.data as SceneArtData).sceneIndex, { seq: e.seq, data: e.data as SceneArtData });
  }
  return { scenes, art };
}

const shotKey = (scene: number, shot: number) => `scene-${String(scene + 1).padStart(2, "0")}-${String(shot + 1).padStart(2, "0")}`;

export async function runCanonCheck(o: { runDir: string; events: StoryEvent[]; role: Role; contexts: string[]; log?: (m: string) => void }): Promise<{ round?: Round; findings: CanonFinding[] }> {
  const canon = canonText(o.events, o.contexts);
  if (!canon) return { findings: [] };
  const { scenes, art } = latest(o.events);
  const findings: CanonFinding[] = [];
  for (const [index, { data }] of [...scenes.entries()].sort((a, b) => a[0] - b[0])) {
    const shots = (art.get(index)?.data.shots ?? []).map((s, k) => ({ key: shotKey(index, k), prompt: s.prompt }));
    const out = await checkCanon(o.role, { canon, prose: data.prose, shots });
    for (const issue of out.result) findings.push({ n: findings.length + 1, scene: index, ...issue });
    o.log?.(`scene ${index + 1}: ${out.result.length ? `${out.result.length} contradiction${out.result.length === 1 ? "" : "s"}` : "agrees with canon"}`);
  }
  if (findings.length === 0) return { findings };
  const round = await newRound(o.runDir, { kind: "canon", subject: "check", findings } satisfies CanonRound);
  await writeFile(join(round.dir, "legend.txt"), formatFindings(findings, o.runDir, round) + "\n");
  return { round, findings };
}

export function formatFindings(findings: CanonFinding[], runDir: string, round: Round): string {
  return [
    `Canon check: ${findings.length} contradiction${findings.length === 1 ? "" : "s"} between the written story and the canon (the run: ${runDir})`,
    "",
    ...findings.flatMap((f) => [
      `${f.n}. scene ${f.scene + 1}, ${f.where === "prose" ? "the prose" : `shot ${f.where} (art/scene/${f.where.slice(6, 8)}/${f.where.slice(9)}.jpg)`}`,
      `   canon: ${f.canon}`,
      `   now:   ${f.quote}`,
      `   fix:   ${f.fix || "(remove it)"}`,
      ""
    ]),
    `Apply them all: npm run canon -- <story.json> --apply   (or --apply --skip 2,5 to leave some; round ${round.name})`
  ].join("\n");
}

// Applies a canon round's fixes (all, or all but `skip`): backs up the event
// log, rewrites the latest prose and shot prompts, and rewrites story.md.
// Returns what changed, and the approved shots whose prompts changed (to revoke and redo).
export async function applyCanonFixes(o: { runDir: string; round?: number; skip?: number[] }): Promise<{ applied: CanonFinding[]; missing: CanonFinding[]; approvedShots: string[]; backup: string }> {
  const round = await findRound(o.runDir, "canon", "check", o.round);
  if (!round) throw new Error("no canon check round — run: npm run make -- <story.json> --only canon");
  const info = await readRound<CanonRound>(round);
  const take = info.findings.filter((f) => !(o.skip ?? []).includes(f.n));
  const file = join(o.runDir, "events.jsonl");
  const backupDir = join(o.runDir, "backups");
  await mkdir(backupDir, { recursive: true });
  const backup = join(backupDir, `events.jsonl.before-canon-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await copyFile(file, backup);
  const events: StoryEvent[] = (await readFile(file, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const { scenes, art } = latest(events);
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const applied: CanonFinding[] = [];
  const missing: CanonFinding[] = [];
  for (const f of take) {
    if (f.where === "prose") {
      const e = bySeq.get(scenes.get(f.scene)?.seq ?? -1);
      const d = e?.data as SceneCommittedData | undefined;
      if (d && d.prose.includes(f.quote)) { d.prose = d.prose.replace(f.quote, f.fix).replace(/ {2,}/g, " ").replace(/ ([.,;!?])/g, "$1"); applied.push(f); } else missing.push(f);
    } else {
      const k = Number(f.where.slice(9)) - 1;
      const shot = (bySeq.get(art.get(f.scene)?.seq ?? -1)?.data as SceneArtData | undefined)?.shots?.[k];
      if (shot && shot.prompt.includes(f.quote)) { shot.prompt = shot.prompt.replace(f.quote, f.fix); applied.push(f); } else missing.push(f);
    }
  }
  await writeFile(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  await writeFile(join(o.runDir, "story.md"), renderStory(events) + "\n");
  const approved = new Set((await readApprovals(o.runDir)).art);
  const approvedShots = [...new Set(applied.filter((f) => f.where !== "prose" && approved.has(f.where)).map((f) => f.where))];
  return { applied, missing, approvedShots, backup };
}
