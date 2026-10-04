import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// What the author has signed off on, in <run>/approvals.json: images by their
// art.json key (character-nell, scene-01-03, cover) and voices by speaker id
// (narrator, nell). Approved work is never regenerated — not by re-runs,
// retakes, --force or a changed sheet — until the author revokes it.

export const APPROVALS_FILE = "approvals.json";

export interface Approvals {
  art: string[];
  voices: string[];
}

export async function readApprovals(runDir: string): Promise<Approvals> {
  try {
    const a = JSON.parse(await readFile(join(runDir, APPROVALS_FILE), "utf8")) as Partial<Approvals>;
    return { art: a.art ?? [], voices: a.voices ?? [] };
  } catch {
    return { art: [], voices: [] };
  }
}

// "voice:<id>" names a voice; anything else is an art key.
export function parseApprovalTarget(target: string): { kind: "art" | "voices"; id: string } {
  return target.startsWith("voice:") ? { kind: "voices", id: target.slice(6) } : { kind: "art", id: target };
}

export async function setApproval(runDir: string, targets: string[], approve: boolean): Promise<Approvals> {
  const a = await readApprovals(runDir);
  for (const t of targets) {
    const { kind, id } = parseApprovalTarget(t);
    const set = new Set(a[kind]);
    if (approve) set.add(id);
    else set.delete(id);
    a[kind] = [...set].sort();
  }
  await writeFile(join(runDir, APPROVALS_FILE), JSON.stringify(a, null, 2) + "\n");
  return a;
}
