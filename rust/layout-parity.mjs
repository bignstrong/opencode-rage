// node rust/layout-parity.mjs [path/to/rage.node]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire, registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mock } from "node:test";
import { centerFrame, createActivity, activityInterval } from "../src/button/activity.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const addon = require.resolve(process.argv[2] ? resolve(process.argv[2]) : "../native/rage.node");
const binding = require(addon);
require.cache[require.resolve("../native/rage.node")] = require.cache[addon];
const widths = [undefined, NaN, -1, 0, 1, 44, 44.99, 45, 72, 79.99, 80, 120, Infinity];
let frames = 0;
for (const mode of ["cycle", "breath", "rain"])
  for (const seed of [1, 15485863, 2147483646]) {
    let n = seed;
    const reference = createActivity(mode, () => (n = (n * 48271) % 2147483647) / 2147483647);
    const native = new binding.Orb(mode, seed);
    for (let tick = 0; tick < 1024; tick++) {
      const frame = reference(),
        columns = widths[tick % widths.length];
      // Interleave old and new APIs: every call must consume exactly one tick.
      if (tick % 7 === 0) assert.equal(native.frame(), frame);
      else
        assert.equal(
          native.layoutFrame(columns ?? NaN),
          centerFrame(frame, columns < 45 ? 3 : columns < 80 ? 9 : 15),
        );
      frames++;
    }
  }

const url = new URL("../src/button/dock.ts", import.meta.url).href;
const baseline = new URL(url);
baseline.search = "?reference";
const original = process.env.RAGE_REFERENCE_ROOT
  ? readFileSync(resolve(process.env.RAGE_REFERENCE_ROOT, "src/button/dock.ts"), "utf8")
  : execFileSync("tar", ["-xOzf", "rust/qa/fixtures/voice-reference.tar.gz", "src/button/dock.ts"], { cwd: root, encoding: "utf8" });
// Supply Solid mount/dispose and a direct-sibling SDK fixture. Run the actual render adapter.
const stubs = {
  "solid-js":
    "export const onMount=f=>fixture.mount=f,onCleanup=f=>fixture.stop=f,Show=()=>{},createComponent=()=>{};",
  "@opentui/solid/jsx-runtime": "export const jsx=(_,p)=>p.ref(fixture.anchor);",
  "./controls.ts": "export const ComposerButtons=()=>{};",
};
const hook = registerHooks({
  resolve(spec, ctx, next) {
    if ([url, baseline.href].includes(ctx.parentURL) && Object.hasOwn(stubs, spec))
      return { url: `data:text/javascript,${encodeURIComponent(stubs[spec])}`, shortCircuit: true };
    return next(spec, ctx);
  },
  load(spec, ctx, next) {
    if (spec === baseline.href)
      return { format: "module-typescript", source: original, shortCircuit: true };
    return next(spec, ctx);
  },
});
let transitions = 0;
try {
  const { DockedButtons: ref } = await import(baseline.href),
    { DockedButtons: native } = await import(url);
  function trace(dock, key, version) {
    const renderer = new EventEmitter();
    const text = (value, id) => ({ visible: true, plainText: value, id });
    const a = text(` ${key ?? ""} commands `, "text-1"),
      b = text(a.plainText, "text-2");
    const foreign = text(a.plainText, "other"),
      guard = text("", "box-1");
    Object.defineProperty(guard, "plainText", {
      get() {
        throw Error("inspected non-text widget");
      },
    });
    let nodes = [guard, foreign, a],
      normal = true;
    const parent = { getChildren: () => nodes };
    const anchor = { parent };
    for (const n of [a, b, foreign]) n.parent = parent;
    const f = (globalThis.fixture = { anchor });
    dock({
      renderer,
      paletteKey: () => key,
      version,
      get normal() {
        return normal;
      },
    });
    f.mount();
    const rows = [];
    const record = () =>
      rows.push([a.visible, b.visible, foreign.visible, renderer.listenerCount("frame")]);
    const sync = () => {
      renderer.emit("frame");
      record();
    };
    record();
    sync();
    normal = false;
    sync();
    nodes.push(b);
    normal = true;
    sync(); // two matches: hide neither
    b.visible = false;
    sync(); // hidden sibling is not a candidate
    a.parent = undefined;
    nodes = [foreign, b];
    b.visible = true;
    sync(); // release detached target
    b.isDestroyed = true;
    b.parent = undefined;
    nodes = [a];
    a.parent = parent;
    sync();
    anchor.isDestroyed = true;
    sync();
    f.stop?.();
    record();
    return rows;
  }
  process.env.RAGE_RUST = "1";
  for (const key of [
    undefined,
    "ctrl+p",
    " Ctrl+P ",
    "\uFEFF",
    "\u0085",
    "🚀",
    "\ud800",
    "\udfff",
    "\u0000",
  ]) {
    for (const version of ["2.4.1", "2.4.2"]) {
      const refTrace = trace(ref, key, version);
      assert.deepEqual(trace(native, key, version), refTrace);
      transitions += refTrace.length;
    }
    const label = `${key ?? ""} commands`.trim();
    for (const list of [
      [],
      ["x", label],
      [label, label],
      [` \uFEFF${label}\u2009`],
      [`\u0085${label}`],
      ["\uFFFD commands"],
    ]) {
      const matches = list.map((s, i) => (s.trim() === label ? i : -1)).filter((i) => i >= 0);
      assert.equal(
        binding.dockCommandIndex(key ?? "", list) ?? -1,
        matches.length === 1 ? matches[0] : -1,
      );
    }
  }
  // Capture real spinner setter semantics: per-field ownership must be rechecked after each write.
  const { installAgentActivity } = await import("../src/button/agent-activity.ts");
  mock.timers.enable({ apis: ["setInterval"] });
  const renderer = new EventEmitter(),
    originalFrames = Array(54).fill("■⬝■⬝■⬝■⬝");
  let restoring = false;
  const leaf = {
    id: "spinner-1",
    frameTexts: originalFrames,
    _interval: 40,
    _color: "old",
    set interval(v) {
      this._interval = v;
    },
    set frames(v) {
      this.frameTexts = v;
    },
    set color(v) {
      this._color = v;
      if (restoring) this.frameTexts = ["other plugin"];
    },
  };
  const box = (...kids) => ({ id: "box-1", getChildren: () => kids }),
    anchor = box();
  anchor.parent = box(box(box(box(leaf), { id: "text-1", plainText: "esc interrupt" })), anchor);
  renderer.width = 44;
  const stop = installAgentActivity({
    renderer,
    anchor: () => anchor,
    version: "2.4.1",
    animate: true,
    foreground: () => "fg",
  });
  assert.deepEqual(leaf.frameTexts, [" · "]);
  renderer.width = 80;
  mock.timers.tick(activityInterval - 1);
  assert.deepEqual(leaf.frameTexts, [" · "]);
  mock.timers.tick(1);
  assert.equal(leaf.frameTexts[0].length, 15);
  restoring = true;
  stop();
  assert.deepEqual(leaf.frameTexts, ["other plugin"]);
  assert.equal(leaf._interval, 40);
  console.log(
    `${frames} orb frames, ${transitions} dock lifecycle observations, 170 ms tick and restore ownership matched.`,
  );
} finally {
  mock.timers.reset();
  delete globalThis.fixture;
  hook.deregister();
}
