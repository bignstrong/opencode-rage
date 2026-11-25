import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { getBundledEngineDir, microphoneLabel, resolveCommand } from "../lib/engine.js";
import { rustBinding } from "../lib/rust-binding.js";
import { getAudioDir, getCacheDir, getModel, getModelPath } from "../lib/models.js";
import { listInputs, startTake, transcribe } from "../rage/core.ts";
import type { VoiceSettings } from "./settings.ts";

type Take = Awaited<ReturnType<typeof startTake>>;
type Recording = Awaited<ReturnType<Take["finish"]>>;
type Session = {
  controller: AbortController;
  take?: Take;
  pending?: Promise<string>;
  finishing?: Promise<string | null>;
  ended?: boolean;
};

export async function listMicrophones(options: Record<string, unknown>, signal?: AbortSignal) {
  const ffmpeg = process.env.RAGE_FFMPEG || resolveCommand("ffmpeg", options);
  if (!ffmpeg) throw new Error("FFmpeg is not installed.");
  const devices = await listInputs(signal, { ...process.env, RAGE_FFMPEG: ffmpeg });
  return devices.map((value) => ({ title: microphoneLabel(value, { platform: "darwin" }), value }));
}

// Only the V2 capture/inference seam. The existing controller owns all UI policy and readiness.
export class NativeRuntime {
  private active?: Session;
  private closing?: Promise<void>;
  private owned = new Map<string, Recording>();
  private job?: { controller: AbortController; done: Promise<string> };
  private options: Record<string, unknown>;
  pendingSubmit = false;
  interruptedMicrophone = false;

  constructor(options: Record<string, unknown> = {}) {
    this.options = options;
  }

  isRecording() {
    return !!this.active?.take && !this.active.ended;
  }
  isTranscribing() {
    return !!this.job;
  }

  async start(settings: Partial<VoiceSettings> = {}, onInterrupted?: () => void) {
    if (this.active?.ended)
      throw Object.assign(
        new Error("Finish or cancel the interrupted recording before starting another."),
        { code: "VOICE_TAKE_PENDING" },
      );
    if (this.active?.pending) return this.active.pending;
    const s: Session = { controller: new AbortController() };
    this.active = s;
    this.interruptedMicrophone = false;
    const start = async () => {
      const dir = getAudioDir(this.options, settings);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const ffmpeg = this.ffmpeg(settings);
      const sox = resolveCommand(process.env.RAGE_SOX ?? "sox", this.commands(settings)) || "";
      const defaultInput = ["", "default", ":default"].includes(settings.mic?.trim() || "");
      if (!ffmpeg && !defaultInput) throw new Error("FFmpeg is not installed.");
      if (!ffmpeg && !sox) throw new Error("No recorder found. Install ffmpeg or sox.");
      s.take = await startTake(
        settings.mic || null,
        () => {
          if (this.active !== s || s.controller.signal.aborted) return;
          this.interruptedMicrophone = true;
          s.ended = true;
          onInterrupted?.();
        },
        s.controller.signal,
        { ...this.env(settings), RAGE_FFMPEG: ffmpeg || "", RAGE_SOX: sox },
        dir,
      );
      return s.take.path;
    };
    try {
      return await (s.pending = start());
    } catch (error) {
      if (this.active === s) this.active = undefined;
      if (error instanceof Error && /^Microphone .* is unavailable\./.test(error.message)) {
        throw Object.assign(error, { code: "VOICE_MIC_UNAVAILABLE" });
      }
      throw error;
    }
  }

  private commands(settings: Partial<VoiceSettings>) {
    return { ...this.options, downloadDir: getCacheDir(this.options, settings) };
  }

  private ffmpeg(settings: Partial<VoiceSettings>) {
    return process.env.RAGE_FFMPEG || resolveCommand("ffmpeg", this.commands(settings));
  }

  private env(settings: Partial<VoiceSettings>) {
    const options = this.commands(settings);
    const lib = join(homedir(), ".local", "lib");
    const paths = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(delimiter);
    return {
      ...process.env,
      PATH: paths(
        getBundledEngineDir("whisper-cli", options),
        getBundledEngineDir("opencode-voice-transcribe", options),
        join(homedir(), ".local", "bin"),
        lib,
        process.env.PATH,
      ),
      LD_LIBRARY_PATH: paths(lib, process.env.LD_LIBRARY_PATH),
      DYLD_LIBRARY_PATH: paths(lib, process.env.DYLD_LIBRARY_PATH),
    };
  }

  async stop() {
    const s = this.active;
    if (!s?.take) return null;
    if (s.finishing) return s.finishing;
    const take = s.take;
    s.finishing = (async () => {
      try {
        const recording = await take.finish();
        if (s.controller.signal.aborted) {
          await recording.dispose();
          return null;
        }
        this.owned.set(recording.path, recording);
        this.interruptedMicrophone ||= recording.interrupted;
        return recording.path;
      } finally {
        if (this.active === s) this.active = undefined;
      }
    })();
    return s.finishing;
  }

  async transcribe(
    path: string,
    model: ReturnType<typeof getModel>,
    settings: Partial<VoiceSettings> = {},
  ) {
    if (this.job) throw new Error("Transcription is already running");
    const controller = new AbortController();
    const recording = this.owned.get(path);
    const decode = async () => {
      const file = getModelPath(model, this.options, settings);
      const core = rustBinding();
      const plan = core.decodePlan({
        engine: model.engine,
        modelName: model.name,
        modelPath: file,
        binary: resolveCommand(core.decoderCommand(model.engine), this.commands(settings)),
        language: settings.language,
        timeoutMs: Number(this.options.transcriptionTimeoutMs),
        cleanup: settings.voiceEnhance !== false,
        cutoffHz: Number(settings.cleanupCutoffHz),
        interrupted: recording?.interrupted,
      });
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(plan.timeoutMs)]);
      return transcribe(path, { model: file, language: plan.language }, signal, {
        ...this.env(settings),
        OPENCODE_VOICE_DIR: getCacheDir(this.options, settings),
        [plan.engineKey]: plan.binary,
        RAGE_FFMPEG: this.ffmpeg(settings) || "",
        RAGE_CLEANUP_FILTER: plan.cleanupFilter,
        RAGE_ENGINE: model.engine,
        RAGE_RECOVER_WAV: plan.recoverWav,
      });
    };
    const job = { controller, done: decode() };
    this.job = job;
    try {
      return await job.done;
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError")
        throw new Error("Transcription timed out");
      throw error;
    } finally {
      if (this.job === job) this.job = undefined;
      await this.cleanupRecording(path);
    }
  }

  async cleanupRecording(path: string) {
    const recording = this.owned.get(path);
    if (!recording) return;
    await recording.dispose();
    this.owned.delete(path);
  }

  async cancel() {
    const s = this.active;
    const job = this.job;
    const files = [...this.owned.keys()];
    if (!s && !job && !files.length) return this.closing;
    this.active = undefined;
    this.job = undefined;
    this.interruptedMicrophone = false;
    s?.controller.abort();
    job?.controller.abort();
    const done = Promise.allSettled([this.closing, s?.pending, s?.finishing, job?.done]).then(
      async () => {
        if (s?.take) await s.take.cancel();
        await Promise.all(files.map((file) => this.cleanupRecording(file)));
      },
    );
    this.closing = done;
    try {
      await done;
    } finally {
      if (this.closing === done) this.closing = undefined;
    }
  }
}
