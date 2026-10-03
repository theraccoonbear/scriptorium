import { createHash } from "node:crypto";
import { replay } from "./bible.ts";
import { sameSpeaker, tagSpeakers } from "./roles.ts";
import type { EventLog } from "./eventlog.ts";
import type { Character, Role, SceneCommittedData, StoryEvent } from "./types.ts";

// Speaker tagging, separate from writing: the writer writes plain prose, and
// before the audiobook a tagger labels each paragraph with who speaks it (and
// how). The labels live in "scene_tags" events beside the committed prose,
// which is never changed — story.md stays exactly what the writer wrote.

export interface SceneTagsData {
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
    const re = new RegExp(`\\b${word}\\s+(?:${SPEECH_VERBS})\\b|\\b(?:${SPEECH_VERBS})\\s+${word}\\b`, "u");
    if (re.test(narration)) found.add([...ids][0]);
  }
  return found.size === 1 ? [...found][0] : undefined;
}

// Applies the quote heuristics to a tagging: no quotes means narrator; an
// explicit attribution wins; dialogue tagged narrator is rescued by attribution.
export function checkTags(paragraphs: string[], tags: string[], cast: { id: string; name: string; gender?: string }[]): { tags: string[]; checks: string[]; dialogue: number; unresolved: number } {
  const genderOf = new Map(cast.map((c) => [c.id, c.gender]));
  const pronounRe = new RegExp(`\\b(she|he)\\s+(?:${SPEECH_VERBS})\\b|\\b(?:${SPEECH_VERBS})\\s+(she|he)\\b`, "i");
  const out = [...tags];
  const checks: string[] = [];
  let dialogue = 0;
  let unresolved = 0;
  paragraphs.forEach((p, n) => {
    const { lines, narration } = splitSpeech(p);
    const tag = out[n];
    if (lines.length === 0) {
      if (tag !== "narrator") { checks.push(`¶${n + 1}: ${tag} → narrator (no dialogue)`); out[n] = "narrator"; }
      return;
    }
    dialogue++;
    const said = attributedSpeaker(narration, cast);
    if (said && said !== tag) { checks.push(`¶${n + 1}: ${tag} → ${said} (attributed)`); out[n] = said; }
    else if (!said && tag === "narrator") unresolved++;
    // "she said" on a man's line (or "he said" on a woman's) is flagged, not fixed: a pronoun can't say which woman.
    const m = narration.match(pronounRe);
    const pronoun = (m?.[1] ?? m?.[2])?.toLowerCase();
    const gender = genderOf.get(out[n]);
    if (pronoun && gender && (pronoun === "she") !== (gender === "female")) checks.push(`¶${n + 1}: "${pronoun} said" but tagged ${out[n]} (${gender}) — check`);
  });
  return { tags: out, checks, dialogue, unresolved };
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
    if (p !== undefined && proseHash(p) === d.source) out.set(d.index, d);
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

// Speakers the tagger found that the bible doesn't have, as characters for voicing.
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
  return out;
}

// Tags every committed scene written without tags (and not tagged yet), appending
// a scene_tags event for each. Returns the scenes tagged.
export async function tagRun(log: EventLog, role: Role, onScene: (index: number, speakers: string[]) => void = () => {}): Promise<number[]> {
  const done = sceneTags(log.events);
  const tagged: number[] = [];
  const committed = log.events.filter((e) => e.type === "scene_committed");
  for (const e of committed) {
    const d = e.data as SceneCommittedData;
    // The cast as it stood once this scene was committed, plus speakers already found.
    const bible = replay(log.events.slice(0, log.events.indexOf(e) + 1));
    const known = new Set(Object.keys(bible.characters));
    if (done.has(d.index) || !needsTagging(d.prose, known)) continue;
    const extra = taggedCharacters(log.events, known);
    const cast = [...Object.values(bible.characters), ...Object.values(extra)].map((c) => ({ id: c.id, name: c.name, voice: c.voice }));
    const paragraphs = proseParagraphs(d.prose);
    const out = await tagSpeakers(role, { paragraphs, cast });
    if (out.result.missing) console.error(`[scriptorium]   tagger skipped ${out.result.missing} paragraph${out.result.missing === 1 ? "" : "s"} of scene ${d.index + 1} — read by the narrator`);
    const genders = new Map([...Object.values(bible.characters), ...Object.values(extra)].map((c) => [c.id, c.gender]));
    const checked = checkTags(paragraphs, out.result.tags, [...cast.map((c) => ({ ...c, gender: genders.get(c.id) })), ...out.result.newSpeakers]);
    console.error(`[scriptorium]   scene ${d.index + 1}: ${paragraphs.length} paragraphs, ${checked.dialogue} with dialogue, ${checked.checks.length} corrected by quote checks${checked.unresolved ? `, ${checked.unresolved} with dialogue left to the narrator` : ""}`);
    for (const ch of checked.checks) console.error(`[scriptorium]     ${ch}`);
    const data: SceneTagsData = { index: d.index, source: proseHash(d.prose), tags: checked.tags, delivery: out.result.delivery, speakers: out.result.newSpeakers, ...(checked.checks.length ? { checks: checked.checks } : {}) };
    await log.append("scene_tags", data);
    tagged.push(d.index);
    onScene(d.index, [...new Set(out.result.tags.filter((t) => t !== "narrator"))]);
  }
  return tagged;
}
