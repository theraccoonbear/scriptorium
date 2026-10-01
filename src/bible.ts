// The story bible is derived state. Only the archivist's patches change it,
// and it is always rebuilt by replaying the event log.
import type { Bible, Patch, StoryEvent } from "./types.ts";

const RECENT_KEEP = 2;
const ARC_CHUNK = 2;
const ARC_MAX_CHARS = 400;

export function emptyBible(): Bible {
  return {
    premise: "",
    tone: "",
    characters: {},
    locations: {},
    objects: {},
    threads: {},
    ledger: [],
    resolvedDecisions: [],
    summary: { arcs: [], recent: [] },
    sceneCount: 0
  };
}

function upsert<T>(map: Record<string, T>, item: Partial<T> & { id?: string }): void {
  if (!item || !item.id) {
    return;
  }
  map[item.id] = { ...(map[item.id] || {}), ...item } as T;
}

export function applyPatch(bible: Bible, patch: Patch | undefined, index: number): Bible {
  const next = structuredClone(bible);
  const p = patch || {};
  for (const c of p.upsertCharacters || []) {
    // A recorded gender is fixed: the audiobook voice must not flip mid-story,
    // and an empty value never erases one.
    const known = c?.id ? next.characters[c.id]?.gender : undefined;
    if (c && (known || !c.gender)) {
      const { gender: _, ...rest } = c;
      upsert(next.characters, rest);
    } else {
      upsert(next.characters, c);
    }
  }
  for (const l of p.upsertLocations || []) {
    upsert(next.locations, l);
  }
  for (const o of p.upsertObjects || []) {
    // A recorded physical description is canon: a later patch may add an owner
    // or fill in a missing description, never rewrite one.
    if (o?.id && next.objects[o.id]?.description && o.description) {
      const { description: _, ...rest } = o;
      upsert(next.objects, rest);
    } else {
      upsert(next.objects, o);
    }
  }
  for (const t of p.upsertThreads || []) {
    upsert(next.threads, t);
  }
  for (const s of p.openSetups || []) {
    if (s && s.id && !next.ledger.some((x) => x.id === s.id)) {
      next.ledger.push({ id: s.id, text: s.text || "", openedAt: index });
    }
  }
  const paid = new Set(p.paySetups || []);
  next.ledger = next.ledger.filter((s) => !paid.has(s.id));
  for (const d of p.resolveDecisions || []) {
    if (d && !next.resolvedDecisions.includes(d)) {
      next.resolvedDecisions.push(d);
    }
  }

  if (p.timeline) {
    next.summary.recent.push(`S${index + 1}: ${p.timeline}`);
  }
  // Deterministic hierarchical compaction: oldest recent lines roll into arcs.
  while (next.summary.recent.length >= RECENT_KEEP + ARC_CHUNK) {
    const chunk = next.summary.recent.splice(0, ARC_CHUNK);
    next.summary.arcs.push(chunk.join(" ").slice(0, ARC_MAX_CHARS));
  }
  next.sceneCount = index + 1;
  return next;
}

export function replay(events: StoryEvent[]): Bible {
  let bible = emptyBible();
  for (const e of events) {
    if (e.type === "scene_committed") {
      const data = e.data as { bible?: Partial<Bible>; patch?: Patch; index: number };
      // First scene may carry the initial bible state from createAndDirect.
      if (data.bible && bible.sceneCount === 0) {
        bible = { ...bible, ...data.bible };
        bible.objects ??= {};  // bibles from before key objects existed
      }
      bible = applyPatch(bible, data.patch, data.index);
    }
  }
  return bible;
}

// Compact text view handed to every role.
export function renderBible(bible: Bible): string {
  const chars = Object.values(bible.characters)
    .map((c) => `- ${c.id} (${c.name}${c.gender ? `, ${c.gender}` : ""}, ${c.status}): ${c.traits} | goal: ${c.goal} | voice: ${c.voice}`)
    .join("\n");
  const locs = Object.values(bible.locations)
    .map((l) => `- ${l.id}: ${l.name}. ${l.description}`)
    .join("\n");
  const objects = Object.values(bible.objects ?? {})
    .map((o) => `- ${o.id}: ${o.name}${o.owner ? ` (${o.owner}'s)` : ""}. ${o.description}`)
    .join("\n");
  const threads = Object.values(bible.threads)
    .map((t) => `- ${t.id}: ${t.title} [${t.status}]`)
    .join("\n");
  const ledger = bible.ledger.map((s) => `- ${s.id} (opened S${s.openedAt + 1}): ${s.text}`).join("\n");
  const decisions = bible.resolvedDecisions.map((d) => `- ${d}`).join("\n");
  return [
    `PREMISE: ${bible.premise}`,
    `TONE: ${bible.tone}`,
    ...(bible.artStyle ? [`ART STYLE: ${bible.artStyle}`] : []),
    `CHARACTERS:\n${chars || "(none)"}`,
    `LOCATIONS:\n${locs || "(none)"}`,
    `KEY OBJECTS (physical descriptions are canon):\n${objects || "(none)"}`,
    `THREADS:\n${threads || "(none)"}`,
    `OPEN SETUPS (Chekhov ledger):\n${ledger || "(none)"}`,
    `RESOLVED DECISIONS (do not re-litigate without new pressure):\n${decisions || "(none)"}`,
    `EARLIER ARCS:\n${bible.summary.arcs.join("\n") || "(none)"}`,
    `RECENT SCENES:\n${bible.summary.recent.join("\n") || "(none)"}`
  ].join("\n\n");
}
