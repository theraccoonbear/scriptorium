import { test } from "node:test";
import assert from "node:assert/strict";
import { RenderStatus } from "../src/renderStatus.ts";
import { parseProgress } from "../src/video.ts";

// Issue #131: live progress across the video's parallel renders.

test("ffmpeg's -progress stream gives seconds rendered and speed", () => {
  const got: Array<[number, number | undefined]> = [];
  parseProgress("frame=10\nout_time_us=12500000\nspeed=2.4x\nprogress=continue\nout_time_us=N/A\nprogress=continue\n", (d, s) => got.push([d, s]));
  assert.deepEqual(got, [[12.5, 2.4]]);
});

test("one line: overall percent, each running part, what's queued, speed and time left", () => {
  let t = 0;
  const lines: string[] = [];
  const st = new RenderStatus({ tty: false, write: (l) => lines.push(l), now: () => t, every: 0 });
  st.plan([{ label: "credits 1", seconds: 5 }, { label: "scene 1 (37 shots)", seconds: 600 }, { label: "scene 2 (30 shots)", seconds: 600 }, { label: "scene 3 (34 shots)", seconds: 600 }]);
  st.skip("credits 1");
  st.start("scene 1 (37 shots)", 600);
  st.start("scene 2 (30 shots)", 600);
  t = 100_000;
  st.progress("scene 1 (37 shots)", 300);
  st.progress("scene 2 (30 shots)", 150);
  assert.equal(st.line(), "video 25% · scene 1 50% · scene 2 25% · 1 queued · 4.5x realtime · ~5 min left");
  st.finish("scene 1 (37 shots)");
  assert.match(lines.at(-1)!, /^video 41% · scene 2 25% · 1 queued/);
});

test("in a terminal the line is redrawn in place, at most every so often", () => {
  let t = 0;
  const out: string[] = [];
  const st = new RenderStatus({ tty: true, write: (l) => out.push(l), now: () => t, every: 1000 });
  st.plan([{ label: "scene 1", seconds: 100 }]);
  st.start("scene 1", 100);
  t = 10; st.progress("scene 1", 1);
  t = 1500; st.progress("scene 1", 20);
  assert.equal(out.length, 2, "throttled");
  assert.ok(out.every((l) => l.startsWith("\r\x1b[2K")));
  st.end();
  assert.equal(out.at(-1), "\n");
});
