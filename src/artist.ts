import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { postJson, requireKey } from "./providers.ts";
import { parseJson } from "./roles.ts";
import type { ArtistBackendSpec, ArtistConfig, CoverArtData, ExtrasArtData, GeminiSpec, SceneArtData, StoryEvent, VisualRefKind } from "./types.ts";
import { readVisualRefs, refKey, storyArtStyle } from "./visualrefs.ts";
import { replay } from "./bible.ts";
import { isBudgetError } from "./usage.ts";
import { microBatcher } from "./batchJobs.ts";
import type { BatchJobs } from "./batchJobs.ts";
import { CAST_SYSTEM, castCharacters, loadImage, toCastDescription } from "./cast.ts";
import type { CastDescriber } from "./cast.ts";

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
  imageSize?: string;    // "1K" (default), "2K" or "4K"
  style?: string;        // the story's art style, sent with every image
  direction?: string;    // the author's art direction for the image model, sent with every image
}

export const PORTRAIT_LABEL = "Canonical look of a character who appears in this image — match their face, build, hair, colors and clothing exactly, but NOT the reference's pose, expression or framing: pose and move them exactly as this image's description says:";
export const LOCATION_LABEL = "The place where this image is set — keep its landmarks, architecture, terrain and materials, but choose your own camera angle and framing:";
export const PROP_LABEL = "A key object that appears in this image — match its shape, materials, colors and markings exactly:";
export const CAST_PHOTO_LABEL = "Real photo of the person or animal this character IS — the portrait must be unmistakably them (same face and features, build, skin, hair; for an animal, breed, coat and markings), redrawn in the story's art style and dressed as the description says, not as in the photo:";
export const CAST_PORTRAIT_LABEL = "Canonical look of a character who appears in this image — a real cast member, so this likeness is intended: match their face, build, hair, colors and clothing exactly, but NOT the reference's pose, expression or framing: pose and move them exactly as this image's description says:";
export const AUTHOR_DESIGN_LABEL = "The author's own drawing of this character — their design: follow its face, hair and facial hair, colouring, build, clothing and gear exactly, but redraw it in the story's art style (not the drawing's medium or line), posed as the description says. A drawing, not a real person:";
export const REFRAME_LABEL = "THE image to reproduce — this exact picture: the same people, poses, place, light, colour grade and photographic look. Reframe it to this new shape: extend the scene naturally at the edges (or crop) so it fills the frame, keeping the main figures whole and central, with open sky at the top. Don't redraw, restyle, add or remove anything:";
export const SCENE_LABEL = "Earlier image from the same story — match its art style, not its composition or poses:";
export const STYLE_LABEL = "Reference image of something ELSE from the same story — match only its art style, not its subject:";

const REF_LABEL: Record<VisualRefKind, string> = { character: PORTRAIT_LABEL, location: LOCATION_LABEL, prop: PROP_LABEL };
const REF_ASPECT: Record<VisualRefKind, string> = { character: "3:4", location: "16:9", prop: "1:1" };

export interface ImageBackend {
  generate(req: ImageRequest): Promise<Image>;
}

export interface Inspection {
  ok: boolean;
  severity?: number;  // 0 (matches) to 10 (unusable)
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
{"ok":boolean,"severity":number,"issues":[string],"revised_prompt":string}

CHECK FOR:
- PROMPT MISMATCH: the main subject, action, or setting described in the prompt is missing or wrong.
- REFERENCE MATCH: each character must match their CHARACTER PORTRAIT (face, build, hair and facial hair color, clothing); the setting must keep the LOCATION reference's landmarks, architecture and materials (any camera angle is fine); each key object must match its PROP reference (shape, materials, colors, markings). A different-looking person, place or object in their stead is an issue.
- CHARACTER MIX-UP: each named character must look like THEIR OWN portrait and no one else's. One character's features on another figure (someone else's beard, hair, horns, shawl, robe or gear), a named character missing, the wrong character doing what the prompt says, or a person merged from two portraits is an issue. Count the people the prompt names: each appears once.
- CONTINUITY: the overall art style must match the other reference images.
- REAL PERSON: any figure that looks like a recognizable real person, actor, or celebrity — EXCEPT a real cast member: a character given as a REAL PHOTO or a CAST MEMBER PORTRAIT is meant to look like that person. For those, check the opposite: they must be recognizably the person (or animal) in the reference — face and features, build, coloring; for an animal, breed, coat and markings. A likeness that drifts away from them is an issue. An AUTHOR'S DESIGN is a drawing, not a real person: matching it is intended.
- DESIGN MATCH: a portrait given an AUTHOR'S DESIGN must follow it — hair and facial hair, colouring, face, build, clothing and its colours, and gear — redrawn in the ART STYLE. A missing signature feature (a beard, bare feet, a weapon), a wrong colour, or copying the drawing's own medium and line instead of the ART STYLE is an issue.
- AUTHOR DIRECTION: if given, the image must satisfy it (it is the author's explicit instruction for every image).
- STYLE: if an ART STYLE is given, the image must be rendered in it (medium, palette, line, level of realism). A different medium or a jump in realism is an issue.
- STAGING: the prompt describes motion or a decisive action, but the figures are stiff — standing still, posed, facing the camera like a portrait, or copying a reference portrait's pose — or the shot ignores the camera angle the prompt names. A flat, lifeless version of an action prompt is an issue.
- ARTIFACTS: malformed anatomy, extra or missing limbs, melted faces, garbled objects.
- TEXT: any visible text, captions, logos, watermarks, or speech bubbles.

RULES:
- ok: true if the image is usable as-is. Minor stylistic drift is fine — only flag what a viewer would notice.
- severity: how far the image falls short, 0-10, judged as a viewer would notice it. 0 = matches everything; 1-2 = small drift a viewer wouldn't notice; 3-4 = noticeable but usable (a slightly off color, a stiff pose); 5-6 = a clear mistake (wrong object shape, wrong hair, ignored camera angle); 7-8 = wrong in a way that breaks the story (wrong character, a character mix-up, a key object wrong, a real-person likeness, text in the image); 9-10 = unusable (broken anatomy, the wrong scene). Score every image, ok or not; the worst images across a story are retaken first.
- issues: one short sentence per problem; empty when ok.
- revised_prompt: when ok is false, rewrite the ORIGINAL prompt to fix the issues (make the missed detail explicit, restate character appearance, make the action and camera angle explicit for a STAGING issue, add "no text"). Keep the same scene and moment. NEVER name any real person, actor or celebrity in it, not even to say "not like them": the image model draws toward any name it reads. For a REAL PERSON issue, describe a clearly different original face instead (bone structure, age, distinctive features). When ok is true, return "".`;

export interface ArtJob {
  key: string;            // "character-<id>", "scene-01-03" (scene 1, shot 3), "scene-01" (pre-shots events) or "cover"
  prompt: string;
  sceneIndex?: number;
  startParagraph?: number;
  ref?: { kind: VisualRefKind; id: string };  // set for canonical reference images
  photos?: string[];      // a cast member's portrait: their photos (run-relative), passed as input images
  photoKey?: string;      // what the photos are (the cast hash) — a skip key
  design?: boolean;       // the photos are the author's drawing of the character, not a real person
  // What the image shows, whose references to pass (shots and cover).
  characters?: string[];
  location?: string;
  props?: string[];
  aspectRatio?: string;   // extras: their own shapes (key art 2:3, 16:9, 1:1)
  imageSize?: string;     // extras: "2K"
  maxPortraits?: number;  // extras: the cast photo passes everyone in it
  from?: string;          // key art: the key of the image it reframes (the cover)
  // The author's override of the story's art style / direction for this image (extras).
  lookStyle?: string;
  lookDirection?: string;
}

// The extras (#49): key art in the shapes streaming apps use, and a cast photo.
// All textless (titles are set separately); 2K.
export const KEY_ART: Record<string, string> = { "extra-keyart-2x3": "2:3", "extra-keyart-16x9": "16:9", "extra-keyart-1x1": "1:1" };
export const CAST_PHOTO_KEY = "extra-cast";
export const EXTRAS_SIZE = "2K";
export const MAX_CAST_PHOTO = 8;  // characters in the cast photo (and portraits passed)
const STYLE_SCENES_FOR_EXTRAS = 3;  // finished scenes shown to an extra for its look

// Canonical references first (characters, locations, props — every later
// image may use them), then the latest scene_art per scene (in scene order,
// one job per shot), then the latest cover_art.
export function buildArtJobs(events: StoryEvent[]): ArtJob[] {
  const scenes = new Map<number, SceneArtData>();
  let cover: CoverArtData | undefined;
  let extras: ExtrasArtData | undefined;
  for (const e of events) {
    if (e.type === "scene_art") {
      const d = e.data as SceneArtData;
      scenes.set(d.sceneIndex, d);
    } else if (e.type === "cover_art") {
      cover = e.data as CoverArtData;
    } else if (e.type === "extras_art") {
      extras = e.data as ExtrasArtData;
    }
  }
  const order: Record<VisualRefKind, number> = { character: 0, location: 1, prop: 2 };
  const cast = castCharacters(events);
  const characters = replay(events).characters;
  const refJobs: ArtJob[] = readVisualRefs(events)
    .sort((a, b) => order[a.kind] - order[b.kind] || a.id.localeCompare(b.id))
    .map((r) => {
      const member = r.kind === "character" ? cast[r.id] : undefined;
      // A real cast member's photos win over a drawing.
      const design = r.kind === "character" && !member ? characters[r.id]?.reference : undefined;
      return {
        key: refKey(r.kind, r.id), prompt: r.prompt, ref: { kind: r.kind, id: r.id },
        ...(member ? { photos: member.photos, photoKey: member.hash } : design ? { photos: [design.file], photoKey: `design:${design.hash}`, design: true } : {})
      };
    });
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
  // The cover and key art feature the story's most-shown characters, place and props.
  const top = (ids: string[], have: Set<string>, n: number) => {
    const counts = new Map<string, number>();
    for (const id of ids) if (have.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([id]) => id);
  };
  const shots = [...jobs];
  const featured = {
    characters: top(shots.flatMap((j) => j.characters ?? []), refIds("character"), 4),
    location: top(shots.flatMap((j) => (j.location ? [j.location] : [])), refIds("location"), 1)[0],
    props: top(shots.flatMap((j) => j.props ?? []), refIds("prop"), 2)
  };
  const feature = {
    ...(featured.characters.length > 0 ? { characters: featured.characters } : {}),
    ...(featured.location ? { location: featured.location } : {}),
    ...(featured.props.length > 0 ? { props: featured.props } : {})
  };
  if (cover) jobs.push({ key: "cover", prompt: cover.prompt, ...feature });
  if (extras) {
    // Every story prompt ends with the art style, verbatim; an extra without it
    // drifts to the image model's own look, so it's added when missing.
    const style = events.filter((e) => e.type === "art_style").map((e) => (e.data as { style?: string }).style?.trim()).filter(Boolean).at(-1);
    const styled = (p: string) => (style && !p.includes(style) ? `${p.trim()} ${style}` : p);
    // Key art is the cover, reframed to each shape: the cover is already in the
    // story's look and true to the story, which a fresh poster prompt wasn't
    // (it drifted to a glossy game-render look and invented a battle).
    for (const [key, aspectRatio] of Object.entries(KEY_ART)) {
      jobs.push(cover
        ? { key, prompt: styled(cover.prompt), from: "cover", aspectRatio, imageSize: EXTRAS_SIZE }
        : { key, prompt: styled(extras.keyArt), ...feature, aspectRatio, imageSize: EXTRAS_SIZE });
    }
    const castIds = extras.castCharacters.filter((id) => refIds("character").has(id)).slice(0, MAX_CAST_PHOTO);
    jobs.push({ key: CAST_PHOTO_KEY, prompt: styled(extras.castPhoto), ...(castIds.length ? { characters: castIds } : {}), aspectRatio: "3:2", imageSize: EXTRAS_SIZE, maxPortraits: MAX_CAST_PHOTO });
  }
  return withShotNotes(withCurrentStyle([...refJobs, ...jobs], events), events);
}

// ---- reshoots ----

// The reference images a shot is drawn with, as renderArt picks them (up to
// maxPortraits characters, its location, two props; only references that
// exist), each with a hash of its image file.
export async function shotInputs(job: ArtJob, manifest: ArtManifest, artDir: string, maxPortraits = 3): Promise<Record<string, string>> {
  const have = (key: string) => Boolean(manifest[key]);
  const keys = [
    ...(job.characters ?? []).map((id) => refKey("character", id)).filter(have).slice(0, job.maxPortraits ?? maxPortraits),
    ...(job.location ? [refKey("location", job.location)] : []).filter(have),
    ...(job.props ?? []).map((id) => refKey("prop", id)).filter(have).slice(0, 2),
    ...(job.from ? [job.from] : []).filter(have)  // a reframed image is redone when its source changes
  ];
  return refHashes(keys, manifest, artDir);
}

// Hashes of these references' images as they are now (a missing one is absent).
export async function refHashes(keys: string[], manifest: ArtManifest, artDir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const bytes = manifest[key] ? await readFile(join(artDir, manifest[key].file)).catch(() => undefined) : undefined;
    if (bytes) out[key] = createHash("sha1").update(bytes).digest("hex").slice(0, 12);
  }
  return out;
}

// The references a shot was drawn from whose image has changed (or gone) since.
// Only the images it used count: a shot re-planned to use others is a new prompt, not a reshoot.
export function changedRefs(was: Record<string, string>, now: Record<string, string>): string[] {
  return Object.keys(was).filter((k) => now[k] !== was[k]).sort();
}

export interface StaleShot { key: string; refs: string[]; approved: boolean }

// Every shot drawn from a reference that has changed since: the reshoot list.
export async function staleShots(events: StoryEvent[], runDir: string, approved: ReadonlySet<string> = new Set(), maxPortraits = 3): Promise<StaleShot[]> {
  const artDir = join(runDir, "art");
  let manifest: ArtManifest = {};
  try { manifest = JSON.parse(await readFile(join(artDir, "art.json"), "utf8")); } catch { return []; }
  const out: StaleShot[] = [];
  for (const job of buildArtJobs(events)) {
    const prior = manifest[job.key];
    if (job.ref || !prior?.refs) continue;
    const refs = changedRefs(prior.refs, await refHashes(Object.keys(prior.refs), manifest, artDir));
    if (refs.length) out.push({ key: job.key, refs, approved: approved.has(job.key) });
  }
  return out;
}

// The reshoot list for the author: by scene, what changed, what it costs.
export function formatReshoot(stale: StaleShot[], batch: boolean, perImageUsd = 0.09): string {
  if (stale.length === 0) return "nothing to reshoot: every shot was drawn from the current references";
  const todo = stale.filter((s) => !s.approved);
  const byScene = new Map<string, StaleShot[]>();
  for (const s of stale) { const k = s.key.match(/^scene-\d+/)?.[0] ?? s.key; byScene.set(k, [...(byScene.get(k) ?? []), s]); }
  const lines = [...byScene].map(([scene, shots]) => `${scene}: ${shots.map((s) => `${s.key.replace(/^scene-\d+-/, "")}${s.approved ? " (approved — stays)" : ""} ← ${s.refs.join(", ")}`).join("; ")}`);
  const usd = todo.length * perImageUsd * (batch ? 0.5 : 1);
  return [...lines, `${todo.length} shot${todo.length === 1 ? "" : "s"} to reshoot, ~$${usd.toFixed(2)}${batch ? " (batch)" : ""} — run make --only art${stale.length > todo.length ? `; ${stale.length - todo.length} approved stay (revoke to reshoot them)` : ""}`].join("\n");
}

// The author's correction for a shot (shot_note events, newest per shot),
// added to its prompt: a new note is a new prompt, so the shot is redone.
function withShotNotes(jobs: ArtJob[], events: StoryEvent[]): ArtJob[] {
  const notes = new Map<string, string>();
  for (const e of events) if (e.type === "shot_note") { const d = e.data as { key: string; note: string }; notes.set(d.key, d.note); }
  if (notes.size === 0) return jobs;
  return jobs.map((j) => (notes.get(j.key)?.trim() ? { ...j, prompt: `${j.prompt}\n\nAUTHOR NOTE — a correction for this shot: ${notes.get(j.key)!.trim()}` } : j));
}

// The art director writes the art style verbatim into every prompt. When the
// style changes, a prompt written before the change still carries the old
// text, which would fight the new one. Swap any earlier style for the current
// one, so a style change reaches every image that isn't approved.
export function withCurrentStyle(jobs: ArtJob[], events: StoryEvent[]): ArtJob[] {
  const styles = events.filter((e) => e.type === "art_style").map((e) => (e.data as { style?: string }).style?.trim()).filter((x): x is string => Boolean(x));
  const current = styles.at(-1);
  const old = [...new Set(styles.slice(0, -1))].filter((x) => x !== current).sort((a, b) => b.length - a.length);
  if (!current || old.length === 0) return jobs;
  return jobs.map((j) => {
    let prompt = j.prompt;
    for (const o of old) if (prompt.includes(o)) prompt = prompt.split(o).join(current);
    return prompt === j.prompt ? j : { ...j, prompt };
  });
}

export const PREVIOUS_DIR = "previous";  // art/previous/<key>/: images a newer one replaced

// Where a key's image lives under art/: one folder per kind — character/,
// location/, prop/, scene/NN/, cover/, extra/ — not 150 files in one.
export function artFile(key: string, ext: string): string {
  const ref = key.match(/^(character|location|prop)-(.+)$/);
  if (ref) return `${ref[1]}/${ref[2]}.${ext}`;
  const shot = key.match(/^scene-(\d+)-(\d+)$/);
  if (shot) return `scene/${shot[1]}/${shot[2]}.${ext}`;
  const scene = key.match(/^scene-(\d+)$/);
  if (scene) return `scene/${scene[1]}/scene.${ext}`;
  if (key === "cover") return `cover/cover.${ext}`;
  const extra = key.match(/^extra-(.+)$/);
  if (extra) return `extra/${extra[1]}.${ext}`;
  return `${key}.${ext}`;
}

// Moves a run's images made before the folders into them, files and art.json
// together. Safe to run again: anything already in place is left alone.
export async function organizeArt(artDir: string): Promise<number> {
  const manifestPath = join(artDir, "art.json");
  let manifest: ArtManifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch { return 0; }
  let moved = 0;
  for (const [key, entry] of Object.entries(manifest)) {
    const want = artFile(key, extname(entry.file).slice(1));
    if (entry.file === want) continue;
    try {
      await mkdir(dirname(join(artDir, want)), { recursive: true });
      await rename(join(artDir, entry.file), join(artDir, want));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;  // a missing file is re-rendered under its new name
    }
    entry.file = want;
    moved++;
  }
  if (moved) await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return moved;
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
  photos?: string;      // a cast portrait's photos (the cast hash; also a skip key)
  attempts: number;
  accepted: boolean;    // false = attempts ran out; the last image was kept anyway
  issues: string[];
  severity?: number;    // the inspector's 0-10 score for the kept image
  retaken?: boolean;    // triage replaced the first image with a better retake
  // A shot's inputs: each reference image it was drawn with (art key -> hash of
  // the image). A reference that changes afterwards makes the shot out of date.
  refs?: Record<string, string>;
}

export type ArtManifest = Record<string, ManifestEntry>;

export type ArtProgress =
  | { type: "job_start"; key: string; index: number; total: number }
  | { type: "job_skipped"; key: string; file: string }
  | { type: "attempt_rejected"; key: string; attempt: number; issues: string[] }
  | { type: "job_done"; key: string; file: string; attempts: number; accepted: boolean }
  | { type: "job_failed"; key: string; error: string }
  | { type: "triage"; scored: number; retakes: number }
  | { type: "retake_done"; key: string; before: number; after: number; kept: boolean }
  | { type: "names_removed"; key: string; names: string[] }
  | { type: "stale_approved"; key: string; refs: string[] };

export interface ArtOptions {
  runDir: string;
  direction?: string;      // the author's art direction for the image model (direction.artist)
  backend: ImageBackend;
  inspector?: Inspector;   // omitted = one shot per image, no review
  maxAttempts?: number;    // per image, default 3
  maxReferences?: number;  // earlier renders passed for continuity, default 3
  maxPortraits?: number;   // character portraits passed per image, default 3 (plus 1 location and 2 props)
  concurrency?: number;    // images rendered at once, default 4
  // Triage: render every shot (and the cover) once, then spend this many
  // retakes per shot on average (0.5 = half a retake each) on the worst-scored
  // first. References keep the full retake loop: every shot depends on them.
  retakes?: number;
  // A cap on triage retakes, e.g. what the budget can buy — a function is asked
  // when triage starts, so it can use what the first pass really cost.
  maxRetakes?: number | (() => number);
  retakeAbove?: number;    // only images scored at least this severity are retaken (default 5)
  force?: boolean;         // re-render even when the prompt is unchanged
  // Images the author signed off on (art.json keys): kept as they are, even
  // when their prompt changes or force is set, and never retaken.
  approved?: ReadonlySet<string>;
  only?: "references";     // render just the reference portraits, places and props
  keys?: string[];         // render just these shots (and the cover, if named); references still load
  // The author's overrides of the story's art style and direction, by key (extras).
  overrides?: Record<string, { style?: string; direction?: string }>;
  redoKeys?: string[];     // render these shots again even if nothing changed (not approved ones)
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
  // Every character's and place's name, for the gate before the image model.
  const names = storyNames(events);
  const outDir = join(opts.runDir, "art");
  await mkdir(outDir, { recursive: true });
  await organizeArt(outDir);
  const manifestPath = join(outDir, "art.json");
  let manifest: ArtManifest = {};
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch { /* first render */ }
  const existing = new Set(await readdir(outDir, { recursive: true }));
  // A new image never destroys the one it replaces: that's kept in
  // art/previous/<key>/<when>.<ext>, so a redo can always be undone.
  const keepPrevious = async (key: string) => {
    const prior = manifest[key];
    if (!prior?.file) return;
    const to = join(outDir, PREVIOUS_DIR, key, `${new Date().toISOString().replace(/[:.]/g, "-")}${extname(prior.file)}`);
    try {
      await mkdir(dirname(to), { recursive: true });
      await rename(join(outDir, prior.file), to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  };
  const maxAttempts = opts.maxAttempts ?? 3;
  const maxReferences = opts.maxReferences ?? 3;
  const emit = opts.onProgress ?? (() => {});

  const maxPortraits = opts.maxPortraits ?? 3;
  // One art style for the whole story, sent with every image request — not left
  // to each prompt to restate.
  const style = storyArtStyle(events);
  const direction = opts.direction?.trim() || undefined;
  const jobs = buildArtJobs(events).map((job) => {
    const o = opts.overrides?.[job.key];
    if (!o || (!o.style?.trim() && !o.direction?.trim())) return job;
    const lookStyle = o.style?.trim() || undefined;
    // The prompt ends with the story's style verbatim: swap in the override.
    const prompt = lookStyle && style && job.prompt.includes(style) ? job.prompt.split(style).join(lookStyle) : lookStyle && !job.prompt.includes(lookStyle) ? `${job.prompt} ${lookStyle}` : job.prompt;
    return { ...job, prompt, ...(lookStyle ? { lookStyle } : {}), ...(o.direction?.trim() ? { lookDirection: o.direction.trim() } : {}) };
  });
  const refs = new Map<string, Image>();       // refKey(kind, id) -> reference image
  // Each scene's first shot is the style anchor for that scene's other shots,
  // so those can render in parallel instead of each waiting for the last.
  const anchors = new Map<number, Image>();    // sceneIndex -> its first shot
  const firstShot = new Map<number, string>(); // sceneIndex -> that shot's key
  for (const j of jobs) if (j.sceneIndex !== undefined && !firstShot.has(j.sceneIndex)) firstShot.set(j.sceneIndex, j.key);
  const isAnchor = (job: ArtJob) => job.sceneIndex !== undefined && firstShot.get(job.sceneIndex) === job.key;
  const shrink = opts.shrink ?? ffmpegShrink;
  const referenceSize = opts.referenceSize ?? 768;
  const inspectSize = opts.inspectSize ?? 1024;
  // Kept images are only ever used as references, so keep the shrunk copy.
  const keep = async (job: ArtJob, image: Image) => {
    const small = await shrink(image, referenceSize);
    if (job.ref) refs.set(refKey(job.ref.kind, job.ref.id), small);
    else if (isAnchor(job)) anchors.set(job.sceneIndex!, small);
  };
  const castIds = new Set(Object.keys(castCharacters(events)));
  const refImages = (kind: VisualRefKind, ids: string[], limit: number): Image[] =>
    ids.flatMap((id) => {
      const img = refs.get(refKey(kind, id));
      const label = kind === "character" && castIds.has(id) ? CAST_PORTRAIT_LABEL : REF_LABEL[kind];
      return img ? [{ ...img, label }] : [];
    }).slice(0, limit);
  // A shot gets the references for what it shows — up to 3 characters, its
  // location, 2 props — then a recent render or two for style. Image models
  // lose track past a handful of references, hence the caps. A reference job
  // gets two earlier references, for style only.
  const referencesFor = async (job: ArtJob): Promise<Image[]> => {
    // Key art reframes the cover: that image is the whole reference.
    if (job.from && manifest[job.from]) return [{ ...(await shrink(await loadImage(join(outDir, manifest[job.from].file)), 2048)), label: REFRAME_LABEL }];
    if (job.ref) {
      // A cast member's portrait is drawn from their photos; a designed character's from the author's drawing.
      const photos = await Promise.all((job.photos ?? []).slice(0, 3).map(async (p) => ({ ...(await shrink(await loadImage(join(opts.runDir, p)), referenceSize)), label: job.design ? AUTHOR_DESIGN_LABEL : CAST_PHOTO_LABEL })));
      // Style: the first reference (rendered on its own first), so references made in parallel still match.
      const anchor = refs.values().next().value as Image | undefined;
      return [...photos, ...(anchor ? [{ ...anchor, label: STYLE_LABEL }] : [])];
    }
    const canon = [
      ...refImages("character", job.characters ?? [], job.maxPortraits ?? maxPortraits),
      ...refImages("location", job.location ? [job.location] : [], 1),
      ...refImages("prop", job.props ?? [], 2)
    ];
    // Style: a shot takes its scene's first shot. A scene's first shot without
    // canon borrows the references, or (a run with none) the previous scene's
    // first shot. The cover takes the latest scene, or several without canon.
    const byScene = [...anchors.entries()].sort((a, b) => a[0] - b[0]);
    const scene = (imgs: Image[]) => imgs.map((img) => ({ ...img, label: SCENE_LABEL }));
    let style: Image[];
    // Extras look most like the story when shown several of its scenes, not just the last.
    // The cover and extras sum up the story: shown several of its scenes, they keep its look.
    if (job.key.startsWith("extra-") || job.key === "cover") style = scene(byScene.slice(-STYLE_SCENES_FOR_EXTRAS).map(([, img]) => img));
    else if (job.sceneIndex === undefined) style = scene(byScene.slice(canon.length > 0 ? -1 : -maxReferences).map(([, img]) => img));
    else if (!isAnchor(job)) style = scene(anchors.has(job.sceneIndex) ? [anchors.get(job.sceneIndex)!] : []);
    else if (canon.length > 0) style = [];
    else if (refs.size > 0) style = [...refs.values()].slice(0, maxReferences).map((img) => ({ ...img, label: STYLE_LABEL }));
    else style = scene(byScene.filter(([i]) => i < job.sceneIndex!).slice(-maxReferences).map(([, img]) => img));
    return [...canon, ...style];
  };
  const result: ArtResult = { outDir, rendered: 0, skipped: 0, failed: 0, manifest };
  // Concurrent images write the manifest one at a time.
  let saving = Promise.resolve();
  const saveManifest = () => (saving = saving.then(() => writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8")));

  const triage = opts.retakes !== undefined && opts.inspector !== undefined;
  const scored = new Map<string, { job: ArtJob; severity: number; retakePrompt?: string }>();
  const one = async (job: ArtJob, index: number) => {
    const prior = manifest[job.key];
    const approved = Boolean(opts.approved?.has(job.key) && prior && existing.has(prior.file));
    // A shot drawn from a reference that has since changed is out of date (a reshoot).
    const changed = !job.ref && prior?.refs ? changedRefs(prior.refs, await refHashes(Object.keys(prior.refs), manifest, outDir)) : [];
    if (approved && changed.length) emit({ type: "stale_approved", key: job.key, refs: changed });
    const redo = opts.redoKeys?.includes(job.key) ?? false;
    if (approved || (!opts.force && !redo && changed.length === 0 && prior && prior.prompt === job.prompt && prior.style === (job.lookStyle ?? style) && prior.direction === (job.lookDirection ?? direction) && prior.photos === job.photoKey && existing.has(prior.file))) {
      // Same image, but keep its placement current in case the shot's anchor moved.
      prior.sceneIndex = job.sceneIndex;
      prior.startParagraph = job.startParagraph;
      // A shot made before inputs were recorded takes today's references as its baseline.
      if (!job.ref && !prior.refs) { prior.refs = await shotInputs(job, manifest, outDir, maxPortraits); await saveManifest(); }
      emit({ type: "job_skipped", key: job.key, file: prior.file });
      await keep(job, { data: await readFile(join(outDir, prior.file)), mimeType: mimeFor(prior.file) });
      result.skipped++;
      return;
    }
    emit({ type: "job_start", key: job.key, index, total: jobs.length });
    const references = await referencesFor(job);
    try {
      const forInspection = (img: Image) => shrink(img, inspectSize);
      const entry = await renderOne(job, references, opts.backend, opts.inspector, triage && !job.ref ? 1 : maxAttempts, emit, job.lookStyle ?? style, forInspection, job.lookDirection ?? direction, names);
      if (triage && !job.ref && entry.severity !== undefined) scored.set(job.key, { job, severity: entry.severity, ...(entry.retakePrompt ? { retakePrompt: entry.retakePrompt } : {}) });
      const file = artFile(job.key, extensionFor(entry.image.mimeType));
      await keepPrevious(job.key);
      await mkdir(dirname(join(outDir, file)), { recursive: true });
      await writeFile(join(outDir, file), entry.image.data);
      manifest[job.key] = {
        file,
        sceneIndex: job.sceneIndex,
        startParagraph: job.startParagraph,
        ...(job.ref ? { refKind: job.ref.kind, refId: job.ref.id } : {}),
        prompt: job.prompt,
        finalPrompt: entry.finalPrompt,
        ...((job.lookStyle ?? style) ? { style: job.lookStyle ?? style } : {}),
        ...((job.lookDirection ?? direction) ? { direction: job.lookDirection ?? direction } : {}),
        ...(job.photoKey ? { photos: job.photoKey } : {}),
        ...(job.ref ? {} : { refs: await shotInputs(job, manifest, outDir, maxPortraits) }),
        attempts: entry.attempts,
        accepted: entry.accepted,
        issues: entry.issues,
        ...(entry.severity !== undefined ? { severity: entry.severity } : {})
      };
      // Persist after every image so an interrupted render resumes where it stopped.
      await saveManifest();
      await keep(job, entry.image);
      result.rendered++;
      emit({ type: "job_done", key: job.key, file, attempts: entry.attempts, accepted: entry.accepted });
    } catch (err) {
      if (isBudgetError(err)) throw err;
      result.failed++;
      emit({ type: "job_failed", key: job.key, error: err instanceof Error ? err.message : String(err) });
    }
  };

  // References first (every shot uses them), then each scene's first shot (the
  // anchors), then every other shot, then the cover — each stage in parallel.
  // A preview or a reshoot: just the named shots. References always go through
  // (approved and finished ones are only loaded), so the shots get them.
  const picked = opts.keys ? new Set(opts.keys) : undefined;
  // With keys, a reference renders only if a named shot uses it (finished ones still load).
  const needed = new Set(jobs.filter((j) => picked?.has(j.key)).flatMap((j) => [...(j.characters ?? []).map((id) => `character-${id}`), ...(j.location ? [`location-${j.location}`] : []), ...(j.props ?? []).map((id) => `prop-${id}`)]));
  // Extras render only when asked for by key (the extras phase), with its overrides.
  const indexed = jobs.map((job, index) => ({ job, index })).filter(({ job }) => (picked ? picked.has(job.key) || (job.ref && (needed.has(job.key) || Boolean(manifest[job.key]))) : !job.key.startsWith("extra-")));
  const refJobs = indexed.filter(({ job }) => job.ref);
  const stages = [
    refJobs.slice(0, 1),
    refJobs.slice(1),
    ...(opts.only === "references" ? [] : [
      indexed.filter(({ job }) => isAnchor(job)),
      indexed.filter(({ job }) => !job.ref && !isAnchor(job) && job.sceneIndex !== undefined),
      indexed.filter(({ job }) => !job.ref && job.sceneIndex === undefined && !job.from),
      // Drawn from another image (key art from the cover): after it.
      indexed.filter(({ job }) => job.from)
    ])
  ];
  // A run with no references chains each scene's first shot to the one before
  // (as it always did), so those render one at a time.
  for (const [n, stage] of stages.entries()) {
    const limit = n === 2 && refs.size === 0 ? 1 : opts.concurrency ?? 4;
    await inParallel(stage, limit, ({ job, index }) => one(job, index));
  }
  if (triage) await triageRetakes();
  await saveManifest();
  return result;

  // Retakes go to the worst images first; a retake is kept only if it scores better.
  async function triageRetakes() {
    const share = Math.max(0, opts.retakes ?? 0);
    const cap = typeof opts.maxRetakes === "function" ? opts.maxRetakes() : opts.maxRetakes;
    const allowed = Math.min(Math.round(share * scored.size), cap ?? Infinity);
    const worst = [...scored.values()].filter((s) => s.severity >= (opts.retakeAbove ?? 5)).sort((a, b) => b.severity - a.severity).slice(0, allowed);
    emit({ type: "triage", scored: scored.size, retakes: worst.length });
    await inParallel(worst, opts.concurrency ?? 4, async ({ job, severity, retakePrompt }) => {
      try {
        const references = await referencesFor(job);
        const again = await renderOne({ ...job, prompt: retakePrompt ?? job.prompt }, references, opts.backend, opts.inspector, 1, emit, job.lookStyle ?? style, (img) => shrink(img, inspectSize), job.lookDirection ?? direction, names);
        const after = again.severity ?? severity;
        const kept = after < severity;
        if (kept) {
          const file = artFile(job.key, extensionFor(again.image.mimeType));
          await keepPrevious(job.key);
          await mkdir(dirname(join(outDir, file)), { recursive: true });
          await writeFile(join(outDir, file), again.image.data);
          const prior = manifest[job.key];
          manifest[job.key] = { ...prior, file, finalPrompt: again.finalPrompt, attempts: (prior?.attempts ?? 1) + 1, accepted: again.accepted, issues: again.issues, severity: after, retaken: true };
          await saveManifest();
        } else {
          manifest[job.key] = { ...manifest[job.key], attempts: (manifest[job.key]?.attempts ?? 1) + 1 };
        }
        emit({ type: "retake_done", key: job.key, before: severity, after, kept });
      } catch (err) {
        if (isBudgetError(err)) throw err;
        emit({ type: "job_failed", key: job.key, error: `retake: ${err instanceof Error ? err.message : String(err)}` });
      }
    });
  }
}

// Runs fn over items, at most `limit` at a time. A budget stop ends the run;
// other failures are fn's to handle.
export async function inParallel<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

// Generate → inspect → regenerate with a revised prompt, up to maxAttempts.
// If every attempt is rejected the last image is kept (accepted: false) so the
// video still has a frame; the manifest records why.
export async function renderOne(
  job: ArtJob,
  references: Image[],
  backend: ImageBackend,
  inspector: Inspector | undefined,
  maxAttempts: number,
  emit: (event: ArtProgress) => void,
  style?: string,
  forInspection: (img: Image) => Promise<Image> = async (img) => img,
  direction?: string,
  names: Array<StoryName | string> = []
): Promise<{ image: Image; finalPrompt: string; attempts: number; accepted: boolean; issues: string[]; severity?: number; retakePrompt?: string }> {
  let prompt = job.prompt;
  let image: Image | undefined;
  let issues: string[] = [];
  let severity: number | undefined;
  let retakePrompt: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // A failed generation (timeout, blocked or empty reply) uses up an attempt rather than the whole image.
    try {
      // The last gate before the image model: no names, ever (see stripNames).
      const gated = stripNames(prompt, names);
      if (gated.removed.length) emit({ type: "names_removed", key: job.key, names: gated.removed });
      image = await backend.generate({ prompt: gated.text, references, ...(style ? { style } : {}), ...(direction ? { direction } : {}), ...(job.ref ? { aspectRatio: REF_ASPECT[job.ref.kind] } : job.aspectRatio ? { aspectRatio: job.aspectRatio } : {}), ...(job.imageSize ? { imageSize: job.imageSize } : {}) });
    } catch (err) {
      if (isBudgetError(err)) throw err;
      issues = [`generation failed: ${err instanceof Error ? err.message : String(err)}`];
      emit({ type: "attempt_rejected", key: job.key, attempt, issues });
      if (attempt === maxAttempts && !image) throw err;
      continue;
    }
    if (!inspector) return { image, finalPrompt: prompt, attempts: attempt, accepted: true, issues: [] };
    const verdict = await inspector.inspect({ prompt, image: await forInspection(image), references, ...(style ? { style } : {}), ...(direction ? { direction } : {}) });
    severity = verdict.severity;
    if (verdict.ok) return { image, finalPrompt: prompt, attempts: attempt, accepted: true, issues: [], ...(severity !== undefined ? { severity } : {}) };
    issues = verdict.issues;
    emit({ type: "attempt_rejected", key: job.key, attempt, issues });
    retakePrompt = retakeFor(job.prompt, verdict.revisedPrompt, issues);
    if (attempt < maxAttempts) prompt = retakePrompt;
  }
  return { image: image!, finalPrompt: prompt, attempts: maxAttempts, accepted: false, issues, ...(severity !== undefined ? { severity } : {}), ...(retakePrompt ? { retakePrompt } : {}) };
}

// Names never reach the image model: it draws toward any name it reads, even in
// "not resembling X". A rejection for a real-person likeness names the person,
// so the retake prompt is checked for every name the issues mention: a revised
// prompt that repeats one is thrown out, and issues go in with names removed.
const NAME = /\b[A-Z][a-z'’-]+(?:\s+(?:[A-Z][a-z'’-]+|[a-z]{1,3}))*\s+[A-Z][a-z'’-]+\b/g;
export function namesIn(issues: string[]): string[] {
  return [...new Set(issues.flatMap((i) => i.match(NAME) ?? []))];
}
const ORIGINAL_FACE = "Every face is entirely original: an ordinary, distinctive person who resembles no actor, celebrity or real person.";
export function retakeFor(original: string, revised: string | undefined, issues: string[]): string {
  const names = namesIn(issues);
  const named = (text: string) => names.some((n) => text.includes(n)) || /\b(actor|actress|celebrity)\b/i.test(text) && names.length > 0;
  if (revised?.trim() && !named(revised)) return revised.trim();
  const clean = issues.map((i) => (names.some((n) => i.includes(n)) ? "A face resembled a real person." : i));
  const lookalike = clean.length !== issues.filter((i) => !names.some((n) => i.includes(n))).length;
  return [
    original,
    `Fix these problems from the previous attempt:\n${clean.map((i) => `- ${i}`).join("\n")}`,
    ...(lookalike ? [ORIGINAL_FACE] : [])
  ].join("\n\n");
}

// A name is no use to an image model: it can only guess a face from it, or
// reach for a real person who shares it. Every prompt is checked right before
// it goes out, whatever wrote it (the art director, the inspector's rewrite, a
// retake): the story's character and place names come out, and so does any
// real person named as an actor or celebrity, or after "resembling".
const NAME_STOPWORDS = new Set(["Unknown", "Woman", "Man", "Elf", "Half-Orc", "Orc", "Student", "Mathematics", "University", "From", "Of", "The", "And", "Troll", "Los", "Prados", "Gnacien"]);
export interface StoryName { name: string; kind: "person" | "place" }
export function storyNames(events: StoryEvent[]): StoryName[] {
  const bible = replay(events);
  const out = new Map<string, StoryName["kind"]>();
  for (const c of Object.values(bible.characters)) {
    if (/^unknown\b/i.test(c.name)) continue;
    const words = c.name.split(/\s+/).filter(Boolean);
    if (!words.every((w) => NAME_STOPWORDS.has(w))) out.set(c.name, "person");
    // A first or last name alone ("Liam", "McPoyle") is a name too.
    if (words.length > 1) for (const w of words) if (/^[A-Z]/.test(w) && w.length >= 3 && !NAME_STOPWORDS.has(w)) out.set(w, "person");
  }
  for (const l of Object.values(bible.locations)) if (/^[A-Z]/.test(l.name)) out.set(l.name.replace(/^The\s+/, ""), "place");
  return [...out].map(([name, kind]) => ({ name, kind })).sort((a, b) => b.name.length - a.name.length);
}

const REAL_PERSON = /\b(?:(?:strictly\s+)?not\s+)?(?:resembl\w*|look(?:s|ing)?\s+like|lookalike\s+of|(?:real\s+)?(?:actor|actress|celebrity))\s+(?:(?:real\s+)?(?:actor|actress|celebrity)\s+)?[A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+)+/g;
export function stripNames(text: string, names: Array<StoryName | string>): { text: string; removed: string[] } {
  const removed: string[] = [];
  let out = text.replace(REAL_PERSON, (m) => { removed.push(m); return "with an original face"; });
  for (const entry of names) {
    const { name, kind } = typeof entry === "string" ? { name: entry, kind: "person" as const } : entry;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(\\b[Tt]he\\s+)?\\b${escaped}(['’]s)?\\b`, "g");
    out = out.replace(re, (m: string, _the: string | undefined, poss: string | undefined) => {
      removed.push(m.replace(/^the\s+/i, ""));
      if (poss) return kind === "place" ? "the place's" : "their";
      return kind === "place" ? "the place" : "the figure";
    });
  }
  return { text: out.replace(/[ \t]{2,}/g, " "), removed: [...new Set(removed)] };
}

// ---- Gemini ----

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

type GeminiPart = { text: string } | { inline_data: { mime_type: string; data: string } };

function imagePart(img: Image): GeminiPart {
  return { inline_data: { mime_type: img.mimeType, data: img.data.toString("base64") } };
}

// With several images in flight a rate limit (429) is likely: wait it out
// (about two minutes in all) rather than lose the image.
const RATE_LIMIT_WAITS_MS = [10000, 20000, 30000, 60000];

async function geminiGenerate(spec: GeminiSpec, role: string, body: unknown, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<any> {
  const headers = { "x-goog-api-key": requireKey(spec.apiKeyEnv || "GEMINI_API_KEY") };
  const url = `${spec.baseUrl || GEMINI_BASE}/models/${spec.model}:generateContent`;
  for (let wait = 0; ; wait++) {
    try {
      return await postJson(url, headers, body, { type: "gemini", model: spec.model, role, timeoutMs: spec.timeoutMs, retries: spec.retries });
    } catch (err) {
      if (isBudgetError(err) || !/\b429\b|RESOURCE_EXHAUSTED/.test(err instanceof Error ? err.message : String(err)) || wait >= RATE_LIMIT_WAITS_MS.length) throw err;
      console.error(`[scriptorium]   ${role}: rate limit — waiting ${RATE_LIMIT_WAITS_MS[wait] / 1000}s`);
      await sleep(RATE_LIMIT_WAITS_MS[wait]);
    }
  }
}

// One image request body, and the image out of its response (live or batch).
export function imageRequest(spec: GeminiSpec, { prompt, references, aspectRatio, imageSize, style, direction }: ImageRequest): Record<string, unknown> {
  const parts: GeminiPart[] = [];
  if (style) parts.push({ text: `ART STYLE — every image of this story uses exactly this style; render in it regardless of the references' subjects: ${style}` });
  if (direction) parts.push({ text: `AUTHOR ART DIRECTION — applies to every image; follow it exactly: ${direction}` });
  for (const ref of references) {
    parts.push({ text: ref.label ?? SCENE_LABEL });
    parts.push(imagePart(ref));
  }
  parts.push({ text: references.length > 0 || style ? `Now generate this image:\n${prompt}` : prompt });
  return {
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: aspectRatio ?? spec.aspectRatio ?? "16:9", ...(imageSize ? { imageSize } : {}) }
    }
  };
}

export function imageFrom(data: any): Image {
  const candidate = data?.candidates?.[0];
  for (const p of candidate?.content?.parts ?? []) {
    const inline = p.inlineData ?? p.inline_data;
    if (inline?.data) {
      return { data: Buffer.from(inline.data, "base64"), mimeType: inline.mimeType ?? inline.mime_type ?? "image/png" };
    }
  }
  const reason = candidate?.finishReason ?? data?.promptFeedback?.blockReason ?? "no candidates";
  throw new Error(`Gemini returned no image (${reason})`);
}

export class GeminiImageBackend implements ImageBackend {
  spec: GeminiSpec;
  constructor(spec: GeminiSpec) { this.spec = spec; }

  async generate(req: ImageRequest): Promise<Image> {
    return imageFrom(await geminiGenerate(this.spec, "artist", imageRequest(this.spec, req)));
  }
}

// Images through Batch Mode: the generations a stage asks for together go out as
// one batch job at half price; retakes asked for while it runs form the next.
export class BatchImageBackend implements ImageBackend {
  private send: (req: ImageRequest) => Promise<Image>;
  constructor(spec: GeminiSpec, jobs: BatchJobs) {
    this.send = microBatcher<ImageRequest, Image>(async (reqs) => {
      const items = await jobs.run(spec.model, "artist", reqs.map((r) => imageRequest(spec, r)));
      return items.map((item) => {
        try { return item.response ? imageFrom(item.response) : new Error(`batch: ${item.error}`); } catch (err) { return err as Error; }
      });
    });
  }
  generate(req: ImageRequest): Promise<Image> { return this.send(req); }
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
      const kind = ref.label === PORTRAIT_LABEL ? "CHARACTER PORTRAIT"
        : ref.label === CAST_PORTRAIT_LABEL ? "CHARACTER PORTRAIT — CAST MEMBER (a real person; likeness intended)"
        : ref.label === CAST_PHOTO_LABEL ? "REAL PHOTO of the cast member this portrait must depict"
        : ref.label === AUTHOR_DESIGN_LABEL ? "AUTHOR'S DESIGN — the author's drawing of this character; the portrait must follow it (not a real person)"
        : ref.label === LOCATION_LABEL ? "LOCATION" : ref.label === PROP_LABEL ? "PROP" : "art style only";
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
  const r = (raw ?? {}) as { ok?: unknown; issues?: unknown; revised_prompt?: unknown; severity?: unknown };
  const issues = Array.isArray(r.issues) ? r.issues.map(String).filter(Boolean) : [];
  const n = Number(r.severity);
  return {
    ok: r.ok === true,
    // A missing score is guessed from the verdict, so triage always has a number.
    severity: Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : r.ok === true ? 0 : 5,
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
      return { ok: false, severity: 6, issues: ["mock: subject missing"], revisedPrompt: `${base}\n\nREVISED: ${n + 1}` };
    }
    return { ok: true, severity: 0, issues: [] };
  }
}

// ---- casting: describe a cast member from their photos ----

export class GeminiCastDescriber implements CastDescriber {
  spec: GeminiSpec;
  constructor(spec: GeminiSpec) { this.spec = spec; }

  async describe(member: { name: string; notes?: string }, photos: Image[]) {
    const parts: GeminiPart[] = [{ text: `Describe this ${member.notes ? `cast member (author's note: ${member.notes})` : "cast member"} from ${photos.length === 1 ? "this photo" : `these ${photos.length} photos of the same subject`}.` }];
    for (const p of photos) parts.push(imagePart(p));
    const data = await geminiGenerate(this.spec, "casting", {
      systemInstruction: { parts: [{ text: CAST_SYSTEM }] },
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
    });
    const text = (data.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
    return toCastDescription(parseJson(text));
  }
}

export class MockCastDescriber implements CastDescriber {
  calls: { name: string; photos: number }[] = [];
  async describe(member: { name: string }, photos: Image[]) {
    this.calls.push({ name: member.name, photos: photos.length });
    return { kind: "person" as const, appearance: `${member.name}: mock appearance from ${photos.length} photo(s).` };
  }
}

// Casting uses the inspector's vision model (or Gemini's default one).
export function makeCastDescriber(config: ArtistConfig): CastDescriber {
  const spec = config.inspector ?? DEFAULT_ARTIST_CONFIG.inspector!;
  if (spec.type === "mock") return new MockCastDescriber();
  if (spec.type === "gemini") return new GeminiCastDescriber(spec);
  throw new Error(`Unknown casting backend type: ${(spec as { type: string }).type}`);
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
