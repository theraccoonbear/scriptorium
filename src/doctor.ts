import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { DEFAULT_ARTIST_CONFIG, resolveArtistConfig } from "./artist.ts";
import { keyTail } from "./env.ts";
import { DEFAULT_GEMINI_TTS_MODEL } from "./geminiTts.ts";
import { MUSIC_DEFAULTS } from "./music.ts";
import type { ResolvedStory } from "./make.ts";
import type { ArtistBackendSpec, ProviderSpec } from "./types.ts";

// `scriptorium doctor`: what this machine can make, from its API keys and
// tools, without spending anything. Each key is checked with a free call (its
// service's model list), never a generation, and each model the pipeline uses
// is looked for in that list. With a story file, also whether that story can run.

export type Mark = "ok" | "no" | "unset";  // ✓ ready, ✗ broken or missing, ○ not set up (or optional)
export interface Row { label: string; mark: Mark; detail: string }

export interface DoctorDeps {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  has: (cmd: string, args: string[]) => Promise<boolean>;  // the command runs and exits 0
  resolves: (pkg: string) => boolean;                      // the npm package is installed
}

export const KEYS = {
  anthropic: { env: "ANTHROPIC_API_KEY", name: "Anthropic (Claude)", where: "https://console.anthropic.com/settings/keys" },
  gemini: { env: "GEMINI_API_KEY", name: "Google Gemini", where: "https://aistudio.google.com/apikey" },
  openai: { env: "OPENAI_API_KEY", name: "OpenAI", where: "https://platform.openai.com/api-keys" },
  opencode: { env: "OPENCODE_API_KEY", name: "OpenCode Go", where: "https://opencode.ai" }
} as const;
export type KeyName = keyof typeof KEYS;

export interface KeyState { set: boolean; valid?: boolean; models?: Set<string>; error?: string; tail?: string }  // tail: the key's last four characters, to say which key

// Each service's free model list: the URL, the auth headers and the model ids in the reply.
const LISTS: Record<KeyName, { url: string; headers: (key: string) => Record<string, string>; ids: (body: any) => string[] }> = {
  anthropic: { url: "https://api.anthropic.com/v1/models?limit=1000", headers: (k) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }), ids: (b) => (b.data ?? []).map((m: { id: string }) => m.id) },
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", headers: (k) => ({ "x-goog-api-key": k }), ids: (b) => (b.models ?? []).map((m: { name: string }) => m.name.replace(/^models\//, "")) },
  openai: { url: "https://api.openai.com/v1/models", headers: (k) => ({ authorization: `Bearer ${k}` }), ids: (b) => (b.data ?? []).map((m: { id: string }) => m.id) },
  opencode: { url: "https://opencode.ai/zen/go/v1/models", headers: (k) => ({ authorization: `Bearer ${k}` }), ids: (b) => (b.data ?? []).map((m: { id: string }) => m.id) }
};

export async function checkKey(deps: DoctorDeps, name: KeyName, envName: string = KEYS[name].env): Promise<KeyState> {
  const key = deps.env[envName]?.trim();
  if (!key) return { set: false };
  const list = LISTS[name];
  const tail = keyTail(key);
  try {
    const res = await deps.fetch(list.url, { headers: list.headers(key) });
    if (res.status === 400 || res.status === 401 || res.status === 403) return { set: true, tail, valid: false, error: "the key was rejected" };
    if (!res.ok) return { set: true, tail, error: `HTTP ${res.status} from the service` };
    return { set: true, tail, valid: true, models: new Set(list.ids(await res.json())) };
  } catch (err) {
    return { set: true, tail, error: `couldn't reach the service (${(err as Error).message})` };
  }
}

export interface Findings {
  keys: Record<KeyName, KeyState>;
  tools: { ffmpeg: boolean; ffprobe: boolean; magick: boolean; fcMatch: boolean; kokoro: boolean };
}

export async function investigate(deps: DoctorDeps): Promise<Findings> {
  const names = Object.keys(KEYS) as KeyName[];
  const states = await Promise.all(names.map((n) => checkKey(deps, n)));
  const [ffmpeg, ffprobe, magick, fcMatch] = await Promise.all([
    deps.has("ffmpeg", ["-version"]), deps.has("ffprobe", ["-version"]), deps.has("magick", ["-version"]), deps.has("fc-match", ["--version"])
  ]);
  return {
    keys: Object.fromEntries(names.map((n, i) => [n, states[i]])) as Record<KeyName, KeyState>,
    tools: { ffmpeg, ffprobe, magick, fcMatch, kokoro: deps.resolves("kokoro-js") && deps.resolves("@huggingface/transformers") }
  };
}

// A capability served by a model on a key: ✓ when the key works and lists the model.
function modelRow(label: string, key: KeyName, state: KeyState, model: string): Row {
  if (!state.set) return { label, mark: "unset", detail: `needs ${KEYS[key].env}` };
  if (!state.valid) return { label, mark: "no", detail: `${KEYS[key].env}: ${state.error ?? "not working"}` };
  if (!state.models?.has(model)) return { label, mark: "no", detail: `${model} isn't available to ${KEYS[key].env} ${state.tail ?? ""}` };
  return { label, mark: "ok", detail: `${model} (${KEYS[key].env} ${state.tail ?? ""})` };
}

function keyRow(label: string, key: KeyName, state: KeyState): Row {
  if (!state.set) return { label, mark: "unset", detail: `needs ${KEYS[key].env}` };
  if (!state.valid) return { label, mark: "no", detail: `${KEYS[key].env} ${state.tail ?? ""}: ${state.error ?? "not working"}` };
  return { label, mark: "ok", detail: `${KEYS[key].env} ${state.tail ?? ""} works (${state.models?.size ?? 0} models; from .env)` };
}

// What this machine can make, whatever the story.
export function capabilities(f: Findings): Row[] {
  const { keys, tools } = f;
  const image = (DEFAULT_ARTIST_CONFIG.image as { model: string }).model;
  const inspector = (DEFAULT_ARTIST_CONFIG.inspector as { model: string }).model;
  const rows: Row[] = [keyRow("Story & writing (Claude)", "anthropic", keys.anthropic)];
  // Other writing backends only when the author has a key for them.
  if (keys.openai.set) rows.push(keyRow("Story & writing (OpenAI)", "openai", keys.openai));
  if (keys.opencode.set) rows.push(keyRow("Story & writing (OpenCode Go)", "opencode", keys.opencode));
  rows.push(
    modelRow("Images (Gemini)", "gemini", keys.gemini, image),
    modelRow("Image checks & cast photos (Gemini)", "gemini", keys.gemini, inspector),
    modelRow("Voices, acted (Gemini TTS)", "gemini", keys.gemini, DEFAULT_GEMINI_TTS_MODEL),
    tools.kokoro ? { label: "Voices, local (Kokoro)", mark: "ok", detail: "free; the model downloads on first use" } : { label: "Voices, local (Kokoro)", mark: "no", detail: "kokoro-js not installed — run npm install" },
    modelRow("Music (Gemini Lyria)", "gemini", keys.gemini, MUSIC_DEFAULTS.model),
    tools.ffmpeg && tools.ffprobe ? { label: "Video & audio mixing (ffmpeg)", mark: "ok", detail: "ffmpeg and ffprobe found" } : { label: "Video & audio mixing (ffmpeg)", mark: "no", detail: `${[!tools.ffmpeg && "ffmpeg", !tools.ffprobe && "ffprobe"].filter(Boolean).join(" and ")} not found — install ffmpeg` },
    tools.magick ? { label: "Review sheets (ImageMagick)", mark: "ok", detail: "magick found" } : { label: "Review sheets (ImageMagick)", mark: "no", detail: "magick not found — install ImageMagick 7" },
    tools.fcMatch ? { label: "System title fonts (fontconfig)", mark: "ok", detail: "fc-match found" } : { label: "System title fonts (fontconfig)", mark: "unset", detail: "optional: only for title fonts beyond the bundled EB Garamond and Cinzel" }
  );
  return rows;
}

// The key a provider needs, if any (see providers.ts makeProvider).
function providerKey(spec: ProviderSpec): { key?: KeyName; env?: string } {
  if (spec.type === "mock") return {};
  if (spec.type === "anthropic") return { key: "anthropic", env: spec.apiKeyEnv || KEYS.anthropic.env };
  if (spec.type === "responses") return { key: "openai", env: spec.apiKeyEnv || KEYS.openai.env };
  if (spec.type === "opencode-go") return { key: "opencode", env: spec.apiKeyEnv || KEYS.opencode.env };
  if (spec.type === "openai" && !spec.baseUrl) return { key: "openai", env: spec.apiKeyEnv || KEYS.openai.env };  // OpenAI itself (#181)
  return spec.apiKeyEnv ? { env: spec.apiKeyEnv } : {};  // another openai-compatible host: a key only if the config names one
}

// Whether one story can run here: what its settings use, and what's missing.
export async function storyRows(story: ResolvedStory, f: Findings, deps: DoctorDeps): Promise<Row[]> {
  const rows: Row[] = [];
  const config = story.config;
  // Writing: every role's provider.
  const byProvider = new Map<string, string[]>();
  for (const [role, r] of Object.entries(config.roles ?? {})) if (r) byProvider.set(r.provider, [...(byProvider.get(r.provider) ?? []), role]);
  for (const [name, roles] of byProvider) {
    const spec = config.providers?.[name];
    const label = `Writing: ${name} (${roles.length} role${roles.length === 1 ? "" : "s"})`;
    if (!spec) { rows.push({ label, mark: "no", detail: `no provider "${name}" in the config` }); continue; }
    const { key, env } = providerKey(spec);
    if (!env) { rows.push({ label, mark: "ok", detail: spec.type === "mock" ? "mock (offline)" : "no key needed" }); continue; }
    const state = key && env === KEYS[key].env ? f.keys[key] : key ? await checkKey(deps, key, env) : { set: Boolean(deps.env[env]), valid: Boolean(deps.env[env]) };
    if (!state.set) rows.push({ label, mark: "no", detail: `needs ${env}` });
    else if (!state.valid) rows.push({ label, mark: "no", detail: `${env}: ${state.error ?? "not working"}` });
    else if (spec.model && state.models && !state.models.has(spec.model)) rows.push({ label, mark: "no", detail: `${spec.model} isn't available to ${env}` });
    else rows.push({ label, mark: "ok", detail: spec.model ? `${spec.type}, ${spec.model}` : spec.type });
  }
  const gemini = (label: string, spec: ArtistBackendSpec | { type: "gemini"; model: string; apiKeyEnv?: string }): Row => {
    if (spec.type === "mock") return { label, mark: "ok", detail: "mock (offline)" };
    if (spec.type === "openai") {  // GPT Image or a GPT vision model (#181)
      const row = modelRow(label, "openai", f.keys.openai, spec.model);
      return row.mark === "unset" ? { ...row, mark: "no" } : row;
    }
    const env = (spec as { apiKeyEnv?: string }).apiKeyEnv;
    if (env && env !== KEYS.gemini.env) return deps.env[env] ? { label, mark: "ok", detail: `${spec.model} (key in ${env}, not checked)` } : { label, mark: "no", detail: `needs ${env}` };
    const row = modelRow(label, "gemini", f.keys.gemini, spec.model);
    return row.mark === "unset" ? { ...row, mark: "no" } : row;
  };
  // Art: only when the story has an art director.
  if (config.roles?.artdirector) {
    const artist = resolveArtistConfig(config.artist);
    rows.push(gemini("Art: images", artist.image));
    if (artist.inspector) rows.push(gemini("Art: image checks", artist.inspector));
  }
  const a = story.audiobook;
  if (a.narration === "gemini" || a.dialogue === "gemini") rows.push(gemini("Audiobook: Gemini voices", { type: "gemini", model: a.geminiModel ?? DEFAULT_GEMINI_TTS_MODEL }));
  if ((a.narration ?? "kokoro") === "kokoro" || (a.dialogue ?? "kokoro") === "kokoro") rows.push(f.tools.kokoro ? { label: "Audiobook: Kokoro voices", mark: "ok", detail: "local, free" } : { label: "Audiobook: Kokoro voices", mark: "no", detail: "kokoro-js not installed — run npm install" });
  if (story.music) rows.push(gemini("Music", { type: "gemini", model: story.music.model ?? MUSIC_DEFAULTS.model }));
  rows.push(f.tools.ffmpeg && f.tools.ffprobe ? { label: "Video & audio mixing", mark: "ok", detail: "ffmpeg and ffprobe found" } : { label: "Video & audio mixing", mark: "no", detail: "install ffmpeg" });
  return rows;
}

const MARKS: Record<Mark, string> = { ok: "✓", no: "✗", unset: "○" };

export function formatRows(rows: Row[], color = false): string {
  const paint: Record<Mark, (s: string) => string> = color
    ? { ok: (s) => `\x1b[32m${s}\x1b[0m`, no: (s) => `\x1b[31m${s}\x1b[0m`, unset: (s) => `\x1b[2m${s}\x1b[0m` }
    : { ok: (s) => s, no: (s) => s, unset: (s) => s };
  const width = Math.max(...rows.map((r) => r.label.length)) + 2;
  return rows.map((r) => `${r.label.padEnd(width)}${paint[r.mark](MARKS[r.mark])}  ${r.detail}`).join("\n");
}

// The real machine: commands on PATH, packages next to this repo.
export function systemDeps(env: Record<string, string | undefined> = process.env): DoctorDeps {
  const require = createRequire(import.meta.url);
  return {
    env,
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15000) }),
    has: (cmd, args) => new Promise((ok) => execFile(cmd, args, { timeout: 10000 }, (err) => ok(!err))),
    resolves: (pkg) => { try { require.resolve(pkg); return true; } catch { return false; } }
  };
}

export async function doctor(deps: DoctorDeps, story?: ResolvedStory): Promise<{ text: string; ready: boolean }> {
  const f = await investigate(deps);
  const color = !deps.env.NO_COLOR && process.stdout.isTTY === true;
  const parts = ["What this machine can make:", "", formatRows(capabilities(f), color)];
  const unset = (Object.keys(KEYS) as KeyName[]).filter((k) => (k === "anthropic" || k === "gemini") && !f.keys[k].set);
  if (unset.length) parts.push("", ...unset.map((k) => `${KEYS[k].name}: get a key at ${KEYS[k].where}, then add ${KEYS[k].env}=... to .env`));
  let ready = true;
  if (story) {
    const rows = await storyRows(story, f, deps);
    ready = rows.every((r) => r.mark !== "no");
    parts.push("", `${story.file}: ${ready ? "ready to run" : "can't run yet"}`, "", formatRows(rows, color));
  }
  parts.push("", "✓ ready   ✗ broken or missing   ○ not set up (or optional)",
    "Keys are checked by listing their models (free); a model being listed doesn't prove the key has billing for it.");
  return { text: parts.join("\n"), ready };
}
