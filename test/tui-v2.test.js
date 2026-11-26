import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import test from "node:test";
import { createSignal } from "solid-js";
import { isServer } from "solid-js/web";
import { DEFAULT_SETTINGS } from "../lib/models.js";
import {
  showLanguagePicker,
  showModelPicker,
  showRecordingSettings,
  showTranscriptionSettings,
} from "../src/dialogs.ts";
import { formatBytes, progressBar } from "../src/formatters.ts";
import { normalizeSettings } from "../src/settings.ts";
import { createVoiceController } from "../src/voice.ts";
import { ensureDownloaded } from "../src/ensure.ts";

// Exercise real footer registration and input callbacks without a native terminal.
// The visual component itself is rendered in voice-button.test.js.
const buttonStub = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@opentui/solid/jsx-runtime" && context.parentURL?.endsWith("/src/tui.ts"))
      return {
        url: "data:text/javascript,export const jsx = (_, props) => props",
        shortCircuit: true,
      };
    if (specifier === "./button/dock.ts" && context.parentURL?.endsWith("/src/tui.ts"))
      return {
        url: "data:text/javascript,export const DockedButtons = props => props",
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const { default: tui } = await import("../src/tui.ts").finally(() => buttonStub.deregister());

test("model progress counts resumed bytes, throttles chunks, and waits for verification", async (t) => {
  const messages = [];
  const toasts = [];
  const notice = ["Скачиваю Fixture. Прогресс смотри под полем ввода.", "info"];
  const MB = 1024 * 1024;
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const env = {
    settings: { uiLanguage: "ru" },
    options: {},
    toast: (...toast) => toasts.push(toast),
    downloadStatus: (id, message) => {
      assert.equal(id, "fixture");
      messages.push(message);
    },
    download: async (_model, _options, _settings, { onProgress }) => {
      const progress = (downloaded, total) =>
        onProgress({ state: "downloading", downloaded, total });
      progress(30 * MB, 100 * MB);
      progress(31 * MB, 100 * MB);
      now += 2000;
      progress(40 * MB, 100 * MB);
      onProgress({ state: "verifying" });
      throw Error("SHA256 mismatch");
    },
  };
  const model = { id: "fixture", name: "Fixture", filename: "unused", implemented: false };
  await assert.rejects(ensureDownloaded(env, model), /SHA256 mismatch/);
  assert.deepEqual(
    messages.map((s) => s.hint),
    [
      "Загрузка модели…",
      "Загрузка модели 30%",
      "Загрузка модели 40%",
      "Проверка…",
      "Сбой загрузки · /voice-settings",
    ],
  );
  assert.equal(messages[2].detail, "40 МБ / 100 МБ");
  assert.equal(messages.at(-1).detail, "SHA256 mismatch");
  assert.deepEqual(toasts, [notice]);
  messages.length = 0;
  env.download = async (_model, _options, _settings, { onProgress }) =>
    onProgress({ state: "downloading", downloaded: 42 * MB, total: 0 });
  await ensureDownloaded(env, model);
  assert.deepEqual(
    messages.map((s) => s.hint),
    ["Загрузка модели…", "Загрузка модели · 42 МБ", "Диктовка готова"],
  );
  assert.deepEqual(toasts, [notice, notice]);
});

function mockStore(initial = {}) {
  const draft = { ...DEFAULT_SETTINGS, uiLanguage: "en", ...initial };
  return {
    state: draft,
    update: async (fn) => {
      fn(draft);
    },
  };
}

function mockDialog(answers = {}) {
  const log = { alerts: [], prompts: [], selects: [], selectArgs: [] };
  const selectQueue = [...(answers.select ?? [])];
  const promptQueue = [...(answers.prompt ?? [])];
  return {
    log,
    api: {
      alert: async (o) => {
        log.alerts.push(o);
      },
      confirm: async (o) => {
        log.alerts.push(o);
        return answers.confirm ?? false;
      },
      prompt: async (o) => {
        log.prompts.push(o);
        return promptQueue.shift();
      },
      select: async (o) => {
        log.selects.push(o.title);
        log.selectArgs.push(o);
        return selectQueue.shift();
      },
    },
  };
}

function stubRuntime() {
  return {
    recording: false,
    transcribing: false,
    pendingSubmit: false,
    startedWith: null,
    cancelled: false,
    async start(s) {
      this.recording = true;
      this.startedWith = s;
    },
    async stop() {
      this.recording = false;
      return "/tmp/voice-test.wav";
    },
    async transcribe() {
      return "hello world";
    },
    cancel() {
      this.cancelled = true;
    },
    isRecording() {
      return this.recording;
    },
    isTranscribing() {
      return this.transcribing;
    },
  };
}

const readyStub = {
  isModelDownloaded: () => true,
  ensureDownloaded: async () => true,
  ensureEngineReady: async () => true,
  ensureRecorderReady: async () => true,
};

test("transcription settings explain the selected model's download failure", async () => {
  const store = mockStore({ model: "whisper-turbo" });
  const dialog = mockDialog({ select: ["downloadError"] });
  await showTranscriptionSettings({
    dialog: dialog.api,
    options: { downloadDir: "/missing/voice-test" },
    getSettings: () => store.state,
    getDownloadStatus: (id) => {
      assert.equal(id, "whisper-turbo");
      return {
        phase: "failed",
        hint: "Сбой загрузки · /voice-settings",
        detail: "SHA256 mismatch",
      };
    },
  });
  const model = dialog.log.selectArgs[0].options.find((item) => item.value === "model");
  assert.equal(model.description, "Whisper Turbo");
  assert.deepEqual(dialog.log.alerts, [{ title: "Download error", message: "SHA256 mismatch" }]);
});

test("V2 normalization leaves an empty recording key unbound", () => {
  const s = normalizeSettings({ recordingHotkey: " ", language: "", autoSubmit: 1 });
  assert.equal(s.recordingHotkey, "");
  assert.equal(s.language, "auto");
  assert.equal(s.autoSubmit, true);
  // V1 parity: getModel() falls back to default at use sites, so unknown ids
  // are preserved in settings (index.js:26 only resets if fallback is unimplemented).
  assert.equal(normalizeSettings({ model: "nope" }).model, "nope");
});

test("cleanup settings default on and normalize cutoff", () => {
  const d = normalizeSettings({});
  assert.equal(d.voiceEnhance, true);
  assert.equal(d.cleanupCutoffHz, 120);
  assert.equal(normalizeSettings({ voiceEnhance: false }).voiceEnhance, false);
  assert.equal(normalizeSettings({ cleanupCutoffHz: 180 }).cleanupCutoffHz, 180);
  assert.equal(normalizeSettings({ cleanupCutoffHz: "90" }).cleanupCutoffHz, 90);
  for (const bad of [0, -3, 9999, "abc", Number.NaN]) {
    assert.equal(normalizeSettings({ cleanupCutoffHz: bad }).cleanupCutoffHz, 120, String(bad));
  }
  assert.equal(normalizeSettings({ cleanupCutoffHz: 20 }).cleanupCutoffHz, 40);
});

test("recording cleanup toggle flips and persists", async () => {
  const store = mockStore({});
  const dialog = mockDialog({ select: ["cleanup", undefined, undefined] });
  const d = {
    dialog: dialog.api,
    toast: () => {},
    options: {},
    getSettings: () => store.state,
    update: store.update,
  };
  await showRecordingSettings(d);
  assert.equal(store.state.voiceEnhance, false);
});

test("cutoff presets and custom validation", async () => {
  const store = mockStore({});
  let dialog = mockDialog({ select: ["cutoff", "180", undefined, undefined] });
  let d = {
    dialog: dialog.api,
    toast: () => {},
    options: {},
    getSettings: () => store.state,
    update: store.update,
  };
  await showRecordingSettings(d);
  assert.equal(store.state.cleanupCutoffHz, 180);
  const toasts = [];
  dialog = mockDialog({ select: ["cutoff", "__custom", undefined, undefined], prompt: ["9"] });
  d = {
    dialog: dialog.api,
    toast: (m) => toasts.push(m),
    options: {},
    getSettings: () => store.state,
    update: store.update,
  };
  await showRecordingSettings(d);
  assert.equal(store.state.cleanupCutoffHz, 180);
  assert.ok(toasts.length > 0);
});

test("formatters stay stable", () => {
  assert.equal(formatBytes(0), "0 MB");
  assert.equal(formatBytes(57 * 1024 * 1024), "57 MB");
  assert.ok(progressBar(50).includes("█") && progressBar(50).includes("░"));
});

test("controller toggle records, transcribes and delivers", async () => {
  const runtime = stubRuntime();
  const delivered = [];
  const toasts = [];
  const c = createVoiceController({
    runtime,
    options: {},
    getSettings: () => normalizeSettings({}),
    toast: (m, v = "info") => toasts.push([null, v]),
    deliver: async (text, submit) => delivered.push([text, submit]),
    onSetupError: () => assert.fail("no setup error expected"),
    ready: readyStub,
  });
  await c.toggle(false);
  assert.equal(runtime.recording, true);
  await c.toggle(false);
  assert.deepEqual(delivered, [["hello world", false]]);
  assert.ok(toasts.some(([, v]) => v === "success"));
});

test("controller guards concurrent transcription", async () => {
  const runtime = stubRuntime();
  runtime.transcribing = true;
  const toasts = [];
  const c = createVoiceController({
    runtime,
    options: {},
    getSettings: () => normalizeSettings({}),
    toast: (m, v = "info") => toasts.push([null, v]),
    deliver: async () => assert.fail("must not deliver"),
    onSetupError: () => {},
    ready: readyStub,
  });
  await c.toggle(false);
  assert.ok(toasts.some(([, v]) => v === "warning"));
});

test("controller cancel stops runtime", () => {
  const runtime = stubRuntime();
  const toasts = [];
  const c = createVoiceController({
    runtime,
    options: {},
    getSettings: () => normalizeSettings({}),
    toast: (m) => toasts.push(m),
    deliver: async () => {},
    onSetupError: () => {},
    ready: readyStub,
  });
  c.cancel();
  assert.equal(runtime.cancelled, true);
});

function draft(before = "", after = "") {
  const marks = new Map();
  let nextID = 1;
  return {
    isDestroyed: false,
    focusCalls: 0,
    focus() {
      this.focusCalls++;
    },
    plainText: before + after,
    editBuffer: new EventEmitter(),
    extmarks: {
      registerType: () => 1,
      create: (options) => {
        const id = nextID++;
        marks.set(id, { ...options, id });
        return id;
      },
      get: (id) => {
        const mark = marks.get(id);
        // OpenCode 2.4.1 materializes a fresh object from the native buffer on each read.
        return mark ? { ...mark } : null;
      },
      delete: (id) => marks.delete(id),
      clear: () => marks.clear(),
    },
    setText(text) {
      this.extmarks.clear();
      this.plainText = text;
      this.cursorOffset = text.length;
      this.editBuffer.emit("content-changed");
    },
    cursorOffset: before.length,
    gotoBufferEnd() {
      this.cursorOffset = this.plainText.length;
    },
    insertText(text) {
      assert.equal(this.isDestroyed, false);
      this.plainText =
        this.plainText.slice(0, this.cursorOffset) + text + this.plainText.slice(this.cursorOffset);
      this.cursorOffset += text.length;
      this.editBuffer.emit("content-changed");
    },
  };
}

async function mountVoice(
  t,
  {
    settings = {},
    route = { type: "session", sessionID: "s1" },
    options = {},
    onSend,
    onWait,
    select,
    confirm,
  } = {},
) {
  const creates = [];
  const sends = [];
  const dispatched = [];
  const navigations = [];
  const modals = [];
  const toasts = [];
  const events = new EventEmitter();
  const location = { directory: "/test/project", workspaceID: "w1" };
  let composer = draft();
  const container = {};
  const anchor = { parent: { parent: container } };
  const renderer = Object.assign(new EventEmitter(), {
    root: { findDescendantById: (id) => (id === "voice-dock-anchor" ? anchor : null) },
    currentFocusedRenderable: composer,
  });
  composer.parent = { parent: { parent: container } };
  const input = {
    get sessionID() {
      return route.sessionID;
    },
    mode: "normal",
    showDetails: true,
  };
  const [currentRoute, setRoute] = createSignal(route);
  const [sessionStatuses, setSessionStatuses] = createSignal({});
  let button;
  let renderStatus;
  const runtime = stubRuntime();
  let layerFn;
  let store;
  let cleanup = await tui.setup({
    options: { createRuntime: () => runtime, ready: readyStub, ...options },
    location,
    data: {
      session: {
        status: (id) => sessionStatuses()[id] ?? "idle",
        pending: { list: () => [] },
      },
      on: (name, cb) => {
        events.on(name, cb);
        return () => events.off(name, cb);
      },
    },
    theme: { text: { muted: "gray" } },
    renderer,
    storage: {
      store: (_key, { initial }) => {
        store = mockStore({
          ...initial,
          rageThemeApplied: true,
          uiLanguage: "en",
          onboardingDone: true,
          setupSkipped: true,
          ...settings,
        });
        return [store.state, store.update];
      },
    },
    ui: {
      toast: { show: (t) => toasts.push(t) },
      dialog: {
        select,
        confirm,
        prompt: async (params) => {
          modals.push(params);
        },
      },
      router: { current: currentRoute, navigate: (next) => navigations.push(next) },
      slot: (claim) => {
        if (claim.append === "app") claim.render();
        if (claim.append === "prompt.footer") {
          const component = claim.render(input);
          if (component?.toggle) {
            button = component;
            component.onAnchor(anchor);
          }
        }
        if (claim.append === "prompt.footer.status")
          renderStatus = () => {
            const view = claim.render(input)[1];
            return (typeof view === "function" ? view() : view)?.children;
          };
        return () => {};
      },
    },
    keymap: { layer: (fn) => (layerFn = fn), dispatch: (id) => dispatched.push(id) },
    client: {
      session: {
        create: async (params) => {
          creates.push(params);
          return { id: "created" };
        },
        prompt: async (params) => {
          sends.push(params);
          await onSend?.(sends.length);
        },
        wait: async ({ sessionID }, { signal }) => onWait?.(sessionID, signal),
      },
    },
  });
  const dispose = () => {
    const done = cleanup?.();
    cleanup = undefined;
    assert.equal(renderer.listenerCount("focused_renderable"), 0);
    return done;
  };
  t.after(dispose);
  t.after(() => {
    assert.deepEqual(modals, [], "Dictation must not open a modal");
    assert.deepEqual(creates, [], "Dictation must not create a session");
    assert.deepEqual(navigations, [], "Dictation must not navigate");
  });
  const command = (id) => layerFn().commands.find((cmd) => cmd.id === id);
  return {
    command,
    events,
    layer: layerFn,
    settings: store.state,
    sends,
    dispatched,
    location,
    toasts,
    runtime,
    setSessionStatus: (id, status) => setSessionStatuses((all) => ({ ...all, [id]: status })),
    dispose,
    button,
    status: renderStatus,
    input,
    get composer() {
      return composer;
    },
    move(next, nextComposer) {
      route = next;
      setRoute(next);
      composer = nextComposer;
      composer.parent = { parent: { parent: container } };
      renderer.currentFocusedRenderable = composer;
    },
    async focus(editor = composer) {
      renderer.currentFocusedRenderable = editor;
      renderer.emit("focused_renderable", editor);
      await Promise.resolve();
    },
  };
}

test("plugin unload waits for the recorder to close and release the take", async (t) => {
  const f = await mountVoice(t);
  const closing = Promise.withResolvers();
  f.runtime.cancel = () => closing.promise;
  let unloaded = false;
  const done = Promise.resolve(f.dispose()).then(() => (unloaded = true));
  await Promise.resolve();
  assert.equal(unloaded, false);
  closing.resolve();
  await done;
  assert.equal(unloaded, true);
});

function wakeWorker(f) {
  const runs = [];
  f.runtime.listen = (settings, emit, signal) => {
    const done = Promise.withResolvers();
    signal.addEventListener("abort", () => setImmediate(done.resolve), { once: true });
    runs.push({ settings, emit, signal, done });
    return done.promise;
  };
  return runs;
}

function say(run, id, text) {
  run.emit({ event: "heard", id });
  run.emit({ event: "text", id, text });
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("/rage-auto sends only final nonblank speech once, with no confirmation", async (t) => {
  const f = await mountVoice(t, { confirm: () => assert.fail("must not confirm") });
  const runs = wakeWorker(f);
  const auto = f.command("voice.auto");
  assert.equal(auto.slash.name, "rage-auto");
  await auto.run();
  const [run] = runs;
  run.emit({ event: "waiting" });
  assert.equal(f.status(), "Auto-send · Waiting for «Рейдж»");
  run.emit({ event: "text", id: 1, text: "not armed" });
  say(run, 1, "   ");
  assert.deepEqual(f.sends, []);
  run.emit({ event: "heard", id: 2 });
  assert.deepEqual(f.sends, []);
  run.emit({ event: "text", id: 2, text: "  send this  " });
  assert.deepEqual(f.sends, [{ sessionID: "s1", text: "send this", delivery: "queue" }]);
  run.emit({ event: "text", id: 2, text: "duplicate" });
  say(run, 2, "duplicate");
  await f.command("voice.listen").run();
  assert.equal(run.signal.aborted, false);
  assert.deepEqual(f.dispatched, []);
  assert.equal(f.composer.plainText, "");
  await auto.run();
  assert.equal(run.signal.aborted, true);
  assert.equal(f.sends.length, 1);
});

test("/rage-auto drains same-session FIFO only when idle, including the POST acknowledgement gap", async (t) => {
  const finishFirst = Promise.withResolvers();
  const waitEntered = Promise.withResolvers();
  let waits = 0;
  const f = await mountVoice(t, {
    onWait: (id) => {
      assert.equal(id, "s1");
      if (++waits === 1) {
        waitEntered.resolve();
        return finishFirst.promise;
      }
    },
  });
  const runs = wakeWorker(f);
  f.setSessionStatus("s1", "running");
  await f.command("voice.auto").run();
  const [run] = runs;
  say(run, 1, "first");
  say(run, 2, "second");
  assert.deepEqual(f.sends, []);
  f.setSessionStatus("s2", "idle");
  await f.focus();
  assert.deepEqual(f.sends, []);
  f.setSessionStatus("s1", "idle");
  if (isServer) await f.focus(); // Node's no-op Solid effects; browser must resume without focus.
  await waitEntered.promise;
  f.events.emit("session.inbox.enqueued", {
    data: { sessionID: "s1", item: { type: "user" } },
  });
  say(run, 3, "third");
  assert.deepEqual(
    f.sends.map(({ text }) => text),
    ["first"],
  );
  f.setSessionStatus("s1", "running");
  finishFirst.resolve();
  await nextTurn();
  assert.deepEqual(
    f.sends.map(({ text }) => text),
    ["first"],
  );
  f.setSessionStatus("s1", "idle");
  if (isServer) await f.focus();
  await nextTurn();
  assert.deepEqual(
    f.sends.map(({ text }) => text),
    ["first", "second", "third"],
  );
  assert.ok(f.sends.every(({ sessionID, delivery }) => sessionID === "s1" && delivery === "queue"));
});

for (const action of ["switch", "toggle", "stop", "dispose"]) {
  test(`/rage-auto drops its busy queue on ${action}`, async (t) => {
    const f = await mountVoice(t);
    const runs = wakeWorker(f);
    f.setSessionStatus("s1", "running");
    const auto = f.command("voice.auto");
    await auto.run();
    say(runs[0], 1, "do not send");
    if (action === "switch") {
      f.move({ type: "session", sessionID: "s2" }, draft());
      if (isServer) await f.focus();
      assert.equal(runs[0].signal.aborted, true);
      f.move({ type: "session", sessionID: "s1" }, draft());
    } else if (action === "toggle") await auto.run();
    else if (action === "stop") await f.command("voice.stop").run();
    else await f.dispose();
    f.setSessionStatus("s1", "idle");
    await f.focus();
    say(runs[0], 2, "late frame");
    assert.deepEqual(f.sends, []);
    assert.equal(f.composer.plainText, "");
  });
}

test("/rage-auto appends to initial and newly typed drafts, including while queued, but never to a replacement", async (t) => {
  const f = await mountVoice(t);
  const runs = wakeWorker(f);
  await f.command("voice.auto").run();
  const [run] = runs;
  f.composer.setText("initial");
  f.composer.cursorOffset = 0;
  say(run, 1, "one");
  assert.equal(f.composer.plainText, "initial one ");
  f.composer.setText("");
  run.emit({ event: "heard", id: 2 });
  f.composer.insertText("typed");
  run.emit({ event: "text", id: 2, text: "two" });
  assert.equal(f.composer.plainText, "typed two ");
  f.composer.setText("");
  f.setSessionStatus("s1", "running");
  say(run, 3, "three");
  f.composer.insertText("while queued");
  f.setSessionStatus("s1", "idle");
  await f.focus();
  assert.equal(f.composer.plainText, "while queued three ");
  run.emit({ event: "heard", id: 4 });
  f.composer.setText("replacement");
  run.emit({ event: "text", id: 4, text: "stale" });
  assert.equal(f.composer.plainText, "replacement");
  assert.deepEqual(f.sends, []);
});

test("/rage-auto preserves definite rejection in its original draft and never retries it", async (t) => {
  const send = Promise.withResolvers();
  const f = await mountVoice(t, { onSend: () => send.promise });
  const runs = wakeWorker(f);
  await f.command("voice.auto").run();
  say(runs[0], 1, "unsent");
  const other = draft("Dialog");
  await f.focus(other);
  send.reject({ _tag: "InvalidRequestError", message: "Prompt rejected" });
  await nextTurn();
  assert.equal(other.plainText, "Dialog");
  assert.equal(f.toasts.at(-1).message, "Prompt rejected");
  await f.focus();
  assert.equal(f.composer.plainText, "unsent ");
  assert.equal(f.sends.length, 1);
});

test("/rage-auto does not restore or retry a send with an unknown outcome", async (t) => {
  const f = await mountVoice(t, {
    onSend: () => {
      throw Error("Disconnected");
    },
  });
  const runs = wakeWorker(f);
  await f.command("voice.auto").run();
  say(runs[0], 1, "possibly sent");
  await nextTurn();
  await f.focus();
  assert.match(f.toasts.at(-1).message, /Send not confirmed/);
  assert.equal(f.composer.plainText, "");
  assert.equal(f.sends.length, 1);
});

test("/rage-auto dispose releases an in-flight draft guard and ignores a late rejection", async (t) => {
  const admission = Promise.withResolvers();
  const f = await mountVoice(t, { onSend: () => admission.promise });
  const runs = wakeWorker(f);
  await f.command("voice.auto").run();
  const baseline = f.composer.editBuffer.listenerCount("content-changed");
  say(runs[0], 1, "already submitted to host");
  say(runs[0], 2, "still queued");
  assert.equal(f.composer.editBuffer.listenerCount("content-changed"), baseline + 2);
  await f.dispose();
  assert.equal(f.composer.editBuffer.listenerCount("content-changed"), 0);
  admission.reject({ _tag: "InvalidRequestError", message: "Late rejection" });
  await nextTurn();
  assert.equal(f.sends.length, 1);
  assert.equal(f.composer.plainText, "");
  assert.ok(!f.toasts.some(({ message }) => message === "Late rejection"));
});

test("wake hit belongs to the original draft, even when the same session and editor are reused", async (t) => {
  const f = await mountVoice(t, { settings: { autoSubmit: true } });
  const runs = wakeWorker(f);
  await f.command("voice.listen").run();
  const [run] = runs;
  f.composer.setText("draft A");
  for (const [i, boundary] of ["submit", "history", "remount", "enqueued", "erase"].entries()) {
    const id = i + 1;
    run.emit({ event: "heard", id });
    if (boundary === "submit") {
      f.composer.setText(""); // The host clears locally before the inbox event.
      f.composer.insertText("draft B");
    } else if (boundary === "history") {
      f.composer.setText(f.composer.plainText); // Different draft, identical characters.
    } else if (boundary === "remount") {
      f.move({ type: "session", sessionID: "s1" }, draft("draft B"));
    } else if (boundary === "erase") {
      f.composer.plainText = ""; // Delete selection without calling the host's reset.
      f.composer.cursorOffset = 0;
      f.composer.editBuffer.emit("content-changed");
      f.composer.insertText("draft B");
    } else {
      await f.focus(draft("Dialog"));
      run.emit({ event: "text", id, text: "stale queued" });
      f.events.emit("session.inbox.enqueued", {
        data: { sessionID: "s1", item: { type: "user" } },
      });
      await f.focus();
    }
    run.emit({ event: "text", id, text: "stale" });
    await f.focus();
    assert.equal(f.composer.plainText, "draft B", boundary);
  }
  // New hits remain usable. Typing, moving the cursor, or another session sending is not replacement.
  run.emit({ event: "heard", id: 6 });
  f.composer.insertText(" edited");
  f.events.emit("session.inbox.enqueued", { data: { sessionID: "other", item: { type: "user" } } });
  f.composer.cursorOffset = 0;
  run.emit({ event: "text", id: 6, text: "one" });
  run.emit({ event: "heard", id: 7 });
  run.emit({ event: "text", id: 7, text: "two" });
  assert.equal(f.composer.plainText, "one two draft B edited");
  assert.deepEqual(f.sends, []);
  assert.deepEqual(f.dispatched, []);
});

test("wake opt-in requires an open session and excludes all manual capture paths until worker exit", async (t) => {
  const f = await mountVoice(t, {
    route: { type: "home" },
    settings: { mic: ":pinned", autoSubmit: true },
  });
  const runs = wakeWorker(f);
  const toggle = f.command("voice.listen");
  assert.equal(toggle.slash.name, "rage-listen");
  await toggle.run();
  assert.equal(runs.length, 0);
  f.move({ type: "session", sessionID: "s1" }, draft("Original "));
  await f.command("voice.record").run();
  await toggle.run();
  assert.equal(runs.length, 0);
  await f.command("voice.stop").run();
  // The fake runtime's cancel only marks cancelled.
  f.runtime.recording = false;
  await toggle.run();
  const [run] = runs;
  assert.equal(run.settings.mic, ":pinned");
  run.emit({ event: "level", level: 2 });
  assert.equal(f.status(), "Starting listener…");
  run.emit({ event: "waiting" });
  assert.equal(f.status(), "Waiting for «Рейдж»");
  run.emit({ event: "level", level: 0 });
  assert.equal(f.status(), "Waiting for «Рейдж» · Silence ░░░");
  run.emit({ event: "level", level: 2 });
  assert.equal(f.status(), "Waiting for «Рейдж» · Sound ██░");
  run.emit({ event: "text", id: 1, text: "before trigger" });
  run.emit({ event: "heard", id: 1 });
  run.emit({ event: "level", level: 3 });
  assert.equal(f.status(), "Wake word heard. Listening for the command");
  run.emit({ event: "text", id: 1, text: "one" });
  run.emit({ event: "heard", id: 1 });
  run.emit({ event: "text", id: 1, text: "duplicate" });
  run.emit({ event: "waiting" });
  assert.equal(f.status(), "Waiting for «Рейдж»");
  await f.command("voice.submit").run();
  f.button.toggle();
  assert.equal(f.runtime.recording, false);
  const closing = toggle.run();
  assert.equal(run.signal.aborted, true);
  run.emit({ event: "level", level: 3 });
  assert.equal(f.status(), "Stopping listener…");
  await f.command("voice.record").run();
  assert.equal(f.runtime.recording, false);
  run.emit({ event: "heard", id: 2 });
  run.emit({ event: "text", id: 2, text: "after stop" });
  run.done.resolve();
  await closing;
  assert.equal(f.status(), undefined);
  assert.equal(f.composer.plainText, "Original one ");
  assert.deepEqual(f.sends, []);
  assert.deepEqual(f.dispatched, []);
  await f.command("voice.record").run();
  assert.equal(f.runtime.recording, true);
});

test("wake meter labels silence and signal in Russian", async (t) => {
  const f = await mountVoice(t, { settings: { uiLanguage: "ru" } });
  const runs = wakeWorker(f);
  await f.command("voice.listen").run();
  runs[0].emit({ event: "waiting" });
  runs[0].emit({ event: "level", level: 0 });
  assert.equal(f.status(), "Жду «Рейдж» · Тихо ░░░");
  runs[0].emit({ event: "level", level: 3 });
  assert.equal(f.status(), "Жду «Рейдж» · Есть звук ███");
});

test("wake drafts wait for their normal editor; session change invalidates queued and late frames", async (t) => {
  const f = await mountVoice(t, { settings: { autoSubmit: true } });
  const runs = wakeWorker(f);
  await f.command("voice.listen").run();
  const [run] = runs;
  const other = draft("Dialog");
  await f.focus(other);
  run.emit({ event: "heard", id: 1 });
  run.emit({ event: "text", id: 1, text: "kept" });
  assert.equal(other.plainText, "Dialog");
  await f.focus();
  assert.equal(f.composer.plainText, "kept ");
  f.input.mode = "shell";
  run.emit({ event: "heard", id: 2 });
  run.emit({ event: "text", id: 2, text: "stale" });
  const original = f.composer;
  f.move({ type: "session", sessionID: "s2" }, draft("Other"));
  f.input.mode = "normal";
  await f.focus();
  assert.equal(run.signal.aborted, true);
  run.emit({ event: "heard", id: 3 });
  run.emit({ event: "text", id: 3, text: "late" });
  assert.equal(f.composer.plainText, "Other");
  run.done.resolve();
  f.move({ type: "session", sessionID: "s1" }, original);
  await f.focus();
  assert.equal(original.plainText, "kept ");
  assert.equal(runs.length, 1);
  assert.deepEqual(f.sends, []);
});

test(
  "route change stops an idle listener without needing focus or another audio frame",
  { skip: isServer && "run with --conditions=browser for reactive Solid" },
  async (t) => {
    const f = await mountVoice(t);
    const runs = wakeWorker(f);
    await f.command("voice.listen").run();
    const [run] = runs;
    run.emit({ event: "waiting" });
    f.move({ type: "home" }, draft());
    assert.equal(run.signal.aborted, true);
    run.done.resolve();
    f.move({ type: "session", sessionID: "s1" }, draft());
    run.emit({ event: "heard", id: 1 });
    run.emit({ event: "text", id: 1, text: "stale" });
    assert.equal(f.composer.plainText, "");
    assert.equal(runs.length, 1);
  },
);

test("/voice-stop invalidates queued wake text even after clean file EOF", async (t) => {
  const f = await mountVoice(t);
  const runs = wakeWorker(f);
  await f.command("voice.listen").run();
  const [run] = runs;
  await f.focus(draft("Dialog"));
  run.emit({ event: "heard", id: 1 });
  run.emit({ event: "text", id: 1, text: "queued" });
  run.done.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await f.command("voice.stop").run();
  await f.focus();
  assert.equal(f.composer.plainText, "");
  assert.deepEqual(f.dispatched, []);
  assert.deepEqual(f.sends, []);
});

test("wake worker error never retries or changes input; dispose invalidates delivery and joins the next worker", async (t) => {
  const f = await mountVoice(t, { settings: { mic: ":My iPhone" } });
  const runs = wakeWorker(f);
  await f.command("voice.listen").run();
  runs[0].done.reject(new Error("Microphone disconnected"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.toasts.at(-1).message, "Microphone disconnected");
  assert.equal(f.settings.mic, ":My iPhone");
  assert.equal(runs.length, 1);
  await f.command("voice.listen").run();
  const run = runs[1];
  await f.focus(draft("Dialog"));
  run.emit({ event: "heard", id: 1 });
  run.emit({ event: "text", id: 1, text: "queued" });
  let finished = false;
  const closing = f.dispose().then(() => (finished = true));
  await f.focus();
  assert.equal(finished, false);
  assert.equal(run.signal.aborted, true);
  run.emit({ event: "heard", id: 2 });
  run.emit({ event: "text", id: 2, text: "late" });
  run.done.resolve();
  await closing;
  assert.equal(f.composer.plainText, "");
  assert.deepEqual(f.sends, []);
});

test("send button dispatches native submit without rebuilding or clearing the draft", async (t) => {
  const f = await mountVoice(t, { route: { type: "home" } });
  await f.focus();
  f.composer.insertText("  ");
  assert.equal(f.button.canSend, false);
  f.button.onSend();
  assert.deepEqual(f.dispatched, []);
  f.composer.insertText("ask about @attached-file");
  assert.equal(f.button.canSend, true);
  f.button.onSend();
  assert.deepEqual(f.dispatched, ["prompt.submit"]);
  assert.equal(f.composer.plainText, "  ask about @attached-file");
  assert.deepEqual(f.sends, []);
  await f.command("voice.record").run();
  f.button.onSend();
  assert.equal(f.dispatched.length, 1);
  await f.command("voice.record").run();
  await f.focus(draft("Unrelated dialog"));
  f.button.onSend();
  assert.equal(f.dispatched.length, 1);
});

test("unavailable iPhone offers a choice without changing input or starting a second recording", async (t) => {
  let confirmations = 0;
  const f = await mountVoice(t, {
    settings: { uiLanguage: "ru", mic: "My iPhone Microphone" },
    confirm: async (dialog) => {
      confirmations++;
      assert.equal(dialog.label.confirm, "Выбрать микрофон");
      return false;
    },
    select: () => assert.fail("closing must not open the picker"),
  });
  let starts = 0;
  f.runtime.start = async () => {
    starts++;
    throw Object.assign(new Error("Microphone unavailable"), { code: "VOICE_MIC_UNAVAILABLE" });
  };
  await f.command("voice.record").run();
  assert.equal(confirmations, 1);
  assert.equal(starts, 1);
  assert.equal(f.runtime.recording, false);
  assert.equal(f.settings.mic, "My iPhone Microphone");
});

test("unplug recovers the partial take into the composer even with automatic submit enabled", async (t) => {
  let interrupt;
  let prompts = 0;
  const f = await mountVoice(t, {
    settings: { autoSubmit: true, uiLanguage: "ru" },
    confirm: async ({ message }) => {
      assert.match(message, /Запись прервалась/);
      assert.match(f.composer.plainText, /hello world/);
      prompts++;
      return false;
    },
  });
  f.runtime.start = async (_settings, onInterrupted) => {
    f.runtime.recording = true;
    interrupt = onInterrupted;
  };
  await f.command("voice.record").run();
  await interrupt();
  assert.equal(prompts, 1);
  assert.deepEqual(f.sends, []);
});

test("choosing a replacement microphone saves it for the next take", async (t) => {
  let picks = 0;
  const f = await mountVoice(t, {
    settings: { mic: ":My iPhone Microphone" },
    options: { platform: "darwin", ffmpeg: process.execPath },
    confirm: async () => true,
    select: async (picker) => {
      picks++;
      assert.ok(picker.options.some(({ value }) => value === ""));
      return "";
    },
  });
  let starts = 0;
  f.runtime.start = async () => {
    starts++;
    throw Object.assign(new Error("Disconnected"), { code: "VOICE_MIC_UNAVAILABLE" });
  };
  await f.command("voice.record").run();
  assert.equal(picks, 1);
  assert.equal(f.settings.mic, "");
  assert.equal(starts, 1);
});

test("/orbs applies the selected effect and keeps it after reopening or cancelling", async (t) => {
  let answer = "rain";
  const choices = [];
  const f = await mountVoice(t, {
    settings: { uiLanguage: "ru", orb: "obsolete" },
    select: async (dialog) => {
      choices.push(dialog);
      return answer;
    },
  });
  const command = f.command("voice.orbs");
  await command.run();
  assert.equal(choices[0].current, "breath");
  assert.deepEqual(
    choices[0].options.map((o) => o.title),
    ["Вдох и дождь", "Цифровой вдох", "Цифровой дождь"],
  );
  assert.equal(f.settings.orb, "rain");
  answer = undefined;
  await command.run();
  assert.equal(choices[1].current, "rain");
  assert.equal(f.settings.orb, "rain");
  assert.deepEqual(f.sends, []);
});

test("V2 registers /voice without a default shortcut and inserts at the live cursor", async (t) => {
  const f = await mountVoice(t);
  assert.equal(f.layer().mode, "global");
  assert.deepEqual(
    f.layer().commands.map((c) => c.id),
    [
      "voice.record",
      "voice.submit",
      "voice.stop",
      "voice.settings",
      "voice.orbs",
      "voice.listen",
      "voice.auto",
    ],
  );
  assert.equal(f.command("voice.orbs").slash.name, "orbs");
  const record = f.command("voice.record");
  assert.equal(record.bind, false);
  assert.deepEqual(record.slash, { name: "voice", aliases: ["voice-record"] });
  f.composer.insertText("Before after");
  await record.run();
  assert.equal(f.runtime.recording, true);
  f.composer.cursorOffset = 7;
  await record.run();
  assert.match(f.composer.plainText, /^Before hello world ?after$/);
  assert.equal(f.composer.focusCalls, 0, "Dictation must not steal keyboard focus");
  assert.deepEqual(f.sends, []);
});

test("V2 drops the legacy default but retains an explicit plugin shortcut", async (t) => {
  const settings = { recordingHotkey: "ctrl+space", hotkeyMigratedV2: true };
  const old = await mountVoice(t, { settings });
  assert.equal(old.settings.recordingHotkey, "");
  assert.equal(old.command("voice.record").bind, false);
  const configured = await mountVoice(t, { options: { recordingHotkey: "ctrl+space" } });
  assert.equal(configured.command("voice.record").bind, "ctrl+space");
});

test("transcription settings toggle autoSubmit", async () => {
  const store = mockStore({});
  const dialog = mockDialog({ select: ["autoSubmit", undefined, undefined] });
  const d = {
    dialog: dialog.api,
    toast: () => {},
    options: {},
    getSettings: () => store.state,
    update: store.update,
  };
  await showTranscriptionSettings(d);
  assert.equal(store.state.autoSubmit, true);
});

test("language picker custom code path", async () => {
  const store = mockStore({});
  const dialog = mockDialog({ select: ["__custom", undefined], prompt: ["de"] });
  const d = {
    dialog: dialog.api,
    toast: () => {},
    options: {},
    getSettings: () => store.state,
    update: store.update,
  };
  await showLanguagePicker(d);
  assert.equal(store.state.language, "de");
});

test("recording hotkey preset updates store", async () => {
  const store = mockStore({});
  const dialog = mockDialog({ select: ["key", "alt+r", undefined, undefined] });
  const d = {
    dialog: dialog.api,
    toast: () => {},
    options: {},
    getSettings: () => store.state,
    update: store.update,
  };
  await showRecordingSettings(d);
  assert.equal(store.state.recordingHotkey, "alt+r");
});

test("model picker options fit narrow dialog", async () => {
  const store = mockStore({});
  const toasts = [];
  const dialog = mockDialog({ select: ["__skip"] });
  const d = {
    dialog: dialog.api,
    toast: (m) => toasts.push(m),
    options: {},
    getSettings: () => store.state,
    update: store.update,
  };
  await showModelPicker(d, true);
  const picker = dialog.log.selectArgs[0];
  assert.ok(picker.options.length > 10);
  for (const opt of picker.options) {
    if (opt.value === "__skip") continue;
    assert.ok(opt.title.length <= 40, `title too long: ${opt.title}`);
    assert.ok(!opt.title.includes("["), `no status tags in title: ${opt.title}`);
    assert.ok(opt.category, "status belongs in the category header");
    assert.equal(opt.description, undefined, "do not repeat status on each clipped row");
    assert.ok(opt.footer.length <= 45, `footer too long: ${opt.footer}`);
  }
  assert.equal(store.state.setupSkipped, true);
});

test("/voice-submit at home inserts the transcript into the home draft", async (t) => {
  const f = await mountVoice(t, { route: { type: "home" } });
  await f.command("voice.submit").run();
  await f.command("voice.submit").run();
  assert.equal(f.composer.plainText.trimEnd(), "hello world");
  assert.deepEqual(f.sends, []);
});

for (const blockedBy of ["dialog focus", "shell mode"]) {
  test(`dictation waits for the normal composer during ${blockedBy}`, async (t) => {
    const f = await mountVoice(t);
    const dialog = draft("Other input");
    await f.command("voice.record").run();
    if (blockedBy === "dialog focus") await f.focus(dialog);
    else f.input.mode = "shell";
    await f.command("voice.record").run();
    assert.equal(dialog.plainText, "Other input");
    assert.equal(f.composer.plainText, "");
    assert.match(f.toasts.at(-1).message, /original prompt/);
    f.input.mode = "normal";
    await f.focus();
    assert.equal(f.composer.plainText.trimEnd(), "hello world");
    assert.deepEqual(f.sends, []);
  });
}

for (const [name, origin, other] of [
  ["session", { type: "session", sessionID: "s1" }, { type: "session", sessionID: "s2" }],
  ["project", { type: "home" }, { type: "home" }],
]) {
  test(`switching ${name} queues dictation until the original draft returns`, async (t) => {
    const f = await mountVoice(t, { route: origin });
    const originDirectory = f.location.directory;
    await f.command("voice.submit").run();
    f.composer.isDestroyed = true;
    const unrelated = draft("Unrelated draft");
    if (name === "project") f.location.directory = "/test/other";
    f.move(other, unrelated);
    await f.command("voice.submit").run();
    assert.equal(unrelated.plainText, "Unrelated draft");
    assert.deepEqual(f.sends, []);

    await f.focus();
    assert.equal(unrelated.plainText, "Unrelated draft");
    const returned = draft("Original draft: ");
    f.location.directory = originDirectory;
    f.move(origin, returned);
    await f.focus();
    await f.focus();
    assert.equal(returned.plainText.trimEnd(), "Original draft: hello world");
    assert.equal(returned.focusCalls, 0);
    assert.deepEqual(f.sends, [], "Returning to the origin must not send a queued transcript");
  });
}

test("teardown prevents a late transcript from entering the draft", async (t) => {
  const f = await mountVoice(t, { route: { type: "home" } });
  const decoding = Promise.withResolvers();
  const transcript = Promise.withResolvers();
  f.runtime.transcribe = () => {
    decoding.resolve();
    return transcript.promise;
  };
  await f.command("voice.record").run();
  const finishing = f.command("voice.record").run();
  await decoding.promise;
  f.dispose();
  assert.equal(f.runtime.cancelled, true);
  transcript.resolve("Late transcript");
  await finishing;
  assert.equal(f.composer.plainText, "");
  assert.deepEqual(f.sends, []);
  assert.ok(!f.toasts.some((toast) => toast.variant === "success"));
});

test("teardown discards queued dictation when a destroyed composer is later replaced", async (t) => {
  const f = await mountVoice(t);
  await f.command("voice.record").run();
  f.composer.isDestroyed = true;
  await f.command("voice.record").run();
  assert.equal(f.composer.plainText, "");
  assert.match(f.toasts.at(-1).message, /original prompt/);
  f.dispose();
  f.move({ type: "session", sessionID: "s1" }, draft("New draft"));
  await f.focus();
  assert.equal(f.composer.plainText, "New draft");
  assert.deepEqual(f.sends, []);
});

test("a failed explicit send restores the original transcript to the draft without retrying", async (t) => {
  const f = await mountVoice(t, {
    onSend: () => {
      throw Error("Disconnected");
    },
  });
  await f.command("voice.submit").run();
  await f.command("voice.submit").run();
  assert.equal(f.composer.plainText.trimEnd(), "hello world");
  assert.deepEqual(f.sends, [{ sessionID: "s1", text: "hello world" }]);
});

for (const [id, autoSubmit] of [
  ["voice.record", true],
  ["voice.submit", false],
]) {
  test(`${id} sends immediately to the unchanged chat with autoSubmit=${autoSubmit}`, async (t) => {
    const f = await mountVoice(t, { settings: { autoSubmit } });
    await f.command(id).run();
    await f.command(id).run();
    assert.deepEqual(f.sends, [{ sessionID: "s1", text: "hello world" }]);
    assert.equal(f.composer.plainText, "");
  });
}

test("button dictation inserts inline even with autoSubmit, whether clicked to start or stop", async (t) => {
  for (const buttonStarts of [true, false]) {
    const f = await mountVoice(t, { settings: { autoSubmit: true } });
    const button = async () => {
      f.button.toggle();
      await new Promise((resolve) => setImmediate(resolve));
    };
    const command = f.command("voice.record").run;
    await (buttonStarts ? button : command)();
    await (buttonStarts ? command : button)();
    assert.equal(f.composer.plainText.trimEnd(), "hello world");
    assert.deepEqual(f.sends, []);
  }
});
