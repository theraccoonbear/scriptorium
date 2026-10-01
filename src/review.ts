import { normalizeIssue } from "./roles.ts";
import type { Issue, Verdict } from "./types.ts";

// How the prose review loop tells a genuinely new issue from a reworded
// repeat, and when a passage has bounced between drafts long enough that the
// beat — not the draft — is the problem. Pure functions; the engine drives them.

// Stable key for an issue: type + constraint (falls back to entity). The constraint
// is the rule being violated and survives rewording across drafts, unlike entity
// quotes which change every rewrite.
export function issueKey(issue: Issue | string): string {
  const i = normalizeIssue(issue);
  const stable = (i.constraint || i.entity).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 50);
  return `${i.type}:${stable}`;
}

const STOP = new Set([
  "the", "and", "for", "from", "with", "that", "this", "his", "her", "its", "their", "into", "onto", "but", "not",
  "are", "was", "were", "has", "have", "had", "who", "what", "when", "where", "which", "while", "then", "than",
  "scene", "draft", "passage", "line", "lines", "moment", "sequence", "description", "section"
]);

function tokens(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[’']s\b/g, "").split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w))
  );
}

// Shared-token overlap relative to the smaller set: reworded quotes of the same
// passage keep their key words ("Kess's arrival and challenge…" twice) even
// when the quoted fragment changes.
function overlap(a: string, b: string): { shared: number; ratio: number } {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return { shared: 0, ratio: 0 };
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return { shared, ratio: shared / Math.min(ta.size, tb.size) };
}

// Two issues point at the same passage of the scene.
export function samePassage(a: Issue | string, b: Issue | string): boolean {
  const o = overlap(normalizeIssue(a).entity, normalizeIssue(b).entity);
  return o.shared >= 2 && o.ratio >= 0.5;
}

// The same complaint, however it's worded: same type, and the same rule, the
// same passage, or substantially the same explanation.
export function sameIssue(a: Issue | string, b: Issue | string): boolean {
  const x = normalizeIssue(a);
  const y = normalizeIssue(b);
  if (x.type !== y.type) return false;
  if (issueKey(x) === issueKey(y)) return true;
  if (samePassage(x, y)) return true;
  const d = overlap(x.detail, y.detail);
  return d.shared >= 4 && d.ratio >= 0.5;
}

export function dedupIssues<T extends Issue | string>(issues: T[]): T[] {
  const kept: T[] = [];
  for (const issue of issues) {
    if (!kept.some((k) => sameIssue(k, issue))) kept.push(issue);
  }
  return kept;
}

// Craft is the critic's lane. The continuist only judges continuity and canon;
// craft flags from it duplicate (or contradict) the critic and stall the loop.
// CRAFT itself is not here: it's the default type for an untyped issue, which
// may well be a real continuity problem.
export const CRAFT_TYPES: ReadonlySet<string> = new Set(["TELLING_NOT_SHOWING", "SENSORY_SPECIFICITY", "PACE", "STYLE_PATTERN"]);

export function continuistLane(verdict: Verdict): { verdict: Verdict; dropped: Issue[] } {
  const issues = verdict.issues.map(normalizeIssue);
  const kept = issues.filter((i) => !CRAFT_TYPES.has(i.type));
  const dropped = issues.filter((i) => CRAFT_TYPES.has(i.type));
  // A rejection that only had craft complaints is an approval from continuity's side.
  return { verdict: { ...verdict, ok: verdict.ok || kept.length === 0, issues: kept }, dropped };
}

// Issues from the latest round whose passage (or complaint) was also flagged
// in at least `minRounds - 1` earlier rounds, by either reviewer, as any type.
// A passage that keeps failing — reworded repeats, or reviewers demanding
// opposite fixes — won't be fixed by another draft.
export function stuckIssues(rounds: Issue[][], minRounds = 3): Issue[] {
  const latest = rounds[rounds.length - 1] ?? [];
  const earlier = rounds.slice(0, -1);
  return latest.filter((issue) => {
    const hits = earlier.filter((round) => round.some((prev) => samePassage(prev, issue) || sameIssue(prev, issue))).length;
    return hits + 1 >= minRounds;
  });
}
