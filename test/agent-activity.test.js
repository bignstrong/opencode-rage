import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installAgentActivity } from "../src/button/agent-activity.ts";
import {
  activityInterval,
  centerFrame,
  createActivity,
  alphabet,
  stillDots,
} from "../src/button/activity.ts";

test("cropping a sparse rain frame keeps a visible glyph in narrow terminals", () => {
  assert.equal(centerFrame("λ             Ψ", 3), " · ");
});

const first = ["       ·       "];
test("a busy run starts with two breaths, then rains fresh glyphs rather than replaying a frame table", () => {
  let seed = 1;
  const next = createActivity(undefined, () => (seed = (seed * 48271) % 2147483647) / 2147483647);
  const frames = Array.from({ length: 1024 }, next);
  assert.equal(frames[0], first[0]);
  assert.ok(frames.every((frame) => frame.length === 15));
  assert.match(frames[6], /^⟨.{6}●.{6}⟩$/u);
  assert.notEqual(frames[6], frames[22]);
  assert.notDeepEqual(frames.slice(32, 64), frames.slice(96, 128));
  const seen = new Set(frames.join(""));
  assert.ok(alphabet.every((c) => seen.has(c)));
});

// Captured 2.4.1 PTY shape. The native spinner exposes write-only setters;
// frameTexts and _interval are the backing fields checked before changing it.
const nativeFrames = Array.from({ length: 54 }, (_, i) => "⬝".repeat(i % 8).padEnd(8, "■"));
const spinner = () => ({
  id: "spinner-2",
  frameTexts: nativeFrames,
  _interval: 40,
  _color: (_frame, column) => (column === 0 ? 1 : 0.18),
  set color(value) {
    this._color = value;
  },
  set frames(value) {
    this.frameTexts = value;
  },
  set interval(value) {
    this._interval = value;
  },
});
function box(id, ...nodes) {
  const box = { id, getChildren: () => nodes };
  for (const child of nodes) child.parent = box;
  return box;
}
function host(leaf = spinner()) {
  const renderer = new EventEmitter();
  const label = { id: "text-462", plainText: "esc interrupt" };
  const holder = box("box-263", leaf);
  const status = box("box-149", box("box-262", holder, label));
  const anchor = box("voice-controls");
  const other = spinner();
  const parent = box("box-146", box("another-plugin", other), status, anchor);
  const install = (overrides = {}) =>
    installAgentActivity({
      version: "2.4.1",
      renderer,
      anchor: () => anchor,
      animate: true,
      foreground: () => "#eeeeee",
      ...overrides,
    });
  return { install, renderer, label, leaf, holder, status, other, parent };
}

test("changes only native frames; preserves armed hint, other plugins and latest host theme on cleanup", async (t) => {
  const h = host();
  const stop = h.install();
  t.after(stop);
  assert.deepEqual(h.leaf.frameTexts, first);
  h.renderer.width = 72;
  await new Promise((resolve) => setTimeout(resolve, activityInterval * 2));
  assert.equal(h.leaf.frameTexts[0].length, 9);
  assert.equal(h.leaf._interval, activityInterval);
  h.label.plainText = "esc again to interrupt";
  const newTheme = [...nativeFrames];
  h.leaf.frames = newTheme;
  h.renderer.emit("frame");
  assert.equal(h.leaf.frameTexts[0].trim(), "·");
  assert.equal(h.label.plainText, "esc again to interrupt");
  assert.equal(h.other.frameTexts, nativeFrames);
  stop();
  stop();
  assert.equal(h.leaf.frameTexts, newTheme);
  assert.equal(h.leaf._interval, 40);
  assert.equal(h.renderer.listenerCount("frame"), 0);
});

test("center glyph uses the supplied color, then restores the host sweep", () => {
  const h = host();
  const original = h.leaf._color;
  let text = "#eeeeee";
  const stop = h.install({ foreground: () => text });
  try {
    assert.equal(h.leaf._color(0, 7, 1, 15), "#eeeeee");
    text = "#191919";
    assert.equal(h.leaf._color(0, 7, 1, 15), "#191919");
  } finally {
    stop();
  }
  assert.equal(h.leaf._color, original);
});

test("reduced motion uses one frame; cleanup never overwrites another plugin's newer values", () => {
  const h = host();
  const stop = h.install({ animate: false });
  assert.deepEqual(h.leaf.frameTexts, [stillDots]);
  h.leaf.frames = ["third party"];
  h.leaf.interval = 80;
  const foreignColor = () => "#ff0000";
  h.leaf.color = foreignColor;
  h.renderer.emit("frame");
  stop();
  assert.deepEqual(h.leaf.frameTexts, ["third party"]);
  assert.equal(h.leaf._interval, 80);
  assert.equal(h.leaf._color, foreignColor);
});

test("static native fallback stays static and retains the original Solid text node", () => {
  const text = {
    fg: "#ffffff",
    children: ["[⋯]"],
    replace(value, index) {
      this.children[index] = value;
    },
  };
  const h = host({ id: "text-463", getTextChildren: () => [text] });
  const stop = h.install({ foreground: () => "#ec5b2b" });
  assert.equal(text.fg, "#ec5b2b");
  assert.deepEqual(text.children, [stillDots]);
  h.renderer.emit("frame");
  stop();
  assert.deepEqual(text.children, ["[⋯]"]);
  assert.equal(text.fg, "#ffffff");
});

test("unknown versions, shapes, ambiguous rows, and non-native spinners keep their visuals", () => {
  for (const setup of [
    (h) => h.install({ version: "2.4.3" }),
    (h) => {
      h.label.plainText = "indexing";
      return h.install();
    },
    (h) => {
      h.parent.getChildren().unshift(h.status);
      return h.install();
    },
    (h) => {
      h.holder.getChildren().push(box("extension"));
      return h.install();
    },
    (h) => {
      h.leaf.frameTexts = ["loading"];
      return h.install();
    },
    (h) => {
      h.leaf._interval = 80;
      return h.install();
    },
    (h) => {
      h.leaf.id = "plugin-spinner";
      return h.install();
    },
  ]) {
    const h = host();
    const stop = setup(h);
    h.renderer.emit("frame");
    assert.notDeepEqual(h.leaf.frameTexts, first);
    assert.equal(h.other.frameTexts, nativeFrames);
    stop();
  }
});

test("handles late mounting and host disposal without writing to destroyed renderables", () => {
  const h = host();
  const nodes = h.holder.getChildren();
  nodes.pop();
  const stop = h.install();
  nodes.push(h.leaf);
  h.renderer.emit("frame");
  assert.deepEqual(h.leaf.frameTexts, first);
  h.leaf.isDestroyed = true;
  const next = spinner();
  nodes.splice(0, 1, next);
  h.renderer.emit("frame");
  assert.deepEqual(h.leaf.frameTexts, first);
  assert.deepEqual(next.frameTexts, first);
  stop();
  assert.equal(next.frameTexts, nativeFrames);
});
