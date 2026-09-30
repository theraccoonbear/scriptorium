import { mkdir, readFile, appendFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { StoryEvent } from "./types.ts";

// Append-only JSONL event log. One directory per run; forks copy a prefix.
export class EventLog {
  dir: string;
  file: string;
  events: StoryEvent[] = [];

  constructor(dir: string) {
    this.dir = dir;
    this.file = join(dir, "events.jsonl");
  }

  async load(): Promise<StoryEvent[]> {
    await mkdir(this.dir, { recursive: true });
    if (!existsSync(this.file)) {
      this.events = [];
      return this.events;
    }
    const raw = await readFile(this.file, "utf8");
    this.events = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as StoryEvent);
    return this.events;
  }

  async append(type: string, data: unknown): Promise<StoryEvent> {
    const event: StoryEvent = { seq: this.events.length, type, ts: new Date().toISOString(), data };
    await appendFile(this.file, JSON.stringify(event) + "\n", "utf8");
    this.events.push(event);
    return event;
  }

  // Copy the seed plus the first `sceneCount` committed scenes into a new run.
  static async fork(srcDir: string, sceneCount: number, dstDir: string): Promise<EventLog> {
    const src = new EventLog(srcDir);
    await src.load();
    const dst = new EventLog(dstDir);
    await mkdir(dstDir, { recursive: true });
    await writeFile(dst.file, "", "utf8");
    dst.events = [];
    let scenes = 0;
    for (const e of src.events) {
      if (e.type === "scene_committed") {
        if (scenes >= sceneCount) {
          break;
        }
        scenes += 1;
      }
      await dst.append(e.type, e.data);
    }
    return dst;
  }
}
