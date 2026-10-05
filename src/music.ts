import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { replay } from "./bible.ts";
import { EventLog } from "./eventlog.ts";
import { encodeWav } from "./geminiBatch.ts";
import { decodeWav } from "./geminiTts.ts";
import { postJson, requireKey } from "./providers.ts";
import { directMusic, voiceWords } from "./roles.ts";
import type { CueSheet, MusicSceneInput } from "./roles.ts";
import { storyArtStyle } from "./visualrefs.ts";
import type { Role, SceneCommittedData, StoryEvent } from "./types.ts";

// The score: a title theme and an underscore for each scene, from a cue sheet
// the music director writes in music-only terms. Lyria generates each cue;
// every cue is listened to for voices (singing, humming, whispering, speech)
// and retaken if it has any, because the narrator is the only voice the film
// should have. The cues live in <run>/music/. The video step lays them under
// the narration: each scene's bed looped to length and ducked under the
// narrator's speech by `duck` dB.

export interface MusicSettings {
  style?: string;      // the score's sound, verbatim (default: the music director's)
  duck?: number;       // dB under the narrator's voice while someone speaks (default 19)
  volume?: number;     // dB up or down for all the music, cards included (default 0)
  model?: string;      // default lyria-3.5
  maxTakes?: number;   // takes before falling back to the 30-second model (default 3)
}

export const MUSIC_DEFAULTS = { duck: 19, volume: 0, model: "lyria-3.5", fallbackModel: "lyria-3-clip-preview", maxTakes: 3 } as const;
const THEME_SECONDS = 40;
const MAX_BED_SECONDS = 150;  // longer scenes loop their bed
const CLIP_SECONDS = 30;      // the fallback model's fixed length
const SHEET_VERSION = 2;
const BED_VERSION = 1;

// ---- the cue sheet ----

// prompt: the full brief. plainPrompt: the style alone, for when a filter
// refuses the brief. fallbackPrompt: for the 30-second model.
export interface Cue { id: string; prompt: string; plainPrompt: string; fallbackPrompt: string; seconds: number }

const loopSeconds = (sceneSec: number | undefined) => Math.min(MAX_BED_SECONDS, Math.max(30, Math.round((sceneSec ?? 120) / 10) * 10));

function lengthWords(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  const parts = [m ? `${m} minute${m === 1 ? "" : "s"}` : "", s ? `${s} seconds` : ""].filter(Boolean);
  return parts.join(" ");
}

// What Lyria is asked for. Music only: no word that invites a voice.
export function cuePrompt(style: string, music: string, seconds: number): string {
  const prompt = `Instrumental. A purely instrumental piece, about ${lengthWords(seconds)} long.\nSound: ${style}\n${music}`;
  const said = voiceWords(prompt);
  if (said.length) throw new Error(`cue prompt uses ${said.join(", ")}: ${prompt.slice(0, 120)}`);
  return prompt;
}

export const sceneCueId = (index: number) => `scene-${String(index + 1).padStart(2, "0")}`;

export function cuesFromSheet(sheet: CueSheet, sceneSeconds: Record<number, number>): Cue[] {
  const cue = (id: string, lead: string, music: string, seconds: number): Cue => ({
    id, seconds,
    prompt: cuePrompt(sheet.style, `${lead} ${music}`, seconds),
    plainPrompt: cuePrompt(sheet.style, lead, seconds),
    fallbackPrompt: cuePrompt(sheet.style, `${lead} ${music}`, CLIP_SECONDS)
  });
  const cues = [cue("theme", "Main title theme.", sheet.theme, THEME_SECONDS)];
  for (const s of sheet.scenes) {
    if (s.music === null) continue;
    cues.push(cue(sceneCueId(s.scene - 1), "Underscore at constant low intensity, sparse, leaving the midrange open, seamlessly loopable.", s.music, loopSeconds(sceneSeconds[s.scene - 1])));
  }
  return cues;
}

function sceneInputs(events: StoryEvent[], sceneSeconds: Record<number, number>): MusicSceneInput[] {
  return events.filter((e) => e.type === "scene_committed").map((e) => {
    const d = e.data as SceneCommittedData;
    const mood = [d.beat?.goal, d.beat?.conflict].filter(Boolean).join(" ").slice(0, 400);
    return { scene: d.index + 1, tension: d.tension ?? 5, mood, seconds: sceneSeconds[d.index] ?? 120, loopSeconds: loopSeconds(sceneSeconds[d.index]) };
  });
}

// The cue sheet for the run, written once and kept in the event log; a new one
// only when the story, its tone or art style, or the author's music style changes.
export async function cueSheetFor(log: EventLog, role: Role | undefined, settings: MusicSettings, sceneSeconds: Record<number, number>): Promise<{ sheet: CueSheet; made: boolean }> {
  const bible = replay(log.events);
  const scenes = sceneInputs(log.events, sceneSeconds);
  const artStyle = storyArtStyle(log.events);
  const source = createHash("sha1").update(JSON.stringify({ v: SHEET_VERSION, tone: bible.tone, artStyle, style: settings.style, scenes: scenes.map((s) => ({ ...s, seconds: Math.round(s.seconds / 30) })) })).digest("hex");
  const kept = [...log.events].reverse().find((e) => e.type === "music_cues" && (e.data as { source?: string }).source === source);
  if (kept) return { sheet: (kept.data as { sheet: CueSheet }).sheet, made: false };
  if (!role) throw new Error("config has no musicdirector (or continuist) role to write the cue sheet");
  const out = await directMusic(role, { tone: bible.tone, artStyle, style: settings.style, scenes });
  await log.append("music_cues", { source, sheet: out.result });
  return { sheet: out.result, made: true };
}

// ---- generating and checking ----

export type Compose = (prompt: string, model: string) => Promise<Buffer>;
// Every passage with a voice in it; [] when the cue is clean.
export type VoiceCheck = (file: string) => Promise<string[]>;

const GEMINI = "https://generativelanguage.googleapis.com/v1beta";

export function lyriaComposer(): Compose {
  return async (prompt, model) => {
    const data = await postJson(`${GEMINI}/interactions`, { "x-goog-api-key": requireKey("GEMINI_API_KEY") }, { model, input: prompt },
      { type: "gemini", model, role: "composer", timeoutMs: 300000, retries: 1 });
    const parts = ((data?.steps ?? []) as Array<{ content?: Array<{ type: string; data?: string }> }>).flatMap((s) => s.content ?? []);
    const audio = parts.find((p) => p.type === "audio" && p.data);
    if (!audio) throw new Error(`${model} returned no audio: ${JSON.stringify(data).slice(0, 200)}`);
    return Buffer.from(audio.data!, "base64");
  };
}

const ffmpegErr = (args: string[]) => new Promise<string>((ok, fail) => execFile("ffmpeg", ["-hide_banner", "-nostats", ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, _out, errOut) => (err ? fail(new Error(`ffmpeg: ${errOut.slice(-300) || err.message}`)) : ok(errOut))));
const ffprobeSec = (file: string) => new Promise<number>((ok, fail) => execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], (err, out) => (err ? fail(err) : ok(Number(out.trim())))));

const CHECK_PROMPT = `You are checking a music track for a film score. Does this audio contain ANY human voice at all: singing, humming, choir, "aah/ooh" vocals, chanting, whispering, breathing sounds, or spoken words? Answer with JSON only: {"voices": true|false, "evidence": "timestamps and description, or empty"}`;

// Listens in 20-second chunks (a whole song can be refused as a recording).
// A chunk the model won't answer for counts as having a voice: we can't vouch for it.
export function geminiVoiceCheck(model = "gemini-3.8-flash"): VoiceCheck {
  return async (file) => {
    const total = await ffprobeSec(file);
    const findings: string[] = [];
    for (let at = 0; at < total - 1; at += 18) {
      const chunk = `${file}.check.mp3`;
      await ffmpegErr(["-y", "-ss", String(at), "-t", "20", "-i", file, "-c:a", "libmp3lame", "-b:a", "128k", chunk]);
      const body = { contents: [{ parts: [{ inline_data: { mime_type: "audio/mpeg", data: (await readFile(chunk)).toString("base64") } }, { text: CHECK_PROMPT }] }], generationConfig: { responseMimeType: "application/json" } };
      const data = await postJson(`${GEMINI}/models/${model}:generateContent`, { "x-goog-api-key": requireKey("GEMINI_API_KEY") }, body, { type: "gemini", model, role: "musicinspector", timeoutMs: 120000, retries: 1 });
      const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
      let verdict: { voices?: boolean; evidence?: string } = { voices: true, evidence: `the check gave no answer (${data?.promptFeedback?.blockReason ?? "empty"})` };
      try { if (text) verdict = JSON.parse(text); } catch { verdict = { voices: true, evidence: `unreadable check: ${text.slice(0, 80)}` }; }
      if (verdict.voices) findings.push(`${Math.floor(at / 60)}:${String(Math.floor(at % 60)).padStart(2, "0")}+ ${verdict.evidence ?? ""}`.trim());
    }
    return findings;
  };
}

export interface CueRecord { prompt: string; model: string; file: string; takes: number; clean: boolean; findings: string[] }
export type CueIndex = Record<string, CueRecord>;

export type MusicProgress =
  | { type: "cue_kept"; id: string; clean: boolean }
  | { type: "take"; id: string; take: number; model: string; findings: string[] }
  | { type: "cue_done"; id: string; clean: boolean; takes: number; model: string };

// Makes every cue that isn't already made from the same prompt: up to
// `maxTakes` with the main model, then one with the 30-second model. A take
// with a voice is set aside in music/rejected/ and never used.
export async function generateCues(runDir: string, cues: Cue[], opts: { compose: Compose; check: VoiceCheck; model?: string; fallbackModel?: string; maxTakes?: number; force?: boolean; onProgress?: (e: MusicProgress) => void }): Promise<CueIndex> {
  const dir = join(runDir, "music");
  await mkdir(join(dir, "rejected"), { recursive: true });
  const indexFile = join(dir, "cues.json");
  let index: CueIndex = {};
  try { index = JSON.parse(await readFile(indexFile, "utf8")); } catch { /* first cues */ }
  const emit = opts.onProgress ?? (() => {});
  const model = opts.model ?? MUSIC_DEFAULTS.model;
  const fallback = opts.fallbackModel ?? MUSIC_DEFAULTS.fallbackModel;
  const takes = Math.max(1, opts.maxTakes ?? MUSIC_DEFAULTS.maxTakes);
  for (const cue of cues) {
    const prev = index[cue.id];
    const exists = prev ? await stat(join(runDir, prev.file)).then(() => true, () => false) : false;
    // A cue that failed every take stays failed until its prompt changes (or --force): retrying costs money.
    if (!opts.force && prev && prev.prompt === cue.prompt && (exists || !prev.clean)) {
      emit({ type: "cue_kept", id: cue.id, clean: prev.clean });
      continue;
    }
    // Takes of the brief; then, if a filter refused it, the plain style; then the 30-second model.
    const plan = [...Array.from({ length: takes }, () => ({ model, prompt: cue.prompt })), { model, prompt: cue.plainPrompt, onlyIfRefused: true }, { model: fallback, prompt: cue.fallbackPrompt }];
    let record: CueRecord = { prompt: cue.prompt, model, file: "", takes: 0, clean: false, findings: [] };
    const refused = new Set<string>();
    let k = -1;  // attempts made (skipped ones don't count)
    for (const t of plan) {
      if (refused.has(`${t.model}|${t.prompt}`) || ("onlyIfRefused" in t && refused.size === 0)) continue;
      k++;
      const take = join(dir, `${cue.id}.take.mp3`);
      let audio: Buffer;
      try {
        audio = await opts.compose(t.prompt, t.model);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/prohibited_content|Input blocked/i.test(message)) throw err;
        // Refused before anything was made (and nothing is charged): never send the same words again.
        refused.add(`${t.model}|${t.prompt}`);
        record = { ...record, findings: [...record.findings, `attempt ${k + 1}: ${t.model} refused the prompt`] };
        emit({ type: "take", id: cue.id, take: k + 1, model: t.model, findings: ["the model refused the prompt"] });
        continue;
      }
      await writeFile(take, audio);
      const findings = await opts.check(take);
      emit({ type: "take", id: cue.id, take: k + 1, model: t.model, findings });
      if (findings.length === 0) {
        await rename(take, join(dir, `${cue.id}.mp3`));
        record = { prompt: cue.prompt, model: t.model, file: `music/${cue.id}.mp3`, takes: k + 1, clean: true, findings: record.findings };
        break;
      }
      await rename(take, join(dir, "rejected", `${cue.id}-${k + 1}.mp3`));
      record = { ...record, takes: k + 1, findings: [...record.findings, ...findings.map((f) => `take ${k + 1}: ${f}`)] };
    }
    index[cue.id] = record;
    await writeFile(indexFile, JSON.stringify(index, null, 2) + "\n", "utf8");
    emit({ type: "cue_done", id: cue.id, clean: record.clean, takes: record.takes, model: record.model });
  }
  return index;
}

export async function readCueIndex(runDir: string): Promise<CueIndex> {
  try { return JSON.parse(await readFile(join(runDir, "music", "cues.json"), "utf8")); } catch { return {}; }
}

// ---- under the narration ----

// Where the narrator is speaking: 50 ms windows above the threshold, joined
// across pauses shorter than `mergeSec` so the music doesn't pump between sentences.
export function speechSpans(samples: Float32Array, rate: number, opts: { thresholdDb?: number; windowSec?: number; mergeSec?: number } = {}): Array<[number, number]> {
  const win = Math.max(1, Math.round((opts.windowSec ?? 0.05) * rate));
  const threshold = 10 ** ((opts.thresholdDb ?? -38) / 20);
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < samples.length; i += win) {
    let sum = 0;
    const end = Math.min(samples.length, i + win);
    for (let j = i; j < end; j++) sum += samples[j] * samples[j];
    if (Math.sqrt(sum / (end - i)) < threshold) continue;
    const [s, e] = [i / rate, end / rate];
    const last = spans.at(-1);
    if (last && s - last[1] < (opts.mergeSec ?? 1.2)) last[1] = e;
    else spans.push([s, e]);
  }
  return spans;
}

// The music's gain over time: 1, dipping to -cutDb under speech, down 0.35 s
// before it starts and back up over 0.8 s after it ends.
export function duckEnvelope(spans: Array<[number, number]>, seconds: number, cutDb: number, rate = 1000): Float32Array {
  const low = 10 ** (-cutDb / 20);
  const pre = 0.35;
  const post = 0.8;
  const env = new Float32Array(Math.ceil(seconds * rate)).fill(1);
  for (const [s, e] of spans) {
    const from = Math.max(0, Math.floor((s - pre) * rate));
    const to = Math.min(env.length, Math.ceil((e + post) * rate));
    for (let i = from; i < to; i++) {
      const t = i / rate;
      const amount = Math.max(0, Math.min(1, (t - (s - pre)) / pre, ((e + post) - t) / post));
      env[i] = Math.min(env[i], 1 - (1 - low) * amount);
    }
  }
  return env;
}

// A bed: the cue looped (crossfading 3 s at each seam) to `seconds`, at `gainDb`,
// faded in, and multiplied by the duck envelope (a WAV at 1 kHz).
export function bedFilterGraph(loops: number, seconds: number, gainDb: number): string {
  const lines: string[] = [];
  let last = "0:a";
  for (let k = 1; k < loops; k++) {
    lines.push(`[${last}][${k}:a]acrossfade=d=3[x${k}]`);
    last = `x${k}`;
  }
  const fmt = "aformat=sample_rates=48000:channel_layouts=stereo";
  lines.push(`[${last}]${fmt},apad=whole_dur=${seconds},atrim=0:${seconds},volume=${gainDb.toFixed(2)}dB,afade=t=in:d=2[m]`);
  lines.push(`[${loops}:a]aresample=48000,${fmt}[e]`);
  lines.push(`[m][e]amultiply,atrim=0:${seconds}[out]`);
  return lines.join(";");
}

export interface MusicTools {
  ffmpeg: (args: string[]) => Promise<string>;   // returns stderr
  duration: (file: string) => Promise<number>;
}
export const defaultMusicTools: MusicTools = { ffmpeg: ffmpegErr, duration: ffprobeSec };

// Integrated loudness (LUFS) from ffmpeg's EBU R128 meter.
export async function loudness(tools: MusicTools, file: string): Promise<number> {
  const out = await tools.ffmpeg(["-i", file, "-af", "ebur128", "-f", "null", "-"]);
  const m = [...out.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].at(-1);
  if (!m) throw new Error(`no loudness reading for ${file}`);
  return Number(m[1]);
}

export interface MusicMix {
  theme?: string;                 // relative to the run dir
  beds: Record<number, string>;   // scene index -> bed WAV
  duck: number;
}

// Builds what the video lays under the narration (in video/music/), measured
// against the narrator so `duck` means the same in every story: under speech
// the music sits `duck` dB below the voice; between lines and under the cards
// it plays at the voice's level plus `volume`. Free: no generation here.
export async function prepareMusic(runDir: string, scenes: Array<{ index: number; audio: string; seconds: number }>, settings: MusicSettings, tools: MusicTools = defaultMusicTools): Promise<MusicMix | undefined> {
  const index = await readCueIndex(runDir);
  const duck = settings.duck ?? MUSIC_DEFAULTS.duck;
  const volume = settings.volume ?? MUSIC_DEFAULTS.volume;
  const outDir = join(runDir, "video", "music");
  await mkdir(outDir, { recursive: true });
  const cacheFile = join(outDir, "beds.json");
  let cache: Record<string, string> = {};
  try { cache = JSON.parse(await readFile(cacheFile, "utf8")); } catch { /* first mix */ }
  const keyOf = async (files: string[], extra: unknown) => {
    const h = createHash("sha1").update(JSON.stringify({ v: BED_VERSION, extra }));
    for (const f of files) { const s = await stat(join(runDir, f)); h.update(`${f}:${s.size}:${s.mtimeMs}`); }
    return h.digest("hex");
  };
  const fresh = async (rel: string, key: string) => cache[rel] === key && await stat(join(runDir, rel)).then(() => true, () => false);

  const voiceLevels: number[] = [];
  const beds: Record<number, string> = {};
  for (const s of scenes) {
    const voice = await loudness(tools, join(runDir, s.audio));
    voiceLevels.push(voice);
    const cue = index[sceneCueId(s.index)];
    if (!cue?.clean) continue;
    const rel = `video/music/bed-${String(s.index + 1).padStart(2, "0")}.wav`;
    const seconds = Math.ceil(s.seconds + 3);
    const key = await keyOf([cue.file, s.audio], { duck, volume, seconds });
    beds[s.index] = rel;
    if (await fresh(rel, key)) continue;
    const music = await loudness(tools, join(runDir, cue.file));
    const cueSec = await tools.duration(join(runDir, cue.file));
    const loops = cueSec >= seconds ? 1 : Math.ceil((seconds - 3) / Math.max(1, cueSec - 3));
    // Speech is found in a small 16-bit 8 kHz mono copy: any narration format, a fraction of the memory.
    const speechFile = join(outDir, `speech-${String(s.index + 1).padStart(2, "0")}.wav`);
    await tools.ffmpeg(["-y", "-i", join(runDir, s.audio), "-ac", "1", "-ar", "8000", "-c:a", "pcm_s16le", speechFile]);
    const narration = decodeWav(await readFile(speechFile));
    const envFile = join(outDir, `duck-${String(s.index + 1).padStart(2, "0")}.wav`);
    await writeFile(envFile, encodeWav(duckEnvelope(speechSpans(narration.samples, narration.sampleRate), seconds, duck + volume), 1000));
    await tools.ffmpeg([
      "-y", ...Array.from({ length: loops }, () => ["-i", join(runDir, cue.file)]).flat(), "-i", envFile,
      "-filter_complex", bedFilterGraph(loops, seconds, voice + volume - music),
      "-map", "[out]", "-c:a", "pcm_s16le", join(runDir, rel)
    ]);
    cache[rel] = key;
    await writeFile(cacheFile, JSON.stringify(cache, null, 2) + "\n", "utf8");
  }

  let theme: string | undefined;
  const t = index.theme;
  if (t?.clean && voiceLevels.length) {
    const avg = voiceLevels.reduce((a, b) => a + b, 0) / voiceLevels.length;
    theme = "video/music/theme.wav";
    const key = await keyOf([t.file], { volume, avg: avg.toFixed(1) });
    if (!(await fresh(theme, key))) {
      const music = await loudness(tools, join(runDir, t.file));
      await tools.ffmpeg(["-y", "-i", join(runDir, t.file), "-af", `aformat=sample_rates=48000:channel_layouts=stereo,volume=${(avg + volume - music).toFixed(2)}dB`, "-c:a", "pcm_s16le", join(runDir, theme)]);
      cache[theme] = key;
      await writeFile(cacheFile, JSON.stringify(cache, null, 2) + "\n", "utf8");
    }
  }
  if (!theme && Object.keys(beds).length === 0) return undefined;
  return { theme, beds, duck };
}

// Seconds of each scene's narration, from the audiobook's timings (if made yet).
export async function sceneSeconds(runDir: string): Promise<Record<number, number>> {
  try {
    const t = JSON.parse(await readFile(join(runDir, "audiobook", "timings.json"), "utf8")) as { scenes: Array<{ index: number; durationSec: number }> };
    return Object.fromEntries(t.scenes.map((s) => [s.index, s.durationSec]));
  } catch { return {}; }
}
