// Test oracle only. Point RAGE_REFERENCE_ROOT at an untouched baseline after cutover.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.env.RAGE_REFERENCE_ROOT ?? fileURLToPath(new URL("../../../", import.meta.url));
if (process.env.RAGE_RUST === "1" && fs.existsSync(path.join(root, "lib", "rust-domain.js"))) {
  throw Error("Use an independent baseline checkout for RAGE_REFERENCE_ROOT; the active native adapter is not a reference.");
}
const load = (name) => import(pathToFileURL(path.join(root, "lib", `${name}.js`)).href);
const [m, s, e, i18n] = await Promise.all(["models", "settings", "enhance", "i18n"].map(load));
if (process.argv[2] === "--catalog") {
  process.stdout.write(JSON.stringify({
    defaultId: m.DEFAULT_MODEL_ID, defaults: m.DEFAULT_SETTINGS, models: m.MODELS,
  }, null, 2) + "\n");
  process.exit(0);
}

const emit = (op, args, expected) =>
  process.stdout.write(JSON.stringify({ op, args, expected: expected ?? null }) + "\n");
const dir = process.argv[2]; // Created by the test. Never inspect the real model cache.
if (!dir || !path.isAbsolute(dir)) throw Error("A temporary directory is required");
const options = { downloadDir: dir };
const settings = { downloadDir: path.join(dir, "other", "..") };
emit("models", {}, m.MODELS);
emit("defaults", {}, m.DEFAULT_SETTINGS);
for (const value of ["", "~", "~/test/../voice", "~/", "a/../b", null])
  emit("expandHome", {value}, m.expandHome(value));
for (const sizeMB of [0, null, 1, 1.5, 1250, 1280, 1750, 1792])
  emit("formatSize", {model:{sizeMB}}, m.formatSize({sizeMB}));
const stampStat = {dev:"900", ino:"72057594037927937", size:"42", mtimeNs:"1749000000000000001", ctimeNs:"1749000000000000002"};
emit("modelVerificationStamp", {digest:"ABC",stat:stampStat}, m.modelVerificationStamp("ABC",stampStat));
for (const [op,fn] of [["normalizeSettings",s.normalizeSettings],["optionsOverlay",s.optionsOverlay],
    ["mergeLegacyHotkey",s.mergeLegacyHotkey],["buildFilterChain",e.buildFilterChain],["parseCutoffHz",s.parseCutoffHz]])
  emit(op, {}, fn());
const modelsDir = m.getModelsDir(options);
fs.mkdirSync(modelsDir);
for (const [idx, model] of m.MODELS.entries()) {
  emit("getModel", { id: model.id }, m.getModel(model.id));
  emit("selectModel", { id: model.id }, m.MODELS.find((v) => v.id === model.id && v.implemented));
  emit("formatSize", { model }, m.formatSize(model));
  emit("normalizeSettings", { raw: {model: model.id} }, s.normalizeSettings({model: model.id}));
  const file = m.getModelPath(model, options);
  // Missing / empty / unmarked / legacy digest / valid stamp / wrong stamp.
  if (idx % 6) fs.writeFileSync(file, idx % 6 === 1 ? "" : "fixture");
  if (idx % 6 >= 3) {
    const receipt = idx % 6 === 3 ? ` ${model.sha256.toUpperCase()}\n`
      : idx % 6 === 4 ? m.modelVerificationStamp(model.sha256, fs.statSync(file, {bigint: true})) : "stale";
    fs.writeFileSync(`${file}.sha256`, receipt);
  }
  for (const op of ["getModelPath", "getModelVerificationPath", "isModelDownloaded", "isModelFilePresent"]) {
    emit(op, { model, options, settings }, m[op](model, options, settings));
  }
}
emit("getModelInventory", { options }, m.getModelInventory(options));
for (const op of ["getCacheDir", "getModelsDir", "getEnginesDir", "getAudioDir"])
  emit(op, {options, settings}, m[op](options, settings));
for (const id of [null, "", "whisper-small ", "unknown", 2])
  emit("getModel", {id}, m.getModel(id));
for (const value of [null, "", "\ufeff  ", true, false, 0, 1, 120, "0x80", "0b101000", "0o120",
    " 179.6 ", "1e2", "1.1E+2", "nan", "2hz", -5, 39.9, 40, 499.9, 501, 1024, 1025,
    "1000", 1e-7, 1e21, [], [120], {}, [" ru ", null, 1]]) {
  emit("parseCutoffHz", {value}, s.parseCutoffHz(value));
  emit("normalizeCutoffHz", {value}, e.normalizeCutoffHz(value));
  for (const enabled of [true, false]) {
    const args = {enabled, cutoffHz: value};
    emit("buildFilterChain", args, e.buildFilterChain(args));
  }
  const raw = Object.fromEntries(["recordingHotkey", "language", "uiLanguage", "mic", "downloadDir",
    "autoSubmit", "onboardingDone", "setupSkipped", "voiceAnimation", "voiceEnhance", "cleanupCutoffHz",
    "orb", "extra", "model"].map(k => [k, value]));
  emit("normalizeSettings", {raw}, s.normalizeSettings(raw));
  emit("optionsOverlay", {options: raw}, s.optionsOverlay(raw));
  for (const current of [{}, {recordingHotkey: value}]) {
    const legacy = {hotkey: value, toggleHotkey: " ctrl+t "};
    emit("mergeLegacyHotkey", {current, legacy}, s.mergeLegacyHotkey(current, legacy));
  }
}
for (const recordingHotkey of ["ctrl+r", "ctrl+space", "alt+r", "", false]) {
  for (const hotkeyMigratedV2 of [true, false]) for (const hotkeyMigratedV3 of [true, false]) {
    const settings = {recordingHotkey, hotkeyMigratedV2, hotkeyMigratedV3};
    emit("migrateHotkeyV2", {settings}, s.migrateHotkeyV2(settings));
    for (const configuredHotkey of [null, " ctrl+space ", recordingHotkey]) {
      emit("migrateRecordingShortcut", {settings, configuredHotkey}, s.migrateRecordingShortcut(settings, configuredHotkey));
    }
  }
}
for (const preference of ["ru", "en", "auto", null, "unknown"]) {
  for (const env of [{LC_ALL:"C", LC_MESSAGES:"ru"}, {LC_ALL:"", LC_MESSAGES:"ru_RU"}, {LANG:"ru"},
        {LANG:"RU.UTF-8"}, {LANG:"ru@x"}, {LANG:"ru-ru"}, {LANG:"rus"}, {LANG:"de"}])
    emit("resolveUiLanguage", {preference, env}, i18n.resolveUiLanguage(preference, env));
}
