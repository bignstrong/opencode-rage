import { Plugin } from "@opencode/plugin/tui";
import { RGBA, type Renderable, type TextareaRenderable } from "@opentui/core";
import { jsx } from "@opentui/solid/jsx-runtime";
import { createComponent, createEffect, createSignal, onCleanup, Show } from "solid-js";
import { VoiceRuntime } from "../lib/engine.js";
import { rustBinding, useRust } from "../lib/rust-binding.js";
import { DEFAULT_SETTINGS, getModel, PLUGIN_ID } from "../lib/models.js";
import { DockedButtons } from "./button/dock.ts";
import { installAgentActivity } from "./button/agent-activity.ts";
import { orbCatalog, type ActivityMode } from "./button/activity.ts";
import { resolveUiLanguage } from "./i18n.ts";
import { applyRageTheme } from "./preset.ts";
import { localizeDownloadStatus, ReportedDownloadError, type DownloadStatus } from "./ensure.ts";
import {
  showError,
  showMicrophonePicker,
  showModelPicker,
  showSettings,
  shouldShowStartupModelPicker,
} from "./dialogs.ts";
import { normalizeSettings, migrateRecordingShortcut, optionsOverlay } from "./settings.ts";
import { createVoiceController, type Destination } from "./voice.ts";

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Record<string, unknown>;
    const createRuntime = options.createRuntime as
      | ((options: Record<string, unknown>) => VoiceRuntime)
      | undefined;
    const native = !createRuntime && useRust() ? await import("./native-runtime.ts") : undefined;
    const runtime = createRuntime
      ? createRuntime(options)
      : native
        ? new native.NativeRuntime(options)
        : new VoiceRuntime(options);

    const [store, updateStore] = ctx.storage.store("settings", {
      initial: {
        ...DEFAULT_SETTINGS,
        uiLanguage: "ru",
        language: "ru",
        model: "whisper-turbo",
        orb: "breath",
        onboardingDone: true,
        setupSkipped: true,
        ...optionsOverlay((ctx.options ?? {}) as Record<string, unknown>),
      },
    });
    const getSettings = () =>
      normalizeSettings(store as unknown as Parameters<typeof normalizeSettings>[0]);
    const getUiLanguage = () => resolveUiLanguage(store.uiLanguage);
    const getOrb = (): ActivityMode =>
      Object.hasOwn(orbCatalog, store.orb) ? (store.orb as ActivityMode) : "cycle";
    const voiceTitle = () => (getUiLanguage() === "ru" ? "Диктовка" : "Voice");
    const update = async (
      fn: (draft: Parameters<Parameters<typeof updateStore>[0]>[0]) => void,
    ) => {
      await updateStore(fn as Parameters<typeof updateStore>[0]);
    };

    const notify = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
      ctx.ui.toast.show({ title: voiceTitle(), message, variant });

    const migration = migrateRecordingShortcut(getSettings(), ctx.options?.recordingHotkey);
    if (!store.rageThemeApplied) {
      try {
        applyRageTheme();
        await updateStore((draft) => {
          draft.rageThemeApplied = true;
        });
      } catch {
        notify(
          getUiLanguage() === "ru"
            ? "Не удалось включить тему orng. Проверьте cli.json."
            : "Could not apply orng. Check cli.json.",
          "warning",
        );
      }
    }
    if (migration)
      await updateStore((draft) => {
        Object.assign(draft, migration);
      });

    // Session and home share the selected model, including while its download stalls.
    const [statuses, setStatuses] = createSignal<Record<string, DownloadStatus>>({});
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let disposed = false;
    const clearReady = (modelId: string) => {
      if (statuses()[modelId]?.phase !== "ready") return;
      clearTimeout(timers.get(modelId));
      timers.delete(modelId);
      setStatuses((previous) => {
        const next = { ...previous };
        delete next[modelId];
        return next;
      });
    };
    const downloadStatus = (modelId: string, value: DownloadStatus) => {
      if (disposed) return;
      clearTimeout(timers.get(modelId));
      timers.delete(modelId);
      setStatuses((previous) => ({ ...previous, [modelId]: value }));
      if (value.phase === "ready")
        timers.set(
          modelId,
          setTimeout(() => clearReady(modelId), 3000),
        );
    };
    const getDownloadStatus = (id: string) => {
      const value = statuses()[id];
      return value && localizeDownloadStatus(value, getUiLanguage());
    };
    const status = () => getDownloadStatus(getModel(store.model).id);
    const renderStatus = () =>
      createComponent(Show, {
        keyed: true,
        get when() {
          return Boolean(status());
        },
        get children() {
          return jsx("text", {
            get fg() {
              return ctx.theme.text.muted;
            },
            get children() {
              return status()?.hint;
            },
          });
        },
      });
    const deps = {
      dialog: ctx.ui.dialog,
      listMicrophones: native?.listMicrophones,
      toast: notify,
      downloadStatus,
      getDownloadStatus,
      options: (ctx.options ?? {}) as Record<string, unknown>,
      getSettings,
      update,
    };

    const currentSessionID = (): string | undefined => {
      const route = ctx.ui.router.current();
      return route?.type === "session" ? route.sessionID : undefined;
    };

    const [phase, setPhase] = createSignal("idle");
    const [startedAt, setStartedAt] = createSignal(0);
    const currentLocation = () => ctx.location ?? ctx.data.location.default();
    const getDestination = (): Destination => {
      const sessionID = currentSessionID();
      return sessionID ? { sessionID } : { location: { ...currentLocation() } };
    };
    const atOrigin = (origin: Destination) => {
      const route = ctx.ui.router.current();
      if ("sessionID" in origin)
        return route.type === "session" && route.sessionID === origin.sessionID;
      if (route.type !== "home") return false;
      const here = currentLocation();
      return (
        here.directory === origin.location.directory &&
        here.workspaceID === origin.location.workspaceID
      );
    };
    const pending = new Set<{ origin: Destination; text: string }>();
    const binding = rustBinding();
    const drafts = binding && new binding.Drafts();
    const coordinates = (origin: Destination) =>
      "sessionID" in origin
        ? ([origin.sessionID, undefined, undefined] as const)
        : ([undefined, origin.location.directory, origin.location.workspaceID] as const);
    const footers = new Set<{ readonly mode: string; readonly sessionID?: string }>();
    const activeFooter = () =>
      [...footers].some((f) => f.mode === "normal" && f.sessionID === currentSessionID());
    const composerEditor = (editor = ctx.renderer.currentFocusedRenderable) => {
      // OpenCode 2.4.1 exposes no composer insertion API. Only accept the focused
      // editor in our own prompt container, never a dialog or another panel.
      const prompt = ctx.renderer.root.findDescendantById("voice-dock-anchor")?.parent?.parent;
      if (
        !prompt ||
        !editor ||
        editor.isDestroyed ||
        editor.parent?.parent?.parent !== prompt ||
        !("insertText" in editor) ||
        typeof editor.insertText !== "function"
      )
        return;
      return editor as TextareaRenderable;
    };
    const [hasDraft, setHasDraft] = createSignal(false);
    let lastEditor: TextareaRenderable | undefined;
    const refreshDraft = () =>
      setHasDraft(Boolean(lastEditor && !lastEditor.isDestroyed && lastEditor.plainText.trim()));
    const trackEditor = (editor: typeof lastEditor) => {
      if (lastEditor === editor) return;
      lastEditor?.editBuffer.off("content-changed", refreshDraft);
      lastEditor = editor;
      lastEditor?.editBuffer.on("content-changed", refreshDraft);
      refreshDraft();
    };
    const flushDraft = () => {
      if (disposed || !activeFooter()) return;
      const editor = composerEditor();
      if (!editor) return;
      trackEditor(editor);
      if (drafts) {
        const route = ctx.ui.router.current();
        if (route.type !== "session" && route.type !== "home") return;
        const args = coordinates(getDestination());
        for (let text = drafts.next(...args); text != null; text = drafts.next(...args)) {
          editor.insertText(text);
          drafts.inserted(...args);
        }
        return;
      }
      for (const entry of pending) {
        if (!atOrigin(entry.origin)) continue;
        editor.insertText(entry.text);
        pending.delete(entry);
      }
    };
    const afterFocus = () => queueMicrotask(flushDraft);
    ctx.renderer?.on?.("focused_renderable", afterFocus);
    const submitDraft = () => {
      if (disposed || phase() !== "idle" || !activeFooter()) return;
      // Keyboard activation moves focus to the button; native submit needs the editor.
      if (ctx.renderer.currentFocusedRenderable?.id === "voice-send") {
        composerEditor(lastEditor)?.focus();
      }
      if (composerEditor()?.plainText.trim()) ctx.keymap.dispatch("prompt.submit");
    };
    const deliver = async (
      text: string,
      submit: boolean,
      origin: Destination,
      cancelled?: () => boolean,
    ) => {
      const ru = getUiLanguage() === "ru";
      const blank = !text.trim();
      const discard = disposed || Boolean(cancelled?.());
      const action = binding
        ? binding.deliveryAction(
            blank,
            discard,
            submit,
            "sessionID" in origin ? origin.sessionID : undefined,
            currentSessionID(),
          )
        : blank
          ? "empty"
          : discard
            ? "discard"
            : submit && "sessionID" in origin && atOrigin(origin)
              ? "submit"
              : "draft";
      if (action === "empty") throw new Error(ru ? "Речь не распознана." : "No speech detected.");
      if (action === "discard") return false as const;
      if (action === "submit" && "sessionID" in origin) {
        setPhase("sending");
        try {
          await ctx.client.session.prompt({ sessionID: origin.sessionID, text });
          return ru ? "Текст распознан и отправлен" : "Transcribed and submitted";
        } catch (error) {
          if (disposed || cancelled?.()) return false as const;
          notify(error instanceof Error ? error.message : String(error), "error");
        }
      }
      const entry = { origin, text };
      if (drafts) drafts.push(text, ...coordinates(origin));
      else pending.add(entry);
      flushDraft();
      if (drafts ? drafts.next(...coordinates(origin)) != null : pending.has(entry))
        notify(
          ru
            ? "Вернитесь в исходное поле ввода, чтобы вставить диктовку."
            : "Return to the original prompt to insert your dictation.",
        );
      return false as const;
    };

    const controller = createVoiceController({
      runtime,
      options: (ctx.options ?? {}) as Record<string, unknown>,
      getSettings,
      getUiLanguage,
      toast: notify,
      downloadStatus,
      onPhaseChange: setPhase,
      onRecordingStarted: (modelId) => {
        setStartedAt(Date.now());
        clearReady(modelId);
      },
      deliver,
      getDestination,
      onSetupError: (title, error) => {
        if (!(error instanceof ReportedDownloadError)) void showError(deps, title, error);
      },
      onMicrophoneUnavailable: async (reason) => {
        const ru = getUiLanguage() === "ru";
        const choose = await deps.dialog.confirm({
          title: ru ? "Микрофон недоступен" : "Microphone unavailable",
          message:
            reason === "interrupted"
              ? ru
                ? "Запись прервалась. Ничего не отправлено. Выбрать микрофон для следующей записи?"
                : "Recording was interrupted. Nothing was sent. Choose a microphone for your next recording?"
              : ru
                ? "Запись не началась. Подключите выбранный микрофон или выберите другой, например встроенный микрофон MacBook."
                : "Recording did not start. Reconnect your microphone or choose another input, such as the built-in MacBook microphone.",
          label: {
            confirm: ru ? "Выбрать микрофон" : "Choose microphone",
            cancel: ru ? "Закрыть" : "Close",
          },
        });
        if (choose && !disposed) await showMicrophonePicker(deps, { standalone: true });
      },
      // Test seam: ctx.options.ready overrides lib-backed readiness checks.
      ready: ((ctx.options ?? {}) as Record<string, unknown>).ready as Parameters<
        typeof createVoiceController
      >[0]["ready"],
    });

    const stopButton = ctx.ui.slot({
      append: "prompt.footer",
      render: (input) => {
        footers.add(input);
        onCleanup(() => footers.delete(input));
        createEffect(() => {
          // Retry after the host mounts a prompt or switches out of shell mode.
          void input.mode;
          void input.sessionID;
          void ctx.ui.router.current();
          afterFocus();
        });
        return createComponent(DockedButtons, {
          version: ctx.app?.version,
          renderer: ctx.renderer,
          paletteKey: () => ctx.keymap.shortcuts("command.palette.show")[0],
          get normal() {
            return input.mode === "normal";
          },
          get phase() {
            return phase();
          },
          get startedAt() {
            return startedAt();
          },
          get locale() {
            return getUiLanguage();
          },
          get animate() {
            return getSettings().voiceAnimation;
          },
          get orb() {
            return getOrb();
          },
          toggle: () => void controller.toggle(false, true),
          get canSend() {
            return input.mode === "normal" && phase() === "idle" && hasDraft();
          },
          onSend: submitDraft,
        });
      },
    });
    const stopStatus = ctx.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        let anchor: Renderable;
        createEffect(() => {
          if (input.sessionID && ctx.data.session.status(input.sessionID) === "running") {
            const orbColor = RGBA.fromHex("#ec5b2b");
            onCleanup(
              installAgentActivity({
                version: ctx.app.version,
                renderer: ctx.renderer,
                anchor: () => anchor,
                animate: getSettings().voiceAnimation,
                foreground: () => orbColor,
                orb: getOrb(),
              }),
            );
          }
        });
        return [
          jsx("box", {
            position: "absolute",
            width: 0,
            height: 0,
            ref: (node: Renderable) => (anchor = node),
          }),
          renderStatus(),
        ];
      },
    });
    const openSettings = () => void showSettings(deps);
    const selectOrb = async () => {
      const locale = getUiLanguage();
      const current = getOrb();
      const selected = await ctx.ui.dialog.select<ActivityMode>(
        binding
          ? JSON.parse(binding.orbDialog(locale === "ru", current))
          : {
              title: locale === "ru" ? "Анимация индикатора" : "Indicator animation",
              placeholder: locale === "ru" ? "Поиск" : "Search",
              current,
              options: (Object.keys(orbCatalog) as ActivityMode[]).map((value) => ({
                value,
                title: orbCatalog[value][locale],
              })),
            },
      );
      if (!disposed && selected && selected !== current && Object.hasOwn(orbCatalog, selected))
        await updateStore((draft) => {
          draft.orb = selected;
        });
    };

    // keymap.layer needs Solid component context (else "Keymap.Provider is
    // missing"): register it from the app slot's render function.
    const stopSlot = ctx.ui.slot({
      append: "app",
      render: () => {
        ctx.keymap.layer(() => {
          const settings = getSettings();
          const ru = getUiLanguage() === "ru";
          const group = voiceTitle();
          const run: Record<string, () => void | Promise<void>> = {
            "voice.record": () => controller.toggle(false),
            "voice.submit": () => controller.toggle(true),
            "voice.stop": () => controller.cancel(),
            "voice.settings": openSettings,
            "voice.orbs": selectOrb,
          };
          if (binding) {
            const rows: {
              id: string;
              title: string;
              group: string;
              palette: true;
              slash: { name: string };
            }[] = JSON.parse(binding.commandRows(ru, settings.recordingHotkey || ""));
            return {
              mode: "global",
              priority: 100,
              bindings: ["voice.record"],
              commands: rows.map((row) => ({ ...row, run: run[row.id] })),
            };
          }
          return {
            mode: "global",
            priority: 100,
            commands: [
              {
                id: "voice.record",
                title: ru ? "Диктовка: записать" : "Voice: record",
                description: ru
                  ? "Начать или закончить диктовку. Без автоотправки текст появится в поле ввода."
                  : "Toggle dictation. Insert text in the prompt unless auto-submit is enabled.",
                group,
                bind: settings.recordingHotkey || false,
                palette: true as const,
                slash: { name: "voice", aliases: ["voice-record"] },
                run: () => controller.toggle(false),
              },
              {
                id: "voice.submit",
                title: ru ? "Диктовка: записать и отправить" : "Voice: submit",
                description: ru
                  ? "Начать или закончить запись и отправить распознанный текст."
                  : "Toggle local voice recording and submit after transcription.",
                group,
                palette: true as const,
                slash: { name: "voice-submit" },
                run: () => controller.toggle(true),
              },
              {
                id: "voice.stop",
                title: ru ? "Диктовка: отменить" : "Voice: stop",
                description: ru
                  ? "Отменить запись или распознавание."
                  : "Cancel active voice recording or transcription.",
                group,
                palette: true as const,
                slash: { name: "voice-stop" },
                run: () => controller.cancel(),
              },
              {
                id: "voice.settings",
                title: ru ? "Диктовка: настройки" : "Voice: settings",
                description: ru
                  ? "Открыть настройки диктовки."
                  : "Open local voice input settings.",
                group,
                palette: true as const,
                slash: { name: "voice-settings" },
                run: openSettings,
              },
              {
                id: "voice.orbs",
                title: ru ? "Диктовка: выбрать анимацию" : "Voice: choose indicator animation",
                description: ru
                  ? "Сменить индикатор ответа агента и распознавания речи."
                  : "Change the indicator for agent responses and transcription.",
                group,
                palette: true as const,
                slash: { name: "orbs" },
                run: selectOrb,
              },
            ],
            bindings: ["voice.record"],
          };
        });
        return null;
      },
    });

    if (shouldShowStartupModelPicker(deps)) void showModelPicker(deps, true);

    return () => {
      stopSlot();
      disposed = true;
      ctx.renderer?.off?.("focused_renderable", afterFocus);
      trackEditor(undefined);
      pending.clear();
      drafts?.clear();
      stopStatus();
      stopButton();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      return controller.cancel(true);
    };
  },
});
