// Typed V2 facade over the shared lib/ controller (plain JS so both loaders
// consume one copy). All logic lives in lib/voice-controller.js.
import { isModelDownloaded } from "../lib/models.js";
import { createVoiceController as createShared } from "../lib/voice-controller.js";
import {
  ensureDownloaded,
  ensureEngineReady,
  ensureRecorderReady,
  type DownloadStatusFn,
  type ToastFn,
  type VoiceRuntime,
} from "./ensure.ts";
import type { UiLanguage } from "./i18n.ts";
import { type VoiceSettings } from "./settings.ts";

export type Destination =
  | { sessionID: string }
  | { location: { directory: string; workspaceID?: string } };

export interface VoiceControllerDeps {
  runtime: VoiceRuntime;
  options: Record<string, unknown>;
  getSettings: () => VoiceSettings;
  getUiLanguage?: () => UiLanguage;
  toast: ToastFn;
  downloadStatus?: DownloadStatusFn;
  onRecordingStarted?: (modelId: string) => void;
  onPhaseChange?: (phase: string) => void;
  /** Return false when delivery needs no success toast. */
  deliver: (
    text: string,
    submit: boolean,
    destination: Destination,
    isCancelled?: () => boolean,
  ) => Promise<void | string | false>;
  getDestination?: () => Destination;
  /** Show a blocking setup error (V2: alert dialog returning to settings). */
  onSetupError: (title: string, error: unknown) => void;
  onMicrophoneUnavailable?: (
    reason: "unavailable" | "interrupted",
    recoveredText?: string,
  ) => Promise<void>;
  /** V1-only toast hints (V2 never passes hold, so this stays undefined). */
  hints?: {
    holdStart?: (key: string) => string;
  };
  ready?: {
    isModelDownloaded?: typeof isModelDownloaded;
    ensureDownloaded?: typeof ensureDownloaded;
    ensureEngineReady?: typeof ensureEngineReady;
    ensureRecorderReady?: typeof ensureRecorderReady;
  };
}

export function createVoiceController(deps: VoiceControllerDeps) {
  return createShared({
    ...deps,
    ready: {
      isModelDownloaded,
      ensureDownloaded,
      ensureEngineReady,
      ensureRecorderReady,
      ...deps.ready,
    },
  });
}

export type VoiceController = ReturnType<typeof createVoiceController>;
