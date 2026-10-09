import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StoryEvent } from "./types.ts";

// Audience ratings (#88): a story can be held to a rating the author picks —
// G, PG, PG-13, R or NC-17 (TV ratings map onto these), or a reader's age —
// with content the author forbids outright, flags for the report, or allows
// above the rating. Off unless the story file has a "rating". Not a legal
// certification: the film's rating card says it's the author's own.

export const RATING_LEVELS = ["G", "PG", "PG-13", "R", "NC-17"] as const;
export type RatingLevel = (typeof RATING_LEVELS)[number];

// TV ratings, and common spellings, onto the film scale.
const ALIASES: Record<string, RatingLevel> = {
  "G": "G", "TV-Y": "G", "TV-Y7": "G", "TV-G": "G",
  "PG": "PG", "TV-PG": "PG",
  "PG-13": "PG-13", "PG13": "PG-13", "TV-14": "PG-13",
  "R": "R", "TV-MA": "R",
  "NC-17": "NC-17", "NC17": "NC-17"
};

export const CONTENT_AREAS = ["violence", "gore", "sexual content", "nudity", "language", "drugs and alcohol", "frightening content", "themes"] as const;
export type ContentArea = (typeof CONTENT_AREAS)[number];

// What each rating allows, area by area. Written for a model to apply.
export const RATING_LIMITS: Record<RatingLevel, Record<ContentArea, string>> = {
  "G": {
    "violence": "only cartoonish or slapstick, no one is hurt in a way that lingers; no weapons used on people",
    "gore": "none: no blood, no wounds",
    "sexual content": "none beyond a hug or a kiss on the cheek",
    "nudity": "none",
    "language": "none: no swearing or insults stronger than 'silly' or 'rotten'",
    "drugs and alcohol": "none shown or mentioned as fun; no drunkenness",
    "frightening content": "gentle: a villain may be grumpy or a storm loud, but nothing that would frighten a small child; peril resolves quickly and safely",
    "themes": "simple and reassuring; no death of loved ones on page, no cruelty"
  },
  "PG": {
    "violence": "mild and brief fantasy action; injuries without detail; no killing shown on page",
    "gore": "none: a scrape or a bruise at most",
    "sexual content": "none beyond brief kissing; innuendo only if it would go over a child's head",
    "nudity": "none",
    "language": "very mild ('darn', 'blast', 'idiot'); stronger swearing reported, not quoted ('he swore')",
    "drugs and alcohol": "adults may drink in passing; no drunkenness played for laughs at length, no drug use",
    "frightening content": "mild peril and scary moments that resolve; monsters may menace but not maim",
    "themes": "may touch loss or danger gently; nothing bleak or cruel"
  },
  "PG-13": {
    "violence": "action and fights with impact but without lingering on injury; deaths may happen, off page or briefly",
    "gore": "minimal: some blood, no graphic wounds",
    "sexual content": "suggestive references and kissing; anything more happens off page",
    "nudity": "none, or brief and non-sexual",
    "language": "moderate swearing; at most one strong word",
    "drugs and alcohol": "drinking and drunkenness; drug use only brief, off page or played as comedy",
    "frightening content": "intense peril and frightening sequences",
    "themes": "mature themes handled with care"
  },
  "R": {
    "violence": "strong violence",
    "gore": "some graphic wounds and blood",
    "sexual content": "sex scenes may be implied or brief, not explicit",
    "nudity": "some",
    "language": "strong language",
    "drugs and alcohol": "drug use may be shown",
    "frightening content": "sustained horror and terror",
    "themes": "adult themes"
  },
  "NC-17": {
    "violence": "anything the story needs",
    "gore": "anything the story needs",
    "sexual content": "adult content, never involving minors",
    "nudity": "anything the story needs",
    "language": "anything",
    "drugs and alcohol": "anything",
    "frightening content": "anything",
    "themes": "anything"
  }
};

export const RATING_TAGLINES: Record<RatingLevel, string> = {
  "G": "General audiences: all ages admitted",
  "PG": "Parental guidance suggested",
  "PG-13": "Parents strongly cautioned: some material may be inappropriate for children under 13",
  "R": "Restricted: under 17 should watch with a parent",
  "NC-17": "Adults only"
};

// A reader's age, when no rating is given: the rating a parent would pick.
export function ratingForAge(age: number): RatingLevel {
  return age < 8 ? "G" : age < 13 ? "PG" : age < 17 ? "PG-13" : "R";
}

export interface RatingPolicy {
  base: RatingLevel;
  label: string;          // as the story file named it ("TV-Y7", "PG")
  age?: number;
  forbid: string[];       // never, whatever the base allows: always blocks
  flag: string[];         // allowed, but reported
  allow: string[];        // allowed above the base
  card: boolean;          // a rating card at the start of the film
  reasons?: string;       // the card's "Rated PG for …" (else drawn from flag)
  acceptPlan?: boolean;   // write even though the author's plan exceeds the rating
}

export type RatingSetting = string | {
  base?: string; age?: number; forbid?: string[]; flag?: string[]; allow?: string[];
  card?: boolean; reasons?: string; acceptPlan?: boolean; mode?: unknown;
};

// The story file's "rating", checked and resolved. Throws on a bad setting.
export function resolveRating(raw: RatingSetting | undefined, where = "rating"): RatingPolicy | undefined {
  if (raw === undefined) return undefined;
  const r = typeof raw === "string" ? { base: raw } : raw;
  if (typeof r !== "object" || r === null) throw new Error(`${where} must be a rating ("PG") or { base, age, forbid, flag, allow, mode, card }`);
  if (r.age !== undefined && !(Number.isInteger(r.age) && r.age > 0 && r.age < 120)) throw new Error(`${where}.age must be a whole number of years`);
  if (r.base === undefined && r.age === undefined) throw new Error(`${where} needs a base rating or an age`);
  const label = (r.base ?? ratingForAge(r.age!)).toUpperCase().trim();
  const base = ALIASES[label];
  if (!base) throw new Error(`${where}: unknown rating "${r.base}" (use ${RATING_LEVELS.join(", ")} or TV-Y, TV-Y7, TV-G, TV-PG, TV-14, TV-MA)`);
  const list = (k: "forbid" | "flag" | "allow") => {
    const v = r[k];
    if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === "string"))) throw new Error(`${where}.${k} must be a list of things, in words`);
    return (v ?? []).map((x) => x.trim()).filter(Boolean);
  };
  // The censor always blocks: a rating that only advised would be no rating.
  if (r.mode !== undefined) throw new Error(`${where}.mode: there's no mode — the censor always blocks a scene past the rating`);
  return {
    base, label, ...(r.age !== undefined ? { age: r.age } : {}),
    forbid: list("forbid"), flag: list("flag"), allow: list("allow"),
    card: r.card ?? true,
    ...(r.reasons?.trim() ? { reasons: r.reasons.trim() } : {}),
    ...(r.acceptPlan ? { acceptPlan: true } : {})
  };
}

// The policy in words, for every creative role and the censor.
export function policyText(p: RatingPolicy): string {
  const limits = RATING_LIMITS[p.base];
  return [
    `AUDIENCE RATING: ${p.label}${p.label !== p.base ? ` (as ${p.base})` : ""}${p.age ? `, for readers aged ${p.age}` : ""}. A hard limit on what the story shows and says:`,
    ...CONTENT_AREAS.map((a) => `- ${a}: ${limits[a]}`),
    ...(p.allow.length ? [`ALLOWED here, above the rating: ${p.allow.join("; ")}.`] : []),
    ...(p.forbid.length ? [`NEVER, whatever the rating allows: ${p.forbid.join("; ")}.`] : []),
    ...(p.age ? [`READING LEVEL: words and sentences a ${p.age}-year-old reads (or follows when read aloud) with ease.`] : []),
    "Keep every beat, joke and turn: change how a thing is shown (cut away, happen off page, be reported rather than shown, softened in the telling), not whether it happens."
  ].join("\n");
}

// What the pictures may show (the image model and its inspector).
export function visualLimits(p: RatingPolicy): string {
  const l = RATING_LIMITS[p.base];
  return [
    `Rated ${p.base}: pictures show violence ${l.violence}; gore ${l.gore}; nudity ${l.nudity}; frightening content ${l["frightening content"]}.`,
    ...(p.forbid.length ? [`Never show: ${p.forbid.join("; ")}.`] : [])
  ].join(" ");
}

// The roles that write, plan or picture the story, and get the policy.
export const RATED_LAYERS = ["worldbuilder", "creator", "director", "beatgate", "writer", "editor", "artdirector", "voicedirector"] as const;

// The film's rating card: the rating, its tagline, why, and for whom.
export function ratingCard(p: RatingPolicy): { rating: string; tagline: string; reasons?: string; age?: string; note: string } {
  const reasons = p.reasons ?? (p.flag.length ? p.flag.join(", ") : undefined);
  return {
    rating: p.label,
    tagline: RATING_TAGLINES[p.base],
    ...(reasons ? { reasons: `Rated ${p.label} for ${reasons}` } : {}),
    ...(p.age ? { age: `Written for ages ${p.age} and up` } : {}),
    note: "Rated by the author: not an MPA or broadcaster rating"
  };
}

// <run>/rating.md (#88): the plan check, then each scene's changes and flags,
// for the author to sign off on.
export function ratingReport(events: StoryEvent[], p: RatingPolicy): string {
  const plan = events.filter((e) => e.type === "rating_plan_check").map((e) => e.data as { feasible?: boolean; reason?: string; conflicts: { item: string; why: string; options: string }[] }).at(-1);
  const scenes = new Map<number, { changed: string[]; flags: string[] }>();
  for (const e of events) if (e.type === "rating_report") { const d = e.data as { index: number; changed: string[]; flags: string[] }; scenes.set(d.index, d); }
  const lines = [
    `# Rating report: ${p.label}${p.age ? `, ages ${p.age}+` : ""}`,
    "",
    ...(p.forbid.length ? [`Never allowed: ${p.forbid.join("; ")}.`] : []),
    ...(p.allow.length ? [`Allowed above the rating: ${p.allow.join("; ")}.`] : []),
    ...(p.flag.length ? [`Flagged for parents: ${p.flag.join("; ")}.`] : []),
    "",
    "## The plan",
    !plan ? "Not checked." : plan.feasible === false ? `**Refused:** this story can't be told at ${p.label}. ${plan.reason ?? ""}` : plan.conflicts.length ? plan.conflicts.map((c) => `- **${c.item}**: ${c.why}. ${c.options}`).join("\n") : "Fits the rating.",
    ""
  ];
  for (const [i, d] of [...scenes.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`## Scene ${i + 1}`, d.changed.length ? `Changed for the rating:\n${d.changed.map((x) => `- ${x}`).join("\n")}` : "Nothing changed for the rating.", ...(d.flags.length ? [`Worth a parent knowing:\n${d.flags.map((x) => `- ${x}`).join("\n")}`] : []), "");
  }
  return lines.join("\n");
}

export async function writeRatingReport(runDir: string, events: StoryEvent[], p: RatingPolicy): Promise<void> {
  await writeFile(join(runDir, "rating.md"), ratingReport(events, p) + "\n");
}
