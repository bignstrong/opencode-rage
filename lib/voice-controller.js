// Shared voice controller (canonical home; plain JS so lib/ stays .ts-free).
// Single-flight phase lock + setup flow, consumed by the V1 adapter (index.js)
// directly and re-exported by src/voice.ts for V2. Adapters inject deliver,
// setup-error display, and (V1-only) hold-to-talk toast hints.
//
// deps: { runtime, options, getSettings, toast, deliver, onSetupError, downloadStatus?, hints?, ready? }
// ready.ensure* (Downloaded/EngineReady/RecorderReady) is REQUIRED: lib/ cannot
// import the TS ensure modules, so each adapter supplies its own flavor
// (V1: dialog-rich index.js locals; V2: src/ensure.ts via the src/voice.ts wrapper).
import { getModel, isModelDownloaded } from "./models.js";
import { normalizeSettings } from "./settings.js";
import { rustBinding } from "./rust-binding.js";
import { rustController } from "./rust-controller.js";

const messages = {
  en: {
    setupFailed: "Voice setup failed",
    runtimeFailed: "Voice runtime setup failed",
    starting: "Starting…",
    stopping: "Stopping…",
    busy: "Transcription is already running",
    recording: "Recording.",
    recordingSubmit: "Recording for submit. Run /voice-submit again to stop.",
    recordingCopy: "Recording. Run /voice again to stop.",
    transcribing: "Transcribing...",
    submitted: "Transcribed and submitted",
    transcribed: "Transcribed",
    cancelled: "Voice recording cancelled",
  },
  ru: {
    setupFailed: "Не удалось настроить диктовку",
    runtimeFailed: "Не удалось подготовить запись и распознавание",
    starting: "Запускаю запись…",
    stopping: "Останавливаю запись…",
    busy: "Распознавание уже идёт",
    recording: "Идёт запись.",
    recordingSubmit: "Идёт запись для отправки. Чтобы закончить, снова запустите /voice-submit.",
    recordingCopy: "Идёт запись. Чтобы закончить, снова запустите /voice.",
    transcribing: "Распознаю речь…",
    submitted: "Текст распознан и отправлен",
    transcribed: "Текст распознан",
    cancelled: "Запись отменена",
  },
};

function errText(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createVoiceController(deps) {
  // V1 has English UI. V2 reads the current language even after an async operation.
  const ui = () => messages[deps.getUiLanguage?.() ?? "en"];
  const ready = deps.ready ?? {};
  for (const name of ["ensureDownloaded", "ensureEngineReady", "ensureRecorderReady"]) {
    if (typeof ready[name] !== "function") {
      throw new Error(`voice-controller: ready.${name} is required`);
    }
  }

  // Single-flight guard: every entry checks AND sets this synchronously,
  // before any await, so concurrent presses cannot slip through the gaps
  // between runtime-flag reads and the state changes that follow them.
  let phase = "idle";
  const setPhase = (next) => {
    phase = next;
    deps.onPhaseChange?.(next);
  };
  let cancelled = false;
  let reviewOnly = false;
  let settings;
  let destination;
  let take;

  const native = rustBinding();
  if (native) return rustController(deps, new native.Session(), ui, isModelDownloaded, normalizeSettings, getModel);

  async function prepare(settings, isCancelled) {
    const model = getModel(settings.model);
    const downloaded = (ready.isModelDownloaded ?? isModelDownloaded)(
      model,
      deps.options,
      settings,
    );
    let errorTitle = downloaded ? "runtimeFailed" : "setupFailed";
    try {
      const env = {
        options: deps.options,
        settings,
        getSettings: deps.getSettings,
        toast: deps.toast,
        downloadStatus: deps.downloadStatus,
      };
      await ready.ensureEngineReady(env, model);
      if (!downloaded && !isCancelled()) await ready.ensureDownloaded(env, model);
      if (isCancelled()) return;
      errorTitle = "runtimeFailed";
      await ready.ensureRecorderReady(env);
    } catch (error) {
      if (!isCancelled()) deps.onSetupError(ui()[errorTitle], error);
      return undefined;
    }
    return true;
  }

  async function start(submit = false, hold = false, review = false) {
    if (phase === "starting") return deps.toast(ui().starting);
    if (phase === "transcribing" || deps.runtime.isTranscribing()) {
      return deps.toast(ui().busy, "warning");
    }
    if (phase === "recording" || phase === "stopping" || deps.runtime.isRecording()) return;
    setPhase("starting");
    reviewOnly = review;
    cancelled = false;
    const active = (take = { interrupted: false });
    try {
      settings = normalizeSettings(deps.getSettings());
      destination = deps.getDestination?.();
      if (!(await prepare(settings, () => cancelled)) || cancelled) return;
      deps.runtime.pendingSubmit = submit || settings.autoSubmit;
      await deps.runtime.start(settings, () => {
        if (active !== take || cancelled || active.interrupted || phase === "idle") return;
        active.interrupted = true;
        if (phase === "recording") return stopAndTranscribe(false);
      });
      if (cancelled) {
        await deps.runtime.cancel();
        return;
      }
      setPhase("recording");
      if (active.interrupted) return await stopAndTranscribe(false);
      deps.onRecordingStarted?.(getModel(settings.model).id);
      if (!reviewOnly) deps.toast(
        hold
          ? (deps.hints?.holdStart?.(settings.recordingHotkey || "the recording key") ??
            ui().recording)
          : submit
            ? ui().recordingSubmit
            : ui().recordingCopy,
      );
    } catch (error) {
      if (cancelled) return;
      if (error?.code === "VOICE_MIC_UNAVAILABLE" && deps.onMicrophoneUnavailable) {
        await deps.onMicrophoneUnavailable("unavailable");
      } else {
        deps.toast(errText(error), "error");
      }
    } finally {
      if (phase === "starting") setPhase("idle");
    }
  }

  async function finish(submit = false) {
    if (phase === "stopping") return deps.toast(ui().stopping);
    if (phase === "transcribing" || deps.runtime.isTranscribing()) {
      return deps.toast(ui().busy, "warning");
    }
    if (phase !== "recording") return;
    // stopAndTranscribe owns the stopping transition (it sets the phase
    // synchronously on entry, so concurrent finishes cannot slip through).
    await stopAndTranscribe(submit || deps.runtime.pendingSubmit);
  }

  async function stopAndTranscribe(submit) {
    if (phase === "stopping") return deps.toast(ui().stopping);
    if (phase === "transcribing" || deps.runtime.isTranscribing()) {
      return deps.toast(ui().busy, "warning");
    }
    if (phase !== "recording") return;
    setPhase("stopping");
    const active = take;
    let recoveredText;
    try {
      const model = getModel(settings.model);
      let audioFile;
      try {
        audioFile = await deps.runtime.stop();
      } finally {
        // Manual stop may discover the unplug before the device watcher fires.
        if (deps.runtime.interruptedMicrophone) active.interrupted = true;
      }
      if (!audioFile) return;
      if (cancelled) {
        await deps.runtime.cleanupRecording?.(audioFile);
        return;
      }
      setPhase("transcribing");
      if (!reviewOnly) deps.toast(ui().transcribing);
      const text = await deps.runtime.transcribe(audioFile, model, settings);
      if (cancelled) return;
      if (active.interrupted) recoveredText = text;
      const send = !active.interrupted && !reviewOnly && submit;
      const message = await deps.deliver(text, send, destination, () => cancelled);
      if (!cancelled && message !== false) deps.toast(
        typeof message === "string" ? message : send ? ui().submitted : ui().transcribed,
        "success",
      );
    } catch (error) {
      // A failed stop() leaves the runtime recording, so go back to
      // recording (next press completes it); anything else goes idle.
      if (!cancelled) deps.toast(errText(error), "error");
    } finally {
      setPhase(!cancelled && deps.runtime.isRecording() ? "recording" : "idle");
      if (phase === "idle") deps.runtime.pendingSubmit = false;
      if (phase === "idle" && active.interrupted && !cancelled) {
        await deps.onMicrophoneUnavailable?.("interrupted", recoveredText);
      }
    }
  }

  async function toggle(submit = false, review = false) {
    if (phase === "transcribing" || deps.runtime.isTranscribing()) {
      return deps.toast(ui().busy, "warning");
    }
    if (phase === "stopping") return deps.toast(ui().stopping);
    if (phase === "starting") return deps.toast(ui().starting);
    if (phase === "recording" || deps.runtime.isRecording()) {
      if (review) reviewOnly = true;
      return finish(submit);
    }
    return start(submit, false, review);
  }

  function cancel(silent = false) {
    cancelled = true;
    const stopped = deps.runtime.cancel();
    if (phase === "recording") setPhase("idle");
    if (!silent) deps.toast(ui().cancelled);
    return stopped;
  }

  return { start, finish, toggle, cancel, stopAndTranscribe };
}
