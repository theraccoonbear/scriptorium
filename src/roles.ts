import { renderBible, emptyBible } from "./bible.ts";
import { OutputLimitError } from "./providers.ts";
import { c } from "./colors.ts";
import type { RefAppearances } from "./visualrefs.ts";
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
  VisualRefKind,
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

// How the Creator and Director write a beat: outcomes for a novelist, not a
// choreography for a typist.
const BEAT_CRAFT = `WRITE THE BEAT AS OUTCOMES, NOT CHOREOGRAPHY — the Writer is a novelist, not a typist:
- constraints: what must be TRUE by the end of the scene (who wins, who lives, what is learned, where everyone ends up), plus at most THREE fixed moments the scene must contain. Never a step-by-step sequence of actions, and never the order of events unless the order is the point. Leave how and when to the Writer. Aim for 4-7 constraints.
- Never write dialogue, or phrasings meant to be spoken, into the beat. State facts, not lines.
- mustReveal: what the READER must come to understand by the end, stated as a fact for the Writer — never as something a character announces.
- Physical canon (sizes, colors, materials) already lives in the bible; don't copy it into constraints.
- Leave room for surprise: a beat whose every move is fixed reads as a checklist.`;

const CREATOR_SYSTEM = `You are the Creator. You generate the foundation for a procedurally generated story.
Output ONLY JSON with this shape:
{
  "premise":string,
  "tone":string,
  "art_style":string,
  "characters":[{"id":string,"name":string,"traits":string,"goal":string,"voice":string,"vocal":string,"gender":"female"|"male"|""}],
  "locations":[{"id":string,"name":string,"description":string}],
  "objects":[{"id":string,"name":string,"description":string,"owner":characterId}],
  "threads":[{"id":string,"title":string,"status":"open"}],
  "arc":[number],
  "beat":{"title":string,"turn":string,"goal":string,"conflict":string,"pov":characterId,"location":locationId,"mustReveal":string,"constraints":[string],"payoffs":[]}
}
arc: the story's tension plan, one target from 1 (calm) to 10 (peak) for each scene, in order — shaped for THIS story and its genre (a slow burn, an early shock, a farce that escalates, a quiet ending), not a stock curve. Keep the author's ARC values where given and fill the rest. Scene 1's beat plays at arc[0].
art_style: how this world is portrayed in pictures, decided with the tone — one or two sentences naming the medium and rendering (e.g. gouache illustration, ink and watercolor, oil painting, woodcut), palette, light, line quality, level of detail, and mood. Specific enough that two illustrators would produce images that look like the same book. Suited to this story's genre and tone; never name a living artist.
Each character needs a distinct voice that will guide the Writer.
vocal: how the character SOUNDS, for casting the audiobook — apparent age, pitch, texture, pace, and accent, in one line (e.g. "fifties, low and gravelly, unhurried, a hill-country burr"). Make the main characters sound clearly different from each other.
objects: the story's KEY OBJECTS — signature items a character carries or uses, or things the plot turns on (an instrument, a relic, a letter). Usually 0-3. The description is canon for every later scene and image, so make it physically exact and true to what that kind of object really is: overall size AND width or thickness at its key points (e.g. "five feet long, an inch across at the mouthpiece, widening to a six-inch bell"), shape, materials, and how it is held or used. A real-world kind of object (an alpenhorn, a longbow) must have that object's real form and handling unless the premise deliberately changes it.
Give each character's gender as "female" or "male" when the story has one in mind; use "" for unspecified, non-binary, or genderless characters. It picks their audiobook narration voice.
The beat is the first scene. Payoffs must be empty (no prior setups exist).
The beat's title is the scene's title, shown on its title card in the video — two to five words, no spoilers. If the STORY CONTEXT names this scene ("Scene 1 — The ditch"), use that name.
Create the premise, setting, and cast that make the best story — one character, five, whatever serves it.
You will be given character names and location names — use them exactly, do not invent new ones.
Before outputting, verify the beat is self-satisfiable: mustReveal and constraints must be jointly satisfiable by one scene. If a constraint requires something to remain unresolved, the reveal cannot be that the thing is solved, resolved, or compensated.
${BEAT_CRAFT}`;

export const DIRECTOR_SYSTEM = `You are the Director of a procedurally generated story. You never write prose.
Plan the next scene as a beat spec. Output ONLY JSON with this shape:
{"title":string,"turn":string,"goal":string,"conflict":string,"pov":characterId,"location":string,"mustReveal":string,"constraints":[string],"payoffs":[setupId]}
title: the scene's title, shown on its title card in the video — two to five words, no spoilers. If the STORY CONTEXT names this scene ("Scene 2 — The pardon"), use that name.
Honor the tension target, and give the scene its turn (see TURN). Every overdue setup must appear in payoffs.
Never contradict the bible.
Before outputting, verify the beat is self-satisfiable: mustReveal and constraints must be jointly satisfiable by one scene. If a constraint requires something to remain unresolved, the reveal cannot be that the thing is solved, resolved, or compensated.
The bible lists RESOLVED DECISIONS — choices characters have already made and closed. Do not build a beat whose core is re-deciding one of them (having characters re-choose what is already chosen). A resolved decision may be referenced only if the beat adds genuinely NEW pressure on it: new stakes, new information, or a new cost. Each scene must turn the story somewhere it has not been.
${BEAT_CRAFT}`;

// Machine-prose tics the Writer avoids and the Line Editor hunts.
export const PROSE_TICS = `- Negation-then-correction ("Not pity, not exactly..."; "Not relief, not quite grief..."), and its cousins "He did not X. He Y." and "It was not X. It was Y." — say the true thing.
- Stacks of sentence fragments (more than two in a row), and inventory lists of features ("Yellow eyes. Tails that twitched.").
- A quip to an object, animal or nobody at every discovery; a character narrating their own realization aloud ("So that's it...").
- Narration that explains what a moment already showed; stating the theme; a character announcing the subtext.
- Stock fantasy phrasing (eyes like glacier ice, old as the mountains, a voice like grinding stone). If you have read it before, write something else.
- Physical tells, images or phrases repeated from earlier scenes (hands shaking afterward, the same light, the same simile).
- Abstract padding where a concrete detail belongs ("the specific weight", "the specific silence").`;

export const WRITER_SYSTEM = `You are the Writer: a novelist writing one scene of a serialized story. The beat spec says where the scene must end up; how it gets there is yours. Write it the way the best writer of this kind of story would — vivid, surprising, alive — never as a list of events carried out in order.

THE CONTRACT (non-negotiable):
- Stay strictly in the POV character's voice and knowledge.
- Every CONSTRAINT must hold by the end of the scene. The order and the means are yours unless a constraint fixes them.
- MUST REVEAL is what the reader must come to understand. Let them understand it through what happens; a character voices part of it only if they truly would, and never as a summary.
- KEY OBJECTS in the bible have canon physical descriptions: depict and handle them exactly as described — never give an object a feature, size, or way of being held that its description rules out. A description binds that object only, not others of its kind.
- Do not resolve anything the beat does not resolve. Output only the scene text.

CRAFT:
- A scene turns. Someone wants something, meets resistance, and comes out changed — winning, losing, or learning at a cost. Find the turn and build to it. Make obstacles push back; let victory cost something.
- Trust the reader. Subtext over statement: people rarely say exactly what they mean, and the narrator never explains what a moment has already shown.
- Dialogue does two jobs at once: it reveals the speaker and moves the scene. Cut lines that only deliver information.
- Specific over general: the one detail only this place, person or moment has — not an inventory.
- Vary rhythm on purpose: long sentences for flow and awe, short ones for impact, and short ones only where the impact is earned.
- Surprise inside the plan: an unexpected detail, a reversal, a character choosing what we didn't predict.
- The bible and previous scenes are facts, not wording. Never reuse their phrases, images or descriptions; find fresh ones.

LENGTH:
- If a LENGTH TARGET is given, stay inside the band — end the scene when it is done.
- Land the ending ONCE. Never restate the resolution, recap the scene's turn, or echo the final beat in new words. One closing image, then stop.

AVOID:
${PROSE_TICS}

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
- REHASH: the beat re-litigates an already-resolved decision without introducing new pressure
- OFF_PLAN: the author's STORY CONTEXT plans this scene, and the spec leaves out its events, replaces them with others, or pulls in a later scene's events, or explains, reveals or connects something the plan leaves unexplained`;

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
KEY OBJECTS: prose that gives a bible object a feature, size, or handling its canon description rules out (finger-holes on an instrument described without them, a two-handed weapon swung one-handed) is CANON_CONTRADICTION (entity = the object id). A canon description binds THAT object only — not other objects of the same kind (another character's instrument), nor things near it (its case, its stand).
YOUR LANE: continuity and canon only. Never raise TELLING_NOT_SHOWING, SENSORY_SPECIFICITY, PACE, or STYLE_PATTERN — craft is the Critic's job, and such issues are discarded.
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
- SENSORY_SPECIFICITY: prose lacks concrete sensory detail where it matters. Ask only for what the POV character could actually perceive and name — never for technical precision outside their experience (exact pitches, frequency ratios, measurements). If the prose already gives a vivid, concrete impression, that is enough.
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
{"upsertCharacters":[{"id":string,"name"?:string,"traits"?:string,"goal"?:string,"voice"?:string,"vocal"?:string,"status"?:string,"gender"?:"female"|"male"|""}],
"upsertLocations":[{"id":string,"name"?:string,"description"?:string}],
"upsertObjects":[{"id":string,"name"?:string,"description"?:string,"owner"?:characterId}],
"upsertThreads":[{"id":string,"title"?:string,"status"?:string}],
"openSetups":[{"id":string,"text":string}],
"paySetups":[setupId],
"resolveDecisions":[string],
"timeline":"one line summary of what happened"}
Only record facts established in the scene.
vocal: for a NEW character who speaks, one line on how they sound for the audiobook — apparent age, pitch, texture, pace, accent. Never rewrite an existing character's vocal.
gender: set it ("female"/"male") for a NEW character when the scene establishes it (pronouns, terms like "mother" or "king"). Never change an existing character's recorded gender; omit the field when it is unclear.
upsertObjects: add a KEY OBJECT (a signature item that recurs or drives the plot) when a scene introduces one, with a physically exact description: size AND width at its key points, shape, materials, how it is held or used — true to what that kind of object really is. Never rewrite an existing object's description.
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
- OFF_PLAN: the author's STORY CONTEXT plans this scene, and the spec leaves out its events, replaces them with others, or pulls in a later scene's events, or explains, reveals or connects something the plan leaves unexplained
- REHASH: the beat re-decides something already closed, or restates a turn the story already made (its "turn" repeats one of the EARLIER TURNS, even reworded)
- MISSING_TURN: the beat has no "turn", or its turn changes nothing; or the author pinned a TURN for this scene and the beat doesn't deliver it

CHECK SPECIFICALLY:
- If the STORY CONTEXT lays out what happens in this scene (by scene number), check the spec against it FIRST. Every event the author lists for this scene must be covered by the spec, as an outcome or a fixed moment (the spec need not fix their order); no event the author assigns to a later scene may be. A spec that goes somewhere else — however well-made — is OFF_PLAN. Bridging from where the last scene actually ended to the plan's events is fine. Then read mustReveal and payoffs against the plan: a reveal, explanation or connection the plan does not make (a secret purpose for an object, a hidden cause behind an event, a link between two of the author's details) is OFF_PLAN, however neat. In an author's story an unexplained detail is often left unexplained on purpose.
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

export const CONTEXT_GATE_SYSTEM = `You are the Context Gate. Before anything is generated, you review the author's context — one or more files, each under a "### from <file>" header — together with the premise and setting.
Your job: catch HARD contradictions the story could not honor, so the author can fix them before the run spends anything.

Output ONLY JSON:
{"ok":boolean,"issues":[ISSUE]}

${ISSUE_SCHEMA}

Allowed types:
- CONTEXT_CONTRADICTION: two files assert facts that cannot both be true (one says a character is 4'8", another 5'2"; two files give the same object different forms; a character is dead in one and alive in another at the same point)
- PREMISE_CONFLICT: a file asserts something the premise or setting rules out
- UNSATISFIABLE_CONSTRAINT: a single file contradicts itself

RULES:
- entity = the fact in dispute. detail MUST quote both sides with the file each came from, e.g. osmagus.md: "stands 4'8"" vs village.md: "no adult over four feet".
- Mixing is the point: a character from one file placed in another file's world, unusual combinations, tonal contrast, or one file adding detail another leaves open are NOT issues. Different files describing different things never conflict.
- Only flag what a writer could not reconcile without dropping or rewriting one of the assertions.
- ok: true when nothing conflicts.`;

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

ART STYLE: every image of a story shares one art style, given as ART STYLE (canon). Render every prompt in exactly that style and end every prompt with it verbatim — never drift toward another medium, palette, or level of realism, for any kind of image. If ART STYLE is "(none yet)", REFERENCES mode must define one in "art_style" (one or two sentences: medium and rendering, palette, light, line, detail, mood; suited to the genre and tone; no living artist names) and use it.

MODES:
- REFERENCES: create the canonical look of the story's recurring visuals — the reference image every later image of them is generated from and checked against.
  Output ONLY JSON:
  {"art_style":string,
   "characters":[{"id":string,"appearance":string,"prompt":string}],
   "locations":[{"id":string,"appearance":string,"prompt":string}],
   "props":[{"id":string,"name":string,"appearance":string,"prompt":string}]}
  - characters / locations: one entry for EACH listed id, using exactly those ids.
  - RECREATE: any ids listed under RECREATE get a fresh reference even though one exists — the old one was wrong. AUTHOR NOTES, when given, are corrections from the author: follow them exactly; they override your own idea of the object.
  - KEY OBJECTS listed under OBJECTS NEEDING REFERENCES are canon (bible KEY OBJECTS): make a prop reference for each, using the bible object id as the prop id and its canon description as the source of truth.
  - props: beyond those, the story's other KEY OBJECTS — things that recur or matter visually and would otherwise be drawn differently every time (a signature instrument, a sacred relic, a letter that drives the plot). Only objects the STORY TEXT shows; not clothing or scenery; skip any already in KNOWN PROPS. id is a short snake_case slug; name is what the story calls it. Usually 0-2 per call; never more than 4.
  - A character whose bible entry has "looks (author)" or "background (author)" is on the author's character sheet: the appearance must keep every detail of the author's looks, and the background (age, trade, history, hardships) shapes what you invent for the rest. The author's sheet outranks your own idea.
  - Match the bible (including recorded gender) and everything the STORY MENTIONS and STORY TEXT show — pronouns, age, build, hair, beard, clothing, materials, landmarks. Never contradict the story; invent only what it leaves open.
  - appearance: one or two sentences fixing what never changes, concrete and distinctive so two things can never be confused. Characters: height and build, age, skin, hair and facial hair (style and color), face, signature clothing or gear. Locations: terrain, architecture, landmarks, materials, vegetation, characteristic light. Props: true size AND proportions — overall length/height plus width or diameter at its key points (e.g. "five feet long, an inch across at the mouthpiece, widening to a six-inch bell"); the image model cannot infer proportions from length alone. Then the silhouette that makes it that kind of object — what an expert would recognize it by — then materials, colors, markings, condition — and how it is held, carried, or used whenever that changes how it looks in a scene (an instrument's playing position, a weapon's carry).
  - prompt: characters — a full-body reference portrait of that one character in a neutral pose, plain softly lit background, no other figures. Locations — a wide establishing view of the place with NO people, showing what defines it. Props — the object alone, whole and centered, on a plain background, drawn at its true proportions (state the length-to-width relationship explicitly, e.g. "long and slender, like a five-foot pole") and showing the shape that identifies it (a long or large object is shown at full length; say so explicitly). All in the story's ART STYLE.
  - Every character must look ORIGINAL: never resemble, evoke, or be described in terms of any real person, actor, or celebrity — EXCEPT the CAST, real people and animals starring in this story by the author's choice. A cast member's portrait is drawn from their real photos: its appearance is their CAST appearance (plus the costume and gear the story gives them), and its prompt is a full-body portrait of exactly that person or animal, recognizably them, in the story's ART STYLE.
- SCENE: break the committed scene into SHOTS — a sequence of stills that follows the narration. The scene is given as numbered paragraphs, and you are told how many shots to make. Each shot starts at a paragraph and stays on screen until the next shot's paragraph is read aloud.
  Output ONLY JSON:
  {"shots":[{"start_paragraph":number,"prompt":string,"characters":[characterId],"location":locationId,"props":[propId]}]}
  - The first shot starts at paragraph 1. start_paragraph values strictly increase.
  - Cut where the action, setting, or focus actually changes, not at even intervals. Spread shots across the WHOLE scene, through to its ending.
  - Each shot depicts a moment that actually happens in its own stretch of paragraphs — never invent events.
  - SHOOT IT LIKE A FILM, NOT A STORYBOARD OF STANDING PEOPLE. You are the cinematographer; do the job:
    - Pick the decisive instant of the stretch — the most visual, highest-energy moment it contains — not its most literal or quietest sentence. In an action passage that is mid-action: the stone in flight, the body mid-leap, the blow landing, the horn sounding with its effect visible. Never the moment before or after when the moment itself happens in the text.
    - Put bodies in motion and give them a line of action: weight shifting, bracing, lunging, recoiling, straining, reaching, turning. A figure standing still, or with one arm raised, is a last resort — at most one such shot per scene, and only when the prose really is that still.
    - Name a camera angle and placement in every prompt: low angle, high angle, over-the-shoulder, ground level, through a doorway or past a foreground object, tilted for chaos; subject off-center (rule of thirds), with depth from foreground to background.
    - Even quiet moments are composed like film frames: an intimate close-up on hands or eyes, a figure small against a vast landscape, a silhouette in a doorway — not two people standing face to face, centered.
    - Match the scene's tone: kinetic and close in action, still and wide in awe or dread — but always a deliberate shot.
  - Vary the framing across shots: wide establishing views, medium shots of characters interacting, close-ups on hands, faces, and objects that matter.
  - At most THREE named characters in any shot; favour singles and two-shots. Image models blend the features of a crowd of specific people. When more of the company are present, they are unnamed, out-of-focus background figures: leave them out of characters and don't describe them.
  - characters: the ids of every named character visible in the shot (empty for none; never more than three). location: the id of the place the shot is set ("" if none fits). props: the ids of KNOWN PROPS visible in the shot. Their reference images are given to the image model.
- COVER: one montage/compilation image that sums up the whole story's action, for a video thumbnail and opening card. Combine the key characters, places, and conflicts into a single composition with a clear focal point — dramatic and in motion, like a film poster, not a lineup of standing figures.
  Output ONLY JSON:
  {"prompt":string}
- EXTRAS: bonus artwork for the finished story, in the story's own art style. Two prompts:
  - keyArt: the story's key art — the image on its streaming tile and poster. One striking, textless composition with a clear focal point: the story's central figure(s), place and conflict, dramatic and iconic rather than a busy montage. It will be framed tall (2:3), wide (16:9) and square (1:1): keep the subject in the middle third, with open sky, darkness or texture at the top for a title to sit on. No text, lettering, logos or borders.
  - castPhoto: a behind-the-scenes cast photo — the story's principal characters posing together between takes, in full costume on the set, relaxed and in good humour, as a film cast would for a publicity still. Each is described by appearance and costume exactly as canon (never by name). Anyone playing a creature, monster or masked part wears the costume with its mask or head off, held under an arm or at their side, their own ordinary face showing. Faces are ordinary, original faces: never resembling any real actor. A group photo, everyone visible head to toe or waist up, no text.
  - castCharacters: the ids of every character in the cast photo (the principal cast, at most eight).
  Output ONLY JSON:
  {"keyArt":string,"castPhoto":string,"castCharacters":[string]}

PROMPT RULES:
- One paragraph, 80-150 words, in present tense, describing what the camera sees. Lead with the camera angle and the action — what each body is doing, in specific physical verbs — then setting, light and art style.
- Only what a camera can see. Never write thoughts, realizations, or "the mood is…" — show mood through body language, light, weather and framing.
- Keep character appearance to its distinguishing essentials (the reference image carries the rest), so the action gets the words.
- Never use character or place names — the image model does not know who or where they are, and each image is generated on its own. In EVERY prompt, describe each character present by appearance (height and build, age, hair, clothing), never by name alone.
- CANONICAL APPEARANCES: when given, describe each character, location, and prop with its canonical appearance — same features, colors, materials, and landmarks, every time. Never contradict it.
- VISUAL CONTINUITY: describe each recurring character the same way in every shot, and if PREVIOUS ART PROMPTS are given, keep each character's appearance (age, build, hair, clothing) and the overall art style consistent with them. Only change a look if the scene's prose changes it. Each image is generated separately, so every prompt must carry the ART STYLE verbatim.
- Wide landscape framing (16:9) with the subject away from the very edges, since the image will be panned and cropped.
- No text, captions, logos, or speech bubbles in the image.
- Nothing graphic: show the action at its peak, but no gore, wounds, or blood.`;

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
  art_style?: string;
  characters?: { id?: string; name?: string; traits?: string; goal?: string; voice?: string; vocal?: string; gender?: string }[];
  locations?: { id?: string; name?: string; description?: string }[];
  objects?: { id?: string; name?: string; description?: string; owner?: string }[];
  threads?: { id?: string; title?: string; status?: string }[];
  arc?: unknown[];
  beat?: Beat;
}

function applyBibleData(data: CreatorFoundation): Bible {
  const bible = emptyBible();
  bible.premise = data.premise || "";
  bible.tone = data.tone || "";
  if (data.art_style?.trim()) bible.artStyle = data.art_style.trim();
  for (const c of data.characters || []) {
    if (c.id) {
      bible.characters[c.id] = { id: c.id, name: c.name || c.id, traits: c.traits || "", goal: c.goal || "", voice: c.voice || "", status: "active" };
      if (c.gender) bible.characters[c.id].gender = c.gender;
      if (c.vocal) bible.characters[c.id].vocal = c.vocal;
    }
  }
  for (const l of data.locations || []) {
    if (l.id) bible.locations[l.id] = { id: l.id, name: l.name || l.id, description: l.description || "" };
  }
  for (const o of data.objects || []) {
    if (o.id) {
      bible.objects[o.id] = { id: o.id, name: o.name || o.id, description: o.description || "" };
      if (o.owner && bible.characters[o.owner]) bible.objects[o.id].owner = o.owner;
    }
  }
  for (const t of data.threads || []) {
    if (t.id) bible.threads[t.id] = { id: t.id, title: t.title || t.id, status: t.status || "open" };
  }
  // The engine settles the final arc (the author's pins win; gaps fall back).
  if (Array.isArray(data.arc)) bible.arc = data.arc.map((t) => (typeof t === "number" && t >= 1 && t <= 10 ? Math.round(t) : null));
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
  arc?: Array<number | null>;   // the author's tension targets, null where the creator decides
  world: WorldOutput;
  premise?: string;
  context?: string;
} & TurnParams & CreativeFeedback): Promise<CreatorOutput> {
  const { sceneIndex, total, arc, world, premise, context, issues, fresh } = params;
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
    `SCENES: ${total} — plan the arc for all of them.`,
    arc?.some((t) => t !== null && t !== undefined) ? `ARC (the author's; keep these values, fill the nulls): ${JSON.stringify(arc)}` : "",
    turnLines({ ...params, sceneIndex, total, context }),
    fix
  ].filter(Boolean).join("\n\n");
  const { result, system, raw } = await callJson(role, {
    role: "creator",
    system: CREATOR_SYSTEM,
    prompt,
    ctx: { sceneIndex, total, arc, turn: params.turn, world, premise, context, issues, fresh }
  });
  const foundation = result as CreatorFoundation;
  const bible = applyBibleData(foundation);
  return { bible, beat: foundation.beat as Beat, prompt, system, raw };
}

// What turns this scene: the author's pinned turn, the author's plan, or the
// director's own choice, never a repeat of an earlier scene's turn. The final
// scene's turn resolves the story (unless the author's plan ends it otherwise).
export interface TurnParams { turn?: string; earlierTurns?: string[] }

export function turnLines(p: TurnParams & { sceneIndex: number; total: number; context?: string }): string {
  const final = p.sceneIndex === p.total - 1;
  const lines = [
    p.turn
      ? `TURN (the author's, for this scene — deliver it): ${p.turn}`
      : p.context
      ? `TURN: the beat's "turn" is the change the author's plan makes in this scene${final ? " — the story's ending as the plan has it" : ""}.`
      : final
      ? `TURN: this is the final scene. Its "turn" resolves the central conflict — the change the whole story has been heading for. Open nothing new.`
      : `TURN: choose this scene's "turn" yourself — the one change the people in it don't see coming, which pushes the story somewhere it hasn't been. Earn it from the bible: its threads, its people's goals, what has been set up.`
  ];
  if (p.earlierTurns?.length) lines.push(`EARLIER TURNS (never repeat one, even reworded):\n${p.earlierTurns.map((t, k) => `- scene ${k + 1}: ${t}`).join("\n")}`);
  return lines.join("\n");
}

export async function direct(role: Role, params: {
  bible: Bible;
  sceneIndex: number;
  total: number;
  tension: number;
  overdue: Setup[];
  context?: string;
} & TurnParams & CreativeFeedback): Promise<RoleOutput<Beat>> {
  const { bible, sceneIndex, total, tension, overdue, context, issues, fresh } = params;
  const fix = feedbackBlock(
    issues,
    fresh,
    "YOUR PREVIOUS BEAT SPEC WAS REJECTED — START FROM SCRATCH with a different approach. DO NOT reuse the previous spec's framing.",
    "YOUR PREVIOUS BEAT SPEC WAS REJECTED. ISSUES TO FIX:"
  );
  const plan = context
    ? `THE AUTHOR'S PLAN COMES FIRST: if the STORY CONTEXT lays out what happens in scene ${sceneIndex + 1}, this beat must deliver those events — as outcomes the scene must reach and at most three fixed moments, never as a step-by-step sequence — and nothing the author assigns to a later scene. Where the last scene ended somewhere the plan didn't expect, bridge from where it actually ended to the plan's events. Reveal only what the plan reveals: mustReveal comes from this scene's planned events, and never explains, solves or connects anything the plan leaves unexplained. An odd detail the author never explains is often the joke or the point, and the reader draws the conclusion; open setups the plan doesn't pay off stay open.`
    : "";
  const prompt = [
    context ? `STORY CONTEXT (provided by author):\n${context}` : "",
    renderBible(bible),
    `SCENE ${sceneIndex + 1} OF ${total}`,
    plan,
    `TENSION TARGET (1-10): ${tension}`,
    turnLines({ ...params, sceneIndex, total, context }),
    `OVERDUE SETUPS TO PAY OFF: ${overdue.map((s) => s.id).join(", ") || "none"}`,
    fix
  ].filter(Boolean).join("\n\n");
  const { result, system, raw } = await callJson(role, {
    role: "director",
    system: DIRECTOR_SYSTEM,
    prompt,
    ctx: { bible, sceneIndex, total, tension, turn: params.turn, overdue, issues, fresh }
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
  suggestions?: Issue[];  // optional craft notes (advisory critic) — take or leave
} & CreativeFeedback): Promise<RoleOutput<string>> {
  const { bible, beat, sceneIndex, attempt, sceneWords, previousDraft, previousScenes, speakerTags, issues, fresh, suggestions } = params;
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
  const advice = suggestions && suggestions.length > 0
    ? `OPTIONAL SUGGESTIONS from the critic (not required — adopt any that make the scene better while you fix the issues above; ignore the rest):\n${suggestions.map((i) => `- ${renderIssue(normalizeIssue(i))}`).join("\n")}`
    : "";
  const draft = previousDraft && !fresh ? `PREVIOUS DRAFT:\n${previousDraft}` : "";
  const priorProse = (previousScenes || [])
    .map((s, idx) => `--- SCENE ${idx + 1} (already committed) ---\n${s}`)
    .join("\n\n");
  const prompt = [
    renderBible(bible),
    priorProse ? `PREVIOUS SCENES (established canon — do not contradict):\n\n${priorProse}` : "",
    `GOAL: ${beat.goal}\nCONFLICT: ${beat.conflict}\nLOCATION: ${beat.location}\nMUST REVEAL (what the reader must come to understand — show it; no one announces it): ${beat.mustReveal}`,
    `CONSTRAINTS (must hold by the end of the scene; the order and the means are yours unless one fixes them):\n${beat.constraints.map((c) => `- ${c}`).join("\n")}`,
    `LENGTH TARGET: ${sceneWords.min}-${sceneWords.max} words. Land the ending once — do not restate the resolution or recap the scene.`,
    voice,
    speakerTagBlock,
    draft,
    fix,
    advice
  ].filter(Boolean).join("\n\n");
  let raw: string;
  try {
    raw = await role.provider.complete({
      role: "writer",
      system: WRITER_SYSTEM,
      prompt,
      temperature: role.temperature,
      timeoutMs: role.timeoutMs,
      ctx: { bible, beat, sceneIndex, attempt, speakerTags }
    });
  } catch (err) {
    // The writer hit its output limit mid-scene. The partial draft is still a
    // draft: keep it and let the reviewers flag the abrupt ending.
    if (!(err instanceof OutputLimitError) || !err.partial) throw err;
    console.error(`[scriptorium]   ${c.retry(`writer: ${err.message} — keeping the partial draft for review`)}`);
    raw = err.partial;
  }
  return { result: raw, prompt, system: WRITER_SYSTEM, raw };
}

export const EDITOR_SYSTEM = `You are the Line Editor. You get one scene of a serialized story and return it edited: the same scene, better written. You are not the author. Never add, remove, reorder or change events, facts, who does what, what anyone learns, or how the scene ends; never change a proper name.

EDIT FOR:
${PROSE_TICS}
- Flab: cut about 10% — throat-clearing, beats that repeat, a second image where one did the job, explanation after the moment has landed.
- Dead phrasing: replace stock or repeated wording (including anything echoed from the END OF THE PREVIOUS SCENE) with something specific and fresh.
- Rhythm: break up runs of same-shaped sentences and same paragraph openings ("He..." "He..." "He...").
- Dialogue: trim lines that only deliver information; keep every line's meaning and the speaker's voice.

Leave good writing alone — never edit for the sake of editing. Keep the author's voice and the POV character's register.

FORMAT: return ONLY the full edited scene, nothing before or after it. Keep the paragraphing. If paragraphs begin with a speaker tag (narrator: or a character id followed by a colon), every paragraph you return must begin with one, and each tag must name who speaks in that paragraph.`;

// One line edit of a draft. The caller guards the result (see the engine).
export async function edit(role: Role, params: {
  bible: Bible;
  prose: string;
  sceneIndex: number;
  previousScene?: string;
  sceneWords?: WordBudget;
}): Promise<RoleOutput<string>> {
  const { bible, prose, sceneIndex, previousScene, sceneWords } = params;
  const voices = Object.values(bible.characters).filter((ch) => ch.voice).map((ch) => `- ${ch.name}: ${ch.voice}`).join("\n");
  const prompt = [
    bible.tone ? `TONE: ${bible.tone}` : "",
    voices ? `VOICE SHEETS:\n${voices}` : "",
    previousScene ? `END OF THE PREVIOUS SCENE (for repetition only — do not edit it):\n${previousScene.slice(-2500)}` : "",
    sceneWords ? `LENGTH: the scene should land within ${sceneWords.min}-${sceneWords.max} words after editing.` : "",
    `SCENE ${sceneIndex + 1} TO EDIT:\n${prose}`
  ].filter(Boolean).join("\n\n");
  const raw = await role.provider.complete({
    role: "editor",
    system: EDITOR_SYSTEM,
    prompt,
    temperature: role.temperature,
    timeoutMs: role.timeoutMs,
    ctx: { prose, sceneIndex }
  });
  return { result: String(raw).trim(), prompt, system: EDITOR_SYSTEM, raw };
}

export const TAGGER_SYSTEM = `You label who speaks in each paragraph of a story scene, for an audiobook. You never change or repeat the text.

Output ONLY JSON:
{"paragraphs":[{"n":number,"speaker":string,"delivery":string}],"newSpeakers":[{"id":string,"name":string,"gender":"female"|"male"|"","description":string}]}

- paragraphs: one entry for EVERY numbered paragraph, with n its number: speaker is "narrator" for a paragraph with no spoken line, or the id of the character who speaks in it.
- Use the ids in CAST. Anyone in CAST is ALWAYS tagged with their CAST id, however the text refers to them (by name, title or job) — never create a new id for someone already in CAST. A paragraph that mixes narration with a character's spoken line gets that character's id; the attribution and action around the quote are handled automatically.
- If two characters speak in one paragraph, use the one who says the most.
- A speaking character who is not in CAST (a creature, a guard, a voice in the dark) gets a new snake_case id, listed once in newSpeakers with a name, a gender only if the text establishes it, and one sentence on who they are and how they sound.
- Unspoken thoughts, sounds, and words read off a page are narrator.
- delivery: a few words directing how the paragraph's speaker performs it, from what the scene makes clear — e.g. "low and furious, trying not to be overheard", "dry, unhurried", "hushed, dreading what comes next". "" when a plain read is right. Never add words to be spoken.`;

export interface SpeakerTagging {
  missing?: number;    // paragraphs the voice director skipped (now narrator)
  tones?: (number | null)[];  // with palettes: per paragraph, an index into its speaker's palette
  tags: string[];
  delivery: string[];  // per paragraph; "" = a plain read
  newSpeakers: { id: string; name: string; gender?: string; description?: string }[];
}

// Labels each paragraph with its speaker. The paragraphs are never sent back,
// so the text cannot change; the result is checked before it is used.
export async function tagSpeakers(role: Role, params: {
  paragraphs: string[];
  cast: { id: string; name: string; voice?: string }[];
  note?: string;  // extra instruction (e.g. a targeted retry)
  palettes?: Record<string, string[]>;  // speaker id (and "narrator") -> tones to choose from
}): Promise<RoleOutput<SpeakerTagging>> {
  const { paragraphs, cast, note, palettes } = params;
  const castBlock = cast.map((c) => `- ${c.id}: ${c.name}${c.voice ? ` (${c.voice})` : ""}`).join("\n") || "(none)";
  let prompt = [
    `CAST:\n${castBlock}`,
    palettes ? `TONE PALETTES — for each paragraph also give "tone": the 0-based index of the tone in its speaker's palette that best fits how it is performed:\n${Object.entries(palettes).map(([id, tones]) => `- ${id}: ${tones.map((t, i) => `${i} = ${t}`).join("; ")}`).join("\n")}` : "",
    `SCENE (${paragraphs.length} numbered paragraphs):\n${paragraphs.map((p, n) => `[${n + 1}] ${p}`).join("\n\n")}`,
    note ?? ""
  ].filter(Boolean).join("\n\n");
  let lastProblem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await callJson(role, { role: "voicedirector", system: TAGGER_SYSTEM, prompt, ctx: { task: "tag", paragraphs, castIds: cast.map((c) => c.id) } });
    const tagging = foldKnownSpeakers(toTagging(out.result, paragraphs.length, palettes), cast);
    lastProblem = taggingProblem(tagging, paragraphs.length, cast.map((c) => c.id)) ?? "";
    if (!lastProblem) return { ...out, result: tagging };
    prompt = `${prompt}\n\nYour last reply was unusable: ${lastProblem}. Reply again, with one entry for each of the ${paragraphs.length} paragraphs.`;
  }
  throw new Error(`speaker tagging failed: ${lastProblem}`);
}

// Entries are keyed by paragraph number, so one skipped paragraph can't shift
// every label after it. A few missing paragraphs become narration (missing
// counts them); too many make the tagging unusable.
function toTagging(raw: unknown, paragraphCount: number, palettes?: Record<string, string[]>): SpeakerTagging {
  const r = (raw ?? {}) as { paragraphs?: unknown; newSpeakers?: unknown };
  const tags: string[] = Array(paragraphCount).fill("");
  const delivery: string[] = Array(paragraphCount).fill("");
  const tones: (number | null)[] = Array(paragraphCount).fill(null);
  for (const entry of Array.isArray(r.paragraphs) ? r.paragraphs : []) {
    const e = (entry ?? {}) as { n?: unknown; speaker?: unknown; delivery?: unknown; tone?: unknown };
    const n = Number(e.n);
    if (!Number.isInteger(n) || n < 1 || n > paragraphCount) continue;
    tags[n - 1] = String(e.speaker ?? "").trim().toLowerCase();
    delivery[n - 1] = String(e.delivery ?? "").trim();
    const t = Number(e.tone);
    if (e.tone !== undefined && e.tone !== null && Number.isInteger(t)) tones[n - 1] = t;
  }
  const missing = tags.filter((t) => !t).length;
  for (let n = 0; n < paragraphCount; n++) if (!tags[n]) tags[n] = "narrator";
  const newSpeakers = (Array.isArray(r.newSpeakers) ? r.newSpeakers : [])
    .map((x) => x as Record<string, unknown>)
    .filter((x) => typeof x.id === "string")
    .map((x) => ({
      id: String(x.id).trim().toLowerCase(),
      name: String(x.name ?? x.id),
      ...(x.gender === "female" || x.gender === "male" ? { gender: x.gender } : {}),
      ...(x.description ? { description: String(x.description) } : {})
    }));
  // A tone only counts if it indexes its speaker's palette.
  const checkedTones = palettes ? tones.map((t, n) => (t !== null && t >= 0 && t < (palettes[tags[n]]?.length ?? 0) ? t : null)) : undefined;
  return { tags, delivery, newSpeakers, missing, ...(checkedTones ? { tones: checkedTones } : {}) };
}

// A "new" speaker who is someone already in the cast (same name, or the name a
// cast member goes by) is folded into that cast id, so one person never gets two voices.
// "Hesketh" and "Hesketh the barkeep" are the same person: every word of one is in the other.
export function sameSpeaker(a: { id: string; name: string }, b: { id: string; name: string }): boolean {
  const words = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w) => w && !["the", "a", "an", "of"].includes(w));
  const [x, y] = [words(a.name), words(b.name)];
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return (short.length > 0 && short.every((w) => long.includes(w))) || a.id.replace(/_.*$/, "") === b.id || b.id.replace(/_.*$/, "") === a.id;
}

export function foldKnownSpeakers(t: SpeakerTagging, cast: { id: string; name: string }[]): SpeakerTagging {
  const remap = new Map<string, string>();
  for (const s of t.newSpeakers) {
    const match = cast.find((c) => sameSpeaker(c, s));
    if (match) remap.set(s.id, match.id);
  }
  if (remap.size === 0) return t;
  return { ...t, tags: t.tags.map((tag) => remap.get(tag) ?? tag), newSpeakers: t.newSpeakers.filter((s) => !remap.has(s.id)) };
}

// Why a tagging can't be used, or undefined when it's sound.
export function taggingProblem(t: SpeakerTagging, paragraphCount: number, castIds: string[]): string | undefined {
  if (t.tags.length !== paragraphCount) return `${t.tags.length} tags for ${paragraphCount} paragraphs`;
  if ((t.missing ?? 0) > Math.max(2, Math.floor(paragraphCount * 0.1))) return `${t.missing} of ${paragraphCount} paragraphs have no entry`;
  const valid = new Set(["narrator", ...castIds, ...t.newSpeakers.map((s) => s.id)]);
  const bad = t.tags.find((tag) => !valid.has(tag));
  if (bad) return `unknown speaker "${bad}" (not narrator, in CAST, or in newSpeakers)`;
  const badId = t.newSpeakers.find((s) => !/^[a-z][a-z0-9_]*$/.test(s.id) || s.id === "narrator" || castIds.includes(s.id));
  if (badId) return `newSpeakers id "${badId.id}" must be a new snake_case id`;
  return undefined;
}

export const PALETTE_SYSTEM = `You are casting director and voice director for an audiobook. You read the whole script and give each speaking character a small palette of distinct performance tones — like choosing a few colours that can paint every line they speak. Each line will later be performed in one of its speaker's tones.

Output ONLY JSON:
{"palettes":{"narrator":[string],"<character id>":[string]}}

- "narrator": the storyteller's own registers across this script — how the narration itself should be read in its calmest, tensest, most intimate and heaviest stretches, in this story's tone (a deadpan comedy's narrator is not a ghost story's). Its FIRST tone is its home register, used for plain narration.
- One entry per character in CAST who speaks in the script (skip anyone who never speaks), using the CAST id.
- Each palette has at most the PALETTE SIZE given: tones of 2-6 words of performance direction ("low, suppressed fury", "bright, deflecting charm").
- Draw them from what the character actually says and goes through across the WHOLE script: cover their real range, from their most common register to their most extreme moment. No near-duplicates.`;

// Designs each speaker's tone palette from the whole script.
export async function designPalettes(role: Role, params: { script: string; cast: { id: string; name: string; voice?: string }[]; size: number }): Promise<RoleOutput<Record<string, string[]>>> {
  const { script, cast, size } = params;
  let prompt = [
    `CAST:\n${cast.map((c) => `- ${c.id}: ${c.name}${c.voice ? ` (${c.voice})` : ""}`).join("\n")}`,
    `PALETTE SIZE: ${size}`,
    `SCRIPT:\n${script}`
  ].join("\n\n");
  let problem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await callJson(role, { role: "voicedirector", system: PALETTE_SYSTEM, prompt, ctx: { task: "palette", castIds: cast.map((c) => c.id), size } });
    const raw = ((out.result ?? {}) as { palettes?: Record<string, unknown> }).palettes ?? {};
    const ids = new Set(cast.map((c) => c.id));
    const palettes: Record<string, string[]> = {};
    problem = "";
    for (const [id, tones] of Object.entries(raw)) {
      const list = Array.isArray(tones) ? tones.map((t) => String(t).trim()).filter(Boolean) : [];
      if (!ids.has(id) && id !== "narrator") { problem = `"${id}" is not a CAST id (or "narrator")`; break; }
      if (list.length === 0 || list.length > size) { problem = `${id} has ${list.length} tones (want 1-${size})`; break; }
      palettes[id] = list;
    }
    if (!problem && !palettes.narrator) problem = "no narrator palette";
    if (!problem) return { ...out, result: palettes };
    prompt = `${prompt}\n\nYour last reply was unusable: ${problem}. Reply again.`;
  }
  throw new Error(`tone palettes failed: ${problem}`);
}

// Words that invite a music model to add voices. A cue description must never
// use them, even to say "no" to them: Lyria 3.5 is a song model, and a cue asked
// to sit "beneath spoken narration" came back with whispered spoken word.
export const VOICE_WORDS = /\b(voices?|vocals?|vocali[sz]\w*|sing|sings|singing|singers?|sung|songs?|lyrics?|lyrical|choirs?|choral|chants?|chanted|chanting|hums?|hummed|humming|whisper\w*|speech|spoken|speak\w*|narrat\w*|words?|poems?|poetry|recit\w*|dialogue|talk\w*|story|stories)\b/gi;

export function voiceWords(text: string): string[] {
  return [...new Set((text.match(VOICE_WORDS) ?? []).map((w) => w.toLowerCase()))];
}

export const MUSICDIRECTOR_SYSTEM = `You are the composer and music supervisor for a narrated film. You write the cue sheet: a short brief for each piece of music, which a music model will generate. The music plays quietly under a narrator, so it must leave room: sparse, low intensity, nothing busy in the midrange.

Output ONLY JSON:
{"style":string,"theme":string,"scenes":[{"scene":number,"music":string|null}]}

- style: the score's one consistent sound for the whole film, in one sentence — instrumentation, ensemble, harmonic colour, recording feel (e.g. "Intimate chamber ensemble: solo cello, low strings, felt piano, a distant bell; dark modal harmony; close, warm recording"). If STYLE is given, use it verbatim.
- theme: the main title theme, 30-45 seconds: a simple, memorable motif on one lead instrument, in the style. Give the motif's character, tempo (BPM) and key.
- scenes: one entry per SCENE, by its number. music: the underscore for that scene, in the style, in 2-4 sentences — mood, tempo (BPM), key, which instruments carry it, texture and dynamics (it may quote the theme's motif softly). Each underscore is a LOOP of the length given, repeated under the whole scene: describe one steady texture, never an arc, timed events or minute marks. Match the scene's TENSION: 1-3 near-still, 4-6 restless, 7-10 driving but still under the narrator. Use null only where silence serves the scene better than any music.
- Describe MUSIC ONLY, in musical terms. Never mention people, names, places, objects or events from the story, and never mention any kind of human voice, singing, speech, narration, lyrics or words — not even to exclude them (the generator adds what it reads). Write "instrumental" if anything.
- Not even as a metaphor: the generator takes "whispering strings" or "a singing melody" literally and adds a voice. These words are refused anywhere in your reply: voice, vocal, sing, sung, song, lyric, lyrical, choir, choral, chant, hum, whisper, speech, spoken, speak, narration, word, poem, poetry, recite, dialogue, talk, story. Use musical terms instead: hushed, sul tasto, breathy bowing, murmuring tremolo, expressive.`;

export interface MusicSceneInput { scene: number; tension: number; mood: string; seconds: number; loopSeconds?: number }
export interface CueSheet { style: string; theme: string; scenes: Array<{ scene: number; music: string | null }> }

// The cue sheet: one style, a theme, and an underscore (or silence) per scene.
export async function directMusic(role: Role, params: { tone: string; artStyle?: string; style?: string; scenes: MusicSceneInput[] }): Promise<RoleOutput<CueSheet>> {
  let prompt = [
    `TONE: ${params.tone}`,
    ...(params.artStyle ? [`ART STYLE (the look of the film, for the score's mood): ${params.artStyle}`] : []),
    ...(params.style ? [`STYLE (the author's; use verbatim): ${params.style}`] : []),
    `SCENES:\n${params.scenes.map((s) => `- scene ${s.scene} (a ${s.loopSeconds ?? 120}-second loop under ${Math.round(s.seconds / 60)} min, tension ${s.tension}/10): ${s.mood}`).join("\n")}`
  ].join("\n\n");
  let problem = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const out = await callJson(role, { role: "musicdirector", system: MUSICDIRECTOR_SYSTEM, prompt, ctx: { task: "cues", scenes: params.scenes.map((s) => s.scene) } });
    const r = (out.result ?? {}) as { style?: unknown; theme?: unknown; scenes?: Array<{ scene?: unknown; music?: unknown }> };
    const sheet: CueSheet = {
      style: params.style ?? String(r.style ?? "").trim(),
      theme: String(r.theme ?? "").trim(),
      scenes: params.scenes.map((s) => {
        const e = (r.scenes ?? []).find((x) => Number(x.scene) === s.scene);
        return { scene: s.scene, music: e?.music === null ? null : e?.music !== undefined ? String(e.music).trim() : "" };
      })
    };
    const missing = sheet.scenes.filter((s) => s.music === "").map((s) => s.scene);
    const said = voiceWords([sheet.style, sheet.theme, ...sheet.scenes.map((s) => s.music ?? "")].join(" "));
    problem = !sheet.style ? "no style"
      : !sheet.theme ? "no theme"
      : missing.length ? `no entry for scene ${missing.join(", ")}`
      : said.length ? `it uses ${said.map((w) => `"${w}"`).join(", ")} — describe music only, never voices or the story`
      : "";
    if (!problem) return { ...out, result: sheet };
    prompt = `${prompt}\n\nYour last reply was unusable: ${problem}. Reply again.`;
  }
  throw new Error(`music cue sheet failed: ${problem}`);
}

export const AUDITION_SYSTEM = `You write audition lines for an audiobook's casting reel. Some characters say too little in the story to judge a voice by; give each one a short speech to read.

Output ONLY JSON:
{"lines":{"<character id>":string}}

- One entry per character listed, by id. 2-3 sentences, 120-250 characters: something this character would plausibly say in this story, in their own manner, in the story's TONE.
- Spoken words only: no quotation marks, no stage directions, no narration, no other characters' names.
- Give the voice something to do: a little range (a question, an aside, a firm statement), not a list.`;

// Short in-character speeches for speakers the story gives too little to cast by.
export async function writeAuditions(role: Role, params: { tone: string; speakers: { id: string; name: string; description: string }[] }): Promise<RoleOutput<Record<string, string>>> {
  let prompt = [
    `TONE: ${params.tone}`,
    `CHARACTERS:\n${params.speakers.map((s) => `- ${s.id} (${s.name}): ${s.description}`).join("\n")}`
  ].join("\n\n");
  let problem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await callJson(role, { role: "voicedirector", system: AUDITION_SYSTEM, prompt, ctx: { task: "audition", ids: params.speakers.map((s) => s.id) } });
    const raw = ((out.result ?? {}) as { lines?: Record<string, unknown> }).lines ?? {};
    const lines: Record<string, string> = {};
    for (const s of params.speakers) {
      const line = String(raw[s.id] ?? "").replace(/["“”]/g, "").replace(/\s+/g, " ").trim();
      if (line.length >= 60) lines[s.id] = line;
    }
    const missing = params.speakers.filter((s) => !lines[s.id]).map((s) => s.id);
    problem = missing.length ? `no usable line for ${missing.join(", ")}` : "";
    if (!problem) return { ...out, result: lines };
    prompt = `${prompt}\n\nYour last reply was unusable: ${problem}. Reply again.`;
  }
  throw new Error(`audition lines failed: ${problem}`);
}

// Voices worth auditioning for one character (see auditions.ts).
export const SUGGEST_SYSTEM = `You are the casting director for an audiobook, auditioning new voices for one character. From the VOICE LIBRARY, choose the voices most worth hearing for how the character should SOUND.

Output ONLY JSON:
{"voices":[{"id":voiceId,"reason":string}]}

- Exactly the number of voices asked for, all different, all from the library, none from NOT THESE.
- Match the DIRECTION first (pitch, texture, age, accent, attitude), then the character. Give a short reason for each: what in the library description fits.
- Range: if several fit, vary them (accent, texture), so the author hears real alternatives.`;

export async function suggestVoices(role: Role, p: { name: string; gender?: string; direction: string; library: { id: string; gender?: string; line: string }[]; exclude: string[]; count: number }): Promise<{ id: string; reason: string }[]> {
  const exclude = new Set(p.exclude);
  const library = p.library.filter((v) => !exclude.has(v.id) && (!p.gender || !v.gender || v.gender === p.gender));
  const ids = new Set(library.map((v) => v.id));
  let prompt = [
    `CHARACTER: ${p.name}${p.gender ? ` (${p.gender})` : ""}`,
    `DIRECTION: ${p.direction}`,
    `VOICES WANTED: ${p.count}`,
    `NOT THESE: ${[...exclude].join(", ") || "none"}`,
    `VOICE LIBRARY (id | gender | pitch | accent | persona | description):\n${library.map((v) => v.line).join("\n")}`
  ].join("\n\n");
  for (let attempt = 0; attempt < 3; attempt++) {
    const out = await callJson(role, { role: "voicedirector", system: SUGGEST_SYSTEM, prompt, ctx: { task: "suggest", count: p.count, libraryIds: library.map((v) => v.id) } });
    const voices = ((out.result as { voices?: { id?: unknown; reason?: unknown }[] })?.voices ?? [])
      .map((v) => ({ id: String(v.id), reason: String(v.reason ?? "") }))
      .filter((v, i, all) => ids.has(v.id) && all.findIndex((w) => w.id === v.id) === i);
    if (voices.length >= Math.min(p.count, ids.size)) return voices.slice(0, p.count);
    prompt += `\n\nYour last reply had ${voices.length} usable voices (unknown, repeated or excluded ids). Reply again with ${p.count}.`;
  }
  throw new Error("the voice director couldn't suggest voices from the library");
}

export const CASTING_SYSTEM = `You are the casting director for an audiobook. Choose a voice from the VOICE LIBRARY for each character listed, and for the NARRATOR if asked.

Output ONLY JSON:
{"narrator":voiceId|null,"characters":{"<character id>":voiceId},"reasons":{"<character id or narrator>":string}}

Casting rules:
- Match gender exactly when the character's gender is given.
- Match how the character SOUNDS (their vocal line, else their traits): apparent age, pitch, texture, energy. The library descriptions give each voice's age and manner.
- Accents should suit the story's world and stay coherent: family members and people from one place should share a regional accent; a stranger from far away may differ.
- Keep the main characters clearly distinct from each other — different pitch or texture, never two near-identical voices — and distinct from the narrator.
- The narrator should be a storyteller or narrator voice that suits the story's tone, with clear diction for long reading.
- Every voice may be used once. reasons: a few words per pick.`;

export interface CastingPick { narrator?: string; characters: Record<string, string>; reasons: Record<string, string> }

// Picks a library voice per character (and the narrator); code checks every pick.
export async function castVoices(role: Role, params: {
  characters: { id: string; name: string; gender?: string; vocal?: string; traits?: string; voice?: string }[];
  narrator: boolean;
  tone?: string;
  library: { id: string; gender?: string; line: string }[];
  taken?: string[];  // voices already cast in this story (kept from earlier chapters)
}): Promise<RoleOutput<CastingPick>> {
  const { characters, narrator, tone, library } = params;
  const taken = new Set(params.taken ?? []);
  const byId = new Map(library.map((v) => [v.id, v]));
  let prompt = [
    tone ? `STORY TONE: ${tone}` : "",
    `CHARACTERS TO CAST:\n${characters.map((c) => `- ${c.id} (${c.name}${c.gender ? `, ${c.gender}` : ""}): ${c.vocal ? `sounds: ${c.vocal}` : `traits: ${c.traits ?? ""}`}${c.voice ? ` | talks: ${c.voice}` : ""}`).join("\n")}`,
    narrator ? "Also cast the NARRATOR." : "The narrator is already cast; return narrator null.",
    taken.size ? `ALREADY TAKEN (don't reuse): ${[...taken].join(", ")}` : "",
    `VOICE LIBRARY (id | gender | pitch | accent | persona | description):\n${library.map((v) => v.line).join("\n")}`
  ].filter(Boolean).join("\n\n");
  let problem = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const out = await callJson(role, { role: "voicedirector", system: CASTING_SYSTEM, prompt, ctx: { task: "cast", characterIds: characters.map((c) => c.id), narrator, libraryIds: library.map((v) => v.id) } });
    const r = (out.result ?? {}) as { narrator?: unknown; characters?: Record<string, unknown>; reasons?: Record<string, unknown> };
    const pick: CastingPick = {
      ...(narrator && typeof r.narrator === "string" ? { narrator: r.narrator } : {}),
      characters: Object.fromEntries(Object.entries(r.characters ?? {}).map(([k, v]) => [k, String(v)])),
      reasons: Object.fromEntries(Object.entries(r.reasons ?? {}).map(([k, v]) => [k, String(v)]))
    };
    problem = castingProblem(pick, characters, narrator, byId, taken) ?? "";
    if (!problem) return { ...out, result: pick };
    prompt = `${prompt}\n\nYour last reply was unusable: ${problem}. Reply again.`;
  }
  throw new Error(`voice casting failed: ${problem}`);
}

export function castingProblem(pick: CastingPick, characters: { id: string; gender?: string }[], narrator: boolean, library: Map<string, { gender?: string }>, taken: Set<string>): string | undefined {
  if (narrator && !pick.narrator) return "no narrator voice";
  if (pick.narrator && !library.has(pick.narrator)) return `narrator voice "${pick.narrator}" is not in the library`;
  const used = new Set(taken);
  if (pick.narrator) { if (used.has(pick.narrator)) return `"${pick.narrator}" is already taken`; used.add(pick.narrator); }
  for (const c of characters) {
    const v = pick.characters[c.id];
    if (!v) return `no voice for ${c.id}`;
    const voice = library.get(v);
    if (!voice) return `"${v}" (for ${c.id}) is not in the library`;
    if ((c.gender === "female" || c.gender === "male") && voice.gender && voice.gender !== c.gender && voice.gender !== "neutral") return `${c.id} is ${c.gender} but "${v}" is ${voice.gender}`;
    if (used.has(v)) return `"${v}" is used twice (or already taken)`;
    used.add(v);
  }
  return undefined;
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
  overdue?: Setup[];
  previousIssues?: ReadonlyArray<Issue | string>;
  context?: string;
} & TurnParams): Promise<RoleOutput<Verdict>> {
  const { bible, beat, sceneIndex, total, tension, overdue, previousIssues, context } = params;
  const priorIssues = previousIssuesBlock(previousIssues, "BEAT SPEC ISSUES FLAGGED PREVIOUSLY (do not re-flag)");
  const prompt = [
    context ? `STORY CONTEXT (provided by author):\n${context}` : "",
    renderBible(bible),
    `SCENE ${sceneIndex + 1} OF ${total}`,
    `TENSION TARGET (1-10): ${tension}`,
    turnLines({ ...params, sceneIndex, total, context }),
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

// Gate the author's (combined) context once, before anything is generated.
export async function reviewContext(role: Role, params: {
  context: string;
  premise?: string;
  setting?: string;
}): Promise<RoleOutput<Verdict>> {
  const { context, premise, setting } = params;
  const prompt = [
    premise ? `STORY PREMISE: ${premise}` : "",
    setting ? `Genre and setting: ${setting}` : "",
    `AUTHOR CONTEXT:\n${context}`
  ].filter(Boolean).join("\n\n");
  return runGate(role, { label: "contextgate", system: CONTEXT_GATE_SYSTEM, prompt, ctx: { context, premise, setting } });
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

export type ArtMode = "scene" | "cover" | "references" | "extras";

export interface ArtShot {
  startParagraph: number; // 0-based index into the scene's paragraphs
  prompt: string;
  characters?: string[];  // bible character ids in the shot
  location?: string;      // bible location id where it's set
  props?: string[];       // known prop ids in the shot
}

export interface KnownRefIds {
  characters: ReadonlySet<string>;
  locations: ReadonlySet<string>;
  props: ReadonlySet<string>;
}

export interface ArtReference {
  kind: VisualRefKind;
  id: string;
  name?: string;
  appearance: string;
  prompt: string;
}

export interface ArtDirection {
  prompt: string;              // cover prompt, the first shot's, or the first reference's
  artStyle?: string;           // references mode, when the story had no style yet
  shots?: ArtShot[];           // scene mode only
  references?: ArtReference[]; // references mode only
  extras?: { keyArt: string; castPhoto: string; castCharacters: string[] };  // extras mode only
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
// A shot's characters, location and props are kept only if they're known ids.
export const MAX_SHOT_CHARACTERS = 3;

export function normalizeShots(raw: unknown, paragraphCount: number, known?: KnownRefIds): ArtShot[] {
  const list = Array.isArray((raw as { shots?: unknown })?.shots) ? (raw as { shots: unknown[] }).shots : [];
  const byStart = new Map<number, ArtShot>();
  for (const item of list) {
    const r = item as { start_paragraph?: unknown; prompt?: unknown; characters?: unknown; location?: unknown; props?: unknown };
    const start = Number(r.start_paragraph);
    if (!Number.isInteger(start) || start < 1 || start > paragraphCount) continue;
    if (typeof r.prompt !== "string" || !r.prompt.trim()) continue;
    if (byStart.has(start - 1)) continue;
    const shot: ArtShot = { startParagraph: start - 1, prompt: r.prompt.trim() };
    if (known) {
      const ids = (v: unknown, set: ReadonlySet<string>) => [...new Set((Array.isArray(v) ? v : []).map(String).filter((id) => set.has(id)))];
      // Three at most: more named people in one frame and the image model mixes up their features.
      shot.characters = ids(r.characters, known.characters).slice(0, MAX_SHOT_CHARACTERS);
      if (typeof r.location === "string" && known.locations.has(r.location)) shot.location = r.location;
      const props = ids(r.props, known.props);
      if (props.length > 0) shot.props = props;
    }
    byStart.set(start - 1, shot);
  }
  const shots = [...byStart.values()].sort((a, b) => a.startParagraph - b.startParagraph);
  if (shots.length > 0) shots[0].startParagraph = 0;
  return shots;
}

// Keeps one reference per requested character/location id, every requested
// prop (canon objects and recreations), plus — when discovering — up to 4 new
// props (slug ids not already known); each needs a non-empty look and prompt.
export function normalizeReferences(
  raw: unknown,
  wanted: { characters: ReadonlySet<string>; locations: ReadonlySet<string>; knownProps: ReadonlySet<string>; props?: ReadonlySet<string>; discoverProps?: boolean }
): ArtReference[] {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out = new Map<string, ArtReference>();
  const take = (kind: VisualRefKind, list: unknown, accept: (id: string) => boolean, limit = Infinity) => {
    let n = 0;
    for (const item of Array.isArray(list) ? list : []) {
      const x = item as { id?: unknown; name?: unknown; appearance?: unknown; prompt?: unknown };
      const id = kind === "prop" ? String(x.id ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") : String(x.id ?? "");
      if (!id || !accept(id) || out.has(`${kind}:${id}`) || n >= limit) continue;
      if (typeof x.appearance !== "string" || !x.appearance.trim()) continue;
      if (typeof x.prompt !== "string" || !x.prompt.trim()) continue;
      const ref: ArtReference = { kind, id, appearance: x.appearance.trim(), prompt: x.prompt.trim() };
      if (kind === "prop") ref.name = typeof x.name === "string" && x.name.trim() ? x.name.trim() : id.replace(/_/g, " ");
      out.set(`${kind}:${id}`, ref);
      n++;
    }
  };
  take("character", r.characters, (id) => wanted.characters.has(id));
  take("location", r.locations, (id) => wanted.locations.has(id));
  const requested = wanted.props ?? new Set<string>();
  take("prop", r.props, (id) => requested.has(id));
  if (wanted.discoverProps ?? true) take("prop", r.props, (id) => !requested.has(id) && !wanted.knownProps.has(id), 4);
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
  // references mode: the character and location ids that need a canonical
  // look, passages where the story mentions each (pronouns, physical details),
  // and the story text to find key props in
  characterIds?: string[];
  locationIds?: string[];
  objectIds?: string[];  // bible key objects that need a prop reference
  discoverProps?: boolean;  // also look for new key props in the story text (default true)
  redoProps?: string[];  // existing prop ids to recreate
  notes?: string;        // author corrections for the recreated references
  mentions?: Record<string, string[]>;
  storyText?: string[];
  // canonical looks already established
  appearances?: RefAppearances;
  // references mode: characters who are real cast members (id -> who they are, from their photos)
  cast?: Record<string, { name: string; kind: "person" | "animal"; appearance: string; notes?: string }>;
  // the story's art style (bible canon); absent = the Art Director defines one
  artStyle?: string;
  // earlier art prompts, oldest first, for visual continuity
  previousPrompts?: string[];
}): Promise<RoleOutput<ArtDirection>> {
  const { bible, mode, beat, sceneIndex, beats, previousPrompts = [] } = params;
  const appearances: RefAppearances = params.appearances ?? { characters: {}, locations: {}, props: {} };
  const paragraphs = params.paragraphs ?? [];
  const shots = params.shots ?? shotCountFor(paragraphs);
  const characterIds = params.characterIds ?? [];
  const locationIds = params.locationIds ?? [];
  const objectIds = params.objectIds ?? [];
  const parts = [renderBible(bible)];
  const artStyle = params.artStyle ?? bible.artStyle;
  parts.push(`ART STYLE (canon — every prompt renders in exactly this and ends with it verbatim): ${artStyle ?? "(none yet)"}`);
  const looks = [
    ...Object.entries(appearances.characters).filter(([id]) => bible.characters[id]).map(([id, a]) => `- character ${id} (${bible.characters[id].name}): ${a}`),
    ...Object.entries(appearances.locations).filter(([id]) => bible.locations[id]).map(([id, a]) => `- location ${id} (${bible.locations[id].name}): ${a}`),
    ...Object.entries(appearances.props).map(([id, p]) => `- prop ${id} (${p.name}): ${p.appearance}`)
  ];
  if (looks.length > 0) parts.push(`CANONICAL APPEARANCES (use these):\n${looks.join("\n")}`);
  const knownProps = Object.keys(appearances.props);
  if (mode === "scene") {
    parts.push(`MODE: SCENE (scene ${(sceneIndex ?? 0) + 1})`);
    if (beat) parts.push(`BEAT SPEC:\n${JSON.stringify(beat, null, 2)}`);
    parts.push(`COMMITTED SCENE (${paragraphs.length} numbered paragraphs):\n${paragraphs.map((p, n) => `[${n + 1}] ${p}`).join("\n\n")}`);
    parts.push(`Make ${shots} shots.`);
  } else if (mode === "references") {
    parts.push("MODE: REFERENCES");
    const mentions = params.mentions ?? {};
    const quoted = [...characterIds, ...locationIds, ...objectIds]
      .filter((id) => (mentions[id] ?? []).length > 0)
      .map((id) => `${id}:\n${mentions[id].map((m) => `  > ${m}`).join("\n")}`);
    if (quoted.length > 0) parts.push(`STORY MENTIONS (how the story so far describes them):\n${quoted.join("\n\n")}`);
    if ((params.storyText ?? []).length > 0) parts.push(`STORY TEXT (find key props here):\n${params.storyText!.join("\n\n")}`);
    const redo = params.redoProps ?? [];
    parts.push(`KNOWN PROPS: ${knownProps.filter((id) => !redo.includes(id)).join(", ") || "(none yet)"}`);
    if (redo.length > 0) parts.push(`RECREATE these props (keep the id): ${redo.map((id) => `${id} (${appearances.props[id]?.name ?? id})`).join(", ")}`);
    if (params.notes?.trim()) parts.push(`AUTHOR NOTES (follow exactly):\n${params.notes.trim()}`);
    const cast = Object.entries(params.cast ?? {}).filter(([id]) => bible.characters[id]);
    if (cast.length > 0) {
      parts.push(`CAST (real ${cast.some(([, m]) => m.kind === "animal") ? "people and animals" : "people"} starring in this story — their likeness is intended; their portraits are drawn from their photos):\n${cast.map(([id, m]) => `- character ${id} (${bible.characters[id].name}) is ${m.name}, ${m.kind === "animal" ? "an animal" : "a person"}: ${m.appearance}`).join("\n")}`);
    }
    if (objectIds.length > 0) parts.push(`OBJECTS NEEDING REFERENCES (canon — props with these ids): ${objectIds.map((id) => `${id} (${bible.objects[id]?.name ?? id})`).join(", ")}`);
    const discover = params.discoverProps ?? true;
    parts.push(`Create references for — characters: ${characterIds.join(", ") || "(none)"}; locations: ${locationIds.join(", ") || "(none)"}; props: ${[...objectIds, ...(params.redoProps ?? [])].join(", ") || "(none)"}${discover ? "; plus any other new key props." : ". No other props this time."}`);
  } else {
    parts.push(mode === "extras" ? "MODE: EXTRAS" : "MODE: COVER");
    const summary = (beats ?? []).map((b, n) => `${n + 1}. [${b.location}] ${b.goal} — ${b.conflict}`).join("\n");
    parts.push(`${mode === "extras" ? "THE STORY" : "STORY SO FAR"} (one line per scene):\n${summary}`);
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
    ctx: {
      mode, beat, sceneIndex, beats, shots, paragraphCount: paragraphs.length, characterIds, locationIds, objectIds, artStyle,
      knownIds: Object.keys(bible.characters), locationIdsKnown: Object.keys(bible.locations), propIds: knownProps
    }
  });
  if (mode === "scene") {
    const normalized = normalizeShots(result, paragraphs.length, {
      characters: new Set(Object.keys(bible.characters)),
      locations: new Set(Object.keys(bible.locations)),
      props: new Set(knownProps)
    });
    if (normalized.length === 0) throw new Error("art director returned no usable shots");
    return { result: { prompt: normalized[0].prompt, shots: normalized }, prompt, system, raw };
  }
  if (mode === "references") {
    const requestedProps = new Set([...(params.redoProps ?? []), ...objectIds]);
    const references = normalizeReferences(result, {
      characters: new Set(characterIds),
      locations: new Set(locationIds),
      knownProps: new Set(knownProps.filter((id) => !requestedProps.has(id))),
      props: requestedProps,
      discoverProps: params.discoverProps ?? true
    });
    const defined = !artStyle && typeof (result as { art_style?: unknown }).art_style === "string" ? (result as { art_style: string }).art_style.trim() : "";
    return { result: { prompt: references[0]?.prompt ?? "", references, ...(defined ? { artStyle: defined } : {}) }, prompt, system, raw };
  }
  if (mode === "extras") {
    const r = (result ?? {}) as { keyArt?: unknown; castPhoto?: unknown; castCharacters?: unknown };
    const keyArt = typeof r.keyArt === "string" ? r.keyArt.trim() : "";
    const castPhoto = typeof r.castPhoto === "string" ? r.castPhoto.trim() : "";
    if (!keyArt || !castPhoto) throw new Error("art director returned no key art or cast photo prompt");
    const castCharacters = (Array.isArray(r.castCharacters) ? r.castCharacters : []).map(String).filter((id, i, all) => bible.characters[id] && all.indexOf(id) === i).slice(0, 8);
    return { result: { prompt: keyArt, extras: { keyArt, castPhoto, castCharacters } }, prompt, system, raw };
  }
  const out = result as Partial<ArtDirection>;
  if (typeof out.prompt !== "string" || !out.prompt.trim()) {
    throw new Error("art director returned no prompt");
  }
  return { result: { prompt: out.prompt.trim() }, prompt, system, raw };
}
