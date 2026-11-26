import assert from "node:assert/strict";
import test from "node:test";
import { createVoiceController } from "../lib/voice-controller.js";
import tui from "../src/tui.ts";

const ready = {
  isModelDownloaded: () => true,
  ensureEngineReady: async () => {},
  ensureDownloaded: async () => {},
  ensureRecorderReady: async () => {},
};

test("V2 commands and recording feedback follow the current UI language without restarting", async (t) => {
  const settings = {
    rageThemeApplied: true,
    uiLanguage: "ru",
    language: "ja",
    onboardingDone: true,
    setupSkipped: true,
    recordingHotkey: "ctrl+r",
  };
  const toasts = [];
  const modals = [];
  const submitted = [];
  const transcript = Promise.withResolvers();
  const decoding = Promise.withResolvers();
  let layer;
  let recording = false;
  const runtime = {
    isRecording: () => recording,
    isTranscribing: () => false,
    start: async () => {
      recording = true;
    },
    stop: async () => {
      recording = false;
      return "recording.wav";
    },
    transcribe: () => {
      decoding.resolve();
      return transcript.promise;
    },
    cancel: () => {},
  };
  const dispose = await tui.setup({
    options: {
      ready,
      createRuntime: () => runtime,
    },
    renderer: { currentFocusedRenderable: null, root: { findDescendantById: () => null } },
    location: { directory: "/test/project" },
    storage: { store: () => [settings, async (fn) => fn(settings)] },
    ui: {
      toast: { show: (toast) => toasts.push(toast) },
      dialog: {
        prompt: async (options) => {
          modals.push(options);
        },
      },
      router: { current: () => ({ type: "session", sessionID: "s1" }) },
      slot: (claim) => {
        if (claim.append === "app") claim.render();
        return () => {};
      },
    },
    keymap: {
      layer: (fn) => {
        layer = fn;
      },
    },
    client: { session: { prompt: async (data) => submitted.push(data) } },
  });
  t.after(dispose);
  const commands = () => layer().commands;
  const russian = commands();
  assert.equal(russian[0].bind, false);
  assert.equal(settings.recordingHotkey, "");
  assert.equal(settings.hotkeyMigratedV3, true);
  assert.deepEqual(toasts, []);
  assert.ok(russian.every((cmd) => cmd.group === "Диктовка" && /[а-я]/i.test(cmd.description)));
  settings.uiLanguage = "en";
  const english = commands();
  assert.deepEqual(
    english.map((c) => c.id),
    russian.map((c) => c.id),
  );
  assert.deepEqual(
    english.map((c) => c.slash),
    russian.map((c) => c.slash),
  );
  assert.ok(english.every((cmd, i) => cmd.group === "Voice" && cmd.title !== russian[i].title));

  await english[0].run();
  assert.equal(toasts.at(-1).message, "Recording. Run /voice again to stop.");
  const finishing = english[0].run();
  await decoding.promise;
  assert.equal(toasts.at(-1).message, "Transcribing...");
  settings.uiLanguage = "ru";
  await russian[0].run();
  assert.deepEqual(toasts.at(-1), {
    title: "Диктовка",
    message: "Распознавание уже идёт",
    variant: "warning",
  });
  transcript.resolve("こんにちは");
  await finishing;
  assert.deepEqual(modals, []);
  assert.deepEqual(submitted, []);
  assert.equal(toasts.at(-1).title, "Диктовка");
  assert.match(toasts.at(-1).message, /исходное поле ввода/);
  const starting = russian[1].run();
  await russian[1].run();
  assert.equal(toasts.at(-1).message, "Запускаю запись…");
  await starting;
  assert.match(toasts.at(-1).message, /Идёт запись.*\/voice-submit/);
  const stopping = russian[1].run();
  const repeatedStop = russian[1].run();
  assert.equal(toasts.at(-1).message, "Останавливаю запись…");
  await Promise.all([stopping, repeatedStop]);
  assert.deepEqual(modals, []);
  assert.deepEqual(submitted, [{ sessionID: "s1", text: "こんにちは" }]);
  assert.equal(toasts.at(-1).message, "Текст распознан и отправлен");
  await english[2].run();
  assert.equal(toasts.at(-1).message, "Запись отменена");
});

test("setup errors use the language at failure and preserve the raw error; V1 stays English", async () => {
  const error = new Error("EACCES: cannot open /voice/mic");
  for (const [downloaded, legacy, expected] of [
    [false, false, "Не удалось настроить диктовку"],
    [true, false, "Не удалось подготовить запись и распознавание"],
    [true, true, "Voice runtime setup failed"],
  ]) {
    let language = "en";
    const setup = Promise.withResolvers();
    let reported;
    const controller = createVoiceController({
      getSettings: () => ({ uiLanguage: "ru" }),
      getUiLanguage: legacy ? undefined : () => language,
      ready: {
        ...ready,
        isModelDownloaded: () => downloaded,
        ensureEngineReady: () => setup.promise,
      },
      runtime: { isRecording: () => false, isTranscribing: () => false },
      onSetupError: (title, cause) => {
        reported = { title, cause };
      },
    });
    const start = controller.start();
    language = "ru";
    setup.reject(error);
    await start;
    assert.equal(reported.title, expected);
    assert.equal(reported.cause, error);
  }
});
