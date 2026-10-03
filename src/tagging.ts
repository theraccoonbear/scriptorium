import { createHash } from "node:crypto";
import { replay } from "./bible.ts";
import { tagSpeakers } from "./roles.ts";
import type { EventLog } from "./eventlog.ts";
import type { Character, Role, SceneCommittedData, StoryEvent } from "./types.ts";

// Speaker tagging, separate from writing: the writer writes plain prose, and
// before the audiobook a tagger labels each paragraph with who speaks it (and
// how). The labels live in "scene_tags" events beside the committed prose,
// which is never changed — story.md stays exactly what the writer wrote.

export interface SceneTagsData {
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

export function applyTags(prose: string, tags: string[]): string {
  return proseParagraphs(prose).map((p, n) => `${tags[n] ?? "narrator"}: ${p}`).join("\n\n");
}

// Speakers the tagger found that the bible doesn't have, as characters for voicing.
export function taggedCharacters(events: StoryEvent[], bibleIds: ReadonlySet<string>): Record<string, Character> {
  const out: Record<string, Character> = {};
  for (const d of sceneTags(events).values()) {
    for (const s of d.speakers) {
      if (bibleIds.has(s.id) || out[s.id]) continue;
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
    const out = await tagSpeakers(role, { paragraphs: proseParagraphs(d.prose), cast });
    if (out.result.missing) console.error(`[scriptorium]   tagger skipped ${out.result.missing} paragraph${out.result.missing === 1 ? "" : "s"} of scene ${d.index + 1} — read by the narrator`);
    const data: SceneTagsData = { index: d.index, source: proseHash(d.prose), tags: out.result.tags, delivery: out.result.delivery, speakers: out.result.newSpeakers };
    await log.append("scene_tags", data);
    tagged.push(d.index);
    onScene(d.index, [...new Set(out.result.tags.filter((t) => t !== "narrator"))]);
  }
  return tagged;
}
