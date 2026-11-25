// Host effects only: the Rust session owns the phase lock and decides whether a take may be sent.
export function rustController(deps, state, ui, isDownloaded, normalize, modelFor) {
  const rt = deps.runtime;
  const ready = deps.ready;
  let settings, destination;
  const change = (op) => {
    const before = state.phase;
    const result = op();
    if (before !== state.phase) deps.onPhaseChange?.(state.phase);
    return result;
  };
  const text = (e) => e instanceof Error ? e.message : String(e);

  async function prepare(settings) {
    const model = modelFor(settings.model);
    // A failing cache lookup is a start error, not an installer failure.
    const cached = !!(ready.isModelDownloaded ?? isDownloaded)(model, deps.options, settings);
    let step = state.prepareStep("begin", cached, false);
    try {
      const env = { options: deps.options, settings, getSettings: deps.getSettings,
        toast: deps.toast, downloadStatus: deps.downloadStatus };
      while (step && step !== "ready") {
        if (step === "ensureRecorderReady") await ready.ensureRecorderReady(env);
        else await ready[step](env, model);
        step = state.prepareStep(step, cached, false);
      }
    } catch (error) {
      const title = state.prepareStep(step, cached, true);
      if (title) deps.onSetupError(ui()[title], error);
      return false;
    }
    return step === "ready";
  }

  async function dispatch(command, submit = false, review = false, hold = false) {
    const effect = change(() => state.press(command, submit, review, rt.isRecording(), rt.isTranscribing(), !!rt.pendingSubmit));
    if (!effect) return;
    if (effect !== "start" && effect !== "stop") return deps.toast(ui()[effect], ...(effect === "busy" ? ["warning"] : []));
    const generation = state.generation;
    if (effect === "start") {
      try {
        settings = normalize(deps.getSettings());
        destination = deps.getDestination?.();
        if (!(await prepare(settings))) return;
        const pending = state.captureIntent(settings.autoSubmit);
        if (pending == null) return;
        rt.pendingSubmit = pending;
        await rt.start(settings, () => {
          if (state.lost(generation)) return dispatch("stop");
        });
        if (state.cancelled) return await rt.cancel();
        change(() => state.started());
        if (state.interrupted) return await dispatch("stop");
        deps.onRecordingStarted?.(modelFor(settings.model).id);
        const notice = state.startNotice(hold, submit);
        if (notice === "hold") deps.toast(deps.hints?.holdStart?.(settings.recordingHotkey || "the recording key") ?? ui().recording);
        else if (notice) deps.toast(ui()[notice]);
      } catch (err) {
        if (!state.cancelled) {
          if (err?.code === "VOICE_MIC_UNAVAILABLE" && deps.onMicrophoneUnavailable) await deps.onMicrophoneUnavailable("unavailable");
          else deps.toast(text(err), "error");
        }
      } finally {
        change(() => state.abortStart());
      }
      return;
    }
    let recovered;
    try {
      let wav;
      try { wav = await rt.stop(); }
      finally { if (rt.interruptedMicrophone) state.lost(generation); }
      if (!wav) return;
      if (state.cancelled) return await rt.cleanupRecording?.(wav);
      change(() => state.decoding());
      if (!state.review) deps.toast(ui().transcribing);
      const transcript = await rt.transcribe(wav, modelFor(settings.model), settings);
      if (state.cancelled) return;
      if (state.interrupted) recovered = transcript;
      const send = state.send;
      const message = await deps.deliver(transcript, send, destination, () => state.cancelled);
      if (!state.cancelled && message !== false) deps.toast(typeof message === "string" ? message : send ? ui().submitted : ui().transcribed, "success");
    } catch (err) {
      if (!state.cancelled) deps.toast(text(err), "error");
    } finally {
      change(() => state.complete(rt.isRecording()));
      if (state.phase === "idle") {
        rt.pendingSubmit = false;
        if (state.interrupted && !state.cancelled) await deps.onMicrophoneUnavailable?.("interrupted", recovered);
      }
    }
  }
  return {
    start: (submit = false, hold = false, review = false) => dispatch("start", submit, review, hold),
    finish: (submit = false) => dispatch("finish", submit),
    toggle: (submit = false, review = false) => dispatch("toggle", submit, review),
    stopAndTranscribe: (submit = false) => dispatch("stop", submit),
    cancel(silent = false) {
      change(() => state.cancel());
      const stopped = rt.cancel();
      if (!silent) deps.toast(ui().cancelled);
      return stopped;
    },
  };
}
