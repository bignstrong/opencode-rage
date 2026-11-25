import {
  listMicrophoneChoices,
  listMicrophoneChoicesAsync,
  microphoneLabel,
  resolveCommand,
} from "../lib/engine.js";
import {
  getEngineStatus,
  importManagedEngine,
  installManagedEngine,
  removeManagedEngine,
} from "../lib/engines.js";
import {
  formatSize,
  getCacheDir,
  getModel,
  getModelInventory,
  getModelPath,
  isModelDownloaded,
  nativePickerRows,
} from "../lib/models.js";
import {
  ensureDownloaded,
  ensureEngineReady,
  ReportedDownloadError,
  type DownloadStatusFn,
  type DownloadStatus,
  type ToastFn,
} from "./ensure.ts";
import { WHISPER_LANGUAGES } from "./languages.ts";
import { parseCutoffHz } from "../lib/settings.js";
import { dialogText } from "./dialog-text.ts";
import {
  liveMicPicker,
  micIdentity,
  type MicDialog,
  type MicRow,
  type MicTheme,
} from "./mic-picker.ts";
import type { UiLanguage } from "./i18n.ts";
import { normalizeSettings, type SettingsUpdate, type VoiceSettings } from "./settings.ts";
import { rustBinding } from "../lib/rust-binding.js";

export interface DialogApi extends Partial<MicDialog> {
  alert(options: { title: string; message: string }): Promise<void>;
  confirm(options: {
    title: string;
    message: string;
    label?: { confirm?: string; cancel?: string };
  }): Promise<boolean | undefined>;
  prompt(options: {
    title: string;
    description?: string;
    placeholder?: string;
    value?: string;
  }): Promise<string | undefined>;
  select<Value>(options: {
    title: string;
    placeholder?: string;
    current?: Value;
    options: ReadonlyArray<{
      title: string;
      value: Value;
      description?: string;
      footer?: string;
      category?: string;
      disabled?: boolean;
    }>;
  }): Promise<Value | undefined>;
}

export interface DialogDeps {
  dialog: DialogApi;
  theme?: MicTheme;
  listMicrophones?: typeof listMicrophoneChoicesAsync;
  toast: ToastFn;
  downloadStatus?: DownloadStatusFn;
  getDownloadStatus?: (id: string) => DownloadStatus | undefined;
  options: Record<string, unknown>;
  getSettings: () => VoiceSettings;
  update: SettingsUpdate;
}

type D = DialogDeps;

function menuArgs(s: VoiceSettings, data: Record<string, unknown>) {
  const {
    language,
    uiLanguage,
    recordingHotkey,
    cleanupCutoffHz,
    voiceAnimation,
    voiceEnhance,
    autoSubmit,
    downloadDir,
    model,
    mic,
    onboardingDone,
    setupSkipped,
  } = s;
  return JSON.stringify({
    settings: {
      language,
      uiLanguage,
      recordingHotkey,
      cleanupCutoffHz,
      voiceAnimation,
      voiceEnhance,
      autoSubmit,
      downloadDir,
      model,
      mic,
      onboardingDone,
      setupSkipped,
    },
    language: dialogText(s).locale,
    ...data,
  });
}

function extra<T>(op: string, settings: VoiceSettings, data: Record<string, unknown> = {}): T {
  return JSON.parse(rustBinding().menuView(`extra/${op}`, menuArgs(settings, data)));
}

type DialogStep = {
  next?: string;
  action?: "import" | "install" | "remove";
  writes?: [keyof VoiceSettings, VoiceSettings[keyof VoiceSettings]][];
  toast?: string;
  variant?: Parameters<ToastFn>[1];
  error?: string;
  warning?: string;
  alert?: Parameters<DialogApi["alert"]>[0];
  prompt?: Parameters<DialogApi["prompt"]>[0];
  confirm?: Parameters<DialogApi["confirm"]>[0];
};

async function applyWrites(d: D, step: DialogStep) {
  for (const [field, value] of step.writes ?? []) await set(d, field, value);
  if (step.toast) d.toast(step.toast);
}
function nativeMenu(screen: string, settings: VoiceSettings, data: Record<string, unknown> = {}) {
  const native = rustBinding();
  if (!native) return undefined;
  return JSON.parse(native.menuView(screen, menuArgs(settings, data))) as Parameters<
    DialogApi["select"]
  >[0] & {
    current?: string;
    options: { title: string; value: string }[];
  };
}

type MenuText = Parameters<ReturnType<typeof dialogText>["t"]>[0];
type MenuEffect = {
  prompt?: { title: MenuText; placeholder: string; description?: MenuText; value: string };
  warning?: MenuText;
  set?: [keyof VoiceSettings, VoiceSettings[keyof VoiceSettings]];
  next?: string;
};

async function nativeSelection(
  d: D,
  screen: string,
  picked: unknown,
  settings: VoiceSettings,
  status?: DownloadStatus,
): Promise<void> {
  const { t } = dialogText(settings);
  const data = {
    picked,
    defaultDir:
      screen === "system" && picked === "downloadDir" ? getCacheDir(d.options, {}) : undefined,
  };
  const step = (extra: Record<string, unknown> = {}): MenuEffect =>
    JSON.parse(
      rustBinding().menuView(`select/${screen}`, menuArgs(settings, { ...data, ...extra })),
    );
  let effect = step();
  if (effect.prompt) {
    const p = effect.prompt;
    const answer = await d.dialog.prompt({
      ...p,
      title: t(p.title),
      description: p.description && t(p.description),
    });
    effect = step({ answered: true, answer });
  }
  if (effect.warning) d.toast(t(effect.warning), "warning");
  if (effect.set) await set(d, ...effect.set);
  switch (effect.next) {
    case "root":
      return showSettings(d);
    case "mic":
      return showMicrophonePicker(d);
    case "recording":
      return showRecordingSettings(d);
    case "key":
      return showRecordingHotkeyPicker(d);
    case "cutoff":
      return showCutoffPicker(d);
    case "transcription":
      return showTranscriptionSettings(d);
    case "language":
      return showLanguagePicker(d);
    case "uiLanguage":
      return showUiLanguagePicker(d);
    case "system":
      return showSystemSettings(d);
    case "engine":
      return showEngineManager(d);
    case "diagnostics":
      return showDiagnostics(d);
    case "model":
      return showModelPicker(d);
    case "download":
      return prepareModel(d, settings, getModel(settings.model));
    case "downloadError": {
      await d.dialog.alert({ title: t("Download error"), message: status?.detail ?? "" });
      return showTranscriptionSettings(d);
    }
  }
}

function settingsOf(d: D): VoiceSettings {
  return normalizeSettings(d.getSettings());
}

async function set(
  d: D,
  name: keyof VoiceSettings,
  value: VoiceSettings[keyof VoiceSettings],
): Promise<void> {
  await d.update((draft) => {
    (draft as unknown as Record<string, unknown>)[name as string] = value;
  });
}

async function prepareModel(d: D, settings: VoiceSettings, model: ReturnType<typeof getModel>) {
  const env = { ...d, settings };
  try {
    await ensureEngineReady(env, model);
    await ensureDownloaded(env, model);
  } catch (error) {
    if (rustBinding()) {
      const title = extra<string | null>("prepareError", settings, {
        reported: error instanceof ReportedDownloadError,
      });
      if (title) return showError(d, title, error);
      return;
    }
    if (!(error instanceof ReportedDownloadError))
      return showError(d, dialogText(settings).t("Voice setup failed"), error);
  }
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function showError(
  d: D,
  title: string,
  error: unknown,
  back = showSettings,
): Promise<void> {
  await d.dialog.alert({ title, message: errText(error) });
  return back(d);
}

export async function showModelPicker(d: D, firstRun = false): Promise<void> {
  const settings = settingsOf(d);
  const { t, locale } = dialogText(settings);
  const groups = {
    downloaded: "Downloaded models",
    "needs verification": "Pending verification",
    "not downloaded": "Available to download",
    planned: "Planned sidecar models",
  } as const;
  const order = Object.keys(groups);
  const rows = nativePickerRows(d.options, settings, locale, {
    ...Object.fromEntries(Object.entries(groups).map(([status, label]) => [status, t(label)])),
    langs: t("langs"),
    multilingual: t("multilingual"),
    English: t("English"),
  });
  const referenceRows = () =>
    getModelInventory(d.options, settings)
      .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))
      .map(({ model, status }) => {
        // Row renders as one clipped line: title + description, footer right.
        // Keep every field a short token so names/status stay readable.
        const rawLangs = model.languages;
        const langs =
          rawLangs.length > 20
            ? `${rawLangs.split(",").length} ${t("langs")}`
            : rawLangs === "multilingual" || rawLangs === "English"
              ? t(rawLangs)
              : rawLangs;
        // Display name only (value keeps full id); strip redundant packaging suffix.
        const label = model.name.replace(/-gguf$/, "");
        return {
          title: label,
          value: model.id,
          category: t(groups[status]),
          disabled: !model.implemented,
          footer: `${modelSize(model, locale)} · ${langs} · ${model.engine}`,
        };
      });
  const nativeView =
    rustBinding() &&
    nativeMenu("extra/model", settings, {
      rows,
      firstRun,
      // Virtual filesystems and extended catalogs still supply their inventory via the host.
      inventory: rows
        ? undefined
        : getModelInventory(d.options, settings).map(({ model, status }) => ({
            id: model.id,
            name: model.name,
            languages: model.languages,
            engine: model.engine,
            implemented: !!model.implemented,
            size: formatSize(model),
            status,
          })),
    });
  const picked = await d.dialog.select<string>(
    nativeView ?? {
      title: t(firstRun ? "Set up voice input: choose a local model" : "Voice model"),
      placeholder: t("Search voice models..."),
      current: settings.model,
      options: [
        ...referenceRows(),
        ...(firstRun
          ? [
              {
                title: t("Skip setup for now"),
                value: "__skip",
                category: t("Setup"),
                description: "/voice-settings",
              },
            ]
          : []),
      ],
    },
  );
  if (rustBinding()) {
    const model = picked !== undefined && picked !== "__skip" ? getModel(picked) : undefined;
    const step = extra<DialogStep>("modelPick", settings, {
      picked,
      firstRun,
      model: model && { id: model.id, implemented: !!model.implemented },
    });
    await applyWrites(d, step);
    if (step.next === "transcription") return showTranscriptionSettings(d);
    if (step.next === "model") return showModelPicker(d, firstRun);
    if (step.next === "prepare") return prepareModel(d, settingsOf(d), model);
    return;
  }
  if (picked === undefined) return firstRun ? undefined : showTranscriptionSettings(d);
  if (picked === "__skip") {
    await set(d, "onboardingDone", true);
    await set(d, "setupSkipped", true);
    d.toast(t("Voice setup skipped. Use /voice-settings when ready."));
    return;
  }
  const model = getModel(picked);
  if (!model?.implemented) return showModelPicker(d, firstRun);
  await set(d, "model", model.id);
  await set(d, "onboardingDone", true);
  await set(d, "setupSkipped", false);
  return prepareModel(d, settingsOf(d), model);
}

function modelSize(model: ReturnType<typeof getModel>, locale: UiLanguage) {
  const size = formatSize(model);
  if (locale === "en") return size;
  if (!model.sizeMB) return "размер неизвестен";
  return size.replace(" MB", " МБ").replace(" GB", " ГБ").replace(".", ",");
}

export function shouldShowStartupModelPicker(d: D): boolean {
  const settings = settingsOf(d);
  const model = getModel(settings.model);
  if (rustBinding()) {
    const answer = extra<boolean | "checkDownload">("startup", settings);
    return answer === "checkDownload" ? !isModelDownloaded(model, d.options, settings) : answer;
  }
  return (
    !settings.onboardingDone ||
    (!settings.setupSkipped && !isModelDownloaded(model, d.options, settings))
  );
}

export async function showLanguagePicker(d: D): Promise<void> {
  const settings = settingsOf(d);
  const { t, locale } = dialogText(settings);
  const names =
    locale === "ru"
      ? new Intl.DisplayNames("ru", { type: "language", fallback: "none" })
      : undefined;
  const custom =
    settings.language !== "auto" &&
    !WHISPER_LANGUAGES.some(([, code]) => code === settings.language);
  const picked = await d.dialog.select<string>(
    nativeMenu("language", settings) ?? {
      title: t("Voice language"),
      placeholder: t("Search…"),
      current: custom ? "__custom" : settings.language,
      options: [
        {
          title: t("Auto detect"),
          value: "auto",
        },
        ...WHISPER_LANGUAGES.map(([name, code]) => ({
          title: names?.of(code) ?? name,
          value: code,
          footer: code,
        })),
        {
          title: t("Custom code"),
          value: "__custom",
          description: custom ? settings.language : undefined,
        },
      ],
    },
  );
  if (rustBinding()) return nativeSelection(d, "language", picked, settings);
  if (picked === undefined) return showTranscriptionSettings(d);
  if (picked === "__custom") {
    const value = await d.dialog.prompt({
      title: t("Custom language code"),
      placeholder: "ru, en, de, ...",
      value: settings.language === "auto" ? "" : settings.language,
    });
    if (value === undefined) return showLanguagePicker(d);
    await set(d, "language", value.trim() || "auto");
    return showTranscriptionSettings(d);
  }
  await set(d, "language", picked);
  return showTranscriptionSettings(d);
}

function micValue(value: string, platform: unknown) {
  if (
    !value ||
    value === "default" ||
    (platform === "darwin" && value === ":default") ||
    (platform === "win32" && value === "audio=default")
  )
    return "";
  if (platform === "darwin" && !value.startsWith(":")) return `:${value}`;
  return value;
}

function micLabel(value: string, platform: unknown, t: ReturnType<typeof dialogText>["t"]) {
  const device = micValue(value, platform);
  if (!device) return t("System default");
  if (platform === "darwin")
    return /^:\d+$/.test(device)
      ? `${t("Device index")} ${device.slice(1)}`
      : microphoneLabel(device, { platform });
  return device;
}

export async function showMicrophonePicker(d: D, { standalone = false } = {}): Promise<void> {
  const settings = settingsOf(d);
  const { t, locale } = dialogText(settings);
  const commandOptions = {
    ...d.options,
    downloadDir: settings.downloadDir || d.options.downloadDir,
    skipFfmpegStaticInstall: true,
  };
  const platform = d.options.platform ?? process.platform;
  if (rustBinding()) {
    const view = (devices: MicRow[]) =>
      extra<{
        title: string;
        placeholder: string;
        current: string;
        options: MicRow[];
      }>("mic", settings, { platform, devices });
    const picked =
      platform === "darwin" && d.dialog.show && d.dialog.clear
        ? await liveMicPicker(d.dialog as MicDialog, {
            ...view([]),
            rows: (devices) => view(devices).options,
            list: (signal) =>
              (d.listMicrophones ?? listMicrophoneChoicesAsync)(commandOptions, signal),
            ru: locale === "ru",
            theme: d.theme,
          })
        : await d.dialog.select(view(listMicrophoneChoices(commandOptions)));
    const select = (data = {}) =>
      extra<DialogStep>("micPick", settings, { platform, picked, standalone, ...data });
    let step = select();
    if (step.prompt) step = select({ answered: true, answer: await d.dialog.prompt(step.prompt) });
    if (step.alert) await d.dialog.alert(step.alert);
    if (step.warning) d.toast(step.warning, "warning");
    await applyWrites(d, step);
    if (step.next === "mic") return showMicrophonePicker(d, { standalone });
    if (step.next === "root") return showSettings(d);
    return;
  }
  const placeholder =
    platform === "win32" ? "Microphone (USB Audio)" : platform === "darwin" ? ":0" : "hw:0,0";
  const saved = micValue(settings.mic, platform);
  const rows = (devices: MicRow[], current = saved) => [
    { title: t("System default"), value: "" },
    ...devices,
    ...(current &&
    !devices.some((device) =>
      platform === "darwin"
        ? micIdentity(device.value) === micIdentity(current)
        : device.value === current,
    )
      ? [
          {
            title: micLabel(current, platform, t),
            value: current,
            description: t(
              platform === "darwin" && /^:\d+$/.test(current)
                ? "Legacy selection"
                : "Saved, not listed",
            ),
          },
        ]
      : []),
    {
      title: t("Custom device"),
      value: "__custom",
    },
    ...(platform === "darwin" ? [{ title: t("Find iPhone"), value: "__iphoneHelp" }] : []),
  ];
  const menu = { title: t("Voice microphone"), placeholder: t("Search…") };
  let picked: string | undefined;
  if (platform === "darwin" && d.dialog.show && d.dialog.clear) {
    picked = await liveMicPicker(d.dialog as MicDialog, {
      ...menu,
      current: saved,
      rows,
      list: (signal) => (d.listMicrophones ?? listMicrophoneChoicesAsync)(commandOptions, signal),
      ru: locale === "ru",
      theme: d.theme,
    });
  } else {
    const devices = listMicrophoneChoices(commandOptions);
    const current =
      platform === "win32" && devices.some(({ value }) => `audio=${value}` === saved)
        ? saved.slice(6)
        : platform === "darwin"
          ? (devices.find(({ value }) => micIdentity(value) === micIdentity(saved))?.value ?? saved)
          : saved;
    picked = await d.dialog.select({ ...menu, current, options: rows(devices, current) });
  }
  if (picked === undefined) return standalone ? undefined : showSettings(d);
  if (picked === "__iphoneHelp") {
    await d.dialog.alert({
      title: t("iPhone not listed?"),
      message: t(
        "Check for the iPhone in Mac System Settings > Sound > Input. Enable Continuity Camera on the iPhone and keep it near the Mac. Close this message to refresh the list, or choose System default.",
      ),
    });
    return showMicrophonePicker(d, { standalone });
  }
  if (picked === "__custom") {
    const value = await d.dialog.prompt({
      title: t("Custom microphone device"),
      placeholder,
      value: settings.mic,
    });
    if (value === undefined) return showMicrophonePicker(d, { standalone });
    picked = micValue(value.trim(), platform);
  }
  if (platform === "darwin" && (picked === ":" || picked === "::")) {
    d.toast(
      locale === "ru" ? "Укажите имя или номер микрофона." : "Enter a microphone name or index.",
      "warning",
    );
    return showMicrophonePicker(d, { standalone });
  }
  await set(d, "mic", picked);
  if (!standalone) return showSettings(d);
}

export async function showRecordingHotkeyPicker(d: D): Promise<void> {
  const settings = settingsOf(d);
  const { t } = dialogText(settings);
  const presets = [
    { title: t("No shortcut"), value: "" },
    { title: "Ctrl + Space", value: "ctrl+space" },
    {
      title: "Ctrl + R",
      value: "ctrl+r",
      description: t("Also renames sessions"),
    },
    { title: "Alt + R", value: "alt+r" },
    {
      title: t("Custom hotkey"),
      value: "__custom",
    },
  ];
  const picked = await d.dialog.select<string>(
    nativeMenu("key", settings) ?? {
      title: t("Record key"),
      placeholder: t("Search…"),
      current: presets.some((p) => p.value === settings.recordingHotkey)
        ? settings.recordingHotkey
        : "__custom",
      options: presets,
    },
  );
  if (rustBinding()) return nativeSelection(d, "key", picked, settings);
  if (picked === undefined) return showRecordingSettings(d);
  if (picked === "__custom") {
    const value = await d.dialog.prompt({
      title: t("Custom recording key"),
      placeholder: "alt+shift+r",
      value: settings.recordingHotkey,
    });
    if (value === undefined) return showRecordingHotkeyPicker(d);
    // Keymap layer is reactive: it re-reads the store, no manual re-register.
    await set(d, "recordingHotkey", value.trim() || settings.recordingHotkey);
    return showRecordingSettings(d);
  }
  await set(d, "recordingHotkey", picked);
  return showRecordingSettings(d);
}

export async function showDiagnostics(d: D): Promise<void> {
  const settings = settingsOf(d);
  const { t } = dialogText(settings);
  const model = getModel(settings.model);
  const commandOptions = {
    ...d.options,
    downloadDir: settings.downloadDir,
    skipFfmpegStaticInstall: true,
  };
  const engine = getEngineStatus(model.engine, d.options, settings);
  if (rustBinding()) {
    const alert = extra<Parameters<DialogApi["alert"]>[0]>("diagnostics", settings, {
      platform: d.options.platform ?? process.platform,
      hostPlatform: `${process.platform}-${process.arch}`,
      status: engine,
      name: model.name,
      recorders: Object.fromEntries(
        ["ffmpeg", "arecord", "sox"].map((k) => [k, !!resolveCommand(k, commandOptions)]),
      ),
      downloaded: isModelDownloaded(model, d.options, settings),
      modelPath: getModelPath(model, d.options, settings),
      cache: getCacheDir(d.options, settings),
    });
    await d.dialog.alert(alert);
    return showSystemSettings(d);
  }
  const recorders = ["ffmpeg", "arecord", "sox"].map(
    (command) => `${command}=${t(resolveCommand(command, commandOptions) ? "yes" : "no")}`,
  );
  const lines = [
    `${t("Platform")}: ${process.platform}-${process.arch}`,
    `${t("Recorder")}: ${recorders.join(", ")}`,
    `${t("Microphone")}: ${micLabel(settings.mic, d.options.platform ?? process.platform, t)}`,
    `${t("Engine")}: ${engine.id} (${t(engine.source)})`,
    ...(engine.resolvedBinary ? [engine.resolvedBinary] : []),
    `${t("Active model")}: ${model.name} (${t(isModelDownloaded(model, d.options, settings) ? "downloaded" : "not downloaded")})`,
    `${t("Model path")}: ${getModelPath(model, d.options, settings)}`,
    `${t("Cache dir")}: ${getCacheDir(d.options, settings)}`,
  ];
  await d.dialog.alert({ title: t("Voice diagnostics"), message: lines.join("\n") });
  return showSystemSettings(d);
}

export async function showEngineManager(
  d: D,
  engineId = getModel(settingsOf(d).model).engine,
): Promise<void> {
  const settings = settingsOf(d);
  const { t } = dialogText(settings);
  const status = getEngineStatus(engineId, d.options, settings);
  if (rustBinding()) {
    const picked = await d.dialog.select(
      nativeMenu("extra/engine", settings, { status, engineId }),
    );
    const select = (data = {}) =>
      extra<DialogStep>("enginePick", settings, { status, picked, ...data });
    let step = select();
    if (step.confirm)
      step = select({ answered: true, answer: await d.dialog.confirm(step.confirm) });
    if (step.action) {
      try {
        if (step.toast) d.toast(step.toast);
        let managedBinary: string | undefined;
        switch (step.action) {
          case "import": {
            const result = await importManagedEngine(
              engineId,
              status.resolvedBinary as string,
              d.options,
              settings,
            );
            managedBinary = result.managedBinary;
            break;
          }
          case "install":
            await installManagedEngine(engineId, d.options, settings);
            break;
          case "remove":
            await removeManagedEngine(engineId, d.options, settings);
            break;
        }
        step = select({ done: true, managedBinary });
        if (step.toast) {
          if (step.variant) d.toast(step.toast, step.variant);
          else d.toast(step.toast);
        }
      } catch (error) {
        return showError(d, select({ failed: true }).error, error, () =>
          showEngineManager(d, engineId),
        );
      }
    }
    if (step.next === "engine") return showEngineManager(d, engineId);
    if (step.next === "system") return showSystemSettings(d);
    return;
  }
  const canImport = Boolean(status.resolvedBinary && status.source !== "managed");
  const picked = await d.dialog.select({
    title: `${engineId} · ${t(status.source)}`,
    placeholder: t("Search…"),
    options: [
      {
        title: t("Import detected engine"),
        value: "import",
        description: canImport ? status.command : undefined,
        disabled: !canImport,
      },
      {
        title: t(status.managedInstalled ? "Check or repair engine" : "Install managed engine"),
        value: "install",
        description: "GitHub Releases",
      },
      {
        title: t("Remove managed engine"),
        value: "remove",
        disabled: !status.managedInstalled,
      },
    ],
  });
  if (picked === undefined) return showSystemSettings(d);
  const back = () => showEngineManager(d, engineId);
  if (picked === "import") {
    try {
      const result = await importManagedEngine(
        engineId,
        status.resolvedBinary as string,
        d.options,
        settings,
      );
      d.toast(`${t("Managed engine imported")}: ${result.managedBinary}`, "success");
      return showEngineManager(d, engineId);
    } catch (error) {
      return showError(d, t("Engine import failed"), error, back);
    }
  }
  if (picked === "install") {
    try {
      d.toast(t("Installing engine…"));
      await installManagedEngine(engineId, d.options, settings);
      d.toast(t("Managed engine ready"), "success");
      return showEngineManager(d, engineId);
    } catch (error) {
      return showError(d, t("Engine install failed"), error, back);
    }
  }
  if (picked === "remove") {
    const ok = await d.dialog.confirm({
      title: t("Remove managed engine?"),
      message: status.managedBinary,
      label: { confirm: t("Remove"), cancel: t("Cancel") },
    });
    if (!ok) return showEngineManager(d, engineId);
    try {
      await removeManagedEngine(engineId, d.options, settings);
      d.toast(t("Managed engine removed"));
      return showEngineManager(d, engineId);
    } catch (error) {
      return showError(d, t("Engine remove failed"), error, back);
    }
  }
}

export async function showRecordingSettings(d: D): Promise<void> {
  const settings = settingsOf(d);
  const { t } = dialogText(settings);
  const picked = await d.dialog.select(
    nativeMenu("recording", settings) ?? {
      title: t("Recording"),
      placeholder: t("Search…"),
      options: [
        {
          title: t("Record key"),
          value: "key",
          description: settings.recordingHotkey || t("No shortcut"),
        },
        {
          title: t("Activity animations"),
          value: "animation",
          description: t(settings.voiceAnimation ? "enabled" : "disabled"),
        },
        {
          title: t("Voice cleanup"),
          value: "cleanup",
          description: t(settings.voiceEnhance ? "enabled" : "disabled"),
        },
        {
          title: t("Rumble filter"),
          value: "cutoff",
          description: settings.voiceEnhance
            ? `${settings.cleanupCutoffHz} ${t("Hz")}`
            : t("off (cleanup disabled)"),
          disabled: !settings.voiceEnhance,
        },
      ],
    },
  );
  if (rustBinding()) return nativeSelection(d, "recording", picked, settings);
  if (picked === undefined) return showSettings(d);
  if (picked === "key") return showRecordingHotkeyPicker(d);
  if (picked === "animation") {
    await set(d, "voiceAnimation", !settings.voiceAnimation);
    return showRecordingSettings(d);
  }
  if (picked === "cleanup") {
    await set(d, "voiceEnhance", !settings.voiceEnhance);
    return showRecordingSettings(d);
  }
  if (picked === "cutoff") return showCutoffPicker(d);
  return showRecordingSettings(d);
}

export async function showCutoffPicker(d: D): Promise<void> {
  const settings = settingsOf(d);
  const { t } = dialogText(settings);
  const presets = [
    { title: `80 ${t("Hz")}`, value: "80", description: t("Gentle") },
    {
      title: `120 ${t("Hz")}`,
      value: "120",
      description: t("Default"),
    },
    { title: `180 ${t("Hz")}`, value: "180", description: t("Strong") },
    {
      title: t("Custom cutoff"),
      value: "__custom",
      description: `40–500 ${t("Hz")}`,
    },
  ];
  const picked = await d.dialog.select<string>(
    nativeMenu("cutoff", settings) ?? {
      title: t("Rumble filter cutoff"),
      placeholder: t("Search…"),
      current: presets.some((p) => p.value === String(settings.cleanupCutoffHz))
        ? String(settings.cleanupCutoffHz)
        : "__custom",
      options: presets,
    },
  );
  if (rustBinding()) return nativeSelection(d, "cutoff", picked, settings);
  if (picked === undefined) return showRecordingSettings(d);
  if (picked === "__custom") {
    const value = await d.dialog.prompt({
      title: t("Custom cutoff frequency"),
      placeholder: "120",
      value: String(settings.cleanupCutoffHz),
    });
    if (value === undefined) return showCutoffPicker(d);
    const parsed = parseCutoffHz(value);
    if (parsed === undefined) {
      d.toast(t("Cutoff must be 40-500 Hz."), "warning");
      return showCutoffPicker(d);
    }
    await set(d, "cleanupCutoffHz", parsed);
    return showRecordingSettings(d);
  }
  await set(d, "cleanupCutoffHz", Number(picked));
  return showRecordingSettings(d);
}

export async function showTranscriptionSettings(d: D): Promise<void> {
  const settings = settingsOf(d);
  const { t, locale } = dialogText(settings);
  const model = getModel(settings.model);
  const downloaded = isModelDownloaded(model, d.options, settings);
  const status = d.getDownloadStatus?.(model.id);
  const busy = status?.phase === "downloading" || status?.phase === "verifying";
  const picked = await d.dialog.select(
    nativeMenu("transcription", settings, {
      name: model.name,
      downloaded,
      status,
      size: rustBinding()
        ? extra<string>("size", settings, { size: formatSize(model) })
        : undefined,
    }) ?? {
      title: t("Transcription"),
      placeholder: t("Search…"),
      options: [
        {
          title: t("Model"),
          value: "model",
          description: model.name,
          footer: downloaded ? t("ready") : undefined,
        },
        ...(!downloaded
          ? [
              {
                title: t(
                  busy
                    ? status.phase === "verifying"
                      ? "Verifying…"
                      : "Downloading…"
                    : "Download model",
                ),
                value: "download",
                description: busy ? status.detail : modelSize(model, locale),
                disabled: busy,
              },
            ]
          : []),
        ...(!downloaded && status?.phase === "failed"
          ? [{ title: t("Show download error"), value: "downloadError" }]
          : []),
        {
          title: t("Language"),
          value: "language",
          description: settings.language === "auto" ? t("auto detect") : settings.language,
        },
        {
          title: t("Auto-submit"),
          value: "autoSubmit",
          description: t(settings.autoSubmit ? "enabled" : "disabled"),
        },
      ],
    },
  );
  if (rustBinding()) return nativeSelection(d, "transcription", picked, settings, status);
  if (picked === undefined) return showSettings(d);
  if (picked === "model") return showModelPicker(d, false);
  if (picked === "download") return prepareModel(d, settings, model);
  if (picked === "downloadError") {
    await d.dialog.alert({ title: t("Download error"), message: status.detail });
    return showTranscriptionSettings(d);
  }
  if (picked === "language") return showLanguagePicker(d);
  if (picked === "autoSubmit") {
    await set(d, "autoSubmit", !settings.autoSubmit);
    return showTranscriptionSettings(d);
  }
}

export async function showSystemSettings(d: D): Promise<void> {
  const settings = settingsOf(d);
  const { t } = dialogText(settings);
  const model = getModel(settings.model);
  const picked = await d.dialog.select(
    (rustBinding() &&
      nativeMenu("system", settings, {
        dir: settings.downloadDir || getCacheDir(d.options, settings),
        source: getEngineStatus(model.engine, d.options, settings).source,
        engine: model.engine,
      })) ?? {
      title: t("System"),
      placeholder: t("Search…"),
      options: [
        {
          title: t("Storage directory"),
          value: "downloadDir",
          description: settings.downloadDir || getCacheDir(d.options, settings),
        },
        {
          title: t("Native engine"),
          value: "engine",
          description: `${t(getEngineStatus(model.engine, d.options, settings).source)} · ${model.engine}`,
        },
        {
          title: t("Diagnostics"),
          value: "diagnostics",
        },
      ],
    },
  );
  if (rustBinding()) return nativeSelection(d, "system", picked, settings);
  if (picked === undefined) return showSettings(d);
  if (picked === "downloadDir") {
    const value = await d.dialog.prompt({
      title: t("Storage directory"),
      description: t("Models, recordings and engines. Leave empty for the default."),
      placeholder: getCacheDir(d.options, {}),
      value: settings.downloadDir,
    });
    if (value === undefined) return showSystemSettings(d);
    await set(d, "downloadDir", value.trim());
    return showSystemSettings(d);
  }
  if (picked === "engine") return showEngineManager(d);
  if (picked === "diagnostics") return showDiagnostics(d);
}

export async function showSettings(d: D): Promise<void> {
  const settings = settingsOf(d);
  const { t } = dialogText(settings);
  const model = getModel(settings.model);
  const picked = await d.dialog.select(
    nativeMenu("root", settings, {
      name: model.name,
      micLabel: rustBinding()
        ? extra<string>("micLabel", settings, { platform: d.options.platform ?? process.platform })
        : undefined,
    }) ?? {
      title: t("Voice settings"),
      placeholder: t("Search…"),
      options: [
        {
          title: t("Microphone"),
          value: "mic",
          description: micLabel(settings.mic, d.options.platform ?? process.platform, t),
        },
        {
          title: t("Recording"),
          value: "recording",
          description: settings.recordingHotkey
            ? `${settings.recordingHotkey} · ${t("toggle")}`
            : t("No shortcut"),
        },
        {
          title: t("Transcription"),
          value: "transcription",
          description: `${model.name} · ${settings.language === "auto" ? t("auto language") : settings.language}`,
        },
        {
          title: t("System"),
          value: "system",
          description: t("Storage and engine"),
        },
        {
          title: t("Interface language"),
          value: "uiLanguage",
        },
      ],
    },
  );
  if (rustBinding()) return nativeSelection(d, "root", picked, settings);
  if (picked === undefined) return;
  if (picked === "mic") return showMicrophonePicker(d);
  if (picked === "recording") return showRecordingSettings(d);
  if (picked === "transcription") return showTranscriptionSettings(d);
  if (picked === "system") return showSystemSettings(d);
  if (picked === "uiLanguage") return showUiLanguagePicker(d);
}

const uiLanguageNames = { en: "English", ru: "Русский" };

async function showUiLanguagePicker(d: D): Promise<void> {
  const settings = settingsOf(d);
  const { t } = dialogText(settings);
  const picked = await d.dialog.select<string>(
    nativeMenu("uiLanguage", settings) ?? {
      title: t("Interface language"),
      placeholder: t("Search…"),
      current: settings.uiLanguage,
      options: [
        { title: t("Follow system language"), value: "auto" },
        { title: uiLanguageNames.en, value: "en" },
        { title: uiLanguageNames.ru, value: "ru" },
      ],
    },
  );
  if (rustBinding()) return nativeSelection(d, "uiLanguage", picked, settings);
  if (picked === "en" || picked === "ru" || picked === "auto") await set(d, "uiLanguage", picked);
  return showSettings(d);
}
