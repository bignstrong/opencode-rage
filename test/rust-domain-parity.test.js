import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as m from "../lib/models.js";
import { rustBinding, useRust } from "../lib/rust-binding.js";
import { showModelPicker } from "../src/dialogs.ts";
import { resolveUiLanguage } from "../src/i18n.ts";
import * as s from "../src/settings.ts";

const enabled = useRust();
const referenceRoot = process.env.RAGE_REFERENCE_ROOT;
const reference = "../native/tests/fixtures/catalog_preferences_reference.mjs";

test(
  "native preferences preserve undefined, function options and opaque object identity",
  { skip: !enabled },
  () => {
    const opaque = {
      toJSON() {
        throw Error("must not serialize injected options");
      },
    };
    opaque.self = opaque;
    const hook = () => {};
    const settings = s.normalizeSettings({ model: undefined, language: undefined, opaque, hook });
    assert.equal(settings.model, undefined);
    assert.equal(settings.language, "auto");
    assert.equal(settings.opaque, opaque);
    assert.equal(settings.hook, hook);
    assert.deepEqual(
      s.optionsOverlay({
        orb: opaque,
        mic: hook,
        model: null,
        language: undefined,
        get createRuntime() {
          throw Error("must not read unrelated hooks");
        },
      }),
      { orb: opaque, mic: hook, model: null },
    );
    assert.equal(s.optionsOverlay(Object.create({ model: "inherited" })).model, "inherited");
    assert.equal(s.mergeLegacyHotkey({ hook }, { hotkey: " alt+r " }).hook, hook);
    assert.equal(s.parseCutoffHz(null), undefined);
    assert.equal(s.parseCutoffHz(120n), 120);
    assert.equal(s.migrateHotkeyV2({ hotkeyMigratedV2: true }), undefined);
    assert.equal(s.migrateRecordingShortcut({ hotkeyMigratedV3: true }), undefined);
    assert.equal(m.expandHome(undefined), undefined);
    assert.equal(m.getModel(Symbol("unrecognized")), m.getModel(m.DEFAULT_MODEL_ID));
    assert.equal(
      resolveUiLanguage("ru", {
        get LC_ALL() {
          throw Error("explicit language wins");
        },
      }),
      "ru",
    );
  },
);

test(
  "public native exports and both V2 picker languages match an independent baseline",
  {
    skip: !enabled || !referenceRoot,
  },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rage-domain-parity-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const cases = execFileSync(
      process.execPath,
      [fileURLToPath(new URL(reference, import.meta.url)), dir],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    const operations = {
      models: () => m.MODELS,
      defaults: () => m.DEFAULT_SETTINGS,
      getModel: (a) => m.getModel(a.id),
      expandHome: (a) => m.expandHome(a.value),
      formatSize: (a) => m.formatSize(a.model),
      modelVerificationStamp: (a) => m.modelVerificationStamp(a.digest, a.stat),
      normalizeSettings: (a) => s.normalizeSettings(a.raw),
      optionsOverlay: (a) => s.optionsOverlay(a.options),
      mergeLegacyHotkey: (a) => s.mergeLegacyHotkey(a.current, a.legacy),
      migrateHotkeyV2: (a) => s.migrateHotkeyV2(a.settings),
      migrateRecordingShortcut: (a) => s.migrateRecordingShortcut(a.settings, a.configuredHotkey),
      parseCutoffHz: (a) => s.parseCutoffHz(a.value),
      resolveUiLanguage: (a) => resolveUiLanguage(a.preference, a.env),
    };
    for (const op of [
      "getCacheDir",
      "getModelsDir",
      "getAudioDir",
      "getEnginesDir",
      "getModelInventory",
    ])
      operations[op] = (a) => m[op](a.options, a.settings);
    for (const op of [
      "getModelPath",
      "getModelVerificationPath",
      "isModelDownloaded",
      "isModelFilePresent",
    ])
      operations[op] = (a) => m[op](a.model, a.options, a.settings);
    let count = 0;
    for (const line of cases.trim().split("\n")) {
      const { op, args, expected } = JSON.parse(line);
      if (!Object.hasOwn(operations, op)) continue; // Rust-only strict selection and separate enhance.js exports.
      const absent =
        expected === null &&
        ["parseCutoffHz", "migrateHotkeyV2", "migrateRecordingShortcut"].includes(op);
      assert.deepEqual(
        operations[op](args),
        absent ? undefined : expected,
        `${op}: ${JSON.stringify(args)}`,
      );
      ++count;
    }
    t.diagnostic(`${count} public-export comparisons`);
    assert.ok(count > 800);
    const baseline = await import(pathToFileURL(path.join(referenceRoot, "src/dialogs.ts")).href);
    const binding = rustBinding();
    const catalog = t.mock.method(binding, "catalog");
    const pick = async (show, uiLanguage) => {
      let rendered;
      await show(
        {
          options: { downloadDir: dir },
          getSettings: () => ({ uiLanguage }),
          dialog: {
            select: async (options) => {
              rendered = options;
            },
          },
        },
        true,
      );
      return rendered;
    };
    for (const lang of ["en", "ru"]) {
      const native = await pick(showModelPicker, lang);
      const original = await pick(baseline.showModelPicker, lang);
      assert.deepEqual(native, original);
    }
    assert.equal(catalog.mock.calls.filter((c) => c.arguments[0] === "pickerRows").length, 2);
  },
);
