import { postJson, requireKey } from "./providers.ts";
import { parseJson } from "./roles.ts";
import { CAST_SYSTEM, toCastDescription } from "./cast.ts";
import type { CastDescriber } from "./cast.ts";
import type { Image, ImageBackend, ImageRequest, Inspection, InspectRequest, Inspector } from "./artist.ts";
import type { OpenAIArtSpec } from "./types.ts";

// OpenAI as the artist (#89): GPT Image renders, a GPT vision model inspects.
// Same seams as Gemini — chosen by the config's artist block, so one story can
// mix an OpenAI artist with any writer.

const OPENAI_BASE = "https://api.openai.com/v1";
// The edits endpoint takes at most this many reference images.
export const OPENAI_MAX_REFERENCES = 4;

const headers = (spec: OpenAIArtSpec) => ({ authorization: `Bearer ${requireKey(spec.apiKeyEnv || "OPENAI_API_KEY")}` });
const dataUrl = (img: Image) => `data:${img.mimeType};base64,${img.data.toString("base64")}`;

// Our aspect ratios as GPT Image sizes: multiples of 16, no edge over 3840.
const SIZES: Record<string, Record<string, string>> = {
  "1K": { "16:9": "1536x864", "9:16": "864x1536", "3:2": "1536x1024", "2:3": "1024x1536", "4:3": "1280x960", "3:4": "960x1280", "1:1": "1024x1024" },
  "2K": { "16:9": "2048x1152", "9:16": "1152x2048", "3:2": "2016x1344", "2:3": "1344x2016", "4:3": "2048x1536", "3:4": "1536x2048", "1:1": "2048x2048" },
  "4K": { "16:9": "3840x2160", "9:16": "2160x3840", "3:2": "3840x2560", "2:3": "2560x3840", "4:3": "3840x2880", "3:4": "2880x3840", "1:1": "3840x3840" }
};
export function openaiSize(aspectRatio = "16:9", imageSize = "1K"): string {
  return SIZES[imageSize]?.[aspectRatio] ?? SIZES["1K"][aspectRatio] ?? "1536x1024";
}

// The prompt GPT Image gets: the edits endpoint takes one prompt and a list of
// images, so what each reference is for is spelled out by its number.
export function openaiImagePrompt(req: ImageRequest, refs: Image[]): string {
  return [
    req.style ? `ART STYLE — render in exactly this style, regardless of the references' subjects: ${req.style}` : "",
    req.direction ? `AUTHOR ART DIRECTION — follow it exactly: ${req.direction}` : "",
    refs.length ? `REFERENCE IMAGES, in order:\n${refs.map((r, i) => `${i + 1}. ${r.label ?? "Reference for this scene."}`).join("\n")}` : "",
    refs.length || req.style ? `Now generate this image:\n${req.prompt}` : req.prompt
  ].filter(Boolean).join("\n\n");
}

export class OpenAIImageBackend implements ImageBackend {
  spec: OpenAIArtSpec;
  onDropped?: (count: number) => void;
  constructor(spec: OpenAIArtSpec, onDropped?: (count: number) => void) { this.spec = spec; this.onDropped = onDropped; }

  async generate(req: ImageRequest): Promise<Image> {
    const refs = req.references.slice(0, OPENAI_MAX_REFERENCES);
    if (req.references.length > refs.length) this.onDropped?.(req.references.length - refs.length);
    const base = this.spec.baseUrl || OPENAI_BASE;
    const body: Record<string, unknown> = {
      model: this.spec.model,
      prompt: openaiImagePrompt(req, refs),
      size: openaiSize(req.aspectRatio ?? this.spec.aspectRatio, req.imageSize),
      quality: this.spec.quality ?? "high",
      output_format: "jpeg",
      n: 1,
      ...(this.spec.moderation ? { moderation: this.spec.moderation } : {}),
      ...(refs.length ? { images: refs.map((r) => ({ image_url: dataUrl(r) })) } : {})
    };
    const url = `${base}/images/${refs.length ? "edits" : "generations"}`;
    const data = await postJson(url, headers(this.spec), body, { type: "openai", model: this.spec.model, role: "artist", timeoutMs: this.spec.timeoutMs ?? 300000, retries: this.spec.retries });
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) throw new Error(`GPT Image returned no image${data?.error?.message ? ` (${data.error.message})` : ""}`);
    return { data: Buffer.from(b64, "base64"), mimeType: "image/jpeg" };
  }
}

// One vision call: text, then images, JSON back.
async function openaiVision(spec: OpenAIArtSpec, role: string, system: string, parts: Array<{ text: string } | { image: Image }>): Promise<string> {
  const content = parts.map((p) => ("text" in p ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: dataUrl(p.image) } }));
  const data = await postJson(`${spec.baseUrl || OPENAI_BASE}/chat/completions`, headers(spec), {
    model: spec.model,
    messages: [{ role: "system", content: system }, { role: "user", content }],
    response_format: { type: "json_object" },
    ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {})
  }, { type: "openai", model: spec.model, role, timeoutMs: spec.timeoutMs ?? 120000, retries: spec.retries });
  const msg = data?.choices?.[0]?.message?.content;
  return Array.isArray(msg) ? msg.map((p: { text?: string }) => p.text ?? "").join("") : String(msg ?? "");
}

export class OpenAIInspector implements Inspector {
  spec: OpenAIArtSpec;
  system: string;
  toInspection: (raw: unknown) => Inspection;
  labels: (ref: Image) => string;
  constructor(spec: OpenAIArtSpec, o: { system: string; toInspection: (raw: unknown) => Inspection; labels: (ref: Image) => string }) {
    this.spec = spec; this.system = o.system; this.toInspection = o.toInspection; this.labels = o.labels;
  }

  async inspect({ prompt, image, references, style, direction }: InspectRequest): Promise<Inspection> {
    const parts: Array<{ text: string } | { image: Image }> = [{ text: `PROMPT:\n${prompt}` }];
    if (style) parts.push({ text: `ART STYLE:\n${style}` });
    if (direction) parts.push({ text: `AUTHOR DIRECTION:\n${direction}` });
    parts.push({ text: "CANDIDATE IMAGE:" }, { image });
    for (const ref of references) parts.push({ text: `REFERENCE IMAGE — ${this.labels(ref)}:` }, { image: ref });
    return this.toInspection(parseJson(await openaiVision(this.spec, "inspector", this.system, parts)));
  }
}

export class OpenAICastDescriber implements CastDescriber {
  spec: OpenAIArtSpec;
  constructor(spec: OpenAIArtSpec) { this.spec = spec; }
  async describe(member: { name: string; notes?: string }, photos: Image[]) {
    const parts: Array<{ text: string } | { image: Image }> = [{ text: `Describe this ${member.notes ? `cast member (author's note: ${member.notes})` : "cast member"} from ${photos.length === 1 ? "this photo" : `these ${photos.length} photos of the same subject`}.` }];
    for (const p of photos) parts.push({ image: p });
    return toCastDescription(parseJson(await openaiVision(this.spec, "casting", CAST_SYSTEM, parts)));
  }
}
