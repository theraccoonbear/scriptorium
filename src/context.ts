import { basename } from "node:path";
import type { StoryEvent } from "./types.ts";

// Author context from one or more `--context` files. Each file keeps a header
// naming its source, so roles — and the context gate — can tell which file an
// assertion came from when files are mixed and matched.

export interface ContextFile {
  name: string;  // shown in the header; the file's basename
  text: string;
}

export interface RunContextData {
  files: string[];
  text: string;
}

export function combineContexts(files: ContextFile[]): string | undefined {
  const parts = files
    .map((f) => ({ name: f.name, text: f.text.trim() }))
    .filter((f) => f.text.length > 0)
    .map((f) => `### from ${f.name}\n\n${f.text}`);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export function contextFile(path: string, text: string): ContextFile {
  return { name: basename(path), text };
}

// The context a run was started with (the newest run_context event).
export function storedContext(events: StoryEvent[]): RunContextData | undefined {
  let found: RunContextData | undefined;
  for (const e of events) if (e.type === "run_context") found = e.data as RunContextData;
  return found;
}
