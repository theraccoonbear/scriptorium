import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildScenes, voicedBible } from "./audiobook.ts";
import { encodeWav } from "./geminiBatch.ts";
import { buildTtsPrompt } from "./geminiTts.ts";
import type { Speak } from "./geminiTts.ts";
import type { SceneCommittedData, StoryEvent } from "./types.ts";

// The words on the video's cards: the title over the cover, a card before
// each scene ("II" over "The Troll and the Gnacien"), "The End" or "To be
// continued", the cast credits and a "Next:" card for a series. Everything
// here is about WHAT the cards say; video.ts decides how they look and when.

export interface TitleSettings {
  opening?: boolean;              // title over the cover (default: on when there's a title)
  narrate?: boolean;              // the narrator reads the title (default off: one paid TTS line)
  sceneTitles?: boolean | string[]; // true = auto, false = no scene cards, or the titles in order
  credits?: boolean;              // default on
  ending?: string | false;        // default "The End", or "To be continued" for a series chapter
  font?: string;                  // bundled name, system family or a font file (default EB Garamond)
  titleFont?: string;             // for the title and the ending (default Cinzel)
}

// What the video draws, resolved: every string final, every font a file.
export interface TitleCards {
  title?: string;
  subtitle?: string;
  sceneCards: boolean;
  sceneTitles: Record<number, string>; // scene index -> title ("" or missing: the numeral alone)
  ending?: string;
  credits: string[][];                 // pages of credit lines
  next?: string;
  font: string;
  titleFont: string;
  narration?: string;                  // the narrated title's WAV, relative to the run dir
}

// ---- scene titles ----

// "Scene 5 — The troll and the gnacien (the road to Gralston, the next day)"
// lines in an author's plan -> { 4: "The troll and the gnacien" }.
export function planSceneTitles(text: string): Record<number, string> {
  const out: Record<number, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^[\s#*]*Scene\s+(\d+)\s*[—–:-]+\s*(.+?)\s*$/i);
    if (!m) continue;
    const title = m[2].replace(/\s*\([^)]*\)\s*$/, "").replace(/[*_]+/g, "").trim();
    const index = Number(m[1]) - 1;
    if (title && index >= 0 && !(index in out)) out[index] = title;
  }
  return out;
}

// The titles the director gave each committed scene's beat (newer runs only).
export function beatSceneTitles(events: StoryEvent[]): Record<number, string> {
  const out: Record<number, string> = {};
  for (const e of events) {
    if (e.type !== "scene_committed") continue;
    const d = e.data as SceneCommittedData;
    const title = d.beat?.title?.trim();
    if (title) out[d.index] = title;
  }
  return out;
}

// The first source with a title wins: the story file's list, the author's
// plan, the director's beat. No title leaves the numeral alone.
export function autoSceneTitles(scenes: number[], sources: { list?: string[]; plan?: Record<number, string>; beats?: Record<number, string> }): Record<number, string> {
  const out: Record<number, string> = {};
  for (const i of scenes) out[i] = sources.list?.[i]?.trim() || sources.plan?.[i] || sources.beats?.[i] || "";
  return out;
}

// <run>/video/titles.json: the scene titles in use, for the author to edit.
// Each entry keeps the automatic title beside the one in use; an entry the
// author changed keeps their title, the rest follow the sources.
export interface TitlesSheet { scenes: Array<{ scene: number; title: string; auto: string }> }

export function mergeTitlesSheet(existing: TitlesSheet | undefined, auto: Record<number, string>): TitlesSheet {
  const before = new Map((existing?.scenes ?? []).map((e) => [e.scene, e]));
  const scenes = Object.keys(auto).map(Number).sort((a, b) => a - b).map((i) => {
    const scene = i + 1;
    const prev = before.get(scene);
    const edited = prev && prev.title !== prev.auto;
    return { scene, title: edited ? prev.title : auto[i], auto: auto[i] };
  });
  return { scenes };
}

export async function syncTitlesSheet(runDir: string, auto: Record<number, string>): Promise<{ file: string; titles: Record<number, string> }> {
  const file = join(runDir, "video", "titles.json");
  let existing: TitlesSheet | undefined;
  try { existing = JSON.parse(await readFile(file, "utf8")); } catch { /* first video */ }
  const sheet = mergeTitlesSheet(existing, auto);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(sheet, null, 2) + "\n", "utf8");
  return { file, titles: Object.fromEntries(sheet.scenes.map((e) => [e.scene - 1, e.title])) };
}

export function romanNumeral(n: number): string {
  const table: Array<[number, string]> = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let out = "";
  for (const [v, s] of table) while (n >= v) { out += s; n -= v; }
  return out;
}

// ---- credits ----

export interface VoiceMap { narrator: string; characters: Record<string, string>; gemini?: { narrator: string; characters: Record<string, string> } }

// How a voice is named in the credits: a library voice by its display name, a
// designed voice as such, a Kokoro voice by its name ("bm_george" -> "George (Kokoro)").
export function voiceCredit(id: string, opts: { gemini: boolean; designed?: boolean; displayNames?: Record<string, string> }): string {
  if (opts.designed || id.startsWith("voice_")) return "a designed voice";
  if (!opts.gemini) {
    const name = id.replace(/^[a-z]{2}_/, "");
    return `${name.charAt(0).toUpperCase()}${name.slice(1)} (Kokoro)`;
  }
  return opts.displayNames?.[id.toLowerCase()] ?? `${id.charAt(0).toUpperCase()}${id.slice(1)}`;
}

// Everyone who speaks, in order of first appearance, with their voice; the
// narrator first and Scriptorium last. Pages hold `perPage` lines.
export function creditPages(events: StoryEvent[], voices: VoiceMap | undefined, opts: { gemini: boolean; designed?: ReadonlySet<string>; displayNames?: Record<string, string>; perPage?: number }): string[][] {
  const bible = voicedBible(events);
  const speakers: string[] = [];
  for (const scene of buildScenes(events)) {
    for (const seg of scene.segments) if (seg.speaker !== "narrator" && !speakers.includes(seg.speaker)) speakers.push(seg.speaker);
  }
  const map = opts.gemini && voices?.gemini ? voices.gemini : voices;
  const credit = (id: string, voice: string) => voiceCredit(voice, { gemini: opts.gemini, designed: opts.designed?.has(id), displayNames: opts.displayNames });
  const lines: string[] = [];
  if (map?.narrator) lines.push(`Narrated by ${credit("narrator", map.narrator)}`);
  for (const id of speakers) {
    const name = bible.characters[id]?.name ?? id;
    const voice = map?.characters[id];
    lines.push(voice ? `${name} — voiced by ${credit(id, voice)}` : name);
  }
  const perPage = opts.perPage ?? 6;
  const pages: string[][] = [];
  for (let k = 0; k < lines.length; k += perPage) pages.push(lines.slice(k, k + perPage));
  pages.push(["Written, illustrated and narrated", "with Scriptorium"]);
  return pages;
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return undefined; }
}

// Library display names from the cached voice list (never fetched here: the video step stays offline).
async function libraryDisplayNames(language = "en"): Promise<Record<string, string>> {
  const cached = await readJson<{ voices: Array<{ id: string; display_name?: string }> }>(join(homedir(), ".cache", "scriptorium", `gemini-voices-${language}.json`));
  return Object.fromEntries((cached?.voices ?? []).filter((v) => v.display_name).map((v) => [v.id.toLowerCase(), v.display_name!]));
}

// ---- fonts ----

const FONT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets", "fonts");
export const BUNDLED_FONTS: Record<string, string> = {
  "eb garamond": join(FONT_DIR, "EBGaramond.ttf"),
  "cinzel": join(FONT_DIR, "Cinzel.ttf"),
  "cinzel decorative": join(FONT_DIR, "CinzelDecorative.ttf"),
  "im fell english sc": join(FONT_DIR, "IMFellEnglishSC.ttf"),
  "medievalsharp": join(FONT_DIR, "MedievalSharp.ttf"),
  "metamorphous": join(FONT_DIR, "Metamorphous.ttf"),
  "new rocker": join(FONT_DIR, "NewRocker.ttf"),
  "pirata one": join(FONT_DIR, "PirataOne.ttf"),
  "uncial antiqua": join(FONT_DIR, "UncialAntiqua.ttf")
};

// The display fonts a logo can be set in, and the feel of each (for the art director).
export const LOGO_FONTS: Record<string, string> = {
  "Cinzel": "engraved Roman capitals: classical, epic, restrained",
  "Cinzel Decorative": "Roman capitals with flourished swashes: grand epic fantasy, heraldic",
  "IM Fell English SC": "old printed-book small caps, slightly worn: storybook, folk tale, historical",
  "MedievalSharp": "pen-drawn medieval book hand: tabletop adventure, tavern, roleplaying game",
  "Metamorphous": "sharp-cut medieval capitals: dark fantasy, sword and sorcery",
  "New Rocker": "heavy, spiky gothic capitals: rowdy, swashbuckling, heavy-metal fantasy adventure",
  "Pirata One": "condensed blackletter: grim, old-world, piratical",
  "Uncial Antiqua": "Celtic uncial: druidic, folkloric, whimsical old magic"
};

// A bundled font by name, a font file by path, or a system family through fontconfig.
export async function resolveFont(name: string, base = process.cwd()): Promise<string> {
  const bundled = BUNDLED_FONTS[name.trim().toLowerCase()];
  if (bundled) return bundled;
  if (/\.(ttf|otf|ttc)$/i.test(name)) return resolve(base, name);
  const file = await new Promise<string>((ok, fail) => execFile("fc-match", ["-f", "%{file}", name], (err, out) => (err ? fail(new Error(`font "${name}": fc-match failed (${err.message})`)) : ok(out.trim()))));
  if (!file) throw new Error(`font "${name}" not found`);
  return file;
}

// ---- the narrated title ----

// Leading and trailing silence trimmed, so the opening can be timed to the voice itself.
export function trimSilence(samples: Float32Array, sampleRate: number, threshold = 0.01, keepSec = 0.05): Float32Array {
  let start = 0;
  let end = samples.length;
  while (start < end && Math.abs(samples[start]) < threshold) start++;
  while (end > start && Math.abs(samples[end - 1]) < threshold) end--;
  if (start === end) return new Float32Array(0);
  const keep = Math.round(keepSec * sampleRate);
  return samples.slice(Math.max(0, start - keep), Math.min(samples.length, end + keep));
}

// video/title.wav, remade only when the words or the voice change.
export async function narrateTitle(runDir: string, text: string, voice: string, speak: Speak): Promise<{ file: string; made: boolean }> {
  const rel = "video/title.wav";
  const indexFile = join(runDir, "video", "title.json");
  const index = await readJson<{ text: string; voice: string }>(indexFile);
  const exists = await readFile(join(runDir, rel)).then(() => true, () => false);
  if (exists && index?.text === text && index.voice === voice) return { file: rel, made: false };
  const audio = await speak(buildTtsPrompt({ name: "Narrator", profile: "The storyteller of this tale, announcing its title.", line: text }), voice);
  await mkdir(join(runDir, "video"), { recursive: true });
  await writeFile(join(runDir, rel), encodeWav(trimSilence(audio.samples, audio.sampleRate), audio.sampleRate));
  await writeFile(indexFile, JSON.stringify({ text, voice }, null, 2) + "\n", "utf8");
  return { file: rel, made: true };
}

// ---- putting it together ----

export interface PrepareTitlesOptions {
  runDir: string;
  title?: string;
  subtitle?: string;
  series?: { next?: string };
  settings?: TitleSettings;
  contextPaths?: string[];       // the author's plan, for scene titles
  gemini?: boolean;              // the audiobook spoke with Gemini voices (default: if voices.json has them)
  speak?: Speak;                 // for the narrated title
  base?: string;                 // where relative font paths resolve (the story file's folder)
  onNote?: (message: string) => void;
}

export async function prepareTitles(events: StoryEvent[], opts: PrepareTitlesOptions): Promise<TitleCards> {
  const s = opts.settings ?? {};
  const note = opts.onNote ?? (() => {});
  const scenes = events.filter((e) => e.type === "scene_committed").map((e) => (e.data as SceneCommittedData).index);

  const sceneCards = s.sceneTitles !== false;
  let sceneTitles: Record<number, string> = {};
  if (sceneCards) {
    const plan: Record<number, string> = {};
    for (const p of opts.contextPaths ?? []) {
      const text = await readFile(p, "utf8").catch(() => "");
      for (const [i, t] of Object.entries(planSceneTitles(text))) if (!(i in plan)) plan[Number(i)] = t;
    }
    const auto = autoSceneTitles(scenes, { list: Array.isArray(s.sceneTitles) ? s.sceneTitles : undefined, plan, beats: beatSceneTitles(events) });
    sceneTitles = (await syncTitlesSheet(opts.runDir, auto)).titles;
  }

  const voices = await readJson<VoiceMap>(join(opts.runDir, "audiobook", "voices.json"));
  const gemini = opts.gemini ?? Boolean(voices?.gemini);
  let credits: string[][] = [];
  if (s.credits !== false) {
    const casting = await readJson<{ characters?: Record<string, { designed?: boolean }> }>(join(opts.runDir, "audiobook", "casting.json"));
    const designed = new Set(Object.entries(casting?.characters ?? {}).filter(([, c]) => c.designed).map(([id]) => id));
    credits = creditPages(events, voices, { gemini, designed, displayNames: gemini ? await libraryDisplayNames() : {} });
  }

  const title = s.opening === false ? undefined : opts.title?.trim() || undefined;
  let narration: string | undefined;
  if (title && s.narrate) {
    const voice = gemini ? voices?.gemini?.narrator : undefined;
    if (!voice || !opts.speak) note("the narrated title needs the audiobook's Gemini narrator — skipped");
    else {
      const text = [title, opts.subtitle?.trim()].filter(Boolean).join(". ") + ".";
      const r = await narrateTitle(opts.runDir, text, voice, opts.speak);
      if (r.made) note(`narrated the title: "${text}"`);
      narration = r.file;
    }
  }

  const ending = s.ending === false ? undefined : s.ending ?? (opts.series ? "To be continued" : "The End");
  return {
    title,
    subtitle: title ? opts.subtitle?.trim() || undefined : undefined,
    sceneCards,
    sceneTitles,
    ending,
    credits,
    next: opts.series?.next ? `Next: ${opts.series.next}` : undefined,
    font: await resolveFont(s.font ?? "EB Garamond", opts.base),
    titleFont: await resolveFont(s.titleFont ?? "Cinzel", opts.base),
    narration
  };
}
