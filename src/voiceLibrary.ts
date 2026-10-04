import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { postJson, requireKey } from "./providers.ts";

// Gemini's voice library: hundreds of voices per language with Google's own
// casting metadata (gender, pitch, accent, persona, a description). Listing it
// is free — it isn't speech generation — and is cached on disk for a week.
// Designed voices (a description -> a persistent voice_ id) live here too.

const BASE = "https://generativelanguage.googleapis.com/v1beta";

export interface LibraryVoice {
  id: string;
  type: string;            // prebuilt | prompted | replicated
  display_name?: string;
  language_code: string;
  region_code?: string;
  accent?: string;
  persona?: string;
  context?: string;
  gender?: string;         // female | male | neutral
  pitch?: string;          // low | medium | high
  description?: string;
}

// English regions the library offers (the API pages at 1,000 voices, so each
// region is fetched on its own).
export const LIBRARY_LANGUAGES: Record<string, string[]> = {
  en: ["en-US", "en-GB", "en-IE", "en-CA", "en-AU", "en-NZ", "en-ZA", "en-IN"]
};

type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function fetchLibrary(language: string, opts: { apiKey?: string; cacheDir?: string; maxAgeMs?: number; fetch?: Fetch; now?: number } = {}): Promise<LibraryVoice[]> {
  const cacheDir = opts.cacheDir ?? join(homedir(), ".cache", "scriptorium");
  const cacheFile = join(cacheDir, `gemini-voices-${language}.json`);
  const now = opts.now ?? Date.now();
  try {
    const cached = JSON.parse(await readFile(cacheFile, "utf8")) as { fetchedAt: number; voices: LibraryVoice[] };
    if (now - cached.fetchedAt < (opts.maxAgeMs ?? 7 * 24 * 3600 * 1000) && cached.voices.length > 0) return cached.voices;
  } catch { /* no cache yet */ }
  const key = opts.apiKey ?? requireKey("GEMINI_API_KEY");
  const get = opts.fetch ?? (fetch as unknown as Fetch);
  const byId = new Map<string, LibraryVoice>();
  for (const code of LIBRARY_LANGUAGES[language] ?? [language]) {
    let token: string | undefined;
    do {
      const url = `${BASE}/voices?page_size=1000&language_code=${encodeURIComponent(code)}${token ? `&page_token=${encodeURIComponent(token)}` : ""}`;
      const res = await get(url, { headers: { "x-goog-api-key": key } });
      if (!res.ok) throw new Error(`voice library: HTTP ${res.status} listing ${code}`);
      const d = (await res.json()) as { voices?: LibraryVoice[]; nextPageToken?: string };
      for (const v of d.voices ?? []) byId.set(v.id, v);
      token = d.nextPageToken;
    } while (token);
  }
  const voices = [...byId.values()];
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cacheFile, JSON.stringify({ fetchedAt: now, voices }) + "\n");
  return voices;
}

// Designs a voice from a description; returns its persistent voice_ id and a WAV preview.
export async function designVoice(spec: { name: string; description: string; languageCode?: string; model?: string; apiKey?: string }): Promise<{ id: string; preview?: Buffer }> {
  const key = spec.apiKey ?? requireKey("GEMINI_API_KEY");
  const model = spec.model ?? "gemini-3.8-flash-tts";
  const data = await postJson(`${BASE}/voices`, { "x-goog-api-key": key }, {
    store: true,
    voice: { type: "prompted", display_name: spec.name, language_code: spec.languageCode ?? "en-US", model: `models/${model}`, prompted: { input: spec.description } }
  }, { type: "gemini", model, role: "voicedesign", timeoutMs: 120000 });
  const id = (data as { id?: string }).id;
  if (!id) throw new Error(`voice design returned no id: ${JSON.stringify(data).slice(0, 200)}`);
  // The preview comes back as the voice's sample_audio (top level).
  const d = data as { sample_audio?: { data?: string }; prompted?: { sample_audio?: { data?: string } } };
  const audio = d.sample_audio?.data ?? d.prompted?.sample_audio?.data;
  return { id, ...(audio ? { preview: Buffer.from(audio, "base64") } : {}) };
}

// One compact line per voice, for a casting prompt.
export function voiceLine(v: LibraryVoice): string {
  return `${v.id} | ${v.gender ?? "?"} | pitch ${v.pitch ?? "?"} | ${v.accent ?? v.language_code} | ${v.persona ?? ""} | ${(v.description ?? "").replace(/\s+/g, " ").slice(0, 160)}`;
}
