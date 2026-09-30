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

export interface Bible {
  premise: string;
  tone: string;
  characters: Record<string, Character>;
  locations: Record<string, Location>;
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
}

export interface Patch {
  upsertCharacters?: Partial<Character>[];
  upsertLocations?: Partial<Location>[];
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
  // When true, the writer tags every paragraph with a speaker (`narrator:` or
  // a bible character id) so the audiobook tool can switch voices per line.
  // Off by default: story.md stays plain prose, unchanged from every prior run.
  speakerTags?: boolean;
}

// A structured role call: the model output plus the exact inputs that produced it.
export interface RoleOutput<T> {
  result: T;
  prompt: string;
  system: string;
  raw: string;
}
