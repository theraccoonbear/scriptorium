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
  WordBudget,
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
  "characters":[{"id":string,"name":string,"traits":string,"goal":string,"voice":string,"gender":"female"|"male"|""}],
  "locations":[{"id":string,"name":string,"description":string}],
  "threads":[{"id":string,"title":string,"status":"open"}],
  "beat":{"goal":string,"conflict":string,"pov":characterId,"location":locationId,"mustReveal":string,"constraints":[string],"payoffs":[]}
}
Each character needs a distinct voice that will guide the Writer.
Give each character's gender as "female" or "male" when the story has one in mind; use "" for unspecified, non-binary, or genderless characters. It picks their audiobook narration voice.
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

export const WRITER_SYSTEM = `You are the Writer. Render the beat spec as a single scene of prose.
Stay strictly in the POV character's voice and knowledge. Obey every constraint.
Do not resolve anything the beat does not resolve. Output only the scene text.

LENGTH:
- If a LENGTH TARGET is given, stay inside the band — end the scene when it is done.
- Land the ending ONCE. Never restate the resolution, recap the scene's turn, or echo the final beat in new words. One closing image, then stop.

STYLE:
- No negation-then-correction ("Not pity, not exactly..."; "Not relief, not quite grief..."). Pick the true thing and commit to it.
- No abstract padding where a concrete detail belongs ("the specific weight", "the specific silence"). Prefer the image, the sound, the physical fact.
- Never state the theme outright when the scene has already dramatized it. If the reader has felt it, don't explain it.

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
- UNADDRESSED_PRACTICAL: an established problem has an obvious in-world fix that goes unused with no reason given (e.g. a crack that could simply be sealed) — if a beat constraint explains the non-use, do not flag
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

PRACTICAL GAPS:
- If the prose establishes a problem with an obvious in-world fix, and neither the scene nor a beat constraint explains why the fix is not used, flag UNADDRESSED_PRACTICAL — entity quotes the problem, constraint names the missing reason.
- If a beat constraint already accounts for why the fix cannot be used, do NOT flag: the constraint is the reason.
- If the beat both forbids the obvious fix and leaves no alternative account, that contradiction belongs to the beat gate (UNSATISFIABLE_CONSTRAINT) — do not flag it here.

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
- STYLE_PATTERN: a stylistic tic repeated THREE OR MORE times in this scene (recurrence required — see STYLE ENFORCEMENT)

LENGTH ENFORCEMENT:
- When the prompt gives a LENGTH TARGET, a scene that exceeds twice the maximum is a blocking PACE issue (sustained overshoot). Under the band is not blocking — flag verbosity or thinness in the review text instead.

STYLE ENFORCEMENT:
- STYLE_PATTERN blocks only when the same tic recurs THREE OR MORE times (negation-then-correction, abstract padding instead of concrete detail, narration restating the theme). Entity quotes one example; detail names the approximate count.
- One or two occurrences are NOT blocking — put them in the review text. CRAFT remains non-blocking regardless.

VOICE DRIFT:
- CHARACTER_ARC also covers voice drift: when a speaker reads like another character's voice sheet, or abandons their own register so who-is-speaking becomes muddled, flag CHARACTER_ARC (entity = the passage; detail = which voice was lost or borrowed).
- Only when it confuses attribution. Subtle register variation under pressure is fine — put that in the review text.

DO NOT put CRAFT issues (word choice, repetition, voice, exposition style, metaphor quality, "overwrought," "editorializing") in the issues array. Put those in the review field instead. CRAFT is subjective and does not justify a rewrite on its own.

- ok: true if the draft is acceptable, false if it needs revision
- review: your markdown review of prose quality, pacing, character voice, craft

- FLAG ONLY THE 3-5 MOST IMPACTFUL ISSUES. If you see more, pick the ones that would most confuse or alienate a reader. Everything else goes in the review.
${ISSUE_RULES}
- Be honest about quality but pragmatic — not every imperfection justifies a rewrite.
- You share this pipeline with a continuity checker. Focus on prose quality and story craft; they handle continuity.`;

export const ARCHIVIST_SYSTEM = `You are the Archivist, the only role allowed to change the story bible.
Read the committed scene and output ONLY a JSON patch:
{"upsertCharacters":[{"id":string,"name"?:string,"traits"?:string,"goal"?:string,"voice"?:string,"status"?:string,"gender"?:"female"|"male"|""}],
"upsertLocations":[{"id":string,"name"?:string,"description"?:string}],
"upsertThreads":[{"id":string,"title"?:string,"status"?:string}],
"openSetups":[{"id":string,"text":string}],
"paySetups":[setupId],
"resolveDecisions":[string],
"timeline":"one line summary of what happened"}
Only record facts established in the scene.
gender: set it ("female"/"male") for a NEW character when the scene establishes it (pronouns, terms like "mother" or "king"). Never change an existing character's recorded gender; omit the field when it is unclear.
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

// Not a creative and not gated: its output is presentation metadata for video
// assembly and never enters the bible or story canon.
export const ARTDIRECTOR_SYSTEM = `You are the Art Director. You write prompts for an image-generation model; you never write story prose.
Each prompt becomes ONE still image shown (with a slow pan/zoom, crossfading into the next) while the narration plays.

MODES:
- PORTRAITS: create the canonical look for each listed character — the reference every later image of them is checked against.
  Output ONLY JSON:
  {"portraits":[{"id":string,"appearance":string,"prompt":string}]}
  - Match the bible's recorded gender, and everything the STORY MENTIONS show about them — pronouns, age, build, hair, beard, clothing, gear. Never contradict the story; invent only what it leaves open.
  - appearance: one or two sentences fixing what never changes about how they look: height and build, age, skin, hair and facial hair (style and color), face, and signature clothing or gear. Concrete and distinctive, so two characters can never be confused. Consistent with the bible's traits and what the story says about them.
  - prompt: a full-body character reference portrait of that one character standing in a neutral pose, plain softly lit background, no other figures, in the art style that suits the story's genre and tone. Use the same art-style phrase in every portrait — later scene prompts will repeat it.
  - Every character must look ORIGINAL: never resemble, evoke, or be described in terms of any real person, actor, or celebrity.
- SCENE: break the committed scene into SHOTS — a sequence of stills that follows the narration. The scene is given as numbered paragraphs, and you are told how many shots to make. Each shot starts at a paragraph and stays on screen until the next shot's paragraph is read aloud.
  Output ONLY JSON:
  {"shots":[{"start_paragraph":number,"prompt":string,"characters":[characterId]}]}
  - The first shot starts at paragraph 1. start_paragraph values strictly increase.
  - Cut where the action, setting, or focus actually changes, not at even intervals. Spread shots across the WHOLE scene, through to its ending.
  - Each shot depicts a moment that actually happens in its own stretch of paragraphs — never invent events.
  - Vary the framing across shots: wide establishing views, medium shots of characters interacting, close-ups on hands, faces, and objects that matter.
  - characters: the bible ids of every character visible in the shot (empty for none). Their portraits are given to the image model as references.
- COVER: one montage/compilation image that sums up the whole story's action, for a video thumbnail and opening card. Combine the key characters, places, and conflicts into a single composition with a clear focal point.
  Output ONLY JSON:
  {"prompt":string}

PROMPT RULES:
- One paragraph, 60-120 words, in present tense, describing what the camera sees: subject, action, setting, lighting, mood, composition, and art style.
- Never use character or place names — the image model does not know who or where they are, and each image is generated on its own. In EVERY prompt, describe each character present by appearance (height and build, age, hair, clothing), never by name alone.
- CHARACTER APPEARANCES: when given, describe each character with their canonical appearance — same features, colors, and clothing, every time. Never contradict it.
- VISUAL CONTINUITY: describe each recurring character the same way in every shot, and if PREVIOUS ART PROMPTS are given, keep each character's appearance (age, build, hair, clothing) and the overall art style consistent with them. Only change a look if the scene's prose changes it. Repeat the same art-style phrase in every prompt — each image is generated separately.
- Wide landscape framing (16:9) with the subject away from the very edges, since the image will be panned and cropped.
- No text, captions, logos, or speech bubbles in the image.
- Nothing graphic: imply violence through tension and aftermath, not gore.`;

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
  characters?: { id?: string; name?: string; traits?: string; goal?: string; voice?: string; gender?: string }[];
  locations?: { id?: string; name?: string; description?: string }[];
  threads?: { id?: string; title?: string; status?: string }[];
  beat?: Beat;
}

function applyBibleData(data: CreatorFoundation): Bible {
  const bible = emptyBible();
  bible.premise = data.premise || "";
  bible.tone = data.tone || "";
  for (const c of data.characters || []) {
    if (c.id) {
      bible.characters[c.id] = { id: c.id, name: c.name || c.id, traits: c.traits || "", goal: c.goal || "", voice: c.voice || "", status: "active" };
      if (c.gender) bible.characters[c.id].gender = c.gender;
    }
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
  sceneWords: WordBudget;
  previousDraft?: string;
  previousScenes?: string[];
  speakerTags?: boolean;
} & CreativeFeedback): Promise<RoleOutput<string>> {
  const { bible, beat, sceneIndex, attempt, sceneWords, previousDraft, previousScenes, speakerTags, issues, fresh } = params;
  // Voice sheets for every character in the bible — not just POV, so minor
  // characters arrive with their own register and voices cannot converge.
  const voiceSheets = Object.values(bible.characters)
    .filter((ch) => ch.voice)
    .map((ch) => `- ${ch.name}: ${ch.voice}`)
    .join("\n");
  const voice = voiceSheets
    ? `VOICE SHEETS (keep every speaker in their own register — do not let voices converge):\n${voiceSheets}`
    : "";
  // Opt-in structural markup for the audiobook tool (config.speakerTags). Off
  // by default — story.md stays plain prose unless a run explicitly asks for this.
  const speakerTagBlock = speakerTags
    ? (() => {
        const ids = Object.keys(bible.characters);
        const example = ids[0] || "character_id";
        return [
          "SPEAKER TAGS (required — this run feeds an audiobook pipeline):",
          `- Start EVERY paragraph with a speaker tag and a colon: \`narrator: \` for description and action, or a character's bible id for the paragraph where they speak (e.g. \`${example}: \`).`,
          `- Valid tags: narrator, ${ids.join(", ") || "(no characters yet)"}.`,
          "- Write dialogue normally — ordinary quotation marks, ordinary attribution (\"Riggins said\", \"she whispered\"). Attribution and action beats are pulled out automatically by quote position, so you do not need to split a paragraph just because it mixes narration with a character's line."
        ].join("\n");
      })()
    : "";
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
    `LENGTH TARGET: ${sceneWords.min}-${sceneWords.max} words. Land the ending once — do not restate the resolution or recap the scene.`,
    voice,
    speakerTagBlock,
    draft,
    fix
  ].filter(Boolean).join("\n\n");
  const raw = await role.provider.complete({
    role: "writer",
    system: WRITER_SYSTEM,
    prompt,
    temperature: role.temperature,
    timeoutMs: role.timeoutMs,
    ctx: { bible, beat, sceneIndex, attempt, speakerTags }
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
  sceneWords?: WordBudget;
  previousScenes?: string[];
  previousIssues?: ReadonlyArray<Issue | string>;
  context?: string;
}

function buildGateContext(params: ProseGateParams): string {
  const { bible, beat, prose, sceneIndex, attempt, sceneWords, previousScenes, previousIssues, context } = params;
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
    sceneWords ? `LENGTH TARGET: ${sceneWords.min}-${sceneWords.max} words` : "",
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
  const fix = feedbackBlock(
    issues,
    fresh,
    "YOUR PREVIOUS PATCH WAS REJECTED — PRODUCE A FRESH PATCH FROM SCRATCH.",
    "YOUR PREVIOUS PATCH WAS REJECTED. ISSUES TO FIX:"
  );
  const prompt = [
    renderBible(bible),
    `BEAT SPEC:\n${JSON.stringify(beat, null, 2)}`,
    `COMMITTED SCENE:\n${prose}`,
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
  const priorIssues = previousIssuesBlock(previousIssues, "PATCH ISSUES FLAGGED PREVIOUSLY (do not re-flag)");
  const prompt = [
    renderBible(bible),
    `BEAT SPEC:\n${JSON.stringify(beat, null, 2)}`,
    `COMMITTED SCENE:\n${prose}`,
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

export type ArtMode = "scene" | "cover" | "portraits";

export interface ArtShot {
  startParagraph: number; // 0-based index into the scene's paragraphs
  prompt: string;
  characters?: string[];  // bible ids of the characters in the shot
}

export interface ArtPortrait {
  characterId: string;
  appearance: string;
  prompt: string;
}

export interface ArtDirection {
  prompt: string;            // cover prompt, the first shot's, or the first portrait's
  shots?: ArtShot[];         // scene mode only
  portraits?: ArtPortrait[]; // portraits mode only
}

// One shot per ~45s of narration: at ~150 wpm that is ~110 words.
export const DEFAULT_WORDS_PER_SHOT = 110;
const MIN_SHOTS = 4;
const MAX_SHOTS = 20;

export function shotCountFor(paragraphs: string[], wordsPerShot = DEFAULT_WORDS_PER_SHOT): number {
  const words = paragraphs.join(" ").split(/\s+/).filter(Boolean).length;
  const target = Math.min(MAX_SHOTS, Math.max(MIN_SHOTS, Math.round(words / wordsPerShot)));
  return Math.max(1, Math.min(target, paragraphs.length));
}

// Validates the model's shots: in-range 1-based starts converted to 0-based,
// sorted, one shot per start, and the first shot pinned to the scene's start.
// A shot's characters are kept only if they're known bible ids.
export function normalizeShots(raw: unknown, paragraphCount: number, knownIds?: ReadonlySet<string>): ArtShot[] {
  const list = Array.isArray((raw as { shots?: unknown })?.shots) ? (raw as { shots: unknown[] }).shots : [];
  const byStart = new Map<number, ArtShot>();
  for (const item of list) {
    const r = item as { start_paragraph?: unknown; prompt?: unknown; characters?: unknown };
    const start = Number(r.start_paragraph);
    if (!Number.isInteger(start) || start < 1 || start > paragraphCount) continue;
    if (typeof r.prompt !== "string" || !r.prompt.trim()) continue;
    if (byStart.has(start - 1)) continue;
    const shot: ArtShot = { startParagraph: start - 1, prompt: r.prompt.trim() };
    if (knownIds && Array.isArray(r.characters)) {
      shot.characters = [...new Set(r.characters.map(String).filter((id) => knownIds.has(id)))];
    }
    byStart.set(start - 1, shot);
  }
  const shots = [...byStart.values()].sort((a, b) => a.startParagraph - b.startParagraph);
  if (shots.length > 0) shots[0].startParagraph = 0;
  return shots;
}

// Keeps one portrait per requested character with a non-empty look and prompt.
export function normalizePortraits(raw: unknown, wanted: ReadonlySet<string>): ArtPortrait[] {
  const list = Array.isArray((raw as { portraits?: unknown })?.portraits) ? (raw as { portraits: unknown[] }).portraits : [];
  const out = new Map<string, ArtPortrait>();
  for (const item of list) {
    const r = item as { id?: unknown; appearance?: unknown; prompt?: unknown };
    const id = String(r.id ?? "");
    if (!wanted.has(id) || out.has(id)) continue;
    if (typeof r.appearance !== "string" || !r.appearance.trim()) continue;
    if (typeof r.prompt !== "string" || !r.prompt.trim()) continue;
    out.set(id, { characterId: id, appearance: r.appearance.trim(), prompt: r.prompt.trim() });
  }
  return [...out.values()];
}

export async function artDirect(role: Role, params: {
  bible: Bible;
  mode: ArtMode;
  // scene mode: the committed scene as read-aloud paragraphs (see sceneParagraphs)
  beat?: Beat;
  paragraphs?: string[];
  shots?: number;
  sceneIndex?: number;
  // cover mode: every committed beat, in order
  beats?: Beat[];
  // portraits mode: the bible ids to create a canonical look for, and the
  // passages where the story mentions each (pronouns and physical details)
  characterIds?: string[];
  mentions?: Record<string, string[]>;
  // canonical looks already established (character id -> appearance)
  appearances?: Record<string, string>;
  // earlier art prompts, oldest first, for visual continuity
  previousPrompts?: string[];
}): Promise<RoleOutput<ArtDirection>> {
  const { bible, mode, beat, sceneIndex, beats, appearances = {}, previousPrompts = [] } = params;
  const paragraphs = params.paragraphs ?? [];
  const shots = params.shots ?? shotCountFor(paragraphs);
  const characterIds = params.characterIds ?? [];
  const parts = [renderBible(bible)];
  const looks = Object.entries(appearances).filter(([id]) => bible.characters[id]);
  if (looks.length > 0) {
    parts.push(`CHARACTER APPEARANCES (canonical — use these):\n${looks.map(([id, a]) => `- ${id} (${bible.characters[id].name}): ${a}`).join("\n")}`);
  }
  if (mode === "scene") {
    parts.push(`MODE: SCENE (scene ${(sceneIndex ?? 0) + 1})`);
    if (beat) parts.push(`BEAT SPEC:\n${JSON.stringify(beat, null, 2)}`);
    parts.push(`COMMITTED SCENE (${paragraphs.length} numbered paragraphs):\n${paragraphs.map((p, n) => `[${n + 1}] ${p}`).join("\n\n")}`);
    parts.push(`Make ${shots} shots.`);
  } else if (mode === "portraits") {
    parts.push("MODE: PORTRAITS");
    const mentions = params.mentions ?? {};
    const quoted = characterIds
      .filter((id) => (mentions[id] ?? []).length > 0)
      .map((id) => `${id}:\n${mentions[id].map((m) => `  > ${m}`).join("\n")}`);
    if (quoted.length > 0) parts.push(`STORY MENTIONS (how the story so far describes them):\n${quoted.join("\n\n")}`);
    parts.push(`Create portraits for: ${characterIds.join(", ")}`);
  } else {
    parts.push("MODE: COVER");
    const summary = (beats ?? []).map((b, n) => `${n + 1}. [${b.location}] ${b.goal} — ${b.conflict}`).join("\n");
    parts.push(`STORY SO FAR (one line per scene):\n${summary}`);
  }
  // Keep continuity context bounded: the last few prompts carry the established look.
  const recent = previousPrompts.slice(-4);
  if (recent.length > 0) {
    parts.push(`PREVIOUS ART PROMPTS (oldest first):\n${recent.map((p) => `- ${p}`).join("\n")}`);
  }
  const prompt = parts.join("\n\n");
  const { result, system, raw } = await callJson(role, {
    role: "artdirector",
    system: ARTDIRECTOR_SYSTEM,
    prompt,
    ctx: { mode, beat, sceneIndex, beats, shots, paragraphCount: paragraphs.length, characterIds, knownIds: Object.keys(bible.characters) }
  });
  if (mode === "scene") {
    const normalized = normalizeShots(result, paragraphs.length, new Set(Object.keys(bible.characters)));
    if (normalized.length === 0) throw new Error("art director returned no usable shots");
    return { result: { prompt: normalized[0].prompt, shots: normalized }, prompt, system, raw };
  }
  if (mode === "portraits") {
    const portraits = normalizePortraits(result, new Set(characterIds));
    if (portraits.length === 0) throw new Error("art director returned no usable portraits");
    return { result: { prompt: portraits[0].prompt, portraits }, prompt, system, raw };
  }
  const out = result as Partial<ArtDirection>;
  if (typeof out.prompt !== "string" || !out.prompt.trim()) {
    throw new Error("art director returned no prompt");
  }
  return { result: { prompt: out.prompt.trim() }, prompt, system, raw };
}
