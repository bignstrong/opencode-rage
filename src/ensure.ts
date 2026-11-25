import { downloadModel } from "../lib/download.js";
import { rustBinding } from "../lib/rust-binding.js";
import {
  VoiceRuntime,
  ensureManagedRecorder,
  getRecorderStatus,
  probeRecorder,
} from "../lib/engine.js";
import { getEngineStatus, installManagedEngine } from "../lib/engines.js";
import { getModel, getModelPath, isModelDownloaded } from "../lib/models.js";
import { formatBytes } from "./formatters.ts";
import { resolveUiLanguage, type UiLanguage } from "./i18n.ts";
import type { VoiceSettings } from "./settings.ts";

export type ToastFn = (message: string, variant?: "info" | "success" | "warning" | "error") => void;
interface StatusCopy {
  hint: string;
  detail: string;
}
export interface DownloadStatus extends StatusCopy {
  phase: "downloading" | "verifying" | "ready" | "failed";
  translations?: Record<UiLanguage, StatusCopy>;
}

function readiness<T>(op: string, args: Record<string, unknown> = {}): T {
  return JSON.parse(rustBinding().readiness(op, JSON.stringify(args)));
}
export function localizeDownloadStatus(
  value: DownloadStatus,
  language: UiLanguage,
): DownloadStatus {
  if (rustBinding()) {
    const fields = (copy?: StatusCopy) => copy && { hint: copy.hint, detail: copy.detail };
    const selected = readiness<UiLanguage | null>("localize", {
      language,
      hint: value.hint,
      detail: value.detail,
      en: fields(value.translations?.en),
      ru: fields(value.translations?.ru),
    });
    return selected ? { ...value, ...value.translations[selected] } : value;
  }
  const copy = value.translations?.[language];
  return copy && (copy.hint !== value.hint || copy.detail !== value.detail)
    ? { ...value, ...copy }
    : value;
}
export type DownloadStatusFn = (modelId: string, status: DownloadStatus) => void;
export class ReportedDownloadError extends Error {}

export interface EnsureEnv {
  options: Record<string, unknown>;
  settings: VoiceSettings;
  getSettings?: () => VoiceSettings;
  toast: ToastFn;
  downloadStatus?: DownloadStatusFn;
  download?: typeof downloadModel;
  installEngine?: typeof installManagedEngine;
  ensureRecorder?: typeof ensureManagedRecorder;
}

interface DownloadFlight {
  result: Promise<boolean>;
  listeners: Map<DownloadStatusFn, EnsureEnv>;
  message?: DownloadStatus;
}

const downloads = new Map<string, DownloadFlight>();

function uiLanguage(env: EnsureEnv) {
  return resolveUiLanguage((env.getSettings?.() ?? env.settings).uiLanguage);
}

export async function ensureDownloaded(
  env: EnsureEnv,
  model = getModel(env.settings.model),
): Promise<boolean> {
  const path = getModelPath(model, env.options, env.settings);
  const current = downloads.get(path);
  const native = rustBinding();
  if (native) {
    const action = readiness<string>("flight", {
      active: !!current,
      newListener: !!(current && env.downloadStatus && !current.listeners.has(env.downloadStatus)),
      hasMessage: current?.message !== undefined,
      downloaded: !current && isModelDownloaded(model, env.options, env.settings),
    });
    if (action === "ready") return true;
    if (action !== "download") {
      if (action !== "join") current.listeners.set(env.downloadStatus, env);
      if (action === "replay")
        env.downloadStatus(model.id, localizeDownloadStatus(current.message, uiLanguage(env)));
      return current.result;
    }
  } else if (current) {
    if (env.downloadStatus && !current.listeners.has(env.downloadStatus)) {
      current.listeners.set(env.downloadStatus, env);
      if (current.message !== undefined)
        env.downloadStatus(model.id, localizeDownloadStatus(current.message, uiLanguage(env)));
    }
    return current.result;
  } else if (isModelDownloaded(model, env.options, env.settings)) return true;

  // Register the flight before the first status callback can trigger another caller.
  const flight: DownloadFlight = {
    listeners: new Map(env.downloadStatus ? [[env.downloadStatus, env]] : []),
    result: Promise.resolve()
      .then(() =>
        (native ? nativeDownload : runDownload)(env, model, (message) => {
          if (
            native
              ? !readiness<boolean>("publish", {
                  previousHint: flight.message?.hint,
                  previousDetail: flight.message?.detail,
                  hint: message.hint,
                  detail: message.detail,
                })
              : flight.message?.detail === message.detail && flight.message.hint === message.hint
          )
            return;
          flight.message = message;
          for (const [listener, subscriber] of flight.listeners)
            listener(model.id, localizeDownloadStatus(message, uiLanguage(subscriber)));
        }),
      )
      .finally(() => downloads.delete(path)),
  };
  downloads.set(path, flight);
  return flight.result;
}

async function nativeDownload(
  env: EnsureEnv,
  model: ReturnType<typeof getModel>,
  report: (status: DownloadStatus) => void,
): Promise<boolean> {
  const download = env.download ?? downloadModel;
  const state = new (rustBinding().DownloadReadiness)();
  let timer: ReturnType<typeof setTimeout>;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const emit = (status: DownloadStatus) => report(localizeDownloadStatus(status, uiLanguage(env)));
  const flush = () => {
    clear();
    emit(JSON.parse(state.flush(performance.now())));
  };
  try {
    const start = readiness<{ retries: number; status: DownloadStatus }>("downloadStart");
    emit(start.status);
    env.toast(
      ...readiness<Parameters<ToastFn>>("downloadNotice", {
        language: uiLanguage(env),
        id: String(model.name),
      }),
    );
    await download(model, env.options, env.settings, {
      retries: start.retries,
      onProgress: (p: { state: string; downloaded: number; total: number }) => {
        const effect: { clear?: true; flush?: true; wait?: number; status?: DownloadStatus } =
          JSON.parse(state.progress(p.state, p.downloaded ?? 0, p.total ?? 0, performance.now()));
        if (effect.clear) clear();
        if (effect.status) emit(effect.status);
        if (effect.flush) flush();
        else if (effect.wait !== undefined) timer ??= setTimeout(flush, effect.wait);
      },
      onRetry: ({ nextAttempt, attempts }) => {
        clear();
        emit(JSON.parse(state.retry(String(nextAttempt), String(attempts))));
      },
    });
    emit(readiness<DownloadStatus>("ready"));
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    emit(readiness<DownloadStatus>("failed", { detail }));
    if (readiness<string>("errorKind", { listener: !!env.downloadStatus }) === "original")
      throw error;
    throw new ReportedDownloadError(detail, { cause: error });
  } finally {
    clear();
  }
}

async function runDownload(
  env: EnsureEnv,
  model: ReturnType<typeof getModel>,
  report: (status: DownloadStatus) => void,
): Promise<boolean> {
  const download = env.download ?? downloadModel;
  const language = () => uiLanguage(env);
  const emit = (phase: DownloadStatus["phase"], en: StatusCopy, ru: StatusCopy) => {
    const translations = { en, ru };
    report({ phase, ...translations[language()], translations });
  };
  let bytes = 0;
  let total = 0;
  let lastUpdate = -Infinity;
  let timer: ReturnType<typeof setTimeout>;
  const clearPending = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const size = (n: number, lang: UiLanguage) =>
    lang === "ru"
      ? formatBytes(n).replace("MB", "МБ").replace("GB", "ГБ").replace(".", ",")
      : formatBytes(n);
  const counts = (lang: UiLanguage) =>
    total > 0 ? `${size(bytes, lang)} / ${size(total, lang)}` : size(bytes, lang);
  const showBytes = () => {
    clearPending();
    lastUpdate = performance.now();
    const amount = (lang: UiLanguage) =>
      total > 0 ? ` ${Math.floor((bytes / total) * 100)}%` : ` · ${size(bytes, lang)}`;
    emit(
      "downloading",
      {
        hint: `Downloading model${amount("en")}`,
        detail: counts("en"),
      },
      {
        hint: `Загрузка модели${amount("ru")}`,
        detail: counts("ru"),
      },
    );
  };
  try {
    emit(
      "downloading",
      { hint: "Downloading model…", detail: "Downloading…" },
      { hint: "Загрузка модели…", detail: "Загрузка…" },
    );
    env.toast(
      language() === "ru"
        ? `Скачиваю ${model.name}. Прогресс смотри под полем ввода.`
        : `Downloading ${model.name}. See progress below the input field.`,
      "info",
    );
    await download(model, env.options, env.settings, {
      retries: 5,
      onProgress: (p: { state: string; downloaded: number; total: number }) => {
        if (p.state === "verifying") {
          clearPending();
          emit(
            "verifying",
            { hint: "Verifying…", detail: "Verifying SHA256" },
            { hint: "Проверка…", detail: "Проверка SHA256" },
          );
        }
        if (p.state !== "downloading") return;
        bytes = p.downloaded;
        total = p.total;
        const wait = 1500 - (performance.now() - lastUpdate);
        if (wait <= 0) showBytes();
        else timer ??= setTimeout(showBytes, wait);
      },
      onRetry: ({ nextAttempt, attempts }: { nextAttempt: number; attempts: number }) => {
        clearPending();
        lastUpdate = -Infinity;
        const attempt = (lang: UiLanguage) =>
          `${nextAttempt}/${attempts}${bytes ? ` · ${counts(lang)}` : ""}`;
        emit(
          "downloading",
          { hint: "Dictation · retrying download", detail: `Attempt ${attempt("en")}` },
          { hint: "Диктовка · повтор загрузки", detail: `Попытка ${attempt("ru")}` },
        );
      },
    });
    emit(
      "ready",
      { hint: "Dictation ready", detail: "Ready" },
      { hint: "Диктовка готова", detail: "Готова" },
    );
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    emit(
      "failed",
      { hint: "Download failed · /voice-settings", detail },
      { hint: "Сбой загрузки · /voice-settings", detail },
    );
    if (!env.downloadStatus) throw error;
    throw new ReportedDownloadError(detail, { cause: error });
  } finally {
    clearPending();
  }
}

async function nativeAsset(
  env: EnsureEnv,
  kind: "engine" | "recorder",
  id?: string,
): Promise<boolean> {
  type Plan = {
    action: "engineStatus" | "recorderStatus" | "ready" | "probe" | "install";
    options?: Record<string, unknown>;
    fromSettings?: (keyof VoiceSettings)[];
    retries?: number;
  };
  const plan = (event: string, data: Record<string, unknown> = {}) =>
    readiness<Plan>("assetPlan", { kind, event, ...data });
  const notice = (event: string, data: Record<string, unknown> = {}) =>
    env.toast(
      ...readiness<Parameters<ToastFn>>("assetNotice", {
        kind,
        id,
        event,
        language: uiLanguage(env),
        ...data,
      }),
    );
  let step = plan("start", { platform: process.platform });
  if (step.action === "ready") return true;
  // Snapshot the install options before probing. SDK callbacks and other opaque options retain identity.
  const options = { ...env.options };
  for (const key of step.fromSettings) options[key] = env.settings[key];
  Object.assign(options, step.options);
  const current =
    step.action === "engineStatus"
      ? getEngineStatus(id, env.options, env.settings)
      : getRecorderStatus(options, env.settings);
  step = plan("status", { resolved: !!current.resolvedBinary });
  if (step.action === "probe") {
    const probe =
      kind === "engine"
        ? await (await import("../lib/engines.js")).probeEngine(id, current.resolvedBinary)
        : await probeRecorder(current.resolvedBinary);
    step = plan("probe", { ok: !!probe.ok });
    if (step.action === "ready") return true;
  }
  const install =
    kind === "engine"
      ? (env.installEngine ?? installManagedEngine)
      : (env.ensureRecorder ?? ensureManagedRecorder);
  notice("start");
  const hooks = {
    retries: step.retries,
    onRetry: ({ error, nextAttempt, attempts }) =>
      notice("retry", {
        error: error instanceof Error ? error.message : String(error),
        next: String(nextAttempt),
        attempts: String(attempts),
      }),
  };
  if (kind === "engine")
    await (install as typeof installManagedEngine)(id, options, env.settings, hooks);
  else await (install as typeof ensureManagedRecorder)(options, env.settings, hooks);
  notice("done");
  return true;
}

export async function ensureEngineReady(
  env: EnsureEnv,
  model = getModel(env.settings.model),
): Promise<boolean> {
  const engineId = model.engine;
  if (rustBinding()) return nativeAsset(env, "engine", engineId);
  const commandOptions = { ...env.options, downloadDir: env.settings.downloadDir };
  const current = getEngineStatus(engineId, env.options, env.settings);
  if (current.resolvedBinary) {
    const { probeEngine } = await import("../lib/engines.js");
    if ((await probeEngine(engineId, current.resolvedBinary)).ok) return true;
  }
  const install = env.installEngine ?? installManagedEngine;
  const russian = () => uiLanguage(env) === "ru";
  env.toast(russian() ? `Установка ${engineId}…` : `Installing ${engineId}...`);
  await install(engineId, commandOptions, env.settings, {
    retries: 5,
    onRetry: ({
      error,
      nextAttempt,
      attempts,
    }: {
      error: unknown;
      nextAttempt: number;
      attempts: number;
    }) =>
      env.toast(
        `${russian() ? "Повтор установки движка" : "Engine install retry"} ${nextAttempt}/${attempts}: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      ),
  });
  env.toast(russian() ? `${engineId} установлен` : `${engineId} installed`, "success");
  return true;
}

export async function ensureRecorderReady(env: EnsureEnv): Promise<boolean> {
  if (rustBinding()) return nativeAsset(env, "recorder");
  if (process.platform !== "win32") return true;
  const commandOptions = {
    ...env.options,
    downloadDir: env.settings.downloadDir,
    skipFfmpegStaticInstall: true,
  };
  const current = getRecorderStatus(commandOptions, env.settings);
  if (current.resolvedBinary && (await probeRecorder(current.resolvedBinary)).ok) return true;
  const ensure = env.ensureRecorder ?? ensureManagedRecorder;
  const russian = () => uiLanguage(env) === "ru";
  env.toast(
    russian() ? "Установка программы записи для Windows…" : "Installing local Windows recorder...",
  );
  await ensure(commandOptions, env.settings, {
    retries: 5,
    onRetry: ({
      error,
      nextAttempt,
      attempts,
    }: {
      error: unknown;
      nextAttempt: number;
      attempts: number;
    }) =>
      env.toast(
        `${russian() ? "Повтор установки программы записи" : "Recorder install retry"} ${nextAttempt}/${attempts}: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      ),
  });
  env.toast(
    russian() ? "Программа записи для Windows установлена" : "Windows recorder installed",
    "success",
  );
  return true;
}

export type { VoiceRuntime };
