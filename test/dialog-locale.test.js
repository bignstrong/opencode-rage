import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import {
  showDiagnostics,
  showMicrophonePicker,
  showModelPicker,
  showSettings,
} from "../src/dialogs.ts";

function fixture(uiLanguage, choices = [], prompts = []) {
  const settings = { uiLanguage, language: "de" };
  const selects = [];
  const alerts = [];
  const toasts = [];
  return {
    selects,
    alerts,
    toasts,
    settings,
    deps: {
      options: {},
      getSettings: () => settings,
      update: (change) => change(settings),
      dialog: {
        select(menu) {
          selects.push(menu);
          const choice = choices.shift();
          if (choice !== undefined) assert.ok(menu.options.some(({ value }) => value === choice));
          return choice;
        },
        alert: (message) => alerts.push(message),
        prompt: () => prompts.shift(),
      },
      toast: (message) => toasts.push(message),
    },
  };
}

for (const [locale, noShortcut, animation] of [
  ["en", "No shortcut", "Activity animations"],
  ["ru", "Без сочетания клавиш", "Анимация активности"],
]) {
  test(`${locale}: recording menu sets custom shortcut, clears it and toggles animation`, async () => {
    const { deps, settings, selects } = fixture(
      locale,
      ["recording", "key", "__custom", "key", "", "animation"],
      [" alt+shift+r "],
    );
    await showSettings(deps);
    const [home, recording, picker, customRecording, customPicker, cleared, toggled] = selects;
    const row = (menu, id) => menu.options.find(({ value }) => value === id);
    assert.ok(row(home, "recording").description.includes(noShortcut));
    assert.equal(row(recording, "animation").title, animation);
    assert.equal(picker.current, "");
    assert.equal(row(picker, "").title, noShortcut);
    assert.equal(row(customRecording, "key").description, "alt+shift+r");
    assert.equal(customPicker.current, "__custom");
    assert.equal(row(cleared, "key").description, noShortcut);
    assert.notEqual(row(toggled, "animation").description, row(cleared, "animation").description);
    assert.equal(settings.recordingHotkey, "");
    assert.equal(settings.voiceAnimation, false);
  });
}

test("switching UI language redraws settings immediately and preserves action IDs and ASR language", async () => {
  const { deps, settings, selects } = fixture("en", ["uiLanguage", "ru"]);
  await showSettings(deps);
  const [english, picker, russian] = selects;
  assert.equal(english.title, "Voice settings");
  assert.deepEqual(
    picker.options.map(({ value }) => value),
    ["auto", "en", "ru"],
  );
  assert.equal(russian.title, "Настройки голосового ввода");
  assert.deepEqual(
    russian.options.map(({ value }) => value),
    english.options.map(({ value }) => value),
  );
  assert.deepEqual(settings, { uiLanguage: "ru", language: "de" });
});

test("selecting a speech language in Russian keeps the UI in Russian", async () => {
  const { deps, settings, selects } = fixture("ru", ["transcription", "language", "en"]);
  await showSettings(deps);
  const picker = selects[2];
  assert.match(picker.options.find(({ value }) => value === "en").title, /английский/i);
  assert.equal(selects.at(-1).title, "Настройки голосового ввода");
  assert.deepEqual(settings, { uiLanguage: "ru", language: "en" });
});

test("Russian onboarding retains the setup command and skip action", async () => {
  const { deps, selects, settings, toasts } = fixture("ru", ["__skip"]);
  await showModelPicker(deps, true);
  assert.match(selects[0].title, /выберите модель/);
  assert.match(
    selects[0].options.find(({ value }) => value === "__skip").description,
    /\/voice-settings/,
  );
  assert.match(toasts[0], /пропущена.*\/voice-settings/);
  assert.equal(settings.setupSkipped, true);
});

test("Russian diagnostics preserve platform, recorder names and the configured cache path", async () => {
  const { deps, alerts, settings } = fixture("ru");
  settings.downloadDir = "/cache/Voice Models";
  await showDiagnostics(deps);
  assert.equal(alerts[0].title, "Диагностика голосового ввода");
  assert.ok(alerts[0].message.includes(`Платформа: ${process.platform}-${process.arch}`));
  assert.match(alerts[0].message, /ffmpeg=(да|нет), arecord=(да|нет), sox=(да|нет)/);
  assert.ok(alerts[0].message.includes(`Папка кеша: ${settings.downloadDir}`));
});

test("mic picker remembers the named input, refreshes iPhone discovery and switches back to default", async (t) => {
  const phone = "Ada’s iPhone";
  const { deps, settings, selects, alerts } = fixture("ru", [
    "mic",
    "__iphoneHelp",
    `:${phone}`,
    "mic",
    "",
  ]);
  settings.mic = ":2";
  deps.options = { platform: "darwin", ffmpeg: process.execPath };
  let scans = 0;
  const stub = t.mock.method(childProcess, "spawnSync", (command, args) => {
    assert.equal(command, process.execPath);
    assert.ok(args.includes("-list_devices"));
    return {
      stderr: `AVFoundation audio devices:\n[0] Built-in Mic\n${++scans > 1 ? `[1] ${phone}\n` : ""}`,
    };
  });
  syncBuiltinESMExports();
  t.after(() => {
    stub.mock.restore();
    syncBuiltinESMExports();
  });
  await showSettings(deps);
  const [, legacy, refreshed, home, reopened, done] = selects;
  const row = (menu, value) => menu.options.find((o) => o.value === value);
  assert.equal(legacy.current, ":2");
  assert.match(row(legacy, ":2").title, /2/);
  assert.match(alerts[0].message, /iPhone.*обновить/s);
  assert.equal(row(refreshed, `:${phone}`).title, phone);
  assert.equal(row(home, "mic").description, phone);
  assert.equal(reopened.current, `:${phone}`);
  assert.equal(done.title, home.title);
  assert.equal(settings.mic, "");
  assert.equal(scans, 3, "scan only inside picker, never on settings home");
  for (const [saved, expected, label] of [
    [":default", "", "Системный микрофон"],
    ["default", "", "Системный микрофон"],
    ["::123", "::123", "123"],
    [":::Jack", ":::Jack", ":Jack"],
    [":uid:abc:Office%20USB", ":uid:abc:Office%20USB", "Office USB"],
    [`:${phone} (offline)`, `:${phone} (offline)`, `${phone} (offline)`],
  ]) {
    settings.mic = saved;
    const count = selects.length;
    await showMicrophonePicker(deps, { standalone: true });
    const menu = selects.at(-1);
    assert.equal(selects.length, count + 1, "standalone cancel must close");
    assert.equal(menu.options.filter((o) => o.value === "").length, 1);
    assert.equal(menu.current, expected);
    assert.equal(row(menu, expected).title, label);
    assert.equal(settings.mic, saved, "opening a picker must not migrate a selection");
  }
  for (const [input, expected] of [
    [":", ":keep"],
    [" :: ", ":keep"],
    ["", ""],
    ["default", ""],
    [":default", ""],
  ]) {
    const form = fixture("ru", ["__custom"], [input]);
    form.deps.options = deps.options;
    form.settings.mic = ":keep";
    await showMicrophonePicker(form.deps, { standalone: true });
    assert.equal(form.settings.mic, expected);
    if (expected === ":keep") assert.match(form.toasts[0], /имя или номер микрофона/);
  }
});

test("Russian settings walk: Esc returns one level and each search field is localized", async () => {
  const { deps, selects, alerts, settings } = fixture("ru", [
    "transcription",
    "model",
    undefined,
    "language",
    "__custom",
    undefined,
    undefined,
    "recording",
    "key",
    undefined,
    "cutoff",
    undefined,
    undefined,
    "system",
    "engine",
    undefined,
    "diagnostics",
    "downloadDir",
    undefined,
    "uiLanguage",
  ]);
  await showSettings(deps);
  assert.deepEqual(
    selects.map((s) => s.title),
    [
      "Настройки голосового ввода",
      "Распознавание",
      "Модель распознавания",
      "Распознавание",
      "Язык распознавания",
      "Язык распознавания",
      "Распознавание",
      "Настройки голосового ввода",
      "Запись",
      "Клавиши записи",
      "Запись",
      "Частота среза фильтра",
      "Запись",
      "Настройки голосового ввода",
      "Система",
      selects[15].title,
      "Система",
      "Система",
      "Система",
      "Настройки голосового ввода",
      "Язык интерфейса",
      "Настройки голосового ввода",
    ],
  );
  assert.match(selects[15].title, /whisper\.cpp/);
  assert.ok(selects.every((menu) => /Поиск|Найти/.test(menu.placeholder)));
  assert.match(alerts[0].title, /Диагностика/);
  assert.deepEqual(settings, { uiLanguage: "ru", language: "de" });
});
