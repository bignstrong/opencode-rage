// node --experimental-test-module-mocks rust/dialog-extra-parity.mjs
// Exercise the SDK adapter twice. Replace engine, download and discovery effects before loading dialogs.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as audio from "../lib/engine.js";
import * as models from "../lib/models.js";

const dir = mkdtempSync(join(tmpdir(), "rage-dialog-"));
let trace, scenario;
const op = (name, ...args) => trace.push([name, ...args]);
const managedBinary = join(dir, "managed voice");
const effect = (name) => async (id, source) => {
  op(name, id, ...(name === "import" ? [source] : []));
  if (scenario.fail === name) throw Error(`fixture ${name} failure`);
  return { managedBinary };
};
class ReportedDownloadError extends Error {}
mock.module("../lib/engine.js", {
  namedExports: {
    ...audio,
    resolveCommand: (name) => (name === "ffmpeg" ? "/fixture/ffmpeg" : ""),
    listMicrophoneChoices: () => scenario.devices ?? [],
  },
});
mock.module("../lib/models.js", {
  namedExports: {
    ...models,
    isModelDownloaded: (m) => {
      op("downloaded?", m.id);
      return !!scenario.ready;
    },
    nativePickerRows: (...args) =>
      scenario.inventory ? undefined : models.nativePickerRows(...args),
    getModelInventory: (...args) =>
      scenario.inventory ? scenario.inventory.slice() : models.getModelInventory(...args),
    getModel: (id) => (id === "planned-fixture" ? { id, implemented: false } : models.getModel(id)),
  },
});
mock.module("../lib/engines.js", {
  namedExports: {
    getEngineStatus: (id) => {
      const source = scenario.source ?? "system";
      return {
        id,
        source,
        command: "fixture-cli",
        managedInstalled: source === "managed",
        resolvedBinary:
          source === "missing"
            ? null
            : source === "managed"
              ? managedBinary
              : "/fixture/path with spaces",
        managedBinary,
      };
    },
    installManagedEngine: effect("install"),
    importManagedEngine: effect("import"),
    removeManagedEngine: effect("remove"),
  },
});
mock.module("../src/ensure.ts", {
  namedExports: {
    ReportedDownloadError,
    ensureEngineReady: async (env, m) => {
      op("ensureEngine", m.id, env.settings.model);
      if (scenario.fail === "prepare") throw Error("fixture setup failure");
    },
    ensureDownloaded: async (_, m) => {
      op("ensureModel", m.id);
      if (scenario.fail === "reported") throw new ReportedDownloadError("already reported");
    },
  },
});

try {
  const {
    showDiagnostics,
    showModelPicker,
    showEngineManager,
    showMicrophonePicker,
    shouldShowStartupModelPicker,
    showTranscriptionSettings,
  } = await import("../src/dialogs.ts");
  let count = 0;
  async function compare(name, config, run) {
    async function record(mode) {
      process.env.RAGE_RUST = mode;
      trace = [];
      scenario = config;
      const settings = {
        uiLanguage: config.language,
        mic: config.mic ?? "",
        downloadDir: dir,
        ...config.settings,
      };
      // Normalization retains extra plugin settings; they must not cross the N-API boundary.
      settings.extension = { opaque: 1n };
      const choices = [...(config.choices ?? [])],
        answers = [...(config.answers ?? [])];
      let statusRead = 0;
      const d = {
        getSettings: () => settings,
        options: { platform: config.platform ?? "darwin", downloadDir: dir },
        getDownloadStatus: config.changingStatus
          ? () => ({ phase: "failed", detail: `failed ${++statusRead}` })
          : undefined,
        update: (fn) =>
          fn(
            new Proxy(settings, {
              set(target, key, value) {
                op("write", key, value);
                target[key] = value;
                return true;
              },
            }),
          ),
        toast: (...args) => op("toast", ...args),
        dialog: {
          select: (view) => {
            op("view", view);
            return choices.shift();
          },
          prompt: (view) => {
            op("prompt", view);
            return answers.shift();
          },
          confirm: (view) => {
            op("confirm", view);
            return answers.shift();
          },
          alert: (view) => op("alert", view),
        },
      };
      const result = await run(d);
      assert.deepEqual(choices, [], name);
      assert.deepEqual(answers, [], name);
      // SDK optional properties serialize as absent on the N-API path.
      return JSON.parse(JSON.stringify({ result, trace }));
    }
    const expected = await record("0");
    const actual = await record("1");
    assert.deepEqual(actual, expected, `${name} (${config.language})`);
    count++;
    return actual;
  }
  for (const language of ["en", "ru"]) {
    const check = (name, config, run) => compare(name, { language, ...config }, run);
    for (const first of [true, false])
      for (const choices of [[], ["__skip"], ["planned-fixture", "whisper-tiny"]]) {
        await check(`model ${first} ${choices}`, { choices }, (d) => showModelPicker(d, first));
      }
    for (const fail of ["reported", "prepare"])
      await check(fail, { choices: ["whisper-tiny"], fail }, (d) => showModelPicker(d, true));
    const inventory = ["planned", "not downloaded", "needs verification", "downloaded"].map(
      (status, i) => ({
        status,
        model: {
          id: `fixture-${i}`,
          name: `Model ${i}-gguf`,
          sizeMB: [0, 580, 1500, 94][i],
          implemented: i !== 0,
          languages: ["English", "multilingual", "en,de,fr,it,zh,ja,ru,uk", "en"][i],
          engine: "fixture",
        },
      }),
    );
    await check("extended model inventory", { inventory }, (d) => showModelPicker(d, true));
    const failed = await check(
      "download error snapshot",
      { choices: ["downloadError"], changingStatus: true },
      showTranscriptionSettings,
    );
    assert.equal(failed.trace.find(([event]) => event === "alert")[1].message, "failed 1");
    for (const onboardingDone of [true, false])
      for (const setupSkipped of [true, false])
        for (const ready of [true, false]) {
          const { trace, result } = await check(
            "startup",
            { settings: { onboardingDone, setupSkipped }, ready },
            shouldShowStartupModelPicker,
          );
          assert.equal(
            trace.length,
            Number(onboardingDone && !setupSkipped),
            "startup download check must short circuit",
          );
          assert.equal(result, !onboardingDone || (!setupSkipped && !ready));
        }
    for (const source of ["managed", "missing", "env", "option", "system"]) {
      await check(
        "diagnostics",
        { source, ready: source === "managed", mic: ":uid:USB:Desk%20Mic" },
        showDiagnostics,
      );
      await check("engine status", { source }, (d) => showEngineManager(d, "transcribe-cpp"));
    }
    for (const action of ["import", "install", "remove"])
      for (const failed of [false, true]) {
        const { trace } = await check(
          action,
          {
            source: action === "remove" ? "managed" : "system",
            choices: [action],
            answers: action === "remove" ? [true] : [],
            fail: failed ? action : "",
          },
          (d) => showEngineManager(d, "transcribe-cpp"),
        );
        assert.equal(trace.filter(([kind]) => kind === action).length, 1);
      }
    for (const answer of [false, undefined]) {
      const { trace } = await check(
        "remove cancelled",
        { source: "managed", choices: ["remove"], answers: [answer] },
        showEngineManager,
      );
      assert.ok(!trace.some(([kind]) => kind === "remove"));
    }
    const devices = [
      { value: ":uid:旧:New", title: "New" },
      { value: "USB", title: "USB" },
    ];
    for (const platform of ["darwin", "win32", "linux"]) {
      for (const mic of [
        ":3",
        "audio=USB",
        ":uid:旧:Old",
        ":uid:%FF:Bad",
        ":uid:A:Old%20%F0%9F%8E%A4",
        "::42",
      ]) {
        await check("microphone view", { platform, mic, devices }, (d) =>
          showMicrophonePicker(d, { standalone: true }),
        );
      }
      for (const answer of [" :: ", "default", undefined, "\uFEFF  USB 🎤  "]) {
        await check(
          "custom microphone",
          { platform, mic: "old", choices: ["__custom"], answers: [answer] },
          (d) => showMicrophonePicker(d, { standalone: true }),
        );
      }
    }
    await check(
      "iPhone refresh and return",
      { choices: ["__iphoneHelp", ""], mic: ":default" },
      showMicrophonePicker,
    );
  }
  console.log(`${count}/${count} reference/native SDK traces matched (EN/RU)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
