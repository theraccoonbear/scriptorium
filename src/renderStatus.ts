// One live status line for the video's parallel renders (#131): overall
// percent, each running part's percent, speed against realtime, time left.
// In a terminal it's redrawn in place; in a log, written every so often.

export interface PartState { seconds: number; done: number; state: "queued" | "running" | "done" }

export class RenderStatus {
  private parts = new Map<string, PartState>();
  private started?: number;
  private renderedAtStart = 0;  // seconds already done (skipped parts) when rendering began
  private lastLine = -Infinity;

  private out: { tty: boolean; write: (line: string) => void; now?: () => number; every?: number };
  constructor(out: { tty: boolean; write: (line: string) => void; now?: () => number; every?: number }) { this.out = out; }

  private now() { return this.out.now?.() ?? Date.now(); }

  plan(parts: { label: string; seconds: number }[]): void {
    for (const p of parts) this.parts.set(p.label, { seconds: p.seconds, done: 0, state: "queued" });
  }
  start(label: string, seconds: number): void {
    if (this.started === undefined) { this.started = this.now(); this.renderedAtStart = this.doneSeconds(); }
    this.parts.set(label, { seconds, done: 0, state: "running" });
    this.draw();
  }
  progress(label: string, done: number): void {
    const p = this.parts.get(label);
    if (p && p.state !== "done") { p.done = Math.min(done, p.seconds); p.state = "running"; }
    this.draw();
  }
  finish(label: string): void {
    const p = this.parts.get(label);
    if (p) { p.done = p.seconds; p.state = "done"; }
    this.draw(true);
  }
  // Skipped parts count as done but not toward the speed.
  skip(label: string): void {
    const p = this.parts.get(label);
    if (p) { p.done = p.seconds; p.state = "done"; }
  }
  // Ends the in-place line.
  end(): void { if (this.out.tty) this.out.write("\n"); }

  private doneSeconds() { return [...this.parts.values()].reduce((n, p) => n + p.done, 0); }

  line(): string {
    const all = [...this.parts.values()];
    const total = all.reduce((n, p) => n + p.seconds, 0) || 1;
    const done = this.doneSeconds();
    const running = [...this.parts.entries()].filter(([, p]) => p.state === "running");
    const queued = all.filter((p) => p.state === "queued").length;
    const pct = (x: number) => `${Math.floor(x * 100)}%`;
    const parts = running.map(([label, p]) => `${label.replace(/ \(.*\)$/, "")} ${pct(p.done / (p.seconds || 1))}`);
    let tail = "";
    if (this.started !== undefined) {
      const elapsed = (this.now() - this.started) / 1000;
      const rendered = done - this.renderedAtStart;
      if (elapsed > 3 && rendered > 0) {
        const rate = rendered / elapsed;  // seconds of video per second, all parts together
        const left = (total - done) / rate;
        tail = ` · ${rate.toFixed(1)}x realtime · ~${left < 90 ? `${Math.max(1, Math.round(left))} s` : `${Math.round(left / 60)} min`} left`;
      }
    }
    return `video ${pct(done / total)}${parts.length ? ` · ${parts.join(" · ")}` : ""}${queued ? ` · ${queued} queued` : ""}${tail}`;
  }

  private draw(force = false): void {
    const t = this.now();
    const every = this.out.every ?? (this.out.tty ? 250 : 10000);
    if (!force && t - this.lastLine < every) return;
    this.lastLine = t;
    this.out.write(this.out.tty ? `\r\x1b[2K${this.line()}` : `${this.line()}\n`);
  }
}
