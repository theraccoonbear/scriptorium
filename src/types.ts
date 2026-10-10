// Shared domain types. One Issue shape for every gate — drift here is the bug
// that let the critic key repeat-detection on prose quotes instead of rules.

export interface Issue {
  type: string;
  entity: string;
  constraint: string;
  detail: string;
}

export interface Verdict {
  ok: boolean;
  issues: Issue[];
  review?: string;
}

// What every gate returns to the engine.
export interface GateResult {
  ok: boolean;
  issueList: Issue[];
}

export interface Character {
  id: string;
  name: string;
  traits: string;
  goal: string;
  voice: string;
  status: string;
  // "female", "male", or absent/"" when unknown or unspecified. Drives the
  // audiobook's voice choice; anything else is treated as unspecified.
  gender?: string;
  // How the character SOUNDS, for audiobook casting: apparent age, pitch,
  // texture, accent (e.g. "fifties, low and gravelly, unhurried, a hill-country burr").
  // `voice` is how they TALK (register, word choice) and guides the writer.
  vocal?: string;
  // From the author's character sheet (characters.json): how they look, and
  // the history the story leaves out. Canon for portraits and casting.
  appearance?: string;
  background?: string;
  // The author's own drawing or design of the character, copied into the run
  // (run-relative) with a hash of its bytes. Their portrait is drawn from it.
  reference?: SheetReference;
}

export interface SheetReference {
  file: string;   // run-relative copy, e.g. references/lemuel.png
  hash: string;   // of the image's bytes: a new image at the same path is a new design
}

// One character on the author's sheet. Filled fields override the generated
// bible; empty ones leave it alone. portrait: false = no reference portrait.
// voiced: true = a voice of their own however little they say; false = always
// read by the narrator (unset: decided by their vocal and how much they say).
export interface SheetCharacter {
  name?: string;
  gender?: string;
  appearance?: string;
  background?: string;
  vocal?: string;
  portrait?: boolean;
  voiced?: boolean;
  // The author's drawing or design of the character: a .png, .jpg or .webp,
  // relative to characters.json (or absolute). Their portrait follows it.
  reference?: string;
}

// author_characters event: the sheet as the author last saved it (newest wins),
// with each reference image as copied into the run.
export interface AuthorCharactersData {
  characters: Record<string, SheetCharacter>;
  references?: Record<string, SheetReference>;
}

export interface Location {
  id: string;
  name: string;
  description: string;
}

export interface Thread {
  id: string;
  title: string;
  status: string;
}

// What a setup is for (#93). A promise must pay off; a red herring pays off by
// misdirecting (shown to be nothing, never given a secret meaning); an open
// question may stay open on purpose; a motif recurs and never needs paying.
// A setup without a kind is a promise, as before.
export type SetupKind = "promise" | "red_herring" | "open_question" | "motif";
export const SETUP_KINDS: readonly SetupKind[] = ["promise", "red_herring", "open_question", "motif"];
export interface Setup {
  id: string;
  text: string;
  openedAt: number;
  kind?: SetupKind;
  purpose?: string;   // the hidden layer: what it's for ("makes the reader suspect Nell"); never stated in the prose
}
// How much the story leaves unsaid (#93): tidy explains everything by the end;
// some lets a couple of questions survive; lots plants and keeps them freely.
export type Ambiguity = "tidy" | "some" | "lots";

export interface BibleSummary {
  arcs: string[];
  recent: string[];
}

// A key object — a signature item that recurs or drives the plot (an
// instrument, a relic, a letter). Its description fixes its physical form so
// the writer, the continuity guard and the art all depict the same thing.
export interface StoryObject {
  id: string;
  name: string;
  description: string;  // size and proportions, shape, materials, how it is held or used
  owner?: string;       // character id
}

export interface Bible {
  premise: string;
  tone: string;
  // How the world is portrayed in pictures — medium, rendering, palette,
  // light, line. Decided with the tone; every image of the story uses it.
  artStyle?: string;
  characters: Record<string, Character>;
  locations: Record<string, Location>;
  objects: Record<string, StoryObject>;
  threads: Record<string, Thread>;
  ledger: Setup[];
  hiddenTruths?: string[];  // what's really going on (#93): kept consistent, never stated outright
  resolvedDecisions: string[];
  // The creator's tension plan, one target (1-10) per scene; null where it gave none.
  arc?: Array<number | null>;
  summary: BibleSummary;
  sceneCount: number;
}

export interface Beat {
  goal: string;
  conflict: string;
  pov: string;
  location: string;
  mustReveal: string;
  constraints: string[];
  payoffs: string[];
  title?: string;     // the scene's title card ("The Pardon"): a few words, no spoilers
  turn?: string;      // what changes in this scene that its people didn't see coming
  plants?: { id: string; text: string; kind: SetupKind; purpose?: string }[];  // setups planted on purpose (#93)
  keepImplied?: string[];  // what this scene leaves implied on purpose: never flagged as unresolved
}

export interface Patch {
  upsertCharacters?: Partial<Character>[];
  upsertLocations?: Partial<Location>[];
  upsertObjects?: Partial<StoryObject>[];
  upsertThreads?: Partial<Thread>[];
  openSetups?: { id: string; text?: string; kind?: SetupKind; purpose?: string }[];
  paySetups?: string[];
  resolveDecisions?: string[];
  timeline?: string;
}

export interface WorldOutput {
  characters: { name: string; archetype: string }[];
  locations: { name: string; archetype: string }[];
  setting_notes: string;
}

export interface StoryEvent<T = unknown> {
  seq: number;
  type: string;
  ts: string;
  data: T;
}

export interface SceneCommittedData {
  patchDisputed?: string[];  // the patch gate's last objections, when the archivist's patch was kept after the last try
  index: number;
  tension: number;
  complication?: string;  // runs written before turns (#90): the stock complication it was given
  beat: Beat;
  prose: string;
  patch: Patch;
  verdict: Verdict;
  attempts: number;
  bible?: Partial<Bible>;
}

// Image-gen prompts from the Art Director. Presentation metadata, not canon:
// replay() ignores these events, so they never touch the bible.
export interface ArtShotData {
  startParagraph: number; // 0-based paragraph index (shared with audiobook timings.json)
  prompt: string;
  // What the shot shows, by reference id; their reference images are passed to the image model.
  characters?: string[];  // bible character ids
  location?: string;      // bible location id
  props?: string[];       // visual_ref prop ids
}

// Canonical visual references: one image per character, location and key prop,
// made once when it enters the story and passed to every image that shows it.
// `appearance` is reused verbatim in scene prompts.
export type VisualRefKind = "character" | "location" | "prop";

export interface VisualRefData {
  kind: VisualRefKind;
  id: string;          // bible id for characters and locations; a slug the Art Director picks for props
  name?: string;       // props: what the story calls it
  appearance: string;
  prompt: string;
  sheet?: string;      // characters: the author's sheet entry it was made from (to notice edits)
}

// Legacy (pre-locations/props) portrait event; read as a character VisualRefData.
export interface CharacterArtData {
  characterId: string;
  appearance: string;
  prompt: string;
}

export interface SceneArtData {
  sceneIndex: number;
  prompt: string;          // first shot's prompt; the only prompt on events from before shots existed
  shots?: ArtShotData[];
  continuity?: ContinuityEntry[];  // the scene's physical facts, stretch by stretch (#140)
}

// One stretch of a scene's continuity sheet (#140), from `fromParagraph` (0-based)
// until the next entry: where it is, and what time, light, weather and state
// every shot in that stretch must show.
export interface ContinuityEntry {
  fromParagraph: number;
  place?: string;          // "a campsite hollow on the open grassland"
  indoors?: boolean;
  time?: string;           // "night, an hour after dusk"
  light?: string;          // "the campfire only; deep blue darkness beyond it"
  weather?: string;        // "dry, still, cold"
  state?: string;          // "the fire is lit"; "the fire is out"
}

// extras_art event: the art director's extras for the story — key art (one
// textless poster composition, rendered at each aspect ratio) and a cast photo
// (the principal characters posing together out of character, as a film cast).
export interface ExtrasArtData {
  keyArt: string;
  castPhoto: string;
  castCharacters: string[];  // who's in the cast photo (character ids)
}

export interface CoverArtData {
  // Number of committed scenes the cover summarizes; a run extended past this gets a fresh cover.
  sceneCount: number;
  prompt: string;
  // Who the cover's prompt describes, most prominent first (the cast check):
  // their portraits go with it, on one contact sheet past three.
  characters?: string[];
}

// ---- provider / role plumbing ----

export interface CompletionRequest {
  role: string;
  system: string;
  prompt: string;
  temperature?: number;
  timeoutMs?: number;
  ctx?: Record<string, unknown>;
}

export interface Provider {
  complete(req: CompletionRequest): Promise<string>;
}

export interface Role {
  provider: Provider;
  temperature?: number;
  timeoutMs?: number;
}

// Roles the engine always requires; gates and worldbuilder are optional.
export interface Roles {
  director: Role;
  writer: Role;
  continuist: Role;
  archivist: Role;
  critic?: Role;
  worldbuilder?: Role;
  beatgate?: Role;
  patchgate?: Role;
  worldgate?: Role;
  contextgate?: Role;
  artdirector?: Role;
  [key: string]: Role | undefined;
}

export interface ProviderSpec {
  type: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  sessionId?: string;
  api?: string;
  authStyle?: string;
  temperature?: number;
  timeoutMs?: number;
  maxTokens?: number;
  maxTokensField?: "max_tokens" | "max_completion_tokens";  // chat completions: which name the host takes (default: max_completion_tokens on OpenAI, max_tokens elsewhere)
  noTemperature?: boolean;
  retries?: number;
  extraBody?: Record<string, unknown>;
  rejectFirstOn?: number[];
  // Mock only: roles whose calls throw, for testing non-fatal failure paths.
  failRoles?: string[];
  [key: string]: unknown;
}

export interface RoleSpec {
  provider: string;
  temperature?: number;
  timeoutMs?: number;
}

// Word band for a scene. Writer stays inside it; critic flags >2x as PACE.
export interface WordBudget {
  min: number;
  max: number;
}

// blocking: critic and continuist must both approve a draft.
// advisory: the critic never blocks; its notes ride along as optional
//   suggestions when the continuist sends a draft back anyway.
// off: the critic isn't called at all.
export const CRITIC_MODES = ["blocking", "advisory", "off"] as const;
export type CriticMode = (typeof CRITIC_MODES)[number];

export interface ExtrasLook { style?: string; direction?: string }

export interface StoryConfig {
  scenes?: number;
  // The author's pins, per scene in order; null leaves that scene to the models.
  tension?: Array<number | null>;   // tension targets 1-10 (else the creator's arc)
  turns?: Array<string | null>;     // each scene's turn (else the author's plan or the director)
  maxRevisions?: number;
  overdueAfter?: number;
  sceneWords?: WordBudget;
  ambiguity?: Ambiguity;  // how much the story leaves unsaid (#93): "tidy", "some" (default) or "lots"
  length?: import("./length.ts").LengthSetting;  // a running time (#170): { minutes, scenes?, wordsPerMinute?, fit? }
  providers: Record<string, ProviderSpec>;
  roles: Record<string, RoleSpec>;
  premise?: string;
  setting?: string;
  context?: string;
  contextFiles?: string[];  // where `context` came from (one or more --context files)
  // When true, the writer tags every paragraph with a speaker (`narrator:` or
  // a bible character id) so the audiobook tool can switch voices per line.
  // Off by default: story.md stays plain prose, unchanged from every prior run.
  speakerTags?: boolean;
  // Author direction per creative layer (role label -> notes the layer must
  // follow), plus "artist" for every image request. See DIRECTION_LAYERS.
  direction?: Record<string, string>;
  // A prescriptive art style that overrides the Creator's choice.
  // The author's overrides of the story's art style and art direction for the
  // extras (#49): for all of them, or just the key art or the cast photo.
  extras?: ExtrasLook & {
    keyArt?: ExtrasLook;
    castPhoto?: ExtrasLook;
    logo?: { file?: string; stackedFile?: string; mode?: "drawn" | "typeset"; font?: string; treatment?: "gilded" | "bronze" | "silver" | "iron" | "parchment" | "plain"; arc?: number; caps?: boolean };  // the title logo (#128): over the art director's design
    box?: boolean;  // the box art (default true)
  };
  artStyle?: string;
  // How much say the critic has over a scene (see CRITIC_MODES). Default "blocking".
  critic?: CriticMode;
  // Art Director: one shot per this many words of narration (~45s at 150 wpm). Default 110.
  artWordsPerShot?: number;
  // Spend accounting: USD per million tokens per model (overrides the defaults
  // in src/usage.ts), and a cap that stops the run before it's exceeded.
  pricing?: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number; perRequest?: number }>;
  // The cap, and which kinds of spend count toward it (#148; default production + rework).
  budget?: { usd: number; count?: Array<"production" | "rework" | "dev" | "experiment"> };
  // The audience rating the story is held to (#88), resolved from the story file's "rating".
  rating?: import("./ratings.ts").RatingPolicy;
  title?: string;  // the story's title (from the story file): who leads its cover
  // Hard stop for a scene that won't settle, even with unlimited attempts. Default 20.
  maxDraftsPerScene?: number;
  // Image rendering for the `art` command; omitted = DEFAULT_ARTIST_CONFIG in src/artist.ts.
  artist?: Partial<ArtistConfig>;
}

// ---- artist (image rendering) ----

export interface GeminiSpec {
  type: "gemini";
  model: string;
  apiKeyEnv?: string;    // default GEMINI_API_KEY
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  aspectRatio?: string;  // image only, default 16:9
  temperature?: number;  // inspector only
}

export interface MockArtSpec {
  type: "mock";
  failOn?: string[];     // image: throw when the prompt contains any of these
  rejectFirst?: number;  // inspector: reject the first N looks at each image
}

// OpenAI as the artist (#89): GPT Image for the image, a GPT vision model for the inspector.
export interface OpenAIArtSpec {
  type: "openai";
  model: string;         // image: gpt-image-2.5-sunburst / -flare; inspector: a vision model (gpt-6.1-sol)
  apiKeyEnv?: string;    // default OPENAI_API_KEY
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  aspectRatio?: string;  // image only, default 16:9
  quality?: "low" | "medium" | "high" | "xhigh" | "max" | "auto";  // image only, default high
  moderation?: "auto" | "low";  // image only
  temperature?: number;  // inspector only (reasoning models take none)
}

export type ArtistBackendSpec = GeminiSpec | MockArtSpec | OpenAIArtSpec;

export interface ArtistConfig {
  image: ArtistBackendSpec;
  inspector?: ArtistBackendSpec | null;  // null disables review
  maxAttempts?: number;
  maxReferences?: number;
  referenceSize?: number;  // longest side (px) of reference images sent; default 768, 0 = full size
  inspectSize?: number;    // longest side (px) of the image sent for inspection; default 1024
  concurrency?: number;    // images rendered at once (default 4)
  // Triage: render every shot once, then this many retakes per shot on average
  // (0.5 = half a retake each), worst-scored first. Unset = retake each image on
  // the spot up to maxAttempts.
  retakes?: number;
  // Triage only retakes images scored at least this severity (0-10; default 5,
  // a clear mistake): below it a retake rarely does better, so the money is kept.
  retakeAbove?: number;
  // Gemini Batch Mode: each stage's images go out as one batch job at half the
  // price; results take minutes (up to 24h). Inspections stay live.
  batch?: boolean;
}

// A structured role call: the model output plus the exact inputs that produced it.
export interface RoleOutput<T> {
  result: T;
  prompt: string;
  system: string;
  raw: string;
}
