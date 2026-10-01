import { replay } from "./bible.ts";
import type { CharacterArtData, StoryEvent, VisualRefData, VisualRefKind } from "./types.ts";

// The story's art style: the Creator's canon, or — for runs from before the
// Creator decided one — the style the Art Director set in an art_style event.
export function storyArtStyle(events: StoryEvent[]): string | undefined {
  const canon = replay(events).artStyle;
  if (canon) return canon;
  let set: string | undefined;
  for (const e of events) if (e.type === "art_style") set = (e.data as { style: string }).style;
  return set;
}

// Canonical visual references (characters, locations, key props) from the
// event log, newest per kind+id. Legacy `character_art` events (portraits made
// before locations and props existed) read as character references.
export function readVisualRefs(events: StoryEvent[]): VisualRefData[] {
  const refs = new Map<string, VisualRefData>();
  for (const e of events) {
    let ref: VisualRefData | undefined;
    if (e.type === "visual_ref") {
      ref = e.data as VisualRefData;
    } else if (e.type === "character_art") {
      const d = e.data as CharacterArtData;
      ref = { kind: "character", id: d.characterId, appearance: d.appearance, prompt: d.prompt };
    }
    if (ref) refs.set(refKey(ref.kind, ref.id), ref);
  }
  return [...refs.values()];
}

export function refKey(kind: VisualRefKind, id: string): string {
  return `${kind}-${id}`;
}

// id -> appearance, per kind, for handing to art direction.
export interface RefAppearances {
  characters: Record<string, string>;
  locations: Record<string, string>;
  props: Record<string, { name: string; appearance: string }>;
}

export function refAppearances(events: StoryEvent[]): RefAppearances {
  const out: RefAppearances = { characters: {}, locations: {}, props: {} };
  for (const r of readVisualRefs(events)) {
    if (r.kind === "character") out.characters[r.id] = r.appearance;
    else if (r.kind === "location") out.locations[r.id] = r.appearance;
    else out.props[r.id] = { name: r.name ?? r.id, appearance: r.appearance };
  }
  return out;
}
