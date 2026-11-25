// Shared settings normalization (canonical home; plain JS so lib/ stays .ts-free).
// Consumed by the V1 adapter (index.js) directly and re-exported by src/settings.ts
// for V2, so both OpenCode versions normalize identically.
import { useRust } from "./rust-binding.js";
import { normalizeCutoffHz } from "./enhance.js";
import { DEFAULT_SETTINGS, getModel, originalCatalog } from "./models.js";
import { rustDomain } from "./rust-domain.js";

export const V2_DEFAULT_HOTKEY = DEFAULT_SETTINGS.recordingHotkey;
const V1_DEFAULT_HOTKEY = "ctrl+space";
const LEGACY_DEFAULT_HOTKEY = "ctrl+r";
const native = (op, args) => rustDomain("preferences", op, args);
const plain = (v) => v == null || typeof v === "boolean" || typeof v === "string" || Number.isFinite(v);
const fields = ["model", "recordingHotkey", "language", "uiLanguage", "mic", "downloadDir", "autoSubmit",
  "onboardingDone", "setupSkipped", "voiceAnimation", "voiceEnhance", "cleanupCutoffHz"];

/** Same normalization rules as V1 `readSettings` (index.js). Extra keys pass through untouched. */
export function normalizeSettings(raw = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...raw };
  if (useRust() && originalCatalog() && fields.every((key) => plain(settings[key]))) {
    // Only normalized fields cross N-API. Extra properties retain identity (including symbols and hooks).
    const input = Object.fromEntries(fields.map((key) => [key, settings[key] ?? null]));
    const result = native("normalizeSettings", { raw: input });
    for (const key of fields) {
      if (key === "model" && result.model === input.model) continue;
      settings[key] = result[key];
    }
    return settings;
  }
  if (!getModel(settings.model)?.implemented) settings.model = DEFAULT_SETTINGS.model;
  settings.recordingHotkey = String(settings.recordingHotkey || "").trim();
  settings.language = String(settings.language || "auto").trim() || "auto";
  if (!["en", "ru"].includes(settings.uiLanguage)) settings.uiLanguage = "auto";
  settings.mic = String(settings.mic || "").trim();
  settings.downloadDir = String(settings.downloadDir || "").trim();
  settings.autoSubmit = settings.autoSubmit === true || settings.autoSubmit === 1;
  settings.onboardingDone = Boolean(settings.onboardingDone);
  settings.setupSkipped = Boolean(settings.setupSkipped);
  settings.voiceAnimation = settings.voiceAnimation !== false;
  settings.voiceEnhance = settings.voiceEnhance !== false;
  settings.cleanupCutoffHz = normalizeCutoffHz(settings.cleanupCutoffHz);
  return settings;
}

/**
 * Legacy installs stored separate hold/toggle keys; both versions keep one `recordingHotkey`.
 * Preserves an explicit legacy hold key, else the old toggle key.
 */
export function mergeLegacyHotkey(current = {}, legacy = {}) {
  if (useRust()) {
    const key = current.recordingHotkey;
    const old = key ? {} : { hotkey: legacy.hotkey, toggleHotkey: legacy.toggleHotkey };
    if (plain(key) && plain(old.hotkey) && plain(old.toggleHotkey)) {
      const result = native("mergeLegacyHotkey", { current: { recordingHotkey: key }, legacy: old });
      return { ...current, recordingHotkey: result.recordingHotkey };
    }
  }
  if (current.recordingHotkey) {
    return { ...current, recordingHotkey: String(current.recordingHotkey).trim() || V1_DEFAULT_HOTKEY };
  }
  const hold = String(legacy.hotkey ?? "").trim();
  const toggle = String(legacy.toggleHotkey ?? "").trim();
  return { ...current, recordingHotkey: hold || toggle || V1_DEFAULT_HOTKEY };
}

/** One-time migration: old default ctrl+r -> ctrl+space (unless already migrated). */
export function migrateHotkeyV2(settings) {
  if (useRust()) {
    const migrated = Boolean(settings.hotkeyMigratedV2);
    const key = migrated ? null : settings.recordingHotkey;
    return native("migrateHotkeyV2", { settings: {
      hotkeyMigratedV2: migrated, recordingHotkey: typeof key === "string" ? key : null,
    } }) ?? undefined;
  }
  if (settings.hotkeyMigratedV2) return undefined;
  if (settings.recordingHotkey !== LEGACY_DEFAULT_HOTKEY) return { hotkeyMigratedV2: true };
  return { recordingHotkey: V1_DEFAULT_HOTKEY, hotkeyMigratedV2: true };
}

/** V2 used to persist its factory shortcut without tracking whether the user chose it. */
export function migrateRecordingShortcut(settings, configuredHotkey) {
  if (useRust() && plain(configuredHotkey)) {
    const migrated = Boolean(settings.hotkeyMigratedV3);
    const key = migrated ? null : settings.recordingHotkey;
    return native("migrateRecordingShortcut", { configuredHotkey, settings: {
      hotkeyMigratedV2: key === "ctrl+r" && Boolean(settings.hotkeyMigratedV2), hotkeyMigratedV3: migrated,
      recordingHotkey: typeof key === "string" ? key : null,
    } }) ?? undefined;
  }
  if (settings.hotkeyMigratedV3) return undefined;
  const key = settings.recordingHotkey;
  const oldDefault = key === "ctrl+space" || (key === "ctrl+r" && !settings.hotkeyMigratedV2);
  if (oldDefault && key !== String(configuredHotkey ?? "").trim()) {
    return { recordingHotkey: V2_DEFAULT_HOTKEY, hotkeyMigratedV3: true };
  }
  return { hotkeyMigratedV3: true };
}

/** Parse a custom cutoff entry (Hz); undefined when outside the 40-500 band. */
export function parseCutoffHz(value) {
  if (useRust()) return native("parseCutoffHz", { value: String(value ?? "") }) ?? undefined;
  const parsed = Number(String(value ?? "").trim());
  if (!Number.isFinite(parsed) || parsed < 40 || parsed > 500) return undefined;
  return Math.round(parsed);
}

/** Plugin options act as initial overrides (lowest precedence: stored settings always win). */
export function optionsOverlay(options = {}) {
  const overlay = {};
  if (useRust() && options &&
      [Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    // Ask Rust for recognized keys. Never serialize or inspect unrelated injected runtime objects.
    const names = Object.fromEntries(Object.getOwnPropertyNames(options).map((key) => [key, true]));
    const allowed = native("optionsOverlay", { options: names });
    for (const key of Object.keys(allowed)) {
      const value = options[key];
      if (value !== undefined) overlay[key] = value;
    }
    return overlay;
  }
  for (const key of [
    "recordingHotkey",
    "model",
    "language",
    "uiLanguage",
    "mic",
    "autoSubmit",
    "downloadDir",
    "voiceEnhance",
    "voiceAnimation",
    "orb",
    "cleanupCutoffHz",
  ]) {
    if (options[key] !== undefined) overlay[key] = options[key];
  }
  return overlay;
}
