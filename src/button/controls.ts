import { MouseButton, RGBA, TextAttributes, type KeyEvent, type MouseEvent } from "@opentui/core";
import { jsx } from "@opentui/solid/jsx-runtime";
import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import { rustBinding } from "../../lib/rust-binding.js";
import {
  activityInterval,
  activityOrange,
  activityWidth,
  centerFrame,
  createActivity,
  stillDots,
} from "./activity.ts";

const labels = {
  en: {
    idle: "Record voice",
    starting: "Preparing…",
    recording: "Stop",
    stopping: "Stopping…",
    transcribing: "Transcribing…",
    sending: "Sending…",
    send: "Send",
  },
  ru: {
    idle: "Диктовать",
    starting: "Подготовка…",
    recording: "Стоп",
    stopping: "Останавливаю…",
    transcribing: "Распознаю речь…",
    sending: "Отправляю…",
    send: "Отправить",
  },
};

const wave = ["⢀⣶⡀", "⢠⡟⢄", "⣰⠃⢸", "⡜⢀⣾", "⠁⣰⡏", "⢠⡞⠁"];
const waveInterval = 160;
const buttonWidth = 3;

type VoiceButtonProps = {
  phase: string;
  locale: "en" | "ru";
  animate: boolean;
  startedAt?: number;
  toggle: () => void;
};

function activationControl(props: {
  id: "voice-button" | "voice-send";
  enabled: Accessor<boolean>;
  showingActivity?: Accessor<boolean>;
  foreground?: Accessor<RGBA>;
  content: Accessor<string>;
  width?: Accessor<number>;
  activate: () => void;
  onFocus: (active: boolean) => void;
}) {
  const [focused, setFocused] = createSignal(false);
  const [pressed, setPressed] = createSignal(false);
  const [available, setAvailable] = createSignal(buttonWidth);
  let lastClick = -Infinity;
  const binding = rustBinding();

  return jsx("box", {
    id: props.id,
    get width() {
      return props.width?.() ?? buttonWidth;
    },
    minWidth: buttonWidth,
    flexShrink: props.width ? 1 : 0,
    onSizeChange() {
      setAvailable(this.width);
    },
    height: 1,
    alignItems: "center",
    get focusable() {
      return props.enabled();
    },
    "on:focused": () => {
      setFocused(true);
      props.onFocus(true);
    },
    "on:blurred": () => {
      setFocused(false);
      props.onFocus(false);
    },
    onMouseOut() {
      setPressed(false);
    },
    onMouseDown(event: MouseEvent) {
      setPressed(event.button === MouseButton.LEFT && props.enabled());
      if (event.button === MouseButton.LEFT) event.preventDefault(); // Keep focus in the prompt.
    },
    onMouseDrag() {
      setPressed(false);
    },
    onMouseUp(event: MouseEvent) {
      const wasPressed = pressed();
      setPressed(false);
      const now = performance.now();
      const left = event.button === MouseButton.LEFT;
      const enabled = props.enabled();
      const effect = binding
        ? binding.releaseButton(wasPressed, enabled, left, !!event.isDragging, now - lastClick)
        : !wasPressed || !enabled || !left || event.isDragging
          ? "ignore"
          : now - lastClick < 400
            ? "consume"
            : "activate";
      if (effect === "ignore") return;
      event.stopPropagation();
      if (effect === "consume") return;
      lastClick = now;
      props.activate();
    },
    onKeyDown(key: KeyEvent) {
      const plainPress =
        !(key.ctrl || key.meta || key.shift || key.option || key.super || key.hyper) &&
        key.eventType === "press" &&
        !key.repeated;
      const allowed = binding
        ? binding.activateKey(key.name, props.enabled(), plainPress)
        : props.enabled() && plainPress && (key.name === "return" || key.name === "space");
      if (!allowed) return;
      key.preventDefault();
      key.stopPropagation();
      props.activate();
    },
    children: jsx("text", {
      get fg() {
        return props.foreground?.() ?? RGBA.defaultForeground();
      },
      selectable: false,
      wrapMode: "none",
      get attributes() {
        if (!props.enabled())
          return props.showingActivity?.() ? TextAttributes.BOLD : TextAttributes.DIM;
        return (
          TextAttributes.BOLD |
          (pressed() ? TextAttributes.INVERSE : 0) |
          (focused() ? TextAttributes.UNDERLINE : 0)
        );
      },
      get content() {
        return centerFrame(props.content(), available());
      },
    }),
  });
}

type SendProps = { onSend: () => void; canSend: boolean };
type Action = "voice" | "send";

export function ComposerButtons(props: VoiceButtonProps & SendProps) {
  const [focused, setFocused] = createSignal<Action>();
  const [width, setWidth] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  const [activity, setActivity] = createSignal(stillDots);
  const start = createMemo(() =>
    props.phase === "recording" ? (props.startedAt ?? Date.now()) : undefined,
  );
  createEffect(() => {
    const phase = props.phase;
    if (phase !== "recording" && phase !== "transcribing") return;
    const moving = props.animate;
    if (!moving && phase !== "recording") return;
    const next = moving && phase === "transcribing" ? createActivity("rain") : undefined;
    const tick = () => (next ? setActivity(next()) : setNow(Date.now()));
    tick();
    const interval = phase === "recording" ? waveInterval : activityInterval;
    const timer = setInterval(tick, moving ? interval : 1000);
    onCleanup(() => clearInterval(timer));
  });

  const focusHint = (action: Action) => (active: boolean) =>
    setFocused((old) => (active ? action : old === action ? undefined : old));
  const frame = (frames: string[], interval: number) =>
    frames[Math.floor(now() / interval) % frames.length];
  const binding = rustBinding();
  const native = createMemo(() =>
    binding?.footerView({
      phase: props.phase,
      ru: props.locale === "ru",
      focus: focused() ?? "",
      animate: props.animate,
      activity: activity(),
      now: now(),
      start: start() ?? 0,
      canSend: props.canSend,
    }),
  );
  const hintText = createMemo(() => {
    if (native()) return native().hint as string;
    const text = labels[props.locale];
    const action = focused();
    const hint =
      action === "send" ? text.send : (text[props.phase as keyof typeof text] ?? text.starting);
    if (props.phase === "recording") {
      const seconds = Math.max(0, Math.floor((now() - start()) / 1000));
      const age = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
      return `${action ? hint : props.animate ? frame(wave, waveInterval) : wave[0]} ${age} `;
    }
    return action ? `${hint} ` : "";
  });
  return jsx("box", {
    id: "voice-controls",
    flexDirection: "row",
    justifyContent: "flex-end",
    marginLeft: "auto",
    height: 1,
    maxWidth: "100%",
    minWidth: 0,
    flexShrink: 1,
    overflow: "hidden",
    onSizeChange() {
      setWidth(this.width);
    },
    children: [
      jsx("text", {
        get width() {
          return hintText().length;
        },
        minWidth: 0,
        height: 1,
        flexShrink: 1,
        fg: RGBA.defaultForeground(),
        selectable: false,
        wrapMode: "none",
        get content() {
          return hintText().length <= width() - 2 * buttonWidth ? hintText() : "";
        },
      }),
      activationControl({
        id: "voice-send",
        enabled: () => native()?.sendEnabled ?? (props.phase === "idle" && props.canSend),
        activate: () => props.onSend(),
        content: () => "↑",
        onFocus: focusHint("send"),
      }),
      activationControl({
        id: "voice-button",
        width: () =>
          native()?.width ??
          (props.phase === "transcribing" && props.animate ? activityWidth : buttonWidth),
        enabled: () =>
          native()?.voiceEnabled ?? (props.phase === "idle" || props.phase === "recording"),
        showingActivity: () => props.phase === "transcribing",
        foreground: () =>
          props.phase === "transcribing" ? activityOrange : RGBA.defaultForeground(),
        activate: () => props.toggle(),
        content() {
          if (native()) return native().voice as string;
          if (props.phase === "idle") return "●";
          if (props.phase === "recording") return "■";
          if (props.phase === "transcribing") return props.animate ? activity() : stillDots;
          return "…";
        },
        onFocus: focusHint("voice"),
      }),
    ],
  });
}
