import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSettings } from "../src/settings.ts";
import { createVoiceController } from "../src/voice.ts";

const readyStub = {
  isModelDownloaded: () => true,
  ensureDownloaded: async () => true,
  ensureEngineReady: async () => true,
  ensureRecorderReady: async () => true,
};

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

// Runtime where stop() is slow (SIGINT + waitForExit in production).
function slowStopRuntime() {
  const gate = deferred();
  const rt = {
    recording: false,
    transcribing: false,
    pendingSubmit: false,
    starts: 0,
    stops: 0,
    transcribes: 0,
    startError: null,
    stopError: null,
    transcribeError: null,
    stopResult: "/tmp/a.wav",
    async start(_settings, onInterrupted) {
      if (this.startError) throw this.startError;
      this.interrupt = onInterrupted;
      this.starts++;
      this.recording = true;
    },
    async stop() {
      this.stops++;
      await gate.promise;
      if (this.stopError) throw this.stopError;
      this.recording = false;
      return this.stopResult;
    },
    async transcribe() {
      this.transcribes++;
      if (this.transcribeError) throw this.transcribeError;
      this.transcribing = true;
      return "text";
    },
    cancel() {
      // Real VoiceRuntime.cancel nulls both flags.
      this.recording = false;
      this.transcribing = false;
    },
    isRecording() {
      return this.recording;
    },
    isTranscribing() {
      return this.transcribing;
    },
    releaseStop: gate.resolve,
  };
  return rt;
}

function harness(runtime, extra = {}) {
  const delivered = [];
  const toasts = [];
  const c = createVoiceController({
    runtime,
    options: {},
    getSettings: () => normalizeSettings({}),
    toast: (m, v = "info") => toasts.push([null, v]),
    deliver: async (text, submit) => delivered.push([text, submit]),
    onSetupError: () => {},
    ready: readyStub,
    ...extra,
  });
  return { c, delivered, toasts };
}

test("rapid double toggle starts recording once", async () => {
  const rt = slowStopRuntime();
  const { c } = harness(rt);
  await Promise.all([c.toggle(false), c.toggle(false)]);
  assert.equal(rt.starts, 1);
});

test("concurrent finish during slow stop transcribes once", async () => {
  const rt = slowStopRuntime();
  const { c, delivered } = harness(rt);
  await c.toggle(false);
  assert.equal(rt.recording, true);
  const f = Promise.all([c.toggle(false), c.toggle(false), c.toggle(false)]);
  await Promise.resolve();
  rt.releaseStop();
  await f;
  assert.equal(rt.transcribes, 1);
  assert.equal(delivered.length, 1);
});

test("toggle in stop-to-transcribe gap does not start over", async () => {
  const rt = slowStopRuntime();
  const preTranscribe = deferred();
  const origTranscribe = rt.transcribe.bind(rt);
  rt.transcribe = async (...a) => {
    await preTranscribe.promise;
    return origTranscribe(...a);
  };
  const { c } = harness(rt);
  await c.toggle(false);
  const finishing = c.toggle(false);
  await Promise.resolve();
  rt.releaseStop();
  await Promise.resolve();
  await Promise.resolve();
  // stop() resolved (recording false) but transcribe() not yet flagged: must not restart.
  await c.toggle(false);
  preTranscribe.resolve();
  await finishing;
  assert.equal(rt.starts, 1);
});

for (const secondSubmit of [false, true]) {
  test(`toggle(submit=${secondSubmit}) during slow prepare preserves the first start`, async () => {
    const release = deferred();
    let checks = 0;
    const rt = slowStopRuntime();
    const { c } = harness(rt, {
      ready: {
        ...readyStub,
        ensureEngineReady: () => {
          checks++;
          return release.promise;
        },
      },
    });
    const starting = c.toggle(false);
    await c.toggle(secondSubmit);
    assert.equal(checks, 1);
    assert.equal(rt.starts, 0);
    release.resolve();
    await starting;
    assert.equal(rt.starts, 1);
    assert.equal(rt.pendingSubmit, false);
  });
}

test("finish while idle is a silent no-op", async () => {
  const rt = slowStopRuntime();
  const { c, delivered, toasts } = harness(rt);
  await c.finish(false);
  assert.equal(rt.stops, 0);
  assert.equal(rt.transcribes, 0);
  assert.deepEqual(delivered, []);
  assert.deepEqual(toasts, []);
});

test("cancel during stop releases a late recording without decoding it", async () => {
  const rt = slowStopRuntime();
  const cleaned = [];
  rt.cleanupRecording = async (file) => void cleaned.push(file);
  const { c, delivered } = harness(rt);
  await c.start();
  const finishing = c.finish();
  await c.cancel();
  rt.releaseStop();
  await finishing;
  assert.deepEqual(cleaned, [rt.stopResult]);
  assert.equal(rt.transcribes, 0);
  assert.deepEqual(delivered, []);
});

test("stop returning null transcribes nothing", async () => {
  const rt = slowStopRuntime();
  rt.stopResult = null;
  const { c, delivered } = harness(rt);
  await c.toggle(false);
  const finishing = c.toggle(false);
  await Promise.resolve();
  rt.releaseStop();
  await finishing;
  assert.equal(rt.transcribes, 0);
  assert.deepEqual(delivered, []);
});

test("stop failure keeps recording; next press completes it", async () => {
  const rt = slowStopRuntime();
  rt.stopError = new Error("Recorder did not create an audio file");
  const { c, delivered, toasts } = harness(rt);
  await c.toggle(false);
  const finishing = c.toggle(false);
  await Promise.resolve();
  rt.releaseStop();
  await finishing;
  assert.equal(rt.transcribes, 0);
  assert.deepEqual(delivered, []);
  assert.ok(toasts.some(([, v]) => v === "error"));
  assert.equal(rt.recording, true);
  rt.stopError = null;
  await c.toggle(false);
  assert.equal(rt.transcribes, 1);
  assert.equal(delivered.length, 1);
});

test("transcribe failure toasts, delivers nothing, recovers", async () => {
  const rt = slowStopRuntime();
  rt.transcribeError = new Error("engine crashed");
  const { c, delivered, toasts } = harness(rt);
  await c.toggle(false);
  const finishing = c.toggle(false);
  await Promise.resolve();
  rt.releaseStop();
  await finishing;
  assert.deepEqual(delivered, []);
  assert.ok(toasts.some(([, v]) => v === "error"));
  rt.transcribeError = null;
  rt.transcribing = false;
  await c.toggle(false);
  assert.equal(rt.recording, true);
});

test("deliver failure surfaces error toast, no crash", async () => {
  const rt = slowStopRuntime();
  const toasts = [];
  const c = createVoiceController({
    runtime: rt,
    options: {},
    getSettings: () => normalizeSettings({}),
    toast: (m, v = "info") => toasts.push([null, v]),
    deliver: async () => {
      throw new Error("session gone");
    },
    onSetupError: () => {},
    ready: readyStub,
  });
  await c.toggle(false);
  const finishing = c.toggle(false);
  await Promise.resolve();
  rt.releaseStop();
  await finishing;
  assert.ok(toasts.some(([, v]) => v === "error"));
});

test("cancel during recording allows fresh start", async () => {
  const rt = slowStopRuntime();
  const { c } = harness(rt);
  await c.toggle(false);
  assert.equal(rt.recording, true);
  c.cancel();
  await c.toggle(false);
  assert.equal(rt.starts, 2);
  assert.equal(rt.recording, true);
});

test("cancel while preparing prevents the microphone from starting later", async () => {
  const gate = deferred();
  const rt = slowStopRuntime();
  const { c } = harness(rt, { ready: { ...readyStub, ensureEngineReady: () => gate.promise } });
  const starting = c.start();
  c.cancel();
  await c.toggle();
  gate.resolve();
  await starting;
  assert.equal(rt.starts, 0);
  await c.start();
  assert.equal(rt.starts, 1);
});

test("cancel while decoding discards late text even if the decoder completes", async () => {
  const entered = deferred();
  const gate = deferred();
  const rt = slowStopRuntime();
  rt.transcribe = () => {
    entered.resolve();
    return gate.promise;
  };
  const { c, delivered } = harness(rt);
  await c.start(true);
  rt.releaseStop();
  const finishing = c.finish();
  await entered.promise;
  c.cancel();
  await c.toggle();
  gate.resolve("late transcript");
  await finishing;
  assert.deepEqual(delivered, []);
  assert.equal(rt.starts, 1);
  await c.start();
  assert.equal(rt.starts, 2);
});

test("submit flag rides pendingSubmit to delivery", async () => {
  const rt = slowStopRuntime();
  const { c, delivered } = harness(rt);
  await c.toggle(true);
  assert.equal(rt.pendingSubmit, true);
  const finishing = c.toggle(false);
  await Promise.resolve();
  rt.releaseStop();
  await finishing;
  assert.deepEqual(delivered, [["text", true]]);
});

test("unplug during auto-submit recovers one draft before offering the next input", async () => {
  const rt = slowStopRuntime();
  const events = [];
  const { c } = harness(rt, {
    getSettings: () => normalizeSettings({ autoSubmit: true }),
    deliver: (text, submit) => events.push([text, submit]),
    onMicrophoneUnavailable: (reason) => events.push([reason]),
  });
  await c.start();
  const recovering = rt.interrupt();
  rt.interrupt();
  await c.finish(true);
  rt.releaseStop();
  await recovering;
  assert.deepEqual(events, [["text", false], ["interrupted"]]);
  assert.equal(rt.stops, 1);
});

test("late unplug from cancelled take does not touch the new recording", async () => {
  const rt = slowStopRuntime();
  const { c, delivered } = harness(rt);
  await c.start(true);
  const old = rt.interrupt;
  await c.cancel();
  await c.start(true);
  await old();
  assert.equal(rt.recording, true);
  assert.equal(rt.stops, 0);
  assert.deepEqual(delivered, []);
});

test("manual finish never submits if the final device scan discovers the unplug", async () => {
  const rt = slowStopRuntime();
  const events = [];
  rt.stop = async () => {
    rt.recording = false;
    rt.interruptedMicrophone = { name: "USB microphone" };
    return "/partial.wav";
  };
  const { c, delivered } = harness(rt, {
    onMicrophoneUnavailable: (reason) => events.push(reason),
  });
  await c.start(true);
  await c.finish(true);
  assert.deepEqual(delivered, [["text", false]]);
  assert.deepEqual(events, ["interrupted"]);
});

test("unplug before first usable sample offers another input without decoding", async () => {
  const rt = slowStopRuntime();
  const events = [];
  rt.start = async (_settings, interrupt) => {
    rt.recording = true;
    interrupt();
  };
  rt.stopResult = null;
  rt.releaseStop();
  const { c, delivered } = harness(rt, {
    onMicrophoneUnavailable: (reason) => events.push(reason),
  });
  await c.start(true);
  assert.deepEqual(events, ["interrupted"]);
  assert.equal(rt.transcribes, 0);
  assert.deepEqual(delivered, []);
});

test("prepare failure calls onSetupError and never starts", async () => {
  const rt = slowStopRuntime();
  const setupErrors = [];
  const toasts = [];
  const c = createVoiceController({
    runtime: rt,
    options: {},
    getSettings: () => normalizeSettings({}),
    toast: (m, v = "info") => toasts.push([null, v]),
    deliver: async () => {},
    onSetupError: (t, e) => setupErrors.push([t, e]),
    ready: {
      ...readyStub,
      ensureEngineReady: async () => {
        throw new Error("no network");
      },
    },
  });
  await c.toggle(false);
  assert.equal(setupErrors.length, 1);
  assert.equal(rt.starts, 0);
  assert.ok(!toasts.some(([m]) => String(m).startsWith("Recording")));
});

test("start failure toasts and allows retry", async () => {
  const rt = slowStopRuntime();
  rt.startError = new Error("no microphone");
  const { c, toasts } = harness(rt);
  await c.toggle(false);
  assert.ok(toasts.some(([, v]) => v === "error"));
  assert.equal(rt.recording, false);
  rt.startError = null;
  await c.toggle(false);
  assert.equal(rt.recording, true);
});

test("start-stop-start triple delivers once", async () => {
  const rt = slowStopRuntime();
  const { c, delivered } = harness(rt);
  await c.toggle(false);
  const finishing = c.toggle(false);
  await Promise.resolve();
  rt.releaseStop();
  await finishing;
  await c.toggle(false);
  assert.equal(rt.starts, 1);
  assert.equal(delivered.length, 1);
});

test("direct stopAndTranscribe while busy warns only", async () => {
  const rt = slowStopRuntime();
  rt.transcribing = true;
  const { c, toasts } = harness(rt);
  await c.stopAndTranscribe(false);
  assert.equal(rt.transcribes, 0);
  assert.ok(toasts.some(([, v]) => v === "warning"));
});
