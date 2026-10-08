import { createHash } from "node:crypto";
import { replay } from "./bible.ts";
import { designPalettes, sameSpeaker, tagSpeakers } from "./roles.ts";
import type { EventLog } from "./eventlog.ts";
import type { Character, Role, SceneCommittedData, StoryEvent } from "./types.ts";

// Speaker tagging, separate from writing: the writer writes plain prose, and
// before the audiobook the voice director labels each paragraph with who speaks it (and
// how). The labels live in "scene_tags" events beside the committed prose,
// which is never changed — story.md stays exactly what the writer wrote.

// Bumped when tagging logic changes, so scenes tagged by an older version are
// tagged again. 2: quote checks, targeted retry for dialogue tagged narrator.
export const TAGGER_VERSION = 2;

export interface SceneTagsData {
  version?: number;
  tones?: (number | null)[];  // palette mode: per paragraph, an index into its speaker's palette
  palette?: string;            // the palette (its source hash) the tones index
  checks?: string[];  // what the quote heuristics corrected, e.g. "¶12: corin → nell (attributed)"
  index: number;
  source: string;  // hash of the committed prose these tags were made for
  tags: string[];  // per paragraph: "narrator" or a speaker id
  delivery: string[];  // per paragraph: how it's performed ("" = plain)
  speakers: TaggedSpeaker[];  // speakers the bible doesn't have (a dragon, a guard)
}

export interface TaggedSpeaker {
  id: string;
  name: string;
  gender?: string;
  description?: string;
}

const TAG_LINE = /^([a-z][a-z0-9_]*):\s+/;

export function proseHash(prose: string): string {
  return createHash("sha1").update(prose).digest("hex");
}

// The paragraphs as committed (the same split the audiobook uses).
export function proseParagraphs(prose: string): string[] {
  return prose.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}

// A scene needs tags when no paragraph carries one (the writer wrote plain prose).
export function needsTagging(prose: string, known: ReadonlySet<string>): boolean {
  return !proseParagraphs(prose).some((p) => {
    const m = p.match(TAG_LINE);
    return m && (m[1] === "narrator" || known.has(m[1]));
  });
}

// ---- quote heuristics: checks that don't depend on a model ----

// Quote marks: straight " (not an inch mark after a digit) and curly “ ”.
function quoteMarks(p: string): number[] {
  const marks: number[] = [];
  for (let k = 0; k < p.length; k++) {
    const ch = p[k];
    if (ch === "\u201C" || ch === "\u201D" || (ch === '"' && !/\d/.test(p[k - 1] ?? ""))) marks.push(k);
  }
  return marks;
}

// The paragraph's spoken lines (the text between quote marks) and its narration
// (everything outside them). An unclosed quote runs to the end of the paragraph,
// the convention for speech that continues into the next one.
export function splitSpeech(p: string): { lines: string[]; narration: string } {
  const marks = quoteMarks(p);
  const lines: string[] = [];
  let narration = "";
  let at = 0;
  for (let k = 0; k < marks.length; k += 2) {
    narration += p.slice(at, marks[k]) + " ";
    const end = marks[k + 1] ?? p.length;
    const line = p.slice(marks[k] + 1, end).trim();
    if (/[\p{L}\p{N}]/u.test(line)) lines.push(line);
    at = end + 1;
  }
  narration += p.slice(at);
  return { lines, narration };
}

const SPEECH_VERBS = "said|says|asked|asks|replied|answered|whispered|muttered|murmured|called|shouted|snapped|told|added|went on|continued|repeated|breathed|hissed|growled|sighed";

// The cast member the narration explicitly attributes the line to ("Nell said",
// "said Corin", "Edrick asked"), using only name words unique to one person.
export function attributedSpeaker(narration: string, cast: { id: string; name: string }[]): string | undefined {
  const wordsOf = (name: string) => name.split(/\s+/).map((w) => w.replace(/[^\p{L}'-]/gu, "")).filter((w) => w.length > 1 && /^\p{Lu}/u.test(w));
  const owners = new Map<string, Set<string>>();
  for (const c of cast) for (const w of wordsOf(c.name)) (owners.get(w) ?? owners.set(w, new Set()).get(w)!).add(c.id);
  const found = new Set<string>();
  for (const [word, ids] of owners) {
    if (ids.size !== 1) continue;  // "Ashby" names two people
    // "Nell said", "said Nell", and "Hesketh, behind the bar, said" (the same clause, no sentence break between).
    const re = new RegExp(`\\b${word}\\b[^.!?;"\u201C\u201D]{0,40}?\\b(?:${SPEECH_VERBS})\\b|\\b(?:${SPEECH_VERBS})\\s+${word}\\b`, "u");
    if (re.test(narration)) found.add([...ids][0]);
  }
  return found.size === 1 ? [...found][0] : undefined;
}

// The quote checks. Code detects, the model decides: the only label code sets
// is the structural one (no spoken quote means narrator). Everything else —
// dialogue tagged narrator, a tag that disagrees with an explicit "Nell said",
// "she said" on a man's line — is a doubt, sent back to the voice director with the reason.
export interface TagDoubt { paragraph: number; reason: string }

export function checkTags(paragraphs: string[], tags: string[], cast: { id: string; name: string; gender?: string }[]): { tags: string[]; checks: string[]; doubts: TagDoubt[]; dialogue: number } {
  const genderOf = new Map(cast.map((c) => [c.id, c.gender]));
  const pronounRe = new RegExp(`\\b(she|he)\\s+(?:${SPEECH_VERBS})\\b|\\b(?:${SPEECH_VERBS})\\s+(she|he)\\b`, "i");
  const out = [...tags];
  const checks: string[] = [];
  const doubts: TagDoubt[] = [];
  let dialogue = 0;
  paragraphs.forEach((p, n) => {
    const { lines, narration } = splitSpeech(p);
    const tag = out[n];
    if (lines.length === 0) {
      if (tag !== "narrator") { checks.push(`¶${n + 1}: ${tag} → narrator (no dialogue)`); out[n] = "narrator"; }
      return;
    }
    dialogue++;
    if (tag === "narrator") { doubts.push({ paragraph: n, reason: "it contains a spoken line in quotation marks, so it is not narrator" }); return; }
    const said = attributedSpeaker(narration, cast);
    if (said && said !== tag) doubts.push({ paragraph: n, reason: `you said ${tag}, but the narration seems to attribute the line to ${said}` });
    const m = narration.match(pronounRe);
    const pronoun = (m?.[1] ?? m?.[2])?.toLowerCase();
    const gender = genderOf.get(tag);
    if (pronoun && gender && (pronoun === "she") !== (gender === "female")) doubts.push({ paragraph: n, reason: `the narration says "${pronoun} said", but you tagged ${tag} (${gender})` });
  });
  return { tags: out, checks, doubts, dialogue };
}

// What the narrator must never read: a quotation mark in a narrator piece is
// someone's line in the wrong voice. Returns "scene N ¶M: text" for each.
export function voicingProblems(scenes: { index: number; segments: { speaker: string; text: string; paragraphs: number[] }[] }[]): string[] {
  const out: string[] = [];
  for (const sc of scenes) {
    for (const seg of sc.segments) {
      if (seg.speaker !== "narrator") continue;
      const pieces = seg.text.split("\n\n");
      pieces.forEach((text, k) => {
        if (splitSpeech(text).lines.length > 0) {
          const p = seg.paragraphs[pieces.length === seg.paragraphs.length ? k : 0];
          out.push(`scene ${sc.index + 1} ¶${(p ?? 0) + 1}: ${text.slice(0, 90)}`);
        }
      });
    }
  }
  return out;
}

// The scene as voiced: one line per spoken piece, who reads it, and how.
export function renderScript(scenes: { index: number; segments: { speaker: string; text: string; paragraphs: number[] }[]; delivery?: Record<number, { speaker: string; note: string }> }[]): string {
  const out = ["# Audiobook script — who voices each piece, and how", ""];
  for (const sc of scenes) {
    out.push(`## Scene ${sc.index + 1}`, "");
    for (const seg of sc.segments) {
      const pieces = seg.text.split("\n\n");
      pieces.forEach((text, k) => {
        const p = seg.paragraphs[pieces.length === seg.paragraphs.length ? k : 0];
        const d = p !== undefined ? sc.delivery?.[p] : undefined;
        const how = d && d.speaker === seg.speaker ? ` _(${d.note})_` : "";
        out.push(`**${seg.speaker}**${how}: ${text}`, "");
      });
    }
  }
  return out.join("\n");
}

// The newest tags for each scene, kept only while they match its committed prose.
export function sceneTags(events: StoryEvent[]): Map<number, SceneTagsData> {
  const prose = new Map<number, string>();
  for (const e of events) if (e.type === "scene_committed") prose.set((e.data as SceneCommittedData).index, (e.data as SceneCommittedData).prose);
  const out = new Map<number, SceneTagsData>();
  for (const e of events) {
    if (e.type !== "scene_tags") continue;
    const d = e.data as SceneTagsData;
    const p = prose.get(d.index);
    if (p !== undefined && proseHash(p) === d.source && (d.version ?? 1) >= TAGGER_VERSION) out.set(d.index, d);
  }
  return out;
}

// Each speaker id the tags use, mapped to the one id that person is voiced as:
// a "new" speaker who is really a bible character, or someone already found in
// an earlier scene, takes that id.
export function speakerAliases(events: StoryEvent[]): Map<string, string> {
  const bible = replay(events);
  const known: { id: string; name: string }[] = Object.values(bible.characters).map((c) => ({ id: c.id, name: c.name }));
  const aliases = new Map<string, string>();
  for (const d of [...sceneTags(events).values()].sort((a, b) => a.index - b.index)) {
    for (const s of d.speakers) {
      const match = known.find((k) => k.id === s.id || sameSpeaker(k, s));
      if (match) { if (match.id !== s.id) aliases.set(s.id, match.id); }
      else known.push({ id: s.id, name: s.name });
    }
  }
  return aliases;
}

export function applyTags(prose: string, tags: string[]): string {
  return proseParagraphs(prose).map((p, n) => `${tags[n] ?? "narrator"}: ${p}`).join("\n\n");
}

// Speakers the voice director found that the bible doesn't have, as characters for voicing.
export function taggedCharacters(events: StoryEvent[], bibleIds: ReadonlySet<string>): Record<string, Character> {
  const out: Record<string, Character> = {};
  const aliases = speakerAliases(events);
  for (const d of sceneTags(events).values()) {
    for (const s of d.speakers) {
      if (bibleIds.has(s.id) || out[s.id]) continue;
      if (aliases.has(s.id)) continue;
      // The same person found again under another id (tags made before folding existed).
      if (Object.values(out).some((c) => sameSpeaker(c, s))) continue;
      out[s.id] = {
        id: s.id, name: s.name, traits: s.description ?? "", goal: "", voice: s.description ?? "", status: "active",
        ...(s.gender === "female" || s.gender === "male" ? { gender: s.gender } : {})
      };
    }
  }
  // Any id the tags use that nobody declared (bible or newSpeakers) is still a
  // speaker: voiced, never left to the narrator with its tag read aloud.
  for (const d of sceneTags(events).values()) {
    for (const tag of d.tags) {
      const id = aliases.get(tag) ?? tag;
      if (id === "narrator" || bibleIds.has(id) || out[id]) continue;
      out[id] = { id, name: id.replace(/[_-]+/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase()), traits: "", goal: "", voice: "", status: "active" };
    }
  }
  return out;
}

// Tags every committed scene written without tags (and not tagged yet), appending
// a scene_tags event for each. Returns the scenes tagged.
export async function tagRun(log: EventLog, role: Role, onScene: (index: number, speakers: string[]) => void = () => {}, palette?: TonePaletteData): Promise<number[]> {
  const palettes = palette ? Object.fromEntries(Object.entries(palette.speakers).map(([id, p]) => [id, p.tones])) : undefined;
  const done = sceneTags(log.events);
  const tagged: number[] = [];
  const committed = log.events.filter((e) => e.type === "scene_committed");
  // Only each scene's latest version: a superseded draft is never voiced.
  const latest = new Map(committed.map((e) => [(e.data as SceneCommittedData).index, e]));
  for (const e of committed) {
    const d = e.data as SceneCommittedData;
    if (latest.get(d.index) !== e) continue;
    // The cast as it stood once this scene was committed, plus speakers already found.
    const bible = replay(log.events.slice(0, log.events.indexOf(e) + 1));
    const known = new Set(Object.keys(bible.characters));
    // Tagged already — unless palette mode needs tones from this palette.
    const prior = done.get(d.index);
    if ((prior && (!palette || prior.palette === palette.source)) || !needsTagging(d.prose, known)) continue;
    const extra = taggedCharacters(log.events, known);
    const cast = [...Object.values(bible.characters), ...Object.values(extra)].map((c) => ({ id: c.id, name: c.name, voice: c.voice }));
    const paragraphs = proseParagraphs(d.prose);
    const out = await tagSpeakers(role, { paragraphs, cast, ...(palettes ? { palettes } : {}) });
    const tones = out.result.tones ? [...out.result.tones] : undefined;
    const tonedFor = [...out.result.tags];  // the speaker each tone was chosen for
    if (out.result.missing) console.error(`[scriptorium]   voice director skipped ${out.result.missing} paragraph${out.result.missing === 1 ? "" : "s"} of scene ${d.index + 1} — read by the narrator`);
    const genders = new Map([...Object.values(bible.characters), ...Object.values(extra)].map((c) => [c.id, c.gender]));
    const checkCast = () => [...cast.map((c) => ({ ...c, gender: genders.get(c.id) })), ...out.result.newSpeakers];
    let checked = checkTags(paragraphs, out.result.tags, checkCast());
    // Doubtful paragraphs go back to the voice director, each with the reason; it decides.
    if (checked.doubts.length > 0) {
      const ask = [...new Map(checked.doubts.map((x) => [x.paragraph, x])).values()];
      const again = await tagSpeakers(role, {
        paragraphs: ask.map((x) => paragraphs[x.paragraph]),
        cast: [...cast, ...out.result.newSpeakers.map((sp) => ({ id: sp.id, name: sp.name, voice: sp.description }))],
        ...(palettes ? { palettes } : {}),
        note: `Look again at these paragraphs; a check doubted your first answer:\n${ask.map((x, k) => `- [${k + 1}] ${x.reason}`).join("\n")}\nA paragraph with a spoken line in quotation marks is never narrator. If the speaker isn't in CAST, add them to newSpeakers.`
      });
      const retagged = [...checked.tags];
      ask.forEach((x, k) => {
        const tag = again.result.tags[k];
        if (tag !== retagged[x.paragraph]) { checked.checks.push(`¶${x.paragraph + 1}: ${retagged[x.paragraph]} → ${tag} (asked again: ${x.reason})`); retagged[x.paragraph] = tag; }
        if (tones) { tones[x.paragraph] = again.result.tones?.[k] ?? null; tonedFor[x.paragraph] = tag; }
      });
      for (const sp of again.result.newSpeakers) if (!out.result.newSpeakers.some((y) => y.id === sp.id)) out.result.newSpeakers.push(sp);
      const before = checked.checks;
      checked = checkTags(paragraphs, retagged, checkCast());
      checked.checks = [...before, ...checked.checks];
    }
    const stillNarrator = checked.doubts.filter((x) => checked.tags[x.paragraph] === "narrator");
    console.error(`[scriptorium]   scene ${d.index + 1}: ${paragraphs.length} paragraphs, ${checked.dialogue} with dialogue, ${checked.checks.length} corrected by quote checks`);
    for (const x of stillNarrator) console.error(`[scriptorium]   ✗ scene ${d.index + 1} ¶${x.paragraph + 1}: dialogue still tagged narrator — the narrator will read the line: ${paragraphs[x.paragraph].slice(0, 80)}`);
    for (const ch of checked.checks) console.error(`[scriptorium]     ${ch}`);
    // A tone is kept only while it indexes the final speaker's palette (a quote check may have changed the speaker).
    const finalTones = tones && palettes ? checked.tags.map((tag, n) => (tag === tonedFor[n] && tones[n] !== null && tones[n]! < (palettes[tag]?.length ?? 0) ? tones[n] : null)) : undefined;
    // Paragraphs the edit didn't touch keep their earlier tag, tone and delivery,
    // so their voice requests (and caches) stay the same (#135).
    const delivery = [...out.result.delivery];
    const kept = keepUnchanged(log.events, d.index, paragraphs, { tags: checked.tags, delivery, ...(finalTones ? { tones: finalTones } : {}) }, palette?.source);
    if (kept > 0) console.error(`[scriptorium]   scene ${d.index + 1}: ${kept} unchanged paragraph${kept === 1 ? "" : "s"} keep their earlier tags and tones`);
    const data: SceneTagsData = {
      version: TAGGER_VERSION, index: d.index, source: proseHash(d.prose), tags: checked.tags, delivery, speakers: out.result.newSpeakers,
      ...(checked.checks.length ? { checks: checked.checks } : {}),
      ...(finalTones && palette ? { tones: finalTones, palette: palette.source } : {})
    };
    await log.append("scene_tags", data);
    tagged.push(d.index);
    onScene(d.index, [...new Set(checked.tags.filter((t) => t !== "narrator"))]);
  }
  return tagged;
}

// The scene's previous tags (for an earlier version of its prose, under the
// same palette) and that prose, newest first; undefined when there are none.
export function previousTags(events: StoryEvent[], index: number, palette?: string): { tags: SceneTagsData; prose: string } | undefined {
  const proseBy = new Map<string, string>();
  for (const e of events) if (e.type === "scene_committed" && (e.data as SceneCommittedData).index === index) proseBy.set(proseHash((e.data as SceneCommittedData).prose), (e.data as SceneCommittedData).prose);
  for (const e of [...events].reverse()) {
    if (e.type !== "scene_tags") continue;
    const t = e.data as SceneTagsData;
    if (t.index !== index || (t.version ?? 1) < TAGGER_VERSION || (palette !== undefined && t.palette !== palette)) continue;
    const prose = proseBy.get(t.source);
    if (prose !== undefined) return { tags: t, prose };
  }
  return undefined;
}

// Copies the earlier tag, tone and delivery onto each paragraph whose text is
// unchanged since the scene was last tagged (each earlier paragraph used once).
// Returns how many paragraphs kept theirs.
export function keepUnchanged(events: StoryEvent[], index: number, paragraphs: string[], into: { tags: string[]; delivery: string[]; tones?: (number | null)[] }, palette?: string): number {
  const before = previousTags(events, index, palette);
  if (!before) return 0;
  const old = proseParagraphs(before.prose);
  const unused = new Map<string, number[]>();
  old.forEach((p, i) => unused.set(p, [...(unused.get(p) ?? []), i]));
  let kept = 0;
  paragraphs.forEach((p, n) => {
    const i = unused.get(p)?.shift();
    if (i === undefined || before.tags.tags[i] === undefined) return;
    into.tags[n] = before.tags.tags[i];
    into.delivery[n] = before.tags.delivery[i] ?? "";
    if (into.tones) into.tones[n] = before.tags.tones?.[i] ?? null;
    kept++;
  });
  return kept;
}

// How much of the book has to be voiced again because its prose changed since
// it was tagged (#149): the words of paragraphs that are new or edited, as a
// share of all the book's words. A scene never tagged counts whole.
export function changedShare(events: StoryEvent[]): number {
  const current = sceneTags(events);
  let changed = 0;
  let total = 0;
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  const latest = new Map<number, string>();
  for (const e of events) if (e.type === "scene_committed") latest.set((e.data as SceneCommittedData).index, (e.data as SceneCommittedData).prose);
  for (const [index, prose] of latest) {
    const paragraphs = proseParagraphs(prose);
    total += paragraphs.reduce((n, p) => n + words(p), 0);
    if (current.has(index)) continue;
    const before = previousTags(events, index);
    const old = new Set(before ? proseParagraphs(before.prose) : []);
    changed += paragraphs.filter((p) => !old.has(p)).reduce((n, p) => n + words(p), 0);
  }
  return total > 0 ? changed / total : 0;
}

// ---- tone palettes (geminiMode "palette") ----

// Bumped when palette logic changes, so palettes made by older logic are remade.
// 4: the narrator's palette is designed from the script like everyone's (#90).
const PALETTE_VERSION = 4;

export interface TonePaletteData {
  version?: number;
  size: number;
  source: string;  // hash of what it was designed from (script, cast, size)
  speakers: Record<string, { tones: string[] }>;  // includes "narrator" (its first tone is its home register)
}

function paletteInputs(events: StoryEvent[], size: number) {
  const committed = events.filter((e) => e.type === "scene_committed").map((e) => e.data as SceneCommittedData).sort((a, b) => a.index - b.index);
  const bible = replay(events);
  const known = new Set(Object.keys(bible.characters));
  const cast = [...Object.values(bible.characters), ...Object.values(taggedCharacters(events, known))].map((c) => ({ id: c.id, name: c.name, voice: c.voice }));
  const script = committed.map((d) => `=== SCENE ${d.index + 1} ===\n${d.prose}`).join("\n\n");
  const source = proseHash(JSON.stringify({ version: PALETTE_VERSION, size, script, cast: cast.map((c) => c.id) }));
  return { cast, script, source };
}

// The story's palette: the newest one made by this palette logic at this size.
// It is kept when the script changes (#135): a prose edit re-designing every
// tone would re-tag and re-voice the whole book. `fresh` asks for a new one.
export function latestPalette(events: StoryEvent[], size: number): TonePaletteData | undefined {
  const e = [...events].reverse().find((x) => x.type === "tone_palette" && (x.data as TonePaletteData).version === PALETTE_VERSION && (x.data as TonePaletteData).size === size);
  return e?.data as TonePaletteData | undefined;
}

// Designs every speaker's tone palette from the whole script, the narrator's
// included: its registers come from this story. Once made it stays (#135); a
// speaker who joins later gets tones of their own, added under the same
// palette, so every scene tagged with it stays valid. `fresh` designs anew.
export async function designRun(log: EventLog, role: Role, size: number, opts: { fresh?: boolean } = {}): Promise<TonePaletteData> {
  const existing = opts.fresh ? undefined : latestPalette(log.events, size);
  const { cast, script, source } = paletteInputs(log.events, size);
  const missing = existing ? cast.filter((c) => !existing.speakers[c.id]) : cast;
  if (existing && missing.length === 0) return existing;
  const out = await designPalettes(role, { script, cast: missing, size });
  const speakers: Record<string, { tones: string[] }> = { ...existing?.speakers };
  for (const [id, tones] of Object.entries(out.result)) if (!existing || !speakers[id]) speakers[id] = { tones };
  const data: TonePaletteData = { version: PALETTE_VERSION, size, source: existing?.source ?? source, speakers };
  await log.append("tone_palette", data);
  return data;
}

// The palette tone each piece is performed in: (scene, paragraph, speaker) -> tone,
// from scene tags made with this palette. A piece whose speaker isn't the
// paragraph's tagged speaker (narration around a quote) has no tone of its own.
export function paletteToneFor(events: StoryEvent[], palette: TonePaletteData): (scene: number, paragraph: number, speaker: string) => string | undefined {
  const tags = sceneTags(events);
  const aliases = speakerAliases(events);
  return (scene, paragraph, speaker) => {
    const t = tags.get(scene);
    if (!t || t.palette !== palette.source || !t.tones) return undefined;
    const tagged = aliases.get(t.tags[paragraph]) ?? t.tags[paragraph];
    const i = t.tones[paragraph];
    if (tagged !== speaker || i === null || i === undefined) return speaker === "narrator" ? palette.speakers.narrator?.tones[0] : undefined;
    return palette.speakers[speaker]?.tones[i];
  };
}
