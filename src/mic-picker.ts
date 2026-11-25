import {
  MouseButton,
  TextAttributes,
  type ColorInput,
  type KeyEvent,
  type MouseEvent,
} from "@opentui/core";
import { jsx } from "@opentui/solid/jsx-runtime";
import { createMemo, createSignal, For, onCleanup, onMount } from "solid-js";
import type { Plugin } from "@opencode/plugin/tui";
import { rustBinding } from "../lib/rust-binding.js";
import { watchMicrophones } from "./mic-picker-watch.js";

export type MicRow = { title: string; value: string; description?: string };
export type MicDialog = Pick<Plugin.Context["ui"]["dialog"], "show" | "clear">;
export type MicTheme = { text: { base: ColorInput; muted: ColorInput } };

// The suffix of a UID selector is its last known display name and can change.
const referenceIdentity = (value: string) => value.match(/^:uid:[^:]+:/)?.[0] ?? value;
export function micIdentity(value: string): string {
  const binding = rustBinding();
  return binding
    ? JSON.parse(binding.pickerState("identity", JSON.stringify({ value })))
    : referenceIdentity(value);
}

type BuildRows = (devices: MicRow[]) => MicRow[];
type Choose = (value?: string) => void;
type Picker = {
  visible(): MicRow[];
  highlighted(row: MicRow): boolean;
  refresh(devices?: MicRow[]): void;
  input(text: string): void;
  key(name: string, ctrl: boolean): boolean;
  scroll(direction?: string): void;
  down(value: string, left: boolean): void;
  up(value: string, left: boolean, dragging: boolean): void;
  clear(): void;
};

// The old mode is also the oracle for rust/picker-parity.mjs.
export function referencePicker(current: string, buildRows: BuildRows, choose: Choose): Picker {
  const [devices, setDevices] = createSignal<MicRow[]>([]);
  const [filter, setFilter] = createSignal("");
  const [cursor, setCursor] = createSignal<string | undefined>(referenceIdentity(current));
  let pressed: string | undefined;
  const rows = createMemo(() => {
    const query = filter().trim().toLowerCase();
    return buildRows(devices()).filter((row) => row.title.toLowerCase().includes(query));
  });
  const index = createMemo(() =>
    cursor() === undefined
      ? 0
      : rows().findIndex((row) => referenceIdentity(row.value) === cursor()),
  );
  function move(delta: number) {
    const next = Math.max(0, Math.min(rows().length - 1, index() + delta));
    if (rows()[next]) setCursor(referenceIdentity(rows()[next].value));
  }
  return {
    visible() {
      const start = Math.max(0, index() - 7);
      return rows().slice(start, start + 8);
    },
    highlighted: (row) => row.value === rows()[index()]?.value,
    refresh(next) {
      if (!next) return;
      setDevices(next);
      if (cursor() === undefined && rows()[0]) setCursor(referenceIdentity(rows()[0].value));
    },
    input(text) {
      setFilter(text);
      // Pin the first matching result too: discovery must never retarget Enter.
      const row = rows()[Math.max(0, index())];
      setCursor(row && referenceIdentity(row.value));
    },
    key(name, ctrl) {
      if (name === "up" || (ctrl && name === "p")) move(-1);
      else if (name === "down" || (ctrl && name === "n")) move(1);
      else if (name === "return") {
        if (rows()[index()]) choose(rows()[index()].value);
      } else if (name === "escape") choose();
      else return false;
      return true;
    },
    scroll(direction) {
      if (direction === "up") move(-1);
      if (direction === "down") move(1);
    },
    down(value, left) {
      if (left) pressed = referenceIdentity(value);
    },
    up(value, left, dragging) {
      if (!left || dragging || pressed !== referenceIdentity(value)) return;
      const row = rows().find((item) => referenceIdentity(item.value) === pressed);
      if (row) choose(row.value);
    },
    clear() {
      pressed = undefined;
    },
  };
}

type NativeStep = (op: string, json: string) => string;
type Frame = {
  state: { cursor: string | null; filter: string; pressed: string | null };
  visible: number[];
  highlighted: number[];
  handled: boolean;
  replace: boolean;
  close: boolean;
  choice: string | null;
};

export function nativePicker(
  current: string,
  buildRows: BuildRows,
  choose: Choose,
  step: NativeStep,
): Picker {
  let rows = buildRows([]);
  const run = (op: string, args: object): Frame =>
    JSON.parse(step(op, JSON.stringify({ rows, ...args })));
  const [frame, setFrame] = createSignal(run("init", { current }));
  function dispatch(op: string, args: object = {}, next?: MicRow[]) {
    const result = run(op, { state: frame().state, ...args, next });
    if (result.replace && next) rows = next;
    setFrame(result);
    if (result.close) choose(result.choice ?? undefined);
    return result.handled;
  }
  return {
    visible: () => frame().visible.map((i) => rows[i]),
    highlighted: (row) => frame().highlighted.some((i) => rows[i] === row),
    refresh: (devices) => dispatch("refresh", {}, devices && buildRows(devices)),
    input: (text) => dispatch("input", { text }),
    key: (name, ctrl) => dispatch("key", { name, ctrl }),
    scroll: (direction) => dispatch("scroll", { direction }),
    down: (value, left) => dispatch("down", { value, left }),
    up: (value, left, dragging) => dispatch("up", { value, left, dragging }),
    clear: () => dispatch("clear"),
  };
}

// Time and AbortSignal belong to the host; the reducer decides what each scan changes.
function scanNative(list: (signal: AbortSignal) => Promise<MicRow[]>, picker: Picker) {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  async function scan() {
    let next: MicRow[] | undefined;
    try {
      next = await list(abort.signal);
    } catch {
      /* failed scan */
    }
    if (abort.signal.aborted) return;
    picker.refresh(Array.isArray(next) ? next : undefined);
    timer = setTimeout(scan, 2500);
  }
  void scan();
  return () => {
    abort.abort();
    clearTimeout(timer);
  };
}

export function liveMicPicker(
  dialog: MicDialog,
  menu: {
    title: string;
    placeholder: string;
    current: string;
    rows: (devices: MicRow[]) => MicRow[];
    list: (signal: AbortSignal) => Promise<MicRow[]>;
    ru: boolean;
    theme?: MicTheme;
  },
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let stop: (() => void) | undefined;
    let closed = false;
    function finish(value?: string) {
      if (closed) return;
      closed = true;
      stop?.();
      resolve(value);
    }
    function choose(value?: string) {
      if (closed) return;
      finish(value);
      dialog.clear();
    }
    dialog.show(
      () => {
        const binding = rustBinding();
        const picker = binding
          ? nativePicker(menu.current, menu.rows, choose, binding.pickerState)
          : referencePicker(menu.current, menu.rows, choose);
        function keyDown(key: KeyEvent) {
          if (!picker.key(key.name, key.ctrl)) return;
          key.preventDefault();
          key.stopPropagation();
        }
        onMount(() => {
          if (!closed)
            stop = binding
              ? scanNative(menu.list, picker)
              : watchMicrophones(menu.list, picker.refresh);
        });
        onCleanup(() => finish());
        return jsx("box", {
          paddingX: 2,
          flexDirection: "column",
          onMouseUp() {
            picker.clear();
          },
          onMouseDrag() {
            picker.clear();
          },
          children: [
            jsx("text", {
              content: menu.title,
              fg: menu.theme?.text.base,
              attributes: TextAttributes.BOLD,
            }),
            jsx("input", {
              id: "voice-mic-filter",
              focused: true,
              placeholder: menu.placeholder,
              textColor: menu.theme?.text.base,
              placeholderColor: menu.theme?.text.muted,
              onInput: picker.input,
              onKeyDown: keyDown,
            }),
            jsx("box", {
              flexDirection: "column",
              onMouseScroll(event: MouseEvent) {
                picker.scroll(event.scroll?.direction);
              },
              children: jsx(For, {
                get each() {
                  return picker.visible();
                },
                fallback: jsx("text", {
                  content: menu.ru ? "Ничего не найдено" : "No matches",
                  fg: menu.theme?.text.muted,
                }),
                children: (row: MicRow) =>
                  jsx("text", {
                    height: 1,
                    selectable: false,
                    wrapMode: "none",
                    fg: menu.theme?.text.base,
                    get attributes() {
                      return picker.highlighted(row) ? TextAttributes.INVERSE : 0;
                    },
                    content: row.description ? `${row.title} · ${row.description}` : row.title,
                    onMouseDown(event: MouseEvent) {
                      picker.down(row.value, event.button === MouseButton.LEFT);
                      event.preventDefault();
                    },
                    onMouseUp(event: MouseEvent) {
                      picker.up(row.value, event.button === MouseButton.LEFT, event.isDragging);
                    },
                  }),
              }),
            }),
            jsx("text", {
              content: menu.ru
                ? "↑↓ Выбор · Enter Сохранить · Esc Назад"
                : "↑↓ Navigate · Enter Choose · Esc Back",
              fg: menu.theme?.text.muted,
            }),
          ],
        });
      },
      () => finish(),
    );
  });
}
