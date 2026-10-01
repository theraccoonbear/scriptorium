import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { postJson, requireKey } from "./providers.ts";
import { parseJson } from "./roles.ts";
import type { ArtistBackendSpec, ArtistConfig, CoverArtData, GeminiSpec, SceneArtData, StoryEvent, VisualRefKind } from "./types.ts";
import { readVisualRefs, refKey, storyArtStyle } from "./visualrefs.ts";
import { isBudgetError } from "./usage.ts";

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
  style?: string;        // the story's art style, sent with every image
  direction?: string;    // the author's art direction for the image model, sent with every image
}

export const PORTRAIT_LABEL = "Canonical look of a character who appears in this image — match their face, build, hair, colors and clothing exactly:";
export const LOCATION_LABEL = "The place where this image is set — keep its landmarks, architecture, terrain and materials, but choose your own camera angle and framing:";
export const PROP_LABEL = "A key object that appears in this image — match its shape, materials, colors and markings exactly:";
export const SCENE_LABEL = "Earlier image from the same story — match its art style:";
export const STYLE_LABEL = "Reference image of something ELSE from the same story — match only its art style, not its subject:";

const REF_LABEL: Record<VisualRefKind, string> = { character: PORTRAIT_LABEL, location: LOCATION_LABEL, prop: PROP_LABEL };
const REF_ASPECT: Record<VisualRefKind, string> = { character: "3:4", location: "16:9", prop: "1:1" };

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
  style?: string;
  direction?: string;
}

export interface Inspector {
  inspect(req: InspectRequest): Promise<Inspection>;
}

export const INSPECTOR_SYSTEM = `You are the Art Inspector. You check a generated still image against the prompt it was made from, before it is used in a narrated story video.

Output ONLY JSON:
{"ok":boolean,"issues":[string],"revised_prompt":string}

CHECK FOR:
- PROMPT MISMATCH: the main subject, action, or setting described in the prompt is missing or wrong.
- REFERENCE MATCH: each character must match their CHARACTER PORTRAIT (face, build, hair and facial hair color, clothing); the setting must keep the LOCATION reference's landmarks, architecture and materials (any camera angle is fine); each key object must match its PROP reference (shape, materials, colors, markings). A different-looking person, place or object in their stead is an issue.
- CONTINUITY: the overall art style must match the other reference images.
- REAL PERSON: any figure that looks like a recognizable real person, actor, or celebrity.
- AUTHOR DIRECTION: if given, the image must satisfy it (it is the author's explicit instruction for every image).
- STYLE: if an ART STYLE is given, the image must be rendered in it (medium, palette, line, level of realism). A different medium or a jump in realism is an issue.
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
  ref?: { kind: VisualRefKind; id: string };  // set for canonical reference images
  // What the image shows, whose references to pass (shots and cover).
  characters?: string[];
  location?: string;
  props?: string[];
}

// Canonical references first (characters, locations, props — every later
// image may use them), then the latest scene_art per scene (in scene order,
// one job per shot), then the latest cover_art.
export function buildArtJobs(events: StoryEvent[]): ArtJob[] {
  const scenes = new Map<number, SceneArtData>();
  let cover: CoverArtData | undefined;
  for (const e of events) {
    if (e.type === "scene_art") {
      const d = e.data as SceneArtData;
      scenes.set(d.sceneIndex, d);
    } else if (e.type === "cover_art") {
      cover = e.data as CoverArtData;
    }
  }
  const order: Record<VisualRefKind, number> = { character: 0, location: 1, prop: 2 };
  const refJobs: ArtJob[] = readVisualRefs(events)
    .sort((a, b) => order[a.kind] - order[b.kind] || a.id.localeCompare(b.id))
    .map((r) => ({ key: refKey(r.kind, r.id), prompt: r.prompt, ref: { kind: r.kind, id: r.id } }));
  const refIds = (kind: VisualRefKind) => new Set(refJobs.filter((j) => j.ref!.kind === kind).map((j) => j.ref!.id));
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
        ...(shot.characters ? { characters: shot.characters } : {}),
        ...(shot.location ? { location: shot.location } : {}),
        ...(shot.props ? { props: shot.props } : {})
      }));
    });
  if (cover) {
    // The cover features the story's most-shown characters, place and props.
    const top = (ids: string[], have: Set<string>, n: number) => {
      const counts = new Map<string, number>();
      for (const id of ids) if (have.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
      return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([id]) => id);
    };
    const characters = top(jobs.flatMap((j) => j.characters ?? []), refIds("character"), 4);
    const location = top(jobs.flatMap((j) => (j.location ? [j.location] : [])), refIds("location"), 1)[0];
    const props = top(jobs.flatMap((j) => j.props ?? []), refIds("prop"), 2);
    jobs.push({
      key: "cover",
      prompt: cover.prompt,
      ...(characters.length > 0 ? { characters } : {}),
      ...(location ? { location } : {}),
      ...(props.length > 0 ? { props } : {})
    });
  }
  return [...refJobs, ...jobs];
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
  refKind?: VisualRefKind; // set for canonical reference images
  refId?: string;
  prompt: string;       // the Art Director's prompt (the skip key)
  finalPrompt: string;  // the prompt that produced the kept image
  direction?: string;   // the author's art direction it was rendered under (also a skip key)
  style?: string;       // the art style it was rendered in (also a skip key)
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
  direction?: string;      // the author's art direction for the image model (direction.artist)
  backend: ImageBackend;
  inspector?: Inspector;   // omitted = one shot per image, no review
  maxAttempts?: number;    // per image, default 3
  maxReferences?: number;  // earlier renders passed for continuity, default 3
  maxPortraits?: number;   // character portraits passed per image, default 3 (plus 1 location and 2 props)
  force?: boolean;         // re-render even when the prompt is unchanged
  // Longest side, in px, of images sent as references (default 768) and of the
  // candidate sent for inspection (default 1024); 0 sends them full size. Files
  // on disk stay full size. References are most of each request's size.
  referenceSize?: number;
  inspectSize?: number;
  shrink?: Shrink;         // resizer; defaults to ffmpeg, falling back to the original
  onProgress?: (event: ArtProgress) => void;
}

export type Shrink = (image: Image, maxSide: number) => Promise<Image>;

// Downscale with ffmpeg (already required by `video`) to a JPEG no larger than
// maxSide on its longest side. Any failure — no ffmpeg, odd input — returns the
// original: smaller requests are an optimization, never a reason to fail a render.
export const ffmpegShrink: Shrink = (image, maxSide) => new Promise((resolve) => {
  if (maxSide <= 0) return resolve(image);
  const scale = `scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease`;
  const child = spawn("ffmpeg", ["-v", "error", "-i", "pipe:0", "-vf", scale, "-frames:v", "1", "-q:v", "3", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"], { stdio: ["pipe", "pipe", "ignore"] });
  const out: Buffer[] = [];
  child.stdout.on("data", (d: Buffer) => out.push(d));
  child.on("error", () => resolve(image));
  child.on("close", (code) => {
    const data = Buffer.concat(out);
    resolve(code === 0 && data.length > 0 && data.length < image.data.length ? { ...image, data, mimeType: "image/jpeg" } : image);
  });
  child.stdin.on("error", () => { /* reported via close */ });
  child.stdin.end(image.data);
});

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

  const maxPortraits = opts.maxPortraits ?? 3;
  // One art style for the whole story, sent with every image request — not left
  // to each prompt to restate.
  const style = storyArtStyle(events);
  const direction = opts.direction?.trim() || undefined;
  const jobs = buildArtJobs(events);
  const rendered: Image[] = [];                // scene shots and cover, in order
  const refs = new Map<string, Image>();       // refKey(kind, id) -> reference image
  const shrink = opts.shrink ?? ffmpegShrink;
  const referenceSize = opts.referenceSize ?? 768;
  const inspectSize = opts.inspectSize ?? 1024;
  // Kept images are only ever used as references, so keep the shrunk copy.
  const keep = async (job: ArtJob, image: Image) => {
    const small = await shrink(image, referenceSize);
    if (job.ref) refs.set(refKey(job.ref.kind, job.ref.id), small);
    else rendered.push(small);
  };
  const refImages = (kind: VisualRefKind, ids: string[], limit: number): Image[] =>
    ids.flatMap((id) => {
      const img = refs.get(refKey(kind, id));
      return img ? [{ ...img, label: REF_LABEL[kind] }] : [];
    }).slice(0, limit);
  // A shot gets the references for what it shows — up to 3 characters, its
  // location, 2 props — then a recent render or two for style. Image models
  // lose track past a handful of references, hence the caps. A reference job
  // gets two earlier references, for style only.
  const referencesFor = (job: ArtJob): Image[] => {
    if (job.ref) return [...refs.values()].slice(-2).map((img) => ({ ...img, label: STYLE_LABEL }));
    const canon = [
      ...refImages("character", job.characters ?? [], maxPortraits),
      ...refImages("location", job.location ? [job.location] : [], 1),
      ...refImages("prop", job.props ?? [], 2)
    ];
    const style = rendered.slice(canon.length > 0 ? -1 : -maxReferences).map((img) => ({ ...img, label: SCENE_LABEL }));
    return [...canon, ...style];
  };
  const result: ArtResult = { outDir, rendered: 0, skipped: 0, failed: 0, manifest };

  for (const [index, job] of jobs.entries()) {
    const prior = manifest[job.key];
    if (!opts.force && prior && prior.prompt === job.prompt && prior.style === style && prior.direction === direction && existing.has(prior.file)) {
      // Same image, but keep its placement current in case the shot's anchor moved.
      prior.sceneIndex = job.sceneIndex;
      prior.startParagraph = job.startParagraph;
      emit({ type: "job_skipped", key: job.key, file: prior.file });
      await keep(job, { data: await readFile(join(outDir, prior.file)), mimeType: mimeFor(prior.file) });
      result.skipped++;
      continue;
    }
    emit({ type: "job_start", key: job.key, index, total: jobs.length });
    const references = referencesFor(job);
    try {
      const forInspection = (img: Image) => shrink(img, inspectSize);
      const entry = await renderOne(job, references, opts.backend, opts.inspector, maxAttempts, emit, style, forInspection, direction);
      const file = `${job.key}.${extensionFor(entry.image.mimeType)}`;
      await writeFile(join(outDir, file), entry.image.data);
      manifest[job.key] = {
        file,
        sceneIndex: job.sceneIndex,
        startParagraph: job.startParagraph,
        ...(job.ref ? { refKind: job.ref.kind, refId: job.ref.id } : {}),
        prompt: job.prompt,
        finalPrompt: entry.finalPrompt,
        ...(style ? { style } : {}),
        ...(direction ? { direction } : {}),
        attempts: entry.attempts,
        accepted: entry.accepted,
        issues: entry.issues
      };
      // Persist after every image so an interrupted render resumes where it stopped.
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
      await keep(job, entry.image);
      result.rendered++;
      emit({ type: "job_done", key: job.key, file, attempts: entry.attempts, accepted: entry.accepted });
    } catch (err) {
      if (isBudgetError(err)) throw err;
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
  emit: (event: ArtProgress) => void,
  style?: string,
  forInspection: (img: Image) => Promise<Image> = async (img) => img,
  direction?: string
): Promise<{ image: Image; finalPrompt: string; attempts: number; accepted: boolean; issues: string[] }> {
  let prompt = job.prompt;
  let image: Image | undefined;
  let issues: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // A failed generation (timeout, blocked or empty reply) uses up an attempt rather than the whole image.
    try {
      image = await backend.generate({ prompt, references, ...(style ? { style } : {}), ...(direction ? { direction } : {}), ...(job.ref ? { aspectRatio: REF_ASPECT[job.ref.kind] } : {}) });
    } catch (err) {
      if (isBudgetError(err)) throw err;
      issues = [`generation failed: ${err instanceof Error ? err.message : String(err)}`];
      emit({ type: "attempt_rejected", key: job.key, attempt, issues });
      if (attempt === maxAttempts && !image) throw err;
      continue;
    }
    if (!inspector) return { image, finalPrompt: prompt, attempts: attempt, accepted: true, issues: [] };
    const verdict = await inspector.inspect({ prompt, image: await forInspection(image), references, ...(style ? { style } : {}), ...(direction ? { direction } : {}) });
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

  async generate({ prompt, references, aspectRatio, style, direction }: ImageRequest): Promise<Image> {
    const parts: GeminiPart[] = [];
    if (style) parts.push({ text: `ART STYLE — every image of this story uses exactly this style; render in it regardless of the references' subjects: ${style}` });
    if (direction) parts.push({ text: `AUTHOR ART DIRECTION — applies to every image; follow it exactly: ${direction}` });
    for (const ref of references) {
      parts.push({ text: ref.label ?? SCENE_LABEL });
      parts.push(imagePart(ref));
    }
    parts.push({ text: references.length > 0 || style ? `Now generate this image:\n${prompt}` : prompt });
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

  async inspect({ prompt, image, references, style, direction }: InspectRequest): Promise<Inspection> {
    const parts: GeminiPart[] = [{ text: `PROMPT:\n${prompt}` }];
    if (style) parts.push({ text: `ART STYLE:\n${style}` });
    if (direction) parts.push({ text: `AUTHOR DIRECTION:\n${direction}` });
    parts.push({ text: "CANDIDATE IMAGE:" }, imagePart(image));
    for (const ref of references) {
      const kind = ref.label === PORTRAIT_LABEL ? "CHARACTER PORTRAIT" : ref.label === LOCATION_LABEL ? "LOCATION" : ref.label === PROP_LABEL ? "PROP" : "art style only";
      parts.push({ text: `REFERENCE IMAGE — ${kind}:` });
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
