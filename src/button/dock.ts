import type { CliRenderer, Renderable } from "@opentui/core";
import { jsx } from "@opentui/solid/jsx-runtime";
import { createComponent, onCleanup, onMount, Show } from "solid-js";
import { ComposerButtons } from "./controls.ts";
import { rustBinding } from "../../lib/rust-binding.js";

type DockProps = Parameters<typeof ComposerButtons>[0] & {
  normal: boolean;
  version: string;
  renderer: CliRenderer;
  paletteKey: () => string | undefined;
  onAnchor?: (anchor: Renderable) => void;
};

export function DockedButtons(props: DockProps) {
  let anchor: Renderable;
  // 2.4.1 has a public footer slot but no slot for the commands label itself.
  // Match only that direct text sibling, leaving other hints and keymaps native.
  onMount(() => {
    if (props.version !== "2.4.1") return;
    const binding = rustBinding();
    let hidden: Renderable | undefined;
    const restore = () => {
      if (hidden && !hidden.isDestroyed) hidden.visible = true;
      hidden = undefined;
    };
    const sync = () => {
      if (!props.normal || !anchor?.parent || anchor.isDestroyed) return restore();
      if (hidden && !hidden.isDestroyed && hidden.parent === anchor.parent) return;
      restore();
      const key = props.paletteKey() ?? "";
      const candidates = anchor.parent
        .getChildren()
        .filter(
          (node): node is Renderable & { plainText: string } =>
            node.visible &&
            /^text-\d+$/.test(node.id) &&
            "plainText" in node &&
            typeof node.plainText === "string",
        );
      if (binding) {
        const index = binding.dockCommandIndex(
          key,
          candidates.map((node) => node.plainText),
        );
        if (index != null) hidden = candidates[index];
      } else {
        const label = `${key} commands`.trim();
        const matches = candidates.filter((node) => node.plainText.trim() === label);
        if (matches.length === 1) hidden = matches[0];
      }
      if (hidden) hidden.visible = false;
    };
    props.renderer.on("frame", sync);
    sync();
    onCleanup(() => {
      props.renderer.off("frame", sync);
      restore();
    });
  });
  return [
    jsx("box", {
      id: "voice-dock-anchor",
      position: "absolute",
      width: 0,
      height: 0,
      ref: (node: Renderable) => {
        anchor = node;
        props.onAnchor?.(node);
      },
    }),
    createComponent(Show, {
      keyed: true,
      get when() {
        return props.normal;
      },
      get children() {
        return createComponent(ComposerButtons, props);
      },
    }),
  ];
}
