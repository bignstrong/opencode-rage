import type { CliRenderer, Renderable, RGBA } from "@opentui/core";
import { rustBinding } from "../../lib/rust-binding.js";
import {
  activityInterval,
  centerFrame,
  createActivity,
  stillDots,
  type ActivityMode,
} from "./activity.ts";

const still = [stillDots];
const nativeStill = "[⋯]";

interface Spinner extends Renderable {
  frameTexts: string[];
  frames: string[];
  _interval: number;
  interval: number;
  _color: RGBA | ((...args: number[]) => RGBA);
  color: Spinner["_color"];
}

interface TextGlyph {
  fg: RGBA | undefined;
  children: string[];
  replace(value: string, index: number): void;
}

function children(node?: Renderable) {
  return node?.getChildren?.() ?? [];
}

// 2.4.1 has no spinner slot: prompt.footer.status contains the status box, then
// our appended anchor. Inspect only siblings before that anchor, never the root.
function nativeIndicator(anchor: Renderable) {
  const siblings = children(anchor.parent);
  let found: Renderable | undefined;
  for (const status of siblings) {
    if (status === anchor) return found;
    if (!/^box-\d+$/.test(status.id)) continue;
    const [row, extraRow] = children(status);
    if (!row || extraRow || !/^box-\d+$/.test(row.id)) continue;
    const [holder, label, extraLabel] = children(row);
    if (!holder || !label || extraLabel || !/^box-\d+$/.test(holder.id)) continue;
    if (
      !/^text-\d+$/.test(label.id) ||
      !("plainText" in label) ||
      (label.plainText !== "esc interrupt" && label.plainText !== "esc again to interrupt")
    )
      continue;
    const [leaf, extraLeaf] = children(holder);
    if (!leaf || extraLeaf) continue;
    if (found) return; // Ambiguous, including another plugin imitating the host row.
    found = leaf;
  }
}

function staticGlyph(leaf: Renderable): TextGlyph | undefined {
  if (!/^text-\d+$/.test(leaf.id) || !("getTextChildren" in leaf)) return;
  if (typeof leaf.getTextChildren !== "function") return;
  const [text, extra] = leaf.getTextChildren();
  if (!extra && text?.children?.length === 1 && typeof text.replace === "function") return text;
}

function activityFrames(orb: ActivityMode | undefined, columns: () => number) {
  const binding = rustBinding();
  if (binding) {
    const animation = new binding.Orb(orb ?? "cycle", 1 + Math.floor(Math.random() * 2147483646));
    return () => [animation.layoutFrame(columns() ?? NaN) as string];
  }
  const next = createActivity(orb);
  return () => [centerFrame(next(), columns() < 45 ? 3 : columns() < 80 ? 9 : 15)];
}

function replaceIndicator(
  leaf: Renderable,
  moving: boolean,
  columns: () => number,
  foreground: () => RGBA,
  orb?: ActivityMode,
) {
  if (/^spinner-\d+$/.test(leaf.id)) {
    const spinner = leaf as Spinner;
    const original = spinner.frameTexts;
    if (
      spinner._interval !== 40 ||
      !("frames" in spinner) ||
      !("interval" in spinner) ||
      !("_color" in spinner) ||
      !("color" in spinner) ||
      !Array.isArray(original) ||
      original.length !== 54 ||
      !original.every((s) => /^[■⬝]{8}$/u.test(s))
    )
      return;
    const render = moving ? activityFrames(orb, columns) : () => still;
    let frames = render();
    // The host sweep dims every glyph after column zero on singleton frames.
    const originalColor = spinner._color;
    spinner.color = foreground;
    spinner.frames = frames;
    spinner.interval = activityInterval;
    const owns = () => spinner.frameTexts === frames && spinner._interval === activityInterval;
    const timer =
      moving &&
      setInterval(() => {
        if (spinner.isDestroyed || !owns()) return;
        spinner.frames = render();
        // The native setter keeps its old array if the new frame looks identical.
        frames = spinner.frameTexts;
      }, activityInterval);
    return {
      owns,
      restore: () => {
        if (timer) clearInterval(timer);
        if (spinner.isDestroyed) return;
        if (spinner._color === foreground) spinner.color = originalColor;
        if (spinner.frameTexts === frames) spinner.frames = original;
        if (spinner._interval === activityInterval) spinner.interval = 40;
      },
    };
  }
  const glyph = staticGlyph(leaf);
  if (glyph?.children[0] !== nativeStill) return;
  // Keep the original Solid text node; its parent owns style and disposal.
  const originalColor = glyph.fg;
  const color = foreground();
  glyph.fg = color;
  glyph.replace(still[0], 0);
  return {
    owns: () => glyph.children[0] === still[0],
    restore: () => {
      if (leaf.isDestroyed) return;
      if (glyph.fg === color) glyph.fg = originalColor;
      if (glyph.children[0] === still[0]) glyph.replace(nativeStill, 0);
    },
  };
}

/** Mount in a running session's appended prompt.footer.status slot; dispose on
 * idle, session/setting change, or unmount. anchor() returns our direct slot child.
 * The host owns the interrupt hint and all layout. */
export function installAgentActivity(options: {
  version: string;
  renderer: Pick<CliRenderer, "on" | "off" | "width">;
  anchor: () => Renderable | undefined;
  animate: boolean;
  foreground: () => RGBA;
  orb?: ActivityMode;
}) {
  if (options.version !== "2.4.1" || !options.renderer?.on || !options.renderer?.off)
    return () => {};
  let anchor: Renderable;
  let leaf: Renderable;
  let patch: ReturnType<typeof replaceIndicator>;
  const release = () => {
    patch?.restore();
    patch = undefined;
  };
  const sync = () => {
    if (!anchor?.parent || anchor.isDestroyed) anchor = options.anchor();
    const next = anchor?.parent && !anchor.isDestroyed ? nativeIndicator(anchor) : undefined;
    if (next === leaf && patch?.owns()) return;
    release();
    leaf = next;
    if (leaf && !leaf.isDestroyed)
      patch = replaceIndicator(
        leaf,
        options.animate,
        () => options.renderer.width,
        options.foreground,
        options.orb,
      );
  };
  options.renderer.on("frame", sync);
  sync();
  return () => {
    options.renderer.off("frame", sync);
    release();
  };
}
