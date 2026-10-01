import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { postJson, requireKey } from "./providers.ts";
import { parseJson } from "./roles.ts";
import type { ArtistBackendSpec, ArtistConfig, CharacterArtData, CoverArtData, GeminiSpec, SceneArtData, StoryEvent } from "./types.ts";

// The Artist renders the Art Director's scene_art / cover_art prompts into images.
// It runs as a separate step over a finished run (like the audiobook), so image
// failures or cost never touch story generation, and images can be re-rendered
// without regenerating the story.

export interface Image {
  data: Buffer;
  mimeType: string;
  // What a reference image is for, told to the model alongside it.
  label?: string;
}

export interface ImageRequest {
  prompt: string;
  // Character portraits and earlier renders, passed as visual references for continuity.
  references: Image[];
  aspectRatio?: string;  // overrides the backend's default (portraits are 3:4)
}

export const PORTRAIT_LABEL = "Canonical look of a character who appears in this image — match their face, build, hair, colors and clothing exactly:";
export const SCENE_LABEL = "Earlier image from the same story — match its art style:";
export const STYLE_LABEL = "Portrait of a DIFFERENT character from the same story — match only its art style, not the person:";

export interface ImageBackend {
  generate(req: ImageRequest): Promise<Image>;
}

export interface Inspection {
  ok: boolean;
  issues: string[];
  revisedPrompt?: string;
}

export interface InspectRequest {
  prompt: string;
  image: Image;
  references: Image[];
}

export interface Inspector {
  inspect(req: InspectRequest): Promise<Inspection>;
}

export const INSPECTOR_SYSTEM = `You are the Art Inspector. You check a generated still image against the prompt it was made from, before it is used in a narrated story video.

Output ONLY JSON:
{"ok":boolean,"issues":[string],"revised_prompt":string}

CHECK FOR:
- PROMPT MISMATCH: the main subject, action, or setting described in the prompt is missing or wrong.
- CHARACTER LIKENESS: each character shown must match their CHARACTER PORTRAIT reference (face, build, hair and facial hair color, clothing). A different-looking person in their place is an issue.
- CONTINUITY: the overall art style must match the other reference images.
- REAL PERSON: any figure that looks like a recognizable real person, actor, or celebrity.
- ARTIFACTS: malformed anatomy, extra or missing limbs, melted faces, garbled objects.
- TEXT: any visible text, captions, logos, watermarks, or speech bubbles.

RULES:
- ok: true if the image is usable as-is. Minor stylistic drift is fine — only flag what a viewer would notice.
- issues: one short sentence per problem; empty when ok.
- revised_prompt: when ok is false, rewrite the ORIGINAL prompt to fix the issues (make the missed detail explicit, restate character appearance, add "no text"). Keep the same scene and moment. When ok is true, return "".`;

export interface ArtJob {
  key: string;            // "character-<id>", "scene-01-03" (scene 1, shot 3), "scene-01" (pre-shots events) or "cover"
  prompt: string;
  sceneIndex?: number;
  startParagraph?: number;
  characterId?: string;   // portraits only
  characters?: string[];  // whose portraits to pass as references (shots and cover)
}

// Character portraits first (every later image references them), then the
// latest scene_art per scene (in scene order, one job per shot), then the latest cover_art.
export function buildArtJobs(events: StoryEvent[]): ArtJob[] {
  const scenes = new Map<number, SceneArtData>();
  const portraits = new Map<string, CharacterArtData>();
  let cover: CoverArtData | undefined;
  for (const e of events) {
    if (e.type === "character_art") {
      const d = e.data as CharacterArtData;
      portraits.set(d.characterId, d);
    } else if (e.type === "scene_art") {
      const d = e.data as SceneArtData;
      scenes.set(d.sceneIndex, d);
    } else if (e.type === "cover_art") {
      cover = e.data as CoverArtData;
    }
  }
  const portraitJobs: ArtJob[] = [...portraits.values()]
    .sort((a, b) => a.characterId.localeCompare(b.characterId))
    .map((d) => ({ key: `character-${d.characterId}`, prompt: d.prompt, characterId: d.characterId }));
  const jobs: ArtJob[] = [...scenes.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([i, d]) => {
      const scene = `scene-${String(i + 1).padStart(2, "0")}`;
      if (!d.shots || d.shots.length === 0) return [{ key: scene, prompt: d.prompt, sceneIndex: i, startParagraph: 0 }];
      return d.shots.map((shot, k) => ({
        key: `${scene}-${String(k + 1).padStart(2, "0")}`,
        prompt: shot.prompt,
        sceneIndex: i,
        startParagraph: shot.startParagraph,
        ...(shot.characters ? { characters: shot.characters } : {})
      }));
    });
  if (cover) jobs.push({ key: "cover", prompt: cover.prompt, ...(portraits.size > 0 ? { characters: [...portraits.keys()].sort() } : {}) });
  return [...portraitJobs, ...jobs];
}

export function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    default: throw new Error(`Unsupported image type ${mimeType}`);
  }
}

function mimeFor(file: string): string {
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

export interface ManifestEntry {
  file: string;
  // Where the image goes in the video: the scene, and the paragraph (index into
  // audiobook/timings.json paragraphStarts) at which it comes on screen. Absent for the cover.
  sceneIndex?: number;
  startParagraph?: number;
  characterId?: string; // set for character portraits
  prompt: string;       // the Art Director's prompt (the skip key)
  finalPrompt: string;  // the prompt that produced the kept image
  attempts: number;
  accepted: boolean;    // false = attempts ran out; the last image was kept anyway
  issues: string[];
}

export type ArtManifest = Record<string, ManifestEntry>;

export type ArtProgress =
  | { type: "job_start"; key: string; index: number; total: number }
  | { type: "job_skipped"; key: string; file: string }
  | { type: "attempt_rejected"; key: string; attempt: number; issues: string[] }
  | { type: "job_done"; key: string; file: string; attempts: number; accepted: boolean }
  | { type: "job_failed"; key: string; error: string };

export interface ArtOptions {
  runDir: string;
  backend: ImageBackend;
  inspector?: Inspector;   // omitted = one shot per image, no review
  maxAttempts?: number;    // per image, default 3
  maxReferences?: number;  // earlier renders passed for continuity, default 3
  maxPortraits?: number;   // character portraits passed per image, default 4
  force?: boolean;         // re-render even when the prompt is unchanged
  onProgress?: (event: ArtProgress) => void;
}

export interface ArtResult {
  outDir: string;
  rendered: number;
  skipped: number;
  failed: number;
  manifest: ArtManifest;
}

export async function renderArt(events: StoryEvent[], opts: ArtOptions): Promise<ArtResult> {
  const outDir = join(opts.runDir, "art");
  await mkdir(outDir, { recursive: true });
  const manifestPath = join(outDir, "art.json");
  let manifest: ArtManifest = {};
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch { /* first render */ }
  const existing = new Set(await readdir(outDir));
  const maxAttempts = opts.maxAttempts ?? 3;
  const maxReferences = opts.maxReferences ?? 3;
  const emit = opts.onProgress ?? (() => {});

  const maxPortraits = opts.maxPortraits ?? 4;
  const jobs = buildArtJobs(events);
  const rendered: Image[] = [];                     // scene shots and cover, in order
  const portraits = new Map<string, Image>();        // character id -> portrait
  const keep = (job: ArtJob, image: Image) => {
    if (job.characterId) portraits.set(job.characterId, image);
    else rendered.push(image);
  };
  // Portraits of the job's characters first, then recent renders for style.
  // A portrait job gets a couple of other portraits, for style only.
  const referencesFor = (job: ArtJob): Image[] => {
    if (job.characterId) {
      return [...portraits.values()].slice(-2).map((img) => ({ ...img, label: STYLE_LABEL }));
    }
    const faces = (job.characters ?? []).flatMap((id) => (portraits.has(id) ? [{ ...portraits.get(id)!, label: PORTRAIT_LABEL }] : [])).slice(0, maxPortraits);
    const style = rendered.slice(faces.length > 0 ? -2 : -maxReferences).map((img) => ({ ...img, label: SCENE_LABEL }));
    return [...faces, ...style];
  };
  const result: ArtResult = { outDir, rendered: 0, skipped: 0, failed: 0, manifest };

  for (const [index, job] of jobs.entries()) {
    const prior = manifest[job.key];
    if (!opts.force && prior && prior.prompt === job.prompt && existing.has(prior.file)) {
      // Same image, but keep its placement current in case the shot's anchor moved.
      prior.sceneIndex = job.sceneIndex;
      prior.startParagraph = job.startParagraph;
      emit({ type: "job_skipped", key: job.key, file: prior.file });
      keep(job, { data: await readFile(join(outDir, prior.file)), mimeType: mimeFor(prior.file) });
      result.skipped++;
      continue;
    }
    emit({ type: "job_start", key: job.key, index, total: jobs.length });
    const references = referencesFor(job);
    try {
      const entry = await renderOne(job, references, opts.backend, opts.inspector, maxAttempts, emit);
      const file = `${job.key}.${extensionFor(entry.image.mimeType)}`;
      await writeFile(join(outDir, file), entry.image.data);
      manifest[job.key] = {
        file,
        sceneIndex: job.sceneIndex,
        startParagraph: job.startParagraph,
        ...(job.characterId ? { characterId: job.characterId } : {}),
        prompt: job.prompt,
        finalPrompt: entry.finalPrompt,
        attempts: entry.attempts,
        accepted: entry.accepted,
        issues: entry.issues
      };
      // Persist after every image so an interrupted render resumes where it stopped.
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
      keep(job, entry.image);
      result.rendered++;
      emit({ type: "job_done", key: job.key, file, attempts: entry.attempts, accepted: entry.accepted });
    } catch (err) {
      result.failed++;
      emit({ type: "job_failed", key: job.key, error: err instanceof Error ? err.message : String(err) });
    }
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return result;
}

// Generate → inspect → regenerate with a revised prompt, up to maxAttempts.
// If every attempt is rejected the last image is kept (accepted: false) so the
// video still has a frame; the manifest records why.
async function renderOne(
  job: ArtJob,
  references: Image[],
  backend: ImageBackend,
  inspector: Inspector | undefined,
  maxAttempts: number,
  emit: (event: ArtProgress) => void
): Promise<{ image: Image; finalPrompt: string; attempts: number; accepted: boolean; issues: string[] }> {
  let prompt = job.prompt;
  let image: Image | undefined;
  let issues: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // A failed generation (timeout, blocked or empty reply) uses up an attempt rather than the whole image.
    try {
      image = await backend.generate({ prompt, references, ...(job.characterId ? { aspectRatio: "3:4" } : {}) });
    } catch (err) {
      issues = [`generation failed: ${err instanceof Error ? err.message : String(err)}`];
      emit({ type: "attempt_rejected", key: job.key, attempt, issues });
      if (attempt === maxAttempts && !image) throw err;
      continue;
    }
    if (!inspector) return { image, finalPrompt: prompt, attempts: attempt, accepted: true, issues: [] };
    const verdict = await inspector.inspect({ prompt, image, references });
    if (verdict.ok) return { image, finalPrompt: prompt, attempts: attempt, accepted: true, issues: [] };
    issues = verdict.issues;
    emit({ type: "attempt_rejected", key: job.key, attempt, issues });
    if (attempt < maxAttempts) {
      prompt = verdict.revisedPrompt?.trim()
        || `${job.prompt}\n\nFix these problems from the previous attempt:\n${issues.map((i) => `- ${i}`).join("\n")}`;
    }
  }
  return { image: image!, finalPrompt: prompt, attempts: maxAttempts, accepted: false, issues };
}

// ---- Gemini ----

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

type GeminiPart = { text: string } | { inline_data: { mime_type: string; data: string } };

function imagePart(img: Image): GeminiPart {
  return { inline_data: { mime_type: img.mimeType, data: img.data.toString("base64") } };
}

async function geminiGenerate(spec: GeminiSpec, role: string, body: unknown): Promise<any> {
  const headers = { "x-goog-api-key": requireKey(spec.apiKeyEnv || "GEMINI_API_KEY") };
  const url = `${spec.baseUrl || GEMINI_BASE}/models/${spec.model}:generateContent`;
  return postJson(url, headers, body, { type: "gemini", model: spec.model, role, timeoutMs: spec.timeoutMs, retries: spec.retries });
}

export class GeminiImageBackend implements ImageBackend {
  spec: GeminiSpec;
  constructor(spec: GeminiSpec) { this.spec = spec; }

  async generate({ prompt, references, aspectRatio }: ImageRequest): Promise<Image> {
    const parts: GeminiPart[] = [];
    for (const ref of references) {
      parts.push({ text: ref.label ?? SCENE_LABEL });
      parts.push(imagePart(ref));
    }
    parts.push({ text: references.length > 0 ? `Now generate this image:\n${prompt}` : prompt });
    const data = await geminiGenerate(this.spec, "artist", {
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseModalities: ["IMAGE"],
        imageConfig: { aspectRatio: aspectRatio ?? this.spec.aspectRatio ?? "16:9" }
      }
    });
    const candidate = data.candidates?.[0];
    for (const p of candidate?.content?.parts ?? []) {
      const inline = p.inlineData ?? p.inline_data;
      if (inline?.data) {
        return { data: Buffer.from(inline.data, "base64"), mimeType: inline.mimeType ?? inline.mime_type ?? "image/png" };
      }
    }
    const reason = candidate?.finishReason ?? data.promptFeedback?.blockReason ?? "no candidates";
    throw new Error(`Gemini returned no image (${reason})`);
  }
}

export class GeminiInspector implements Inspector {
  spec: GeminiSpec;
  constructor(spec: GeminiSpec) { this.spec = spec; }

  async inspect({ prompt, image, references }: InspectRequest): Promise<Inspection> {
    const parts: GeminiPart[] = [{ text: `PROMPT:\n${prompt}` }, { text: "CANDIDATE IMAGE:" }, imagePart(image)];
    for (const ref of references) {
      parts.push({ text: `REFERENCE IMAGE — ${ref.label === PORTRAIT_LABEL ? "CHARACTER PORTRAIT (canonical look)" : "art style only"}:` });
      parts.push(imagePart(ref));
    }
    const data = await geminiGenerate(this.spec, "inspector", {
      systemInstruction: { parts: [{ text: INSPECTOR_SYSTEM }] },
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", temperature: this.spec.temperature ?? 0.2 }
    });
    const text = (data.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
    return toInspection(parseJson(text));
  }
}

export function toInspection(raw: unknown): Inspection {
  const r = (raw ?? {}) as { ok?: unknown; issues?: unknown; revised_prompt?: unknown };
  const issues = Array.isArray(r.issues) ? r.issues.map(String).filter(Boolean) : [];
  return {
    ok: r.ok === true,
    issues,
    revisedPrompt: typeof r.revised_prompt === "string" && r.revised_prompt.trim() ? r.revised_prompt : undefined
  };
}

// ---- Mock (offline tests and story:mock runs) ----

// 1×1 PNG.
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

export class MockImageBackend implements ImageBackend {
  calls: ImageRequest[] = [];
  failOn: Set<string>;
  // failOn: generation throws when the prompt contains any of these substrings.
  constructor(failOn: string[] = []) { this.failOn = new Set(failOn); }

  async generate(req: ImageRequest): Promise<Image> {
    this.calls.push(req);
    for (const s of this.failOn) {
      if (req.prompt.includes(s)) throw new Error(`mock: image generation failed for "${s}"`);
    }
    return { data: PLACEHOLDER_PNG, mimeType: "image/png" };
  }
}

export class MockInspector implements Inspector {
  calls: InspectRequest[] = [];
  seen = new Map<string, number>();
  rejectFirst: number;
  // rejectFirst: reject the first N inspections of each distinct original prompt.
  constructor(rejectFirst = 0) { this.rejectFirst = rejectFirst; }

  async inspect(req: InspectRequest): Promise<Inspection> {
    this.calls.push(req);
    const base = req.prompt.split("\n\nREVISED:")[0];
    const n = this.seen.get(base) ?? 0;
    this.seen.set(base, n + 1);
    if (n < this.rejectFirst) {
      return { ok: false, issues: ["mock: subject missing"], revisedPrompt: `${base}\n\nREVISED: ${n + 1}` };
    }
    return { ok: true, issues: [] };
  }
}

// ---- config ----

export const DEFAULT_ARTIST_CONFIG: ArtistConfig = {
  image: { type: "gemini", model: "gemini-3.1-flash-image", aspectRatio: "16:9" },
  inspector: { type: "gemini", model: "gemini-3.8-flash" },
  maxAttempts: 3,
  maxReferences: 3
};

export function resolveArtistConfig(partial?: Partial<ArtistConfig>): ArtistConfig {
  return { ...DEFAULT_ARTIST_CONFIG, ...partial };
}

export function makeImageBackend(spec: ArtistBackendSpec): ImageBackend {
  if (spec.type === "mock") return new MockImageBackend(spec.failOn);
  if (spec.type === "gemini") return new GeminiImageBackend(spec);
  throw new Error(`Unknown artist image backend type: ${(spec as { type: string }).type}`);
}

export function makeInspector(spec: ArtistBackendSpec): Inspector {
  if (spec.type === "mock") return new MockInspector(spec.rejectFirst);
  if (spec.type === "gemini") return new GeminiInspector(spec);
  throw new Error(`Unknown artist inspector type: ${(spec as { type: string }).type}`);
}
