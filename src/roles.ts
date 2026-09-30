import { renderBible, emptyBible } from "./bible.ts";
import type {
  Beat,
  Bible,
  CompletionRequest,
  Issue,
  Patch,
  Role,
  RoleOutput,
  Setup,
  Verdict,
  WorldOutput
} from "./types.ts";

const WORLDBUILDER_SYSTEM = `You are the Worldbuilder. Generate names and setting details for a story.
Given a genre and setting, produce character names that belong there.
Output ONLY JSON with this shape:
{
  "characters":[{"name":string,"archetype":string}],
  "locations":[{"name":string,"archetype":string}],
  "setting_notes":string
}
Names should feel like real people in this specific world — not generic, not curated for variety.
Location names should be evocative but grounded.
setting_notes is one paragraph of world flavor that will guide the Creator.`;

const CREATOR_SYSTEM = `You are the Creator. You generate the foundation for a procedurally generated story.
Output ONLY JSON with this shape:
{
  "premise":string,
  "tone":string,
  "characters":[{"id":string,"name":string,"traits":string,"goal":string,"voice":string}],
  "locations":[{"id":string,"name":string,"description":string}],
  "threads":[{"id":string,"title":string,"status":"open"}],
  "beat":{"goal":string,"conflict":string,"pov":characterId,"location":locationId,"mustReveal":string,"constraints":[string],"payoffs":[]}
}
Each character needs a distinct voice that will guide the Writer.
The beat is the first scene. Payoffs must be empty (no prior setups exist).
Create the premise, setting, and cast that make the best story — one character, five, whatever serves it.
You will be given character names and location names — use them exactly, do not invent new ones.
Before outputting, verify the beat is self-satisfiable: mustReveal and constraints must be jointly satisfiable by one scene. If a constraint requires something to remain unresolved, the reveal cannot be that the thing is solved, resolved, or compensated.`;

export const DIRECTOR_SYSTEM = `You are the Director of a procedurally generated story. You never write prose.
Plan the next scene as a beat spec. Output ONLY JSON with this shape:
{"goal":string,"conflict":string,"pov":characterId,"location":string,"mustReveal":string,"constraints":[string],"payoffs":[setupId]}
Honor the tension target and the required complication. Every overdue setup must appear in payoffs.
Never contradict the bible.
Before outputting, verify the beat is self-satisfiable: mustReveal and constraints must be jointly satisfiable by one scene. If a constraint requires something to remain unresolved, the reveal cannot be that the thing is solved, resolved, or compensated.
The bible lists RESOLVED DECISIONS — choices characters have already made and closed. Do not build a beat whose core is re-deciding one of them (having characters re-choose what is already chosen). A resolved decision may be referenced only if the beat adds genuinely NEW pressure on it: new stakes, new information, or a new cost. Each scene must turn the story somewhere it has not been.`;

const WRITER_SYSTEM = `You are the Writer. Render the beat spec as a single scene of prose.
Stay strictly in the POV character's voice and knowledge. Obey every constraint.
Do not resolve anything the beat does not resolve. Output only the scene text.

REVISION RULES:
- When given a previous draft and issues to fix, PRESERVE the existing prose.
- Do not rewrite from scratch. Only change what the issues require.
- Keep everything that works — voice, pacing, imagery, dialogue.
- Fix the listed issues surgically. Introducing new problems is worse than leaving minor ones.

EXCEPTION — STRUCTURAL ISSUES:
- CONSTRAINT_VIOLATION, UNRESOLVED_SETUP, UNSATISFIABLE_CONSTRAINT, POV_VIOLATION, and TIMELINE_INCONSISTENCY are structural. They cannot be fixed by rewording sentences.
- For these, you MAY restructure the scene — including rewriting the ending or a whole passage — as long as the beat spec is satisfied and other constraints are not broken.
- Style/pace issues (TELLING_NOT_SHOWING, SENSORY_SPECIFICITY, PACE, CRAFT) still get surgical fixes only.`;

const ISSUE_TYPES = `ISSUE TYPES (use the exact enum value):
- POV_VIOLATION: narrator knows/observes what POV character cannot
- CONSTRAINT_VIOLATION: scene breaks a beat spec constraint
- TIMELINE_INCONSISTENCY: dates, durations, or event ordering conflict
- CHARACTER_ARC: behavior contradicts established personality without motivation
- TELLING_NOT_SHOWING: emotional beats explained instead of dramatized
- SENSORY_SPECIFICITY: prose lacks concrete sensory detail (e.g. what something sounds like)
- EPISTEMIC_VIOLATION: character asserts certainty they cannot have
- UNRESOLVED_SETUP: a required revelation or payoff is only implied, not established
- UNINTRODUCED_ENTITY: named character/location appears without introduction
- PACE: scene moves too fast/slow, transitions feel abrupt
- CRAFT: word choice, repetition, voice inconsistency, exposition issues

SPEC ISSUE TYPES (for reviewing beat specs and bible patches, not prose):
- UNSATISFIABLE_CONSTRAINT: two or more requirements in the spec cannot all be satisfied at once
- CANON_CONTRADICTION: spec or patch conflicts with established bible facts
- POV_LEAK: spec requires information the POV character cannot plausibly have
- WRONG_PAYOFF: a payoff doesn't match its setup, or a required setup is missing
- INADEQUATE_SPEC: required fields missing/empty, duplicate names, or output too generic to use
- REHASH: the beat re-litigates an already-resolved decision without introducing new pressure`;

// Shared issue contract for ALL gates. One schema, one dedup key — a gate that
// omits `constraint` degrades repeat-detection to prose quotes that change every
// rewrite, making the same conceptual issue look new forever.
export const ISSUE_SCHEMA = `Each ISSUE is an object:
{"type":string,"entity":string,"constraint":string,"detail":string}
- type: one of the allowed ISSUE TYPES (see below)
- entity: the specific text, phrase, character, or element in conflict (quote it directly if text-based)
- constraint: the rule being broken (beat spec constraint, bible rule, craft requirement) — omit if N/A
- detail: one sentence explaining why this is broken`;

// Shared first-appearance / dedup rules for ALL gates.
export const ISSUE_RULES = `CRITICAL RULES:
- FLAG EVERY ISSUE THE MOMENT YOU SEE IT. An issue you observe but do not flag in the draft where it appears can never be flagged in a later draft.
- If you already flagged an issue in a previous draft, do NOT flag it again — even if you would word it differently. Same type + same constraint (or same entity if no constraint) = same issue. You will be shown issues you flagged in previous drafts.
- NEVER include an issue if your reasoning concludes "this is not an issue." If it's fine, omit it.
- Each issue must be a concrete, specific problem with a quotable entity and, where one exists, the rule it breaks.`;

export const CONTINUIST_SYSTEM = `You are the Continuity Guard. Check the scene against the bible, the beat spec, the open setups, and all previous scenes.

Output ONLY JSON:
{"ok":boolean,"issues":[ISSUE]}

${ISSUE_SCHEMA}

${ISSUE_TYPES}

You are a BLOCKING reviewer. Only flag issues that would break the story for a reader.
Do NOT flag style preferences or prose quality (the Critic handles that).

INTERPRETING CONSTRAINTS:
- "Unresolved" means the material state of the world — a shortage still short, a secret still hidden, a choice still unmade. It is NOT about the character's attitude or emotional response.
- If the prose states the problem is still unresolved AND no resource, answer, or resolution has actually appeared, the constraint is satisfied — even if the character feels hopeful, calm, or confident about it.
- Do not flag a constraint when the only evidence is the character's internal outlook.

DELIVERING THE BEAT (check this every draft):
- The beat spec's mustReveal and every constraint are requirements the prose must ESTABLISH — on the page, in this scene, before it ends.
- If the scene ends without establishing the mustReveal (a character never appears, an event never happens, a revelation stays implied), flag UNRESOLVED_SETUP with the beat text as the constraint.
- If the prose violates an explicit constraint, flag CONSTRAINT_VIOLATION with that constraint text.
- Do not assume a later scene will deliver what this beat requires. The beat gate approved the spec for THIS scene.

${ISSUE_RULES}`;

export const CRITIC_SYSTEM = `You are the Critic. You review drafts of a story scene for quality and request revisions when needed.

Output ONLY JSON:
{"ok":boolean,"issues":[ISSUE],"review":string}

${ISSUE_SCHEMA}

BLOCKING ISSUE TYPES (only these can go in "issues"):
- TELLING_NOT_SHOWING: emotional beats explained instead of dramatized
- SENSORY_SPECIFICITY: prose lacks concrete sensory detail where it matters
- PACE: scene moves too fast/slow, transitions feel abrupt
- EPISTEMIC_VIOLATION: character asserts certainty they cannot have
- UNRESOLVED_SETUP: a required revelation or payoff is only implied, not established
- CHARACTER_ARC: behavior contradicts established personality without motivation

DO NOT put CRAFT issues (word choice, repetition, voice, exposition style, metaphor quality, "overwrought," "editorializing") in the issues array. Put those in the review field instead. CRAFT is subjective and does not justify a rewrite on its own.

- ok: true if the draft is acceptable, false if it needs revision
- review: your markdown review of prose quality, pacing, character voice, craft

- FLAG ONLY THE 3-5 MOST IMPACTFUL ISSUES. If you see more, pick the ones that would most confuse or alienate a reader. Everything else goes in the review.
${ISSUE_RULES}
- Be honest about quality but pragmatic — not every imperfection justifies a rewrite.
- You share this pipeline with a continuity checker. Focus on prose quality and story craft; they handle continuity.`;

export const ARCHIVIST_SYSTEM = `You are the Archivist, the only role allowed to change the story bible.
Read the committed scene and output ONLY a JSON patch:
{"upsertCharacters":[{"id":string,"name"?:string,"traits"?:string,"goal"?:string,"voice"?:string,"status"?:string}],
"upsertLocations":[{"id":string,"name"?:string,"description"?:string}],
"upsertThreads":[{"id":string,"title"?:string,"status"?:string}],
"openSetups":[{"id":string,"text":string}],
"paySetups":[setupId],
"resolveDecisions":[string],
"timeline":"one line summary of what happened"}
Only record facts established in the scene.
resolveDecisions: choices or commitments that CLOSED in this scene — decisions the characters will not re-make without new pressure. List only what the scene actually settles; an open or deferred choice does not belong here.`;

export const BEAT_GATE_SYSTEM = `You are the Beat Gate. You review a beat spec BEFORE any prose is written.
Your job: catch specs that a writer cannot satisfy, or that contradict the story bible.

Output ONLY JSON:
{"ok":boolean,"issues":[ISSUE]}

${ISSUE_SCHEMA}

Allowed types:
- UNSATISFIABLE_CONSTRAINT: two or more requirements cannot all be satisfied by one scene
- CANON_CONTRADICTION: the spec conflicts with established bible facts
- POV_LEAK: the spec requires the POV character to know something they cannot plausibly know
- WRONG_PAYOFF: a payoff doesn't match its setup, or an overdue setup is missing from payoffs

CHECK SPECIFICALLY:
- Read mustReveal against every constraint. If the reveal would itself violate a constraint (e.g. the reveal says a problem is solved/compensated while a constraint says it must remain unresolved), flag UNSATISFIABLE_CONSTRAINT.
- Read constraints against each other. Two constraints that cannot hold in the same scene = UNSATISFIABLE_CONSTRAINT.
- Read the conflict and payoffs against the bible and prior scenes.
- Read the beat's goal and conflict against the bible's RESOLVED DECISIONS. If the scene's core is re-deciding something already closed — with no new pressure, stakes, or information — flag REHASH.
- A beat that adds nothing the story hasn't already done (same turn, restated) also fails: flag REHASH.

${ISSUE_RULES}
- ok: true if a competent writer can satisfy this spec without contradicting itself or the bible.
- Only flag issues that genuinely block a draft. Do not suggest improvements or style opinions.`;

export const PATCH_GATE_SYSTEM = `You are the Patch Gate. You review the Archivist's proposed bible patch BEFORE it is applied.
Your job: catch patches that contradict the story bible or record facts the scene never established.

SCOPE — WHAT YOU DO NOT JUDGE:
- The committed scene has ALREADY been approved against the beat spec by the prose gates. Do NOT re-check whether the scene delivered the beat's mustReveal or satisfied its constraints. That verdict is final.
- Do NOT flag a patch because it accurately records an incomplete scene (e.g. a setup left open, a revelation not yet delivered). An accurate record of what happened — including what did NOT happen — is correct and safe to apply.
- You judge ONLY the patch: does each entry match the committed scene, and does it contradict the bible?

Output ONLY JSON:
{"ok":boolean,"issues":[ISSUE]}

${ISSUE_SCHEMA}

Allowed types:
- CANON_CONTRADICTION: the patch contradicts an existing bible fact or a previously committed scene
- WRONG_PAYOFF: the patch claims a payoff happened in this scene when the committed scene shows it did not, or opens a duplicate/unknown setup
- UNINTRODUCED_ENTITY: the patch creates a character/location/thread the scene never mentioned

${ISSUE_RULES}
- ok: true if the patch is safe to apply.
- Only record what the committed scene actually establishes — flag anything inferred, assumed, or carried over from an uncommitted draft.`;

export const WORLD_GATE_SYSTEM = `You are the World Gate. You review the Worldbuilder's output before the Creator uses it.
Your job: catch names and setting details that are unusable or clash with the premise.

Output ONLY JSON:
{"ok":boolean,"issues":[ISSUE]}

${ISSUE_SCHEMA}

Allowed types:
- CANON_CONTRADICTION: an entry contradicts the premise, setting, or author context
- INADEQUATE_SPEC: required fields missing/empty, duplicate names, or archetypes so generic they can't distinguish characters

${ISSUE_RULES}
- ok: true if the Creator can build a story from this output.
- Names need not be perfect — only flag output that is empty, duplicated, contradictory, or unusable.`;

export function parseJson(text: unknown): unknown {
  const trimmed = String(text).trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error(`No JSON object in model output: ${trimmed.slice(0, 120)}`);
    }
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

interface JsonCallRequest {
  role: string;
  system: string;
  prompt: string;
  ctx?: Record<string, unknown>;
}

async function callJson(role: Role, req: JsonCallRequest, retries = 1): Promise<RoleOutput<unknown>> {
  let lastErr: unknown;
  let raw = "";
  let prompt = req.prompt;
  let current = req;
  for (let i = 0; i <= retries; i++) {
    prompt = current.prompt;
    raw = await role.provider.complete({ ...current, temperature: role.temperature, timeoutMs: role.timeoutMs });
    try {
      return { result: parseJson(raw), prompt, system: current.system, raw };
    } catch (err) {
      lastErr = err;
      current = { ...current, prompt: `${current.prompt}\n\nYour last reply was not valid JSON. Reply with JSON only.` };
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// Shape of the Creator's JSON output (foundation + scene-1 beat).
interface CreatorFoundation {
  premise?: string;
  tone?: string;
  characters?: { id?: string; name?: string; traits?: string; goal?: string; voice?: string }[];
  locations?: { id?: string; name?: string; description?: string }[];
  threads?: { id?: string; title?: string; status?: string }[];
  beat?: Beat;
}

function applyBibleData(data: CreatorFoundation): Bible {
  const bible = emptyBible();
  bible.premise = data.premise || "";
  bible.tone = data.tone || "";
  for (const c of data.characters || []) {
    if (c.id) bible.characters[c.id] = { id: c.id, name: c.name || c.id, traits: c.traits || "", goal: c.goal || "", voice: c.voice || "", status: "active" };
  }
  for (const l of data.locations || []) {
    if (l.id) bible.locations[l.id] = { id: l.id, name: l.name || l.id, description: l.description || "" };
  }
  for (const t of data.threads || []) {
    if (t.id) bible.threads[t.id] = { id: t.id, title: t.title || t.id, status: t.status || "open" };
  }
  return bible;
}

// Shared feedback block for every creative: how a rejected output is handed back.
function feedbackBlock(
  issues: ReadonlyArray<Issue | string> | undefined,
  fresh: boolean | undefined,
  freshHeader: string,
  retryHeader: string,
  trailer = ""
): string {
  if (!issues || issues.length === 0) return "";
  const header = fresh ? freshHeader : retryHeader;
  const lines = issues.map((i) => `- ${renderIssue(normalizeIssue(i))}`).join("\n");
  return `${header}\n${lines}${trailer}`;
}

// Shared "previously flagged issues" block for every gate prompt.
function previousIssuesBlock(
  issues: ReadonlyArray<Issue | string> | undefined,
  heading: string
): string {
  if (!issues || issues.length === 0) return "";
  return `${heading}:\n${issues.map((i) => `- ${renderIssue(normalizeIssue(i))}`).join("\n")}`;
}

export interface CreativeFeedback {
  issues?: ReadonlyArray<Issue | string>;
  fresh?: boolean;
}

export async function buildWorld(role: Role, params: {
  setting?: string;
  premise?: string;
  context?: string;
} & CreativeFeedback): Promise<RoleOutput<WorldOutput>> {
  const { setting, premise, context, issues, fresh } = params;
  const parts: string[] = [];
  if (context) parts.push(`STORY CONTEXT (provided by author):\n${context}`);
  if (premise) parts.push(`STORY PREMISE: ${premise}`);
  if (setting) parts.push(`Genre and setting: ${setting}`);
  if (!premise && !setting && !context) {
    parts.push(`Generate character names and locations for a story. Pick a genre and setting that makes for a good story.`);
  } else {
    parts.push(`Generate character names and locations that belong in this world.`);
  }
  const fb = feedbackBlock(
    issues,
    fresh,
    "YOUR PREVIOUS OUTPUT WAS REJECTED — START FROM SCRATCH with different names and details. DO NOT reuse the previous output.",
    "YOUR PREVIOUS OUTPUT WAS REJECTED. ISSUES TO FIX:"
  );
  if (fb) parts.push(fb);
  const prompt = parts.join("\n\n");
  const { result, system, raw } = await callJson(role, {
    role: "worldbuilder",
    system: WORLDBUILDER_SYSTEM,
    prompt,
    ctx: { setting, premise, context, issues, fresh }
  });
  return { result: result as WorldOutput, prompt, system, raw };
}

export interface CreatorOutput {
  bible: Bible;
  beat: Beat;
  prompt: string;
  system: string;
  raw: string;
}

export async function createAndDirect(role: Role, params: {
  sceneIndex: number;
  total: number;
  tension: number;
  complication: string;
  world: WorldOutput;
  premise?: string;
  context?: string;
} & CreativeFeedback): Promise<CreatorOutput> {
  const { sceneIndex, total, tension, complication, world, premise, context, issues, fresh } = params;
  const charNames = (world.characters || []).map((c) => `${c.name} (${c.archetype})`).join(", ");
  const locNames = (world.locations || []).map((l) => `${l.name} (${l.archetype})`).join(", ");
  const fix = feedbackBlock(
    issues,
    fresh,
    "YOUR PREVIOUS FOUNDATION AND BEAT WERE REJECTED — START FROM SCRATCH with a different approach. DO NOT reuse the previous framing.",
    "YOUR PREVIOUS BEAT SPEC WAS REJECTED. ISSUES TO FIX:"
  );
  const prompt = [
    `Generate the foundation for a story, then plan scene 1 of ${total}.`,
    context ? `STORY CONTEXT (provided by author):\n${context}` : "",
    premise ? `STORY PREMISE: ${premise}` : "",
    world.setting_notes ? `WORLD: ${world.setting_notes}` : "",
    charNames ? `USE THESE CHARACTER NAMES: ${charNames}` : "",
    locNames ? `USE THESE LOCATION NAMES: ${locNames}` : "",
    `TENSION TARGET (1-10): ${tension}`,
    `REQUIRED COMPLICATION: ${complication}`,
    fix
  ].filter(Boolean).join("\n\n");
  const { result, system, raw } = await callJson(role, {
    role: "creator",
    system: CREATOR_SYSTEM,
    prompt,
    ctx: { sceneIndex, total, tension, complication, world, premise, context, issues, fresh }
  });
  const foundation = result as CreatorFoundation;
  const bible = applyBibleData(foundation);
  return { bible, beat: foundation.beat as Beat, prompt, system, raw };
}

export async function direct(role: Role, params: {
  bible: Bible;
  sceneIndex: number;
  total: number;
  tension: number;
  complication: string;
  overdue: Setup[];
} & CreativeFeedback): Promise<RoleOutput<Beat>> {
  const { bible, sceneIndex, total, tension, complication, overdue, issues, fresh } = params;
  const fix = feedbackBlock(
    issues,
    fresh,
    "YOUR PREVIOUS BEAT SPEC WAS REJECTED — START FROM SCRATCH with a different approach. DO NOT reuse the previous spec's framing.",
    "YOUR PREVIOUS BEAT SPEC WAS REJECTED. ISSUES TO FIX:"
  );
  const prompt = [
    renderBible(bible),
    `SCENE ${sceneIndex + 1} OF ${total}`,
    `TENSION TARGET (1-10): ${tension}`,
    `REQUIRED COMPLICATION: ${complication}`,
    `OVERDUE SETUPS TO PAY OFF: ${overdue.map((s) => s.id).join(", ") || "none"}`,
    fix
  ].filter(Boolean).join("\n\n");
  const { result, system, raw } = await callJson(role, {
    role: "director",
    system: DIRECTOR_SYSTEM,
    prompt,
    ctx: { bible, sceneIndex, total, tension, complication, overdue, issues, fresh }
  });
  return { result: result as Beat, prompt, system, raw };
}

export async function write(role: Role, params: {
  bible: Bible;
  beat: Beat;
  sceneIndex: number;
  attempt: number;
  previousDraft?: string;
  previousScenes?: string[];
} & CreativeFeedback): Promise<RoleOutput<string>> {
  const { bible, beat, sceneIndex, attempt, previousDraft, previousScenes, issues, fresh } = params;
  const pov = bible.characters[beat.pov];
  const voice = pov && pov.voice ? `VOICE: ${pov.name} — ${pov.voice}` : "";
  const fix = feedbackBlock(
    issues,
    fresh,
    "PREVIOUS ATTEMPTS AT THIS SCENE FAILED REVIEW. TAKE A FRESH STAB — write this scene from scratch with a different approach. Do not reuse the previous drafts' wording or structure. These are the requirements learned so far:",
    "THE REVIEWERS REJECTED THE PREVIOUS DRAFT. ISSUES TO FIX:",
    fresh ? "" : "\n\nPreserve everything that works in the previous draft. Fix only the issues above."
  );
  const draft = previousDraft && !fresh ? `PREVIOUS DRAFT:\n${previousDraft}` : "";
  const priorProse = (previousScenes || [])
    .map((s, idx) => `--- SCENE ${idx + 1} (already committed) ---\n${s}`)
    .join("\n\n");
  const prompt = [
    renderBible(bible),
    priorProse ? `PREVIOUS SCENES (established canon — do not contradict):\n\n${priorProse}` : "",
    `GOAL: ${beat.goal}\nCONFLICT: ${beat.conflict}\nLOCATION: ${beat.location}\nMUST REVEAL: ${beat.mustReveal}`,
    `CONSTRAINTS:\n${beat.constraints.map((c) => `- ${c}`).join("\n")}`,
    voice,
    draft,
    fix
  ].filter(Boolean).join("\n\n");
  const raw = await role.provider.complete({
    role: "writer",
    system: WRITER_SYSTEM,
    prompt,
    temperature: role.temperature,
    timeoutMs: role.timeoutMs,
    ctx: { bible, beat, sceneIndex, attempt }
  });
  return { result: raw, prompt, system: WRITER_SYSTEM, raw };
}

// Context shared by the two prose gates. Same inputs, different prompts.
export interface ProseGateParams {
  bible: Bible;
  beat: Beat;
  prose: string;
  sceneIndex: number;
  attempt: number;
  previousScenes?: string[];
  previousIssues?: ReadonlyArray<Issue | string>;
  context?: string;
}

function buildGateContext(params: ProseGateParams): string {
  const { bible, beat, prose, sceneIndex, attempt, previousScenes, previousIssues, context } = params;
  const priorProse = (previousScenes || [])
    .map((s, idx) => `--- SCENE ${idx + 1} (committed) ---\n${s}`)
    .join("\n\n");
  const priorIssues = previousIssuesBlock(
    previousIssues,
    "ISSUES FLAGGED IN PREVIOUS DRAFTS (do not re-flag — same type + same constraint = same issue)"
  );
  const draftNum = attempt + 1;
  return [
    `SCENE ${sceneIndex + 1}`,
    context ? `STORY CONTEXT (provided by author):\n${context}` : "",
    renderBible(bible),
    priorProse ? `PREVIOUS SCENES (established canon):\n\n${priorProse}` : "",
    priorIssues,
    beat ? `BEAT SPEC:\n${JSON.stringify(beat, null, 2)}` : "",
    `CURRENT SCENE (draft ${draftNum}):\n${prose}`
  ].filter(Boolean).join("\n\n");
}

// Normalize an issue from either structured object or legacy string format.
export function normalizeIssue(issue: Issue | string): Issue {
  if (typeof issue === "string") {
    return { type: "CRAFT", entity: issue.slice(0, 80), constraint: "", detail: issue };
  }
  const i = issue as Partial<Issue>;
  return {
    type: i.type || "CRAFT",
    entity: i.entity || "",
    constraint: i.constraint || "",
    detail: i.detail || ""
  };
}

// Render an issue for human-readable output.
export function renderIssue(issue: Issue | string): string {
  const i = normalizeIssue(issue);
  const parts = [`[${i.type}] ${i.entity}`];
  if (i.constraint) parts.push(`(constraint: ${i.constraint})`);
  if (i.detail) parts.push(`— ${i.detail}`);
  return parts.join(" ");
}

// ---- gates ----
// ONE runner for every gate: same normalization, same verdict format, same raw
// output shape. A gate prompt only supplies its label, system, and prompt.

interface GateCall {
  label: string;
  system: string;
  prompt: string;
  ctx: Record<string, unknown>;
  review?: boolean;
}

async function runGate(role: Role, call: GateCall): Promise<RoleOutput<Verdict>> {
  const { result, system, prompt, raw: rawJson } = await callJson(role, {
    role: call.label,
    system: call.system,
    prompt: call.prompt,
    ctx: call.ctx
  });
  const parsed = result as { ok?: unknown; issues?: unknown; review?: unknown };
  const verdict: Verdict = {
    ok: Boolean(parsed.ok),
    issues: Array.isArray(parsed.issues) ? parsed.issues.map((i) => normalizeIssue(i as Issue | string)) : [],
    ...(call.review ? { review: String(parsed.review || "") } : {})
  };
  const raw = [
    `**Verdict:** ${verdict.ok ? "APPROVED" : `REVISION REQUESTED (${verdict.issues.length} issue${verdict.issues.length === 1 ? "" : "s"})`}`,
    verdict.issues.length ? `**Issues:**\n${verdict.issues.map((i) => `- ${renderIssue(i)}`).join("\n")}` : "",
    verdict.review || "",
    "```json",
    rawJson,
    "```"
  ].filter((line) => line !== "").join("\n");
  return { result: verdict, prompt, system, raw };
}

export async function checkContinuity(role: Role, params: ProseGateParams): Promise<RoleOutput<Verdict>> {
  const prompt = buildGateContext(params);
  return runGate(role, {
    label: "continuist",
    system: CONTINUIST_SYSTEM,
    prompt,
    ctx: {
      bible: params.bible, beat: params.beat, prose: params.prose,
      sceneIndex: params.sceneIndex, attempt: params.attempt,
      previousScenes: params.previousScenes, previousIssues: params.previousIssues
    }
  });
}

export async function review(role: Role, params: ProseGateParams): Promise<RoleOutput<Verdict>> {
  const prompt = buildGateContext(params);
  return runGate(role, {
    label: "critic",
    system: CRITIC_SYSTEM,
    prompt,
    ctx: {
      bible: params.bible, beat: params.beat, prose: params.prose,
      sceneIndex: params.sceneIndex, attempt: params.attempt,
      previousScenes: params.previousScenes, previousIssues: params.previousIssues
    },
    review: true
  });
}

export async function archive(role: Role, params: {
  bible: Bible;
  beat: Beat;
  prose: string;
  sceneIndex: number;
  isFinal: boolean;
} & CreativeFeedback): Promise<RoleOutput<Patch>> {
  const { bible, beat, prose, sceneIndex, isFinal, issues, fresh } = params;
  const trimmedProse = prose.length > 3000 ? prose.slice(0, 3000) + "\n\n[...truncated for archivist]" : prose;
  const fix = feedbackBlock(
    issues,
    fresh,
    "YOUR PREVIOUS PATCH WAS REJECTED — PRODUCE A FRESH PATCH FROM SCRATCH.",
    "YOUR PREVIOUS PATCH WAS REJECTED. ISSUES TO FIX:"
  );
  const prompt = [
    renderBible(bible),
    `BEAT SPEC:\n${JSON.stringify(beat, null, 2)}`,
    `COMMITTED SCENE:\n${trimmedProse}`,
    fix
  ].filter(Boolean).join("\n\n");
  const { result, system, raw } = await callJson(role, {
    role: "archivist",
    system: ARCHIVIST_SYSTEM,
    prompt,
    ctx: { bible, beat, prose, sceneIndex, isFinal, issues, fresh }
  });
  return { result: result as Patch, prompt, system, raw };
}

// Gate a beat spec before any prose is written.
export async function reviewBeat(role: Role, params: {
  bible: Bible;
  beat: Beat;
  sceneIndex: number;
  total: number;
  tension: number;
  complication: string;
  overdue?: Setup[];
  previousIssues?: ReadonlyArray<Issue | string>;
  context?: string;
}): Promise<RoleOutput<Verdict>> {
  const { bible, beat, sceneIndex, total, tension, complication, overdue, previousIssues, context } = params;
  const priorIssues = previousIssuesBlock(previousIssues, "BEAT SPEC ISSUES FLAGGED PREVIOUSLY (do not re-flag)");
  const prompt = [
    context ? `STORY CONTEXT (provided by author):\n${context}` : "",
    renderBible(bible),
    `SCENE ${sceneIndex + 1} OF ${total}`,
    `TENSION TARGET (1-10): ${tension}`,
    `REQUIRED COMPLICATION: ${complication}`,
    overdue ? `OVERDUE SETUPS TO PAY OFF: ${overdue.map((s) => s.id).join(", ") || "none"}` : "",
    `BEAT SPEC:\n${JSON.stringify(beat, null, 2)}`,
    priorIssues
  ].filter(Boolean).join("\n\n");
  return runGate(role, {
    label: "beatgate",
    system: BEAT_GATE_SYSTEM,
    prompt,
    ctx: { bible, beat, sceneIndex, overdue, previousIssues }
  });
}

// Gate the Worldbuilder's output before the Creator uses it.
export async function reviewWorld(role: Role, params: {
  world: WorldOutput;
  setting?: string;
  premise?: string;
  context?: string;
  previousIssues?: ReadonlyArray<Issue | string>;
}): Promise<RoleOutput<Verdict>> {
  const { world, setting, premise, context, previousIssues } = params;
  const priorIssues = previousIssuesBlock(previousIssues, "WORLD OUTPUT ISSUES FLAGGED PREVIOUSLY (do not re-flag)");
  const prompt = [
    context ? `STORY CONTEXT (provided by author):\n${context}` : "",
    premise ? `STORY PREMISE: ${premise}` : "",
    setting ? `Genre and setting: ${setting}` : "",
    `WORLD OUTPUT:\n${JSON.stringify(world, null, 2)}`,
    priorIssues
  ].filter(Boolean).join("\n\n");
  return runGate(role, {
    label: "worldgate",
    system: WORLD_GATE_SYSTEM,
    prompt,
    ctx: { world, setting, premise, previousIssues }
  });
}

// Gate an archivist patch before it mutates the bible.
export async function reviewPatch(role: Role, params: {
  bible: Bible;
  beat: Beat;
  prose: string;
  sceneIndex: number;
  patch: Patch;
  previousIssues?: ReadonlyArray<Issue | string>;
}): Promise<RoleOutput<Verdict>> {
  const { bible, beat, prose, sceneIndex, patch, previousIssues } = params;
  const trimmedProse = prose.length > 3000 ? prose.slice(0, 3000) + "\n\n[...truncated for review]" : prose;
  const priorIssues = previousIssuesBlock(previousIssues, "PATCH ISSUES FLAGGED PREVIOUSLY (do not re-flag)");
  const prompt = [
    renderBible(bible),
    `BEAT SPEC:\n${JSON.stringify(beat, null, 2)}`,
    `COMMITTED SCENE:\n${trimmedProse}`,
    `PROPOSED PATCH:\n${JSON.stringify(patch, null, 2)}`,
    priorIssues
  ].join("\n\n");
  return runGate(role, {
    label: "patchgate",
    system: PATCH_GATE_SYSTEM,
    prompt,
    ctx: { bible, beat, prose, sceneIndex, patch, previousIssues }
  });
}
