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
}

// One character on the author's sheet. Filled fields override the generated
// bible; empty ones leave it alone. portrait: false = no reference portrait.
export interface SheetCharacter {
  name?: string;
  gender?: string;
  appearance?: string;
  background?: string;
  vocal?: string;
  portrait?: boolean;
}

// author_characters event: the sheet as the author last saved it (newest wins).
export interface AuthorCharactersData {
  characters: Record<string, SheetCharacter>;
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

export interface Setup {
  id: string;
  text: string;
  openedAt: number;
}

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
  resolvedDecisions: string[];
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
}

export interface Patch {
  upsertCharacters?: Partial<Character>[];
  upsertLocations?: Partial<Location>[];
  upsertObjects?: Partial<StoryObject>[];
  upsertThreads?: Partial<Thread>[];
  openSetups?: { id: string; text?: string }[];
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
  index: number;
  tension: number;
  complication: string;
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
}

export interface CoverArtData {
  // Number of committed scenes the cover summarizes; a run extended past this gets a fresh cover.
  sceneCount: number;
  prompt: string;
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

export interface StoryConfig {
  rngSeed?: number;
  scenes?: number;
  maxRevisions?: number;
  overdueAfter?: number;
  sceneWords?: WordBudget;
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
  artStyle?: string;
  // How much say the critic has over a scene (see CRITIC_MODES). Default "blocking".
  critic?: CriticMode;
  // Art Director: one shot per this many words of narration (~45s at 150 wpm). Default 110.
  artWordsPerShot?: number;
  // Spend accounting: USD per million tokens per model (overrides the defaults
  // in src/usage.ts), and a cap that stops the run before it's exceeded.
  pricing?: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number; perRequest?: number }>;
  budget?: { usd: number };
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

export type ArtistBackendSpec = GeminiSpec | MockArtSpec;

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
