import { ratingCard, visualLimits } from "./ratings.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { boxArt, drawLogo, exists, renderLogo, SHELF, shelfCover, suppliedLogo, TREATMENTS } from "./titleArt.ts";
import type { BoxCopy, LogoSettings } from "./titleArt.ts";
import { LOGO_FONTS } from "./titles.ts";
import type { Pronunciations } from "./geminiTts.ts";
import { basename, isAbsolute, join, resolve } from "node:path";
import { combineContexts, contextFile } from "./context.ts";
import { EventLog } from "./eventlog.ts";
import { buildRoleProviders, postJson, requireKey } from "./providers.ts";
import { planExtras, planReferences, planShots, planArc, runStory } from "./engine.ts";
import { WORDS_PER_MINUTE, lengthReport, measuredPace, resolveLength, sceneBudgets } from "./length.ts";
import { RenderStatus } from "./renderStatus.ts";
import { readApprovals } from "./approvals.ts";
import { syncCharacterSheet } from "./characterSheet.ts";
import { geminiSpeaker } from "./geminiTts.ts";
import { lineCounts, needAuditions, renderVoiceSamples } from "./voiceSamples.ts";
import { generateAudiobook, voicedBible, writeVoiceMap } from "./audiobook.ts";
import { renderVideo } from "./video.ts";
import { prepareTitles } from "./titles.ts";
import { cueSheetFor, cuesFromSheet, cuesToMake, generateCues, geminiVoiceCheck, lyriaComposer, MUSIC_DEFAULTS, prepareMusic, sceneSeconds } from "./music.ts";
import type { Compose, MusicSettings, VoiceCheck } from "./music.ts";
import type { TitleSettings } from "./titles.ts";
import type { EncoderChoice } from "./video.ts";
import { BatchImageBackend, CAST_PHOTO_KEY, CAST_PHOTO_LABEL, KEY_ART, extensionFor, ffmpegShrink, makeCastDescriber, makeImageBackend, makeInspector, renderArt, renderOne, resolveArtistConfig, storyNames, stripNames } from "./artist.ts";
import type { ArtManifest, ImageBackend, Inspector, Shrink } from "./artist.ts";
import { castContext, castRun, loadImage, slug } from "./cast.ts";
import type { CastDescriber, CastEntry, CastMember } from "./cast.ts";
import { storyArtStyle } from "./visualrefs.ts";
import { designRun, needsTagging, proseHash, sceneTags, tagRun, vocalRun, VOCAL_TAGS } from "./tagging.ts";
import { briefLogoArt, designLogo, draftCrawl, writeAuditions, writeBoxCopy } from "./roles.ts";
import { castVoiceRun, narratorReads } from "./casting.ts";
import { speechCheckRound } from "./rounds.ts";
import type { CheckReport } from "./speechCheck.ts";
import { geminiBatchJobs } from "./batchJobs.ts";
import type { GeminiSpec } from "./types.ts";
import type { TonePaletteData } from "./tagging.ts";
import type { GeminiMode } from "./geminiBatch.ts";
import { replay } from "./bible.ts";
import { c } from "./colors.ts";
import { accountantFor, readLedger, runAccounted, usd } from "./usage.ts";
import { TYPICAL } from "./pitch.ts";
import type { Bible, SceneCommittedData, StoryConfig, StoryEvent } from "./types.ts";

// The pipeline's steps — story, art, audiobook, video — as plain functions with
// their console progress. Shared by the individual CLI commands and `make`.
// Each step resumes or skips finished work, so re-running one is always safe.

// Runs a paid step with spend accounting: every API call is logged to the run's
// usage.jsonl, the budget is enforced, and the step's spend is printed. Every
// step of a run shares one accountant (so steps running at once — art and
// audio — see each other's spend against the budget), and each carries its own
// step label through its async work.
export async function accounted<T>(runDir: string, config: StoryConfig | undefined, step: string, fn: () => Promise<T>): Promise<T> {
  const acc = accountantFor(runDir, { pricing: config?.pricing, budgetUsd: config?.budget?.usd, ...(config?.budget?.count ? { budgetKinds: config.budget.count } : {}) });
  const before = acc.spentIn(step);
  try {
    return await runAccounted(acc, step, fn);
  } finally {
    const spent = acc.spentIn(step) - before;
    const budget = acc.budgetUsd !== undefined ? ` of ${usd(acc.budgetUsd)} budget` : "";
    if (spent > 0) console.error(`[scriptorium] ${c.dim(`spend: ${step} ${usd(spent)} · run total ${usd(acc.spent)}${budget}`)}`);
  }
}

export interface StoryStepOptions {
  config: StoryConfig;
  runDir: string;
  scenes?: number;
  maxAttempts?: number;
  premise?: string;
  setting?: string;
  contextPaths?: string[];
  speakerTags?: boolean;
  cast?: CastMember[];  // real people and animals who star, from photos
}

export async function readContexts(paths: string[]): Promise<{ context?: string; contextFiles: string[] }> {
  const files = await Promise.all(paths.map(async (p) => contextFile(p, await readFile(p, "utf8"))));
  return { context: combineContexts(files), contextFiles: paths.map((p) => basename(p)) };
}

export async function storyStep(opts: StoryStepOptions): Promise<{ log: EventLog; bible: Bible }> {
  return accounted(opts.runDir, opts.config, "story", () => storyStepInner(opts));
}

async function storyStepInner(opts: StoryStepOptions): Promise<{ log: EventLog; bible: Bible }> {
  const { config, runDir } = opts;
  const log = new EventLog(runDir);
  let { context, contextFiles } = await readContexts(opts.contextPaths ?? []);
  if (opts.cast && opts.cast.length > 0) {
    const cast = await castStep(runDir, config, log, opts.cast);
    const files = await Promise.all((opts.contextPaths ?? []).map(async (p) => contextFile(p, await readFile(p, "utf8"))));
    context = combineContexts([...files, { name: "the cast (from photos)", text: castContext(cast) }]);
    contextFiles = [...contextFiles, "cast"];
  }
  const bible = await runStory({
    config: {
      ...config,
      premise: opts.premise,
      setting: opts.setting || config.setting,
      // No context given: runStory falls back to the context the run started with.
      ...(context ? { context, contextFiles } : {}),
      speakerTags: opts.speakerTags ?? config.speakerTags
    },
    log,
    roles: buildRoleProviders(config),
    scenes: opts.scenes,
    maxAttempts: opts.maxAttempts,
    runDir,
    onScene: (s) => {
      console.log(`${c.ok(`scene ${s.index + 1} committed`)} ${c.dim(`(tension ${s.tension}, attempts ${s.attempts})`)}`);
    }
  });
  for (const line of lengthLines(config, log.events, bible, opts.scenes ?? config.scenes, runDir)) console.log(line);
  return { log, bible };
}

// Scene by scene, how long the story runs against its budget (#170).
export function lengthLines(config: StoryConfig, events: StoryEvent[], bible: Bible, scenes: number | undefined, runDir?: string): string[] {
  const total = scenes ?? events.filter((e) => e.type === "scene_committed").length;
  if (total === 0) return [];
  const measuredWpm = runDir ? measuredPace(runDir, events) : undefined;
  const len = config.length ? resolveLength(config.length, { scenes: total, ...(measuredWpm ? { measuredWpm } : {}) }) : undefined;
  const wpm = len?.wordsPerMinute ?? measuredWpm ?? WORDS_PER_MINUTE;
  const budgets = config.sceneWords ? Array.from({ length: total }, () => config.sceneWords!) : len ? sceneBudgets(len.totalWords, planArc(total, config.tension, bible.arc)) : undefined;
  const report = lengthReport(events, budgets, wpm);
  if (report.length === 0) return [];
  const n = (x: number) => x.toLocaleString("en-US");
  const minutes = report.reduce((a, r) => a + r.minutes, 0);
  return [
    ...report.map((r) => `  scene ${r.scene}: ${n(r.words)} words, ~${r.minutes.toFixed(1)} min${r.budget ? ` (budget ${n(r.budget.min)}-${n(r.budget.max)})` : ""}${r.off ? ` ${c.retry(r.off === "long" ? "— long" : "— short")}` : ""}`),
    `length: ~${Math.round(minutes)} min read aloud${len ? ` (asked ${len.minutes})` : ""}`
  ];
}

// Describes the cast from their photos (once; again only when a member's
// name, notes or photos change) and records them in the run.
async function castStep(runDir: string, config: StoryConfig, log: EventLog, members: CastMember[], describer?: CastDescriber, shrink: Shrink = ffmpegShrink): Promise<CastEntry[]> {
  const events = await log.load();
  const { entries, changed } = await castRun(runDir, members, describer ?? makeCastDescriber(resolveArtistConfig(config.artist)), events, (img) => shrink(img, 1024));
  if (changed) await log.append("cast", { members: entries });
  for (const e of entries) console.error(`[scriptorium] ${c.dim(`cast: ${e.name} (${e.kind}) — ${e.appearance}`)}`);
  return entries;
}

// A quick look at the cast before a whole story: describes each member (the
// same casting the story step does, recorded in the run so the story reuses
// it) and renders one portrait each from their photos, in the story's art
// style, into <runDir>/cast/preview/. `as` dresses them for the part.
export interface CastPreviewOptions {
  runDir: string;
  config: StoryConfig;
  cast: CastMember[];
  as?: string;
  backend?: ImageBackend;    // injectable for tests
  inspector?: Inspector | null;
  describer?: CastDescriber;
  shrink?: Shrink;
}

export async function castPreviewStep(opts: CastPreviewOptions): Promise<{ name: string; file: string; accepted: boolean; issues: string[] }[]> {
  return accounted(opts.runDir, opts.config, "cast", () => castPreviewInner(opts));
}

async function castPreviewInner(opts: CastPreviewOptions) {
  const { runDir, config } = opts;
  if (opts.cast.length === 0) throw new Error("this story file has no \"cast\"");
  const artist = resolveArtistConfig(config.artist);
  const log = new EventLog(runDir);
  const entries = await castStep(runDir, config, log, opts.cast, opts.describer, opts.shrink);
  const backend = opts.backend ?? makeImageBackend(artist.image);
  const inspector = opts.inspector === undefined ? (artist.inspector ? makeInspector(artist.inspector) : undefined) : opts.inspector ?? undefined;
  const shrink = opts.shrink ?? ffmpegShrink;
  const style = config.artStyle ?? storyArtStyle(log.events);
  const direction = artistDirection(config);
  const outDir = join(runDir, "cast", "preview");
  await mkdir(outDir, { recursive: true });
  const results = [];
  for (const e of entries) {
    const subject = e.kind === "animal" ? "this animal" : "this person";
    const prompt = [
      `A full-body character portrait of ${subject}: ${e.appearance}`,
      opts.as ? `Dressed and equipped for the story as: ${opts.as}.` : "",
      "A relaxed, natural pose with a hint of personality; plain, softly lit background; no other figures; no text."
    ].filter(Boolean).join(" ");
    const references = await Promise.all(e.photos.slice(0, 3).map(async (p) => ({ ...(await shrink(await loadImage(join(runDir, p)), 768)), label: CAST_PHOTO_LABEL })));
    console.error(`[scriptorium] ${c.blue(c.bold(`portrait: ${e.name}`))}`);
    const out = await renderOne(
      { key: `cast-${slug(e.name)}`, prompt, ref: { kind: "character", id: slug(e.name) } },
      references, backend, inspector, artist.maxAttempts ?? 3,
      (ev) => { if (ev.type === "attempt_rejected") console.error(`[scriptorium]   ${c.retry(`attempt ${ev.attempt} rejected: ${ev.issues.join("; ")}`)}`); },
      style, (img) => shrink(img, artist.inspectSize ?? 1024), direction, e.name.split(/\s+/).filter((w) => w.length >= 3)
    );
    const file = join(outDir, `${slug(e.name)}.${extensionFor(out.image.mimeType)}`);
    await writeFile(file, out.image.data);
    console.log(`${out.accepted ? c.ok(`${e.name}:`) : c.retry(`${e.name} (kept after ${out.attempts} rejected attempts):`)} ${c.cyan(file)}`);
    results.push({ name: e.name, file, accepted: out.accepted, issues: out.issues });
  }
  return results;
}

// The phases an author can review one at a time. "references": just the
// portraits, places and props (remaking any in `redo`, with the author's
// `notes`); otherwise everything — shots planned for any scene without them.
export interface ArtPhase {
  only?: "references";
  redo?: string[];     // "kind:id"
  shotRedo?: string[]; // shot keys to render again (scene-04-07, cover), with notes as the author's correction
  replan?: number[];   // scene indexes whose shots are planned again
  notes?: string;
  edit?: { keys: string[]; note: string; source?: string; with?: string[] };  // edit these images in place (#141)
}

// Plans whatever art the run is missing (with the config's art director), then
// renders it into <runDir>/art/. Approved images are never redone.
export async function artStep(runDir: string, config: StoryConfig, events: StoryEvent[], force: boolean | undefined, phase: ArtPhase = {}) {
  return accounted(runDir, config, phase.only === "references" ? "refs" : "art", async () => {
    const approved = new Set((await readApprovals(runDir)).art);
    const roles = buildRoleProviders(config);
    if (roles.artdirector && events.some((e) => e.type === "scene_committed")) {
      const log = new EventLog(runDir);
      await log.load();
      if (phase.only === "references") {
        await syncCharacterSheet(runDir, log);
        const { made, stale } = await planReferences({ config, log, roles, runDir, redo: phase.redo, notes: phase.notes, approved });
        if (stale.length) console.error(`[scriptorium] ${c.dim(`character sheet changed for ${stale.join(", ")} — new portraits`)}`);
        if (made.length) console.error(`[scriptorium] ${c.ok(`${made.length} reference${made.length === 1 ? "" : "s"} planned`)} ${c.dim(made.join(", "))}`);
      } else {
        if (phase.redo?.length) throw new Error("--redo kind:id applies to the refs step (make --only refs --redo kind:id)");
        const locked = [...(phase.shotRedo ?? []), ...(phase.edit?.keys ?? [])].filter((k) => approved.has(k));
        if (locked.length) throw new Error(`${locked.join(", ")} ${locked.length === 1 ? "is" : "are"} approved — revoke the approval before redoing`);
        // The author's correction rides with the shot's prompt from now on.
        if (phase.notes) for (const key of phase.shotRedo ?? []) await log.append("shot_note", { key, note: phase.notes });
        // --redo cover: the cover is directed again (a new prompt), then rendered.
        const planned = await planShots({ config, log, roles, runDir, ...(phase.replan?.length ? { replan: phase.replan } : {}), ...(phase.shotRedo?.includes("cover") ? { redirectCover: true } : {}) });
        if (planned) console.error(`[scriptorium] ${c.ok(`shots planned for ${planned} scene${planned === 1 ? "" : "s"}`)}`);
      }
      events = log.events;
    } else if (phase.only === "references" || phase.redo?.length) {
      throw new Error("the refs step needs a config with an artdirector role");
    }
    // An edit renders just the edited images.
    const edit = phase.edit?.keys.length ? { keys: phase.edit.keys, edits: Object.fromEntries(phase.edit.keys.map((k) => [k, { note: phase.edit!.note, ...(phase.edit!.source ? { source: phase.edit!.source } : {}), ...(phase.edit!.with?.length ? { with: phase.edit!.with } : {}) }])) } : {};
    return artStepInner(runDir, config, events, force, { approved, ...(phase.only ? { only: phase.only } : {}), ...(phase.shotRedo?.length ? { redoKeys: phase.shotRedo } : {}), ...edit });
  });
}

// What the image model (and its inspector) is told beyond the art style: the
// author's art direction, and a rated story's visual limits (#88). A story
// without either is unchanged, so its images aren't redrawn.
export function artistDirection(config: StoryConfig): string | undefined {
  return [config.direction?.artist?.trim(), config.rating ? visualLimits(config.rating) : ""].filter(Boolean).join("\n") || undefined;
}

// The extras phase (#49): key art (2:3, 16:9, 1:1) and a cast photo, in the
// story's art style, at 2K; directed once, then rendered like the cover.
// redo: these extras keys again (a new prompt with redirect, or just new takes).
export async function extrasStep(runDir: string, config: StoryConfig, events: StoryEvent[], force: boolean | undefined, opts: { redo?: string[]; redirect?: boolean; notes?: string; title?: string; subtitle?: string; base?: string; edit?: { keys: string[]; note: string; source?: string; with?: string[] } } = {}) {
  return accounted(runDir, config, "extras", async () => {
    const approved = new Set((await readApprovals(runDir)).art);
    const roles = buildRoleProviders(config);
    if (!roles.artdirector) throw new Error("the extras step needs a config with an artdirector role");
    const locked = [...(opts.redo ?? []), ...(opts.edit?.keys ?? [])].filter((k) => approved.has(k));
    if (locked.length) throw new Error(`${locked.join(", ")} ${locked.length === 1 ? "is" : "are"} approved — revoke the approval before redoing`);
    const log = new EventLog(runDir);
    await log.load();
    if (opts.notes) for (const key of opts.redo ?? []) await log.append("shot_note", { key, note: opts.notes });
    if (await planExtras({ config, log, roles, runDir, redo: opts.redirect === true })) console.error(`[scriptorium] ${c.ok("extras planned: key art and a cast photo")}`);
    const keys = [...Object.keys(KEY_ART), CAST_PHOTO_KEY];
    // The author's overrides of the story's look: for all extras, or the key art / cast photo alone.
    const x = config.extras ?? {};
    const look = (own?: { style?: string; direction?: string }) => ({ ...(own?.style ?? x.style ? { style: own?.style ?? x.style } : {}), ...(own?.direction ?? x.direction ? { direction: own?.direction ?? x.direction } : {}) });
    const overrides = Object.fromEntries([...Object.keys(KEY_ART).map((k) => [k, look(x.keyArt)]), [CAST_PHOTO_KEY, look(x.castPhoto)]].filter(([, o]) => Object.keys(o as object).length));
    // An edit in place (#150): the image, plus any likeness references, and the note.
    const edits = opts.edit ? Object.fromEntries(opts.edit.keys.map((k) => [k, { note: opts.edit!.note, ...(opts.edit!.source ? { source: opts.edit!.source } : {}), ...(opts.edit!.with?.length ? { with: opts.edit!.with } : {}) }])) : undefined;
    const result = await artStepInner(runDir, config, log.events, force, { approved, keys, ...(Object.keys(overrides).length ? { overrides } : {}), ...(opts.redo?.length ? { redoKeys: opts.redo } : {}), ...(edits ? { edits } : {}) });
    await composeExtras(runDir, config, log, roles, { ...(opts.title ? { title: opts.title } : {}), ...(opts.subtitle ? { subtitle: opts.subtitle } : {}), ...(opts.base ? { base: opts.base } : {}), ...(opts.redo?.includes("extra-logo") ? { redoLogo: true } : {}) });
    return result;
  });
}

// What text an image shows (the drawn logo's spelling check).
async function readLettering(spec: { model?: string; apiKeyEnv?: string }, img: { data: Buffer; mimeType: string }): Promise<string> {
  const model = spec.model ?? "gemini-3.8-flash";
  const data = await postJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { "x-goog-api-key": requireKey(spec.apiKeyEnv ?? "GEMINI_API_KEY") },
    { contents: [{ parts: [{ inlineData: { mimeType: img.mimeType, data: img.data.toString("base64") } }, { text: "Read the text written in this image, exactly as spelled, letter by letter. Output only that text." }] }], generationConfig: { temperature: 0 } },
    { type: "gemini", model, role: "inspector", timeoutMs: 60000, retries: 1 });
  return String(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
}

// The title logo, shelf covers and box art (#128), composited in code from
// the approved art: free, and rebuilt every time the extras run.
async function composeExtras(runDir: string, config: StoryConfig, log: EventLog, roles: ReturnType<typeof buildRoleProviders>, o: { title?: string; subtitle?: string; base?: string; redoLogo?: boolean }) {
  if (!o.title?.trim()) { console.error(`[scriptorium] ${c.dim("no title in the story file — no logo, covers or box")}`); return; }
  const artDir = join(runDir, "art");
  const extraDir = join(artDir, "extra");
  const manifest: ArtManifest = JSON.parse(await readFile(join(artDir, "art.json"), "utf8"));
  // The logo: the art director's design (once; again when the title, tone or style changes), the author's settings over it.
  const bible = replay(log.events);
  const logoSource = proseHash(JSON.stringify({ title: o.title, tone: bible.tone, style: storyArtStyle(log.events) }));
  let design = log.events.filter((e) => e.type === "logo_design").map((e) => e.data as { source: string } & LogoSettings).reverse().find((d) => d.source === logoSource);
  if (!design && roles.artdirector && !config.extras?.logo?.file) {
    const out = await designLogo(roles.artdirector, { title: o.title, tone: bible.tone, ...(storyArtStyle(log.events) ? { artStyle: storyArtStyle(log.events) } : {}), fonts: LOGO_FONTS, treatments: TREATMENTS });
    design = { source: logoSource, font: out.result.font, treatment: out.result.treatment as LogoSettings["treatment"], arc: out.result.arc, caps: out.result.caps };
    await log.append("logo_design", { ...design, reason: out.result.reason });
    console.error(`[scriptorium] ${c.ok(`logo designed: ${out.result.font}, ${out.result.treatment}${out.result.arc ? `, arched ${out.result.arc}°` : ""}`)} ${c.dim(out.result.reason)}`);
  }
  const settings: LogoSettings = { ...(design ? { font: design.font, treatment: design.treatment, arc: design.arc, caps: design.caps } : {}), ...config.extras?.logo };
  // Drawn (opt-in, "mode": "drawn"): the art director briefs, the image model letters it on green
  // that's keyed out. No real alpha, so it can't blend like typeset lettering; typeset is the default.
  const artist = resolveArtistConfig(config.artist);
  let letters: { logo: string; stacked: string; mono: string } | undefined;
  // The author's own logo wins.
  const own = config.extras?.logo;
  if (own?.file) {
    const at = (f: string) => (isAbsolute(f) ? f : resolve(o.base ?? process.cwd(), f));
    letters = await suppliedLogo({ file: at(own.file), ...(own.stackedFile ? { stackedFile: at(own.stackedFile) } : {}), outDir: extraDir });
    console.error(`[scriptorium] ${c.ok(`logo: ${own.file}`)}`);
  }
  if (!letters && config.extras?.logo?.mode === "drawn" && artist.image.type === "gemini" && roles.artdirector) {
    const record = join(extraDir, "logo.json");
    let prev: { source?: string } = {};
    try { prev = JSON.parse(await readFile(record, "utf8")); } catch { /* first logo */ }
    if (prev.source === logoSource && !o.redoLogo && await exists(join(extraDir, "logo.png"))) {
      letters = { logo: join(extraDir, "logo.png"), stacked: join(extraDir, "logo-stacked.png"), mono: join(extraDir, "logo-mono.png") };
    } else {
      const brief = (await briefLogoArt(roles.artdirector, { title: o.title, tone: bible.tone, ...(storyArtStyle(log.events) ? { artStyle: storyArtStyle(log.events) } : {}) })).result.prompt;
      const backend = makeImageBackend(artist.image);
      const inspector = artist.inspector && artist.inspector.type === "gemini" ? artist.inspector : { type: "gemini" as const, model: "gemini-3.8-flash" };
      letters = await drawLogo({
        title: o.title, brief: stripNames(brief, storyNames(log.events)).text, outDir: extraDir, log: (m) => console.error(`[scriptorium]   ${c.retry(m)}`),
        draw: {
          generate: async (req) => { const img = await backend.generate({ prompt: req.prompt, references: [], aspectRatio: req.aspectRatio, imageSize: req.imageSize }); return { data: Buffer.from(img.data), mimeType: img.mimeType }; },
          read: (img) => readLettering(inspector, img)
        }
      });
      if (letters) {
        await writeFile(record, JSON.stringify({ source: logoSource, brief }, null, 2) + "\n");
        console.error(`[scriptorium] ${c.ok("logo drawn")} ${c.dim(brief.slice(0, 140))}`);
      } else console.error(`[scriptorium] ${c.retry("the drawn logo kept misspelling the title — typeset instead")}`);
    }
  }
  const { logo, stacked, mono } = letters ?? await renderLogo({ title: o.title, ...(o.subtitle ? { subtitle: o.subtitle } : {}), outDir: extraDir, settings, ...(o.base ? { base: o.base } : {}) });
  for (const [name, c2] of Object.entries(SHELF)) {
    const key = manifest[`extra-${c2.from}`];
    if (key) await shelfCover(join(artDir, key.file), c2.stacked ? stacked : logo, join(extraDir, `${name}.jpg`), c2.size, c2.logoWidth);
  }
  console.error(`[scriptorium] ${c.ok(`logo and shelf covers → ${extraDir}/`)}`);
  if (config.extras?.box === false || !manifest["extra-keyart-2x3"]) return;
  // The box copy, written once (again when the title or story changes).
  const committed = log.events.filter((e) => e.type === "scene_committed").map((e) => e.data as SceneCommittedData);
  const source = proseHash(JSON.stringify({ title: o.title, beats: committed.map((d) => d.beat) }));
  let copy = (log.events.filter((e) => e.type === "box_copy").map((e) => e.data as { source: string } & BoxCopy).reverse().find((d) => d.source === source));
  if (!copy && roles.artdirector) {
    const out = await writeBoxCopy(roles.artdirector, { bible: replay(log.events), title: o.title, beats: committed.map((d) => d.beat) });
    copy = { source, ...out.result };
    await log.append("box_copy", copy);
  }
  if (!copy) return;
  // Four stills from across the story: the approved scene shots, spread out.
  const approved = new Set((await readApprovals(runDir)).art);
  const shots = Object.keys(manifest).filter((k) => /^scene-\d+-\d+$/.test(k)).sort();
  const pool = shots.filter((k) => approved.has(k)).length >= 4 ? shots.filter((k) => approved.has(k)) : shots;
  const stills = pool.length ? [0, 1, 2, 3].map((i) => join(artDir, manifest[pool[Math.min(pool.length - 1, Math.floor((i + 0.5) * pool.length / 4))]].file)) : [];
  if (stills.length < 4) return;
  await mkdir(join(extraDir, "box"), { recursive: true });
  await boxArt({ front: join(extraDir, "cover-2x3.jpg"), mono, stills, copy, out: join(extraDir, "box", "box.jpg"), ...(o.base ? { base: o.base } : {}) });
  console.error(`[scriptorium] ${c.ok(`box art → ${join(extraDir, "box", "box.jpg")}`)}`);
}

// With a budget, triage retakes are capped at what's left — worked out when
// triage starts, from what the first pass really cost (batch price included).
function triageCap(runDir: string, config: StoryConfig, _events: StoryEvent[]): { maxRetakes?: () => number } {
  if (!config.budget) return {};
  const budget = config.budget.usd;
  const batch = config.artist?.batch === true;
  return {
    maxRetakes: () => {
      const ledger = readLedger(runDir);
      const avg = (match: (e: { model: string; role: string }) => boolean) => {
        const xs = ledger.filter((e) => match(e) && e.usd !== null);
        return xs.length > 0 ? xs.reduce((a, e) => a + (e.usd ?? 0), 0) / xs.length : undefined;
      };
      // The ledger already holds batch calls at half price.
      const perImage = (avg((e) => e.model.includes("image")) ?? TYPICAL.imageUsd * (batch ? 0.5 : 1)) + (avg((e) => e.role === "inspector") ?? TYPICAL.inspectionUsd);
      const left = budget - accountantFor(runDir).spent;
      const n = Math.max(0, Math.floor(left / perImage));
      console.error(`[scriptorium] ${c.dim(`triage: ${usd(Math.max(0, left))} left in the budget — room for up to ${n} retake${n === 1 ? "" : "s"} at ${usd(perImage)} each`)}`);
      return n;
    }
  };
}

async function artStepInner(runDir: string, config: StoryConfig, events: StoryEvent[], force: boolean | undefined, lock: { approved?: ReadonlySet<string>; only?: "references"; redoKeys?: string[]; keys?: string[]; overrides?: Record<string, { style?: string; direction?: string }>; edits?: Record<string, { note: string; source?: string; with?: string[] }> } = {}) {
  const artist = resolveArtistConfig(config.artist);
  // Batch Mode: every image a stage asks for goes out together, at half price.
  const batch = artist.batch === true && artist.image.type === "gemini";
  const result = await renderArt(events, {
    runDir,
    backend: batch
      ? new BatchImageBackend(artist.image as GeminiSpec, geminiBatchJobs({ stateFile: join(runDir, "art", "batch-jobs.json"), log: (m) => console.error(`[scriptorium] ${c.dim(m)}`) }))
      : makeImageBackend(artist.image),
    inspector: artist.inspector ? makeInspector(artist.inspector) : undefined,
    maxAttempts: artist.maxAttempts,
    maxReferences: artist.maxReferences,
    concurrency: batch ? 10000 : artist.concurrency,
    ...(artist.retakes !== undefined ? { retakes: artist.retakes, retakeAbove: artist.retakeAbove, ...triageCap(runDir, config, events) } : {}),
    referenceSize: artist.referenceSize,
    inspectSize: artist.inspectSize,
    direction: artistDirection(config),
    force,
    ...lock,
    onProgress: (event) => {
      if (event.type === "job_start") console.error(`[scriptorium] ${c.blue(c.bold(`${event.key} (${event.index + 1}/${event.total})`))}`);
      else if (event.type === "job_skipped") console.error(`[scriptorium] ${c.dim(`${event.key} unchanged — skipping (${event.file})`)}`);
      else if (event.type === "attempt_rejected") console.error(`[scriptorium]   ${c.retry(`attempt ${event.attempt} rejected: ${event.issues.join("; ")}`)}`);
      else if (event.type === "job_done") console.error(`[scriptorium] ${event.accepted ? c.ok(`${event.key} written`) : c.retry(`${event.key} kept after ${event.attempts} rejected attempts`)} ${c.dim(event.file)}`);
      else if (event.type === "job_failed") console.error(`[scriptorium] ${c.fail(`${event.key} failed: ${event.error}`)}`);
      else if (event.type === "triage") console.error(`[scriptorium] ${c.blue(c.bold(`triage: ${event.scored} images scored — retaking the worst ${event.retakes}`))}`);
      else if (event.type === "names_removed") console.error(`[scriptorium]   ${c.retry(`${event.key}: removed names from the image prompt: ${event.names.join(", ")}`)}`);
      else if (event.type === "portraits_dropped") console.error(`[scriptorium]   ${c.retry(`${event.key}: more people than portraits it can take — ${event.dropped.join(", ")} drawn from their description`)}`);
      else if (event.type === "stale_approved") console.error(`[scriptorium]   ${c.retry(`${event.key}: drawn from ${event.refs.join(", ")}, which changed — approved, so it stays (revoke to reshoot)`)}`);
      else if (event.type === "retake_done") console.error(`[scriptorium]   ${event.kept ? c.ok(`${event.key}: retake kept (severity ${event.before} → ${event.after})`) : c.dim(`${event.key}: retake no better (${event.before} → ${event.after}) — kept the first`)}`);
    }
  });
  if (result.rendered + result.failed > 0) {
    console.log(`${c.ok(`art: ${result.rendered} rendered, ${result.skipped} unchanged, ${result.failed} failed →`)} ${c.cyan(result.outDir + "/")}`);
  }
  return result;
}

export interface AudiobookStepOptions {
  narratorVoice?: string;
  language?: string;
  characterGenders?: Record<string, string>;
  narration?: "kokoro" | "gemini";
  dialogue?: "kokoro" | "gemini";
  geminiModel?: string;
  geminiVoices?: Record<string, string>;
  kokoroVoices?: { include?: string[]; exclude?: string[] };
  characterVoices?: Record<string, string>;
  geminiMode?: GeminiMode;
  paletteSize?: number;  // palette mode: tones per speaker (default 4)
  freshPalette?: boolean;  // design the tone palettes anew (--redo palette); otherwise they're kept (#135)
  geminiRpm?: number;
  geminiFallback?: "kokoro" | "gemini";
  pauseScale?: number;
  geminiConcurrency?: number;
  geminiBatch?: boolean;      // batched modes through Gemini Batch Mode (half price, slower)
  casting?: boolean;          // cast Gemini voices from the library (default true when Gemini speaks)
  castingFile?: string;       // a cast list shared across chapters
  castMin?: number;           // characters spoken to earn a voice of their own; the rest are read by the narrator
  audioTags?: boolean | string[];  // performance tags in Gemini lines (#71): true, or a list of allowed sounds; off by default
  pronunciations?: Pronunciations;  // how to say the story's hard words, for every Gemini line
  designVoices?: string[];    // characters to give a designed voice
  force?: boolean;
  config?: StoryConfig;  // for spend accounting (pricing, budget)
}

// Labels who speaks each paragraph (and how) for scenes written as plain prose,
// so every story can be voiced. Uses the config's "voicedirector" role, else its
// continuist's model (a cheap one). Without a config, untagged scenes are read
// by the narrator alone.
// audioTags in the story file: true for the standard list, or a list of its tags; off by default.
export function resolveAudioTags(setting: boolean | string[] | undefined): readonly string[] | undefined {
  if (!setting) return undefined;
  if (setting === true) return VOCAL_TAGS;
  const bad = setting.filter((t) => !(VOCAL_TAGS as readonly string[]).includes(t));
  if (bad.length) throw new Error(`audiobook.audioTags: unknown tag${bad.length === 1 ? "" : "s"} ${bad.join(", ")} — use any of ${VOCAL_TAGS.join(", ")}`);
  return setting.length ? setting : undefined;
}

async function tagStep(runDir: string, events: StoryEvent[], config?: StoryConfig, palette?: TonePaletteData): Promise<StoryEvent[]> {
  const bible = replay(events);
  const known = new Set(Object.keys(bible.characters));
  const tags = sceneTags(events);
  const untagged = events.filter((e) => e.type === "scene_committed")
    .map((e) => e.data as SceneCommittedData)
    .filter((d) => (!tags.has(d.index) || (palette && tags.get(d.index)!.palette !== palette.source)) && needsTagging(d.prose, known));
  if (untagged.length === 0) return events;
  const roles = config ? buildRoleProviders(config) : undefined;
  const role = roles?.voicedirector ?? roles?.continuist;
  if (!role) {
    console.error(`[scriptorium] ${c.retry(`${untagged.length} scene${untagged.length === 1 ? "" : "s"} written without speaker tags — the narrator reads ${untagged.length === 1 ? "it" : "them"} alone (pass --config so they can be tagged)`)}`);
    return events;
  }
  const log = new EventLog(runDir);
  await log.load();
  await tagRun(log, role, (index, speakers) => {
    console.error(`[scriptorium] ${c.ok(`scene ${index + 1} tagged`)} ${c.dim(`(speakers: ${speakers.join(", ") || "narrator only"})`)}`);
  }, palette);
  return log.events;
}

export async function audiobookStep(runDir: string, events: StoryEvent[], opts: AudiobookStepOptions = {}) {
  return accounted(runDir, opts.config, "audiobook", () => audiobookStepInner(runDir, events, opts));
}

// Everything voicing needs before a word is spoken: the tone palette (palette
// mode), speaker tags, and the cast. `recast` speakers get a fresh voice.
async function prepareVoices(runDir: string, events: StoryEvent[], opts: AudiobookStepOptions, recast: string[] = []) {
  // Palette mode: design each speaker's tones from the whole script first, so
  // tagging can choose a tone for every line from them.
  let palette: TonePaletteData | undefined;
  if (opts.geminiMode === "palette") {
    const roles = opts.config ? buildRoleProviders(opts.config) : undefined;
    const role = roles?.voicedirector ?? roles?.continuist;
    if (!role) throw new Error('geminiMode "palette" needs a config (for the voice director\'s model) — pass --config');
    const log = new EventLog(runDir);
    await log.load();
    palette = await designRun(log, role, opts.paletteSize ?? 4, { fresh: opts.freshPalette });
    for (const [speaker, p] of Object.entries(palette.speakers)) console.error(`[scriptorium] ${c.dim(`palette ${speaker}: ${p.tones.join(" · ")}`)}`);
    events = log.events;
  }
  events = await tagStep(runDir, events, opts.config, palette);
  // Performance tags (#71): the sounds each scene's lines call for, once its speakers are known.
  const audioTags = resolveAudioTags(opts.audioTags);
  if (audioTags && (opts.narration === "gemini" || opts.dialogue === "gemini")) {
    const roles = opts.config ? buildRoleProviders(opts.config) : undefined;
    const role = roles?.voicedirector ?? roles?.continuist;
    if (!role) console.error(`[scriptorium] ${c.retry("audioTags needs a config (for the voice director's model) — pass --config")}`);
    else {
      const log = new EventLog(runDir);
      await log.load();
      await vocalRun(log, role, audioTags, (index, count, dropped) => {
        console.error(`[scriptorium] ${c.ok(`scene ${index + 1}: ${count} sound${count === 1 ? "" : "s"} marked`)}${dropped.length ? c.dim(` (${dropped.length} set aside: ${dropped.slice(0, 3).join("; ")})`) : ""}`);
      });
      events = log.events;
    }
  }
  // Casting: a voice from Gemini's library (or a designed one) for every speaker.
  let geminiVoices = opts.geminiVoices;
  const geminiSpeaks = opts.narration === "gemini" || opts.dialogue === "gemini";
  // Walk-on parts are read by the narrator, not cast (#105).
  const byNarrator = geminiSpeaks ? narratorReads(events, { min: opts.castMin, pinned: opts.geminiVoices }) : [];
  if (geminiSpeaks && opts.casting !== false) {
    const roles = opts.config ? buildRoleProviders(opts.config) : undefined;
    const role = roles?.voicedirector ?? roles?.continuist;
    if (role) {
      geminiVoices = await castVoiceRun({
        events, role, runDir, language: opts.language ?? "en",
        ...(opts.castingFile ? { castingFile: opts.castingFile } : {}),
        ...(opts.designVoices ? { designVoices: opts.designVoices } : {}),
        pinned: opts.geminiVoices ?? {},
        ...(opts.castMin !== undefined ? { castMin: opts.castMin } : {}),
        ...(recast.length ? { recast } : {}),
        log: (m) => console.error(m)
      });
    } else {
      console.error(`[scriptorium] ${c.retry("no config — Gemini voices assigned by gender, not cast (pass --config)")}`);
    }
  }
  // A voice pinned in the story file for a walk-on part still wins.
  if (geminiVoices) geminiVoices = Object.fromEntries(Object.entries(geminiVoices).filter(([id]) => !byNarrator.includes(id) || opts.geminiVoices?.[id]));
  return { events, palette, geminiVoices, byNarrator };
}

// The voices phase: tag and cast the story, then a short sample of every cast
// voice for the author to review (audiobook/samples/). `redo` speakers are
// cast afresh — never ones the author approved.
export async function voicesStep(runDir: string, events: StoryEvent[], opts: AudiobookStepOptions & { redo?: string[] } = {}) {
  return accounted(runDir, opts.config, "voices", async () => {
    const approved = new Set((await readApprovals(runDir)).voices);
    const locked = (opts.redo ?? []).filter((id) => approved.has(id));
    if (locked.length) throw new Error(`voice${locked.length === 1 ? "" : "s"} ${locked.join(", ")} approved — revoke the approval before recasting`);
    if (opts.narration !== "gemini" && opts.dialogue !== "gemini") throw new Error("the voices step casts Gemini voices — set audiobook narration or dialogue to \"gemini\"");
    // The author's sheet (vocal descriptions) is what casting reads.
    const log = new EventLog(runDir);
    await log.load();
    await syncCharacterSheet(runDir, log);
    events = log.events;
    const prepared = await prepareVoices(runDir, events, opts, opts.redo);
    // Only this story's speakers (a cast list shared across chapters holds others).
    const speaking = lineCounts(prepared.events);
    const voices = Object.fromEntries(Object.entries(prepared.geminiVoices ?? {}).filter(([id]) => speaking.has(id)));
    // Speakers the story gives too little to judge a voice by read an audition line instead (written once, kept).
    const need = needAuditions(prepared.events, Object.keys(voices));
    let auditions: Record<string, string> = {};
    if (need.length) {
      const bible = voicedBible(prepared.events);
      const all = need.map((id) => ({ id, name: bible.characters[id]?.name ?? id, description: [bible.characters[id]?.vocal, bible.characters[id]?.traits].filter(Boolean).join(". ") || "a minor character" }));
      // Kept per speaker: a line is rewritten only when that speaker's description changes.
      type Kept = { source: string; lines: Record<string, string>; sources?: Record<string, string> };
      const kept = log.events.filter((e) => e.type === "audition_lines").map((e) => e.data as Kept);
      for (const s of all) {
        const source = proseHash(JSON.stringify(s));
        const hit = [...kept].reverse().find((k) => k.lines[s.id] && (k.sources ? k.sources[s.id] === source : true));  // lines written before per-speaker keys: kept
        if (hit) auditions[s.id] = hit.lines[s.id];
      }
      const speakers = all.filter((s) => !auditions[s.id]);
      const roles = speakers.length && opts.config ? buildRoleProviders(opts.config) : undefined;
      const role = roles?.voicedirector ?? roles?.continuist;
      if (role) {
        const lines = (await writeAuditions(role, { tone: bible.tone, speakers })).result;
        await log.append("audition_lines", { source: proseHash(JSON.stringify(speakers)), lines, sources: Object.fromEntries(speakers.map((s) => [s.id, proseHash(JSON.stringify(s))])) });
        Object.assign(auditions, lines);
        console.error(`[scriptorium] ${c.dim(`audition lines written for ${speakers.map((s) => s.id).join(", ")} (the story gives them too little to judge by)`)}`);
      }
    }
    if (prepared.byNarrator.length) console.error(`[scriptorium] ${c.dim(`read by the narrator (too little to cast): ${prepared.byNarrator.join(", ")}`)}`);
    const flagged: CheckReport[] = [];
    const samples = await renderVoiceSamples(prepared.events, { runDir, voices, auditions, narrated: prepared.byNarrator, speak: geminiSpeaker({ ...(opts.geminiModel ? { model: opts.geminiModel } : {}), ...(opts.pronunciations ? { pronunciations: opts.pronunciations } : {}), onReport: (r) => flagged.push(r) }) });
    const checked = await speechCheckRound(runDir, "voices", flagged);
    if (checked) console.error(`[scriptorium] ${c.retry(`speech check flagged ${flagged.length} sample${flagged.length === 1 ? "" : "s"} (${flagged.filter((r) => !r.ok).length} still flagged) — every take to listen to: ${checked.dir}/legend.txt`)}`);
    for (const s of samples) console.error(`[scriptorium] ${s.made ? c.ok(`${s.name}: ${s.voice}${s.source === "audition" ? " (audition line)" : ""}`) : c.dim(`${s.name}: ${s.voice} (sample unchanged)`)}${approved.has(s.id) ? c.dim(" — approved") : ""} ${c.dim(s.file)}`);
    return samples;
  });
}

async function audiobookStepInner(runDir: string, events: StoryEvent[], opts: AudiobookStepOptions) {
  const prepared = await prepareVoices(runDir, events, opts);
  events = prepared.events;
  const { palette, geminiVoices, byNarrator } = prepared;
  const result = await generateAudiobook(events, {
    runDir,
    ...(resolveAudioTags(opts.audioTags) ? { audioTags: resolveAudioTags(opts.audioTags) } : {}),
    narratorVoice: opts.narratorVoice,
    language: opts.language,
    characterGenders: opts.characterGenders,
    narration: opts.narration,
    dialogue: opts.dialogue,
    geminiModel: opts.geminiModel,
    geminiVoices,
    ...(byNarrator.length ? { narratorReads: byNarrator } : {}),
    ...(opts.pronunciations ? { pronunciations: opts.pronunciations } : {}),
    kokoroVoices: opts.kokoroVoices,
    characterVoices: opts.characterVoices,
    geminiMode: opts.geminiMode,
    palette,
    geminiRpm: opts.geminiRpm,
    geminiFallback: opts.geminiFallback,
    pauseScale: opts.pauseScale,
    geminiConcurrency: opts.geminiConcurrency,
    geminiBatch: opts.geminiBatch,
    force: opts.force,
    onProgress: (event) => {
      if (event.type === "model_loading") console.error(`[scriptorium] ${c.dim("loading Kokoro model (first run downloads it — this can take a while)...")}`);
      else if (event.type === "model_ready") console.error(`[scriptorium] ${c.ok("model ready")}`);
      else if (event.type === "line_fallback") console.error(`[scriptorium]   ${c.retry(`Gemini TTS failed for ${event.speaker}, used Kokoro for that line: ${event.error.slice(0, 120)}`)}`);
      else if (event.type === "scene_skipped") console.error(`[scriptorium] ${c.dim(`scene ${event.index + 1} unchanged — skipping (${event.path})`)}`);
      else if (event.type === "scene_start") console.error(`[scriptorium] ${c.blue(c.bold(`scene ${event.index + 1}/${event.total}`))} ${c.dim(`(${event.segments} segment${event.segments === 1 ? "" : "s"})`)}`);
      else if (event.type === "chunk_done") console.error(`[scriptorium]   ${c.dim(`[${event.speaker}] ${event.text.slice(0, 60)}${event.text.length > 60 ? "..." : ""}`)}`);
      else if (event.type === "segment_done") console.error(`[scriptorium]   ${c.dim(`segment ${event.segmentIndex + 1}/${event.segments} (${event.speaker}) done`)}`);
      else if (event.type === "scene_done") console.error(`[scriptorium] ${c.ok(`scene ${event.index + 1} written`)} ${c.dim(event.path)}`);
      else if (event.type === "batch_done") console.error(`[scriptorium]   ${c.dim(`batch ${event.batch}/${event.batches}: ${event.speaker}${event.tone ? ` (${event.tone})` : ""}, ${event.lines} line${event.lines === 1 ? "" : "s"}${event.cached ? " — kept from an earlier run" : ""}`)}`);
      else if (event.type === "batch_failed") console.error(`[scriptorium]   ${c.retry(`batch for ${event.speaker} (${event.lines} line${event.lines === 1 ? "" : "s"}) didn't cut cleanly — ${event.split ? "trying it in two halves" : "voicing the line on its own"}: ${event.error.slice(0, 120)}`)}`);
      else if (event.type === "line_kept_long") console.error(`[scriptorium]   ${c.retry(`${event.speaker}: every Gemini take ran long — kept the shortest (${event.seconds.toFixed(1)}s); check this line`)}`);
    }
  });
  await writeVoiceMap(result.outDir, result.voices);
  console.log(`${c.ok(`${result.rendered} scene${result.rendered === 1 ? "" : "s"} rendered, ${result.skipped} unchanged →`)} ${c.cyan(result.outDir + "/")}`);
  return result;
}

// The score: the music director's cue sheet, then each cue from Lyria, checked
// for voices and retaken until clean. Paid (a flat price per cue); the mix
// under the narration happens in the video step and costs nothing.
export async function musicStep(runDir: string, config: StoryConfig, settings: MusicSettings, opts: { force?: boolean; compose?: Compose; check?: VoiceCheck } = {}) {
  return accounted(runDir, config, "music", async () => {
    const log = new EventLog(runDir);
    await log.load();
    const roles = buildRoleProviders(config);
    const lengths = await sceneSeconds(runDir);
    const { sheet, made } = await cueSheetFor(log, roles.musicdirector ?? roles.continuist, settings, lengths);
    console.error(`[scriptorium] ${c.dim(`${made ? "cue sheet written" : "cue sheet unchanged"} — sound: ${sheet.style}`)}`);
    // The author's own tracks (#174) stand in for the cues they cover.
    const cues = cuesToMake(cuesFromSheet(sheet, lengths), settings);
    const index = await generateCues(runDir, cues, {
      compose: opts.compose ?? lyriaComposer(),
      check: opts.check ?? geminiVoiceCheck(),
      model: settings.model, maxTakes: settings.maxTakes, force: opts.force,
      onProgress: (e) => {
        if (e.type === "cue_kept") console.error(`[scriptorium] ${c.dim(`${e.id} unchanged${e.clean ? "" : " (failed before; change its prompt or --force to retry)"}`)}`);
        else if (e.type === "take" && e.findings.length) console.error(`[scriptorium]   ${c.retry(`${e.id} take ${e.take} (${e.model}) has a voice — set aside: ${e.findings[0].slice(0, 120)}`)}`);
        else if (e.type === "cue_done") console.error(`[scriptorium] ${e.clean ? c.ok(`${e.id} made (${e.model}, ${e.takes} take${e.takes === 1 ? "" : "s"})`) : c.retry(`${e.id}: every take had a voice — this cue is left out`)}`);
      }
    });
    const clean = cues.filter((q) => index[q.id]?.clean).length;
    console.log(`${c.ok(`${clean} of ${cues.length} cues ready →`)} ${c.cyan(join(runDir, "music") + "/")}`);
    return index;
  });
}

export interface VideoStepOptions {
  pronunciations?: Pronunciations;  // for the narrated title
  encoder?: EncoderChoice;
  parallel?: number;
  titles?: TitleSettings | false;   // false: the plain cut, no cards
  title?: string;
  subtitle?: string;
  series?: { next?: string };
  contextPaths?: string[];          // the author's plan, for scene titles
  base?: string;                    // where relative font paths resolve
  gemini?: boolean;                 // the audiobook spoke with Gemini voices
  geminiModel?: string;             // for the narrated title
  music?: MusicSettings;            // lay the score under the narration
  config?: StoryConfig;             // for "crawl": true — the director drafts the crawl (#145); a rating's card (#88)
}

// A draft of the opening crawl (#145), from the author's notes, ending just
// before the film's first line. One short call to the story's best writer (a
// cheap model retells the first scene however it's told not to); paid, so
// accounted to the video step.
function crawlDrafter(runDir: string, events: StoryEvent[], opts: VideoStepOptions): (() => Promise<string[]>) | undefined {
  const roles = opts.config ? buildRoleProviders(opts.config) : undefined;
  const role = roles?.editor ?? roles?.writer ?? roles?.director ?? roles?.continuist;
  if (!role) return undefined;
  return () => accounted(runDir, opts.config, "video", async () => {
    const notes = (await Promise.all((opts.contextPaths ?? []).map((p) => readFile(p, "utf8").catch(() => "")))).filter(Boolean).join("\n\n");
    const first = events.filter((e) => e.type === "scene_committed").map((e) => e.data as SceneCommittedData).sort((a, b) => a.index - b.index)[0];
    // What scene 1 shows: its beat when the run has one, else its whole prose.
    const b = first?.beat;
    const sceneOne = b ? [b.goal, b.conflict, b.mustReveal, b.turn, ...(b.constraints ?? [])].filter(Boolean).join("\n") : first?.prose ?? "";
    const firstLine = (first?.prose ?? "").split(/\n\s*\n/)[0] ?? "";
    return (await draftCrawl(role, { notes, firstLine, sceneOne, ...(opts.title ? { title: opts.title } : {}) })).result;
  });
}

export async function videoStep(runDir: string, events: StoryEvent[], force: boolean | undefined, opts: VideoStepOptions = {}) {
  const titles = opts.titles === false ? undefined : await prepareTitles(events, {
    runDir,
    title: opts.title,
    subtitle: opts.subtitle,
    series: opts.series,
    settings: opts.titles,
    contextPaths: opts.contextPaths,
    gemini: opts.gemini,
    base: opts.base,
    speak: geminiSpeaker({ ...(opts.geminiModel ? { model: opts.geminiModel } : {}), ...(opts.pronunciations ? { pronunciations: opts.pronunciations } : {}) }),
    onNote: (m) => console.error(`[scriptorium] ${c.dim(m)}`),
    ...(opts.titles && opts.titles.crawl === true ? { draftCrawl: crawlDrafter(runDir, events, opts) } : {}),
    ...(opts.config?.rating?.card ? { rating: ratingCard(opts.config.rating) } : {}),
    ...(opts.music?.tracks?.some((t) => t.credit) ? { musicCredits: opts.music.tracks.map((t) => t.credit?.trim()).filter((x): x is string => Boolean(x)) } : {})
  });
  if (titles?.sceneCards) console.error(`[scriptorium] ${c.dim(`scene titles: ${Object.values(titles.sceneTitles).map((t) => t || "—").join(" · ")} (edit ${join(runDir, "video", "titles.json")})`)}`);
  let music;
  if (opts.music) {
    const timings = JSON.parse(await readFile(join(runDir, "audiobook", "timings.json"), "utf8").catch(() => '{"scenes":[]}')) as { scenes: Array<{ index: number; file: string; durationSec: number }> };
    music = await prepareMusic(runDir, timings.scenes.map((s) => ({ index: s.index, audio: `audiobook/${s.file}`, seconds: s.durationSec })), opts.music);
    if (music) console.error(`[scriptorium] ${c.dim(`music: ${music.theme ? "theme + " : ""}${Object.keys(music.beds).length} scene bed${Object.keys(music.beds).length === 1 ? "" : "s"}, ${opts.music.duck ?? MUSIC_DEFAULTS.duck} dB under the narrator`)}`);
    else console.error(`[scriptorium] ${c.retry("music is on, but there are no cues yet — run the music step first")}`);
  }
  const tty = process.stderr.isTTY === true;
  const status = new RenderStatus({ tty, write: (line) => process.stderr.write(line.startsWith("\r") ? `\r\x1b[2K[scriptorium] ${line.replace(/^\r\x1b\[2K/, "")}` : `[scriptorium] ${line}`) });
  const result = await renderVideo(events, {
    runDir,
    force,
    encoder: opts.encoder,
    parallel: opts.parallel,
    titles,
    music,
    onProgress: (event) => {
      // In a terminal, one live line (redrawn in place) carries the render's progress (#131).
      const say = (line: string) => { if (tty) process.stderr.write("\r\x1b[2K"); console.error(line); };
      if (event.type === "encoder") say(`[scriptorium] ${c.dim(`encoding with ${event.encoder === "nvenc" ? "NVENC (GPU)" : "x264 (CPU)"}, ${event.parallel} scene${event.parallel === 1 ? "" : "s"} at a time`)}`);
      else if (event.type === "warning") say(`[scriptorium] ${c.retry(event.message)}`);
      else if (event.type === "plan") status.plan(event.parts);
      else if (event.type === "part_start") { if (!tty) say(`[scriptorium] ${c.blue(c.bold(event.label))} ${c.dim(`(${Math.round(event.seconds)}s of video)`)}`); status.start(event.label, event.seconds); }
      else if (event.type === "part_progress") status.progress(event.label, event.done);
      else if (event.type === "part_skipped") { status.skip(event.label); say(`[scriptorium] ${c.dim(`${event.label} unchanged — skipping`)}`); }
      else if (event.type === "part_done") { say(`[scriptorium] ${c.ok(`${event.label} rendered in ${Math.round(event.elapsedMs / 1000)}s`)}`); status.finish(event.label); }
      else if (event.type === "muxing") { status.end(); console.error(`[scriptorium] ${c.dim("joining parts and adding narration...")}`); }
    }
  });
  const m = Math.floor(result.durationSec / 60);
  const s = Math.round(result.durationSec % 60);
  console.log(`${c.ok(`${m}m ${s}s video written to`)} ${c.cyan(result.video)} ${c.dim("(+ thumbnail.jpg, story.srt)")}`);
  return result;
}

// Loads a run's event log (for steps that read a finished or in-progress run).
export async function loadRun(runDir: string): Promise<StoryEvent[]> {
  const log = new EventLog(runDir);
  return log.load();
}
