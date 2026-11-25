import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  listMicrophoneChoices,
  listMicrophoneChoicesAsync,
  listMicrophones,
  microphoneLabel,
  VoiceRuntime,
} from "../lib/engine.js";
import { getModel, getModelPath } from "../lib/models.js";

const iphone = "Anna’s iPhone Microphone";
function listing(names) {
  return [
    "AVFoundation video devices:",
    "[0] FaceTime Camera",
    "[1] Capture screen 0",
    "AVFoundation audio devices:",
    ...names.map((name, i) => `[${i}] ${name}`),
  ]
    .map((row) => `[AVFoundation indev @ 0x123] ${row}\n`)
    .join("");
}

// Neither listing nor capture can reach a native executable, even on macOS.
function setup(t, names = ["Built-in Mic", iphone]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-mac-test-"));
  const options = {
    downloadDir: dir,
    platform: "darwin",
    ffmpeg: process.execPath,
    whisperCli: process.execPath,
  };
  const rt = new VoiceRuntime(options);
  const started = Promise.withResolvers();
  const h = { options, rt, dir, names, started, captures: [], listings: 0 };
  t.mock.method(childProcess, "spawnSync", (_cmd, args) => {
    assert.ok(args.includes("-list_devices"));
    return { stderr: listing(h.names), status: 1 };
  });
  t.mock.method(childProcess, "spawn", (_cmd, args, opts) => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = (signal) => {
      queueMicrotask(() => proc.emit("close", null, signal));
      return true;
    };
    opts.signal?.addEventListener("abort", () => proc.kill("SIGKILL"), { once: true });
    if (args.includes("-list_devices")) {
      h.listings++;
      if (h.onList) {
        h.onList(proc);
        return proc;
      }
      queueMicrotask(() => {
        proc.stderr.write(listing(h.names));
        proc.emit("close", 1);
      });
    } else if (args.includes("-np")) {
      queueMicrotask(() => {
        h.transcribed = fs.readFileSync(args[args.indexOf("-f") + 1]);
        proc.stdout.write("partial speech");
        proc.emit("close", 0);
      });
    } else {
      const capture = {
        proc,
        args,
        file: args.at(-1),
        input: args[args.indexOf("-i") + 1],
        opened(name) {
          proc.stderr.write(`[avfoundation @ 0xabc] audio device '${name}' opened\n`);
        },
        write(bytes = 56) {
          const wav = Buffer.alloc(44 + bytes);
          wav.write("RIFF");
          wav.writeUInt32LE(0xffffffff, 4);
          wav.write("WAVEfmt ", 8);
          wav.writeUInt32LE(16, 16);
          wav.writeUInt16LE(1, 20);
          wav.writeUInt16LE(1, 22);
          wav.writeUInt32LE(16000, 24);
          wav.writeUInt32LE(32000, 28);
          wav.writeUInt16LE(2, 32);
          wav.writeUInt16LE(16, 34);
          wav.write("data", 36);
          wav.writeUInt32LE(0xffffffff, 40);
          wav.fill(123, 44);
          fs.writeFileSync(capture.file, wav);
        },
      };
      h.captures.push(capture);
      started.resolve(capture);
    }
    return proc;
  });
  syncBuiltinESMExports();
  t.after(async () => {
    await rt.cancel();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return h;
}

test("sync and async pickers keep the device UID and readable labels across reordering", async (t) => {
  const h = setup(t, [`${iphone}  [uid:0x123] [serial:123]`, "Built-in Mic"]);
  const expected = { title: iphone, value: `:uid:0x123:${encodeURIComponent(iphone)}` };
  assert.deepEqual(listMicrophoneChoices(h.options), [
    expected,
    { title: "Built-in Mic", value: ":Built-in Mic" },
  ]);
  h.names.reverse();
  assert.deepEqual(listMicrophoneChoices(h.options)[1], expected);
  assert.deepEqual(listMicrophones(h.options), [":Built-in Mic", expected.value]);
  assert.deepEqual(await listMicrophoneChoicesAsync(h.options), listMicrophoneChoices(h.options));
  assert.equal(microphoneLabel(expected.value, h.options), iphone);
});

test("async discovery distinguishes a complete empty audio section, failure and abort", async (t) => {
  const h = setup(t, []);
  assert.deepEqual(await listMicrophoneChoicesAsync(h.options), []);
  h.onList = (proc) =>
    queueMicrotask(() => {
      proc.stderr.write(listing([]));
      proc.emit("close", 251);
    });
  assert.deepEqual(await listMicrophoneChoicesAsync(h.options), []);
  for (const [text, status] of [
    ["AVFoundation video devices:\n", 0],
    [listing([]) + "[0]\n", 1],
    [listing([]), null],
  ]) {
    h.onList = (proc) =>
      queueMicrotask(() => {
        proc.stderr.write(text);
        proc.emit("close", status);
      });
    await assert.rejects(listMicrophoneChoicesAsync(h.options));
  }
  const controller = new AbortController();
  let child;
  h.onList = (proc) => {
    child = proc;
    child.kill = () => true;
  };
  const scan = listMicrophoneChoicesAsync(h.options, controller.signal);
  controller.abort();
  await assert.rejects(scan, {
    name: "AbortError",
  });
  child.emit("close", null, "SIGKILL");
});

for (const selector of [":", "::", ":uid::name", ":uid:%ZZ:name"]) {
  test(`invalid explicit selector ${selector} never opens default`, async (t) => {
    const h = setup(t);
    await assert.rejects(h.rt.start({ mic: selector }), { code: "VOICE_MIC_UNAVAILABLE" });
    assert.equal(h.captures.length, 0);
  });
}

test("UID selection binds the original same-name device and rejects its replacement", async (t) => {
  const h = setup(t, ["USB  [uid:a:b]", "USB  [uid:c]"]);
  const [choice] = await listMicrophoneChoicesAsync(h.options);
  await assert.rejects(h.rt.start({ mic: ":USB" }), { code: "VOICE_MIC_UNAVAILABLE" });
  const start = h.rt.start({ mic: choice.value });
  const capture = await h.started.promise;
  assert.equal(capture.args[capture.args.indexOf("-audio_device_id") + 1], "uid:a:b");
  capture.opened("USB");
  capture.write();
  await start;
  h.names = ["USB  [uid:c]"];
  assert.equal(await h.rt.stop(), capture.file);
  assert.deepEqual(h.rt.interruptedMicrophone, { name: "USB" });
  await assert.rejects(h.rt.start({ mic: choice.value }), { code: "VOICE_MIC_UNAVAILABLE" });
  assert.equal(h.captures.length, 1);
});

for (const code of [0, 1]) {
  test(`unexpected recorder exit ${code} keeps partial PCM for explicit transcription`, async (t) => {
    const h = setup(t);
    const notify = t.mock.fn();
    const start = h.rt.start({ mic: `:${iphone}` }, notify);
    const capture = await h.started.promise;
    capture.opened(iphone);
    capture.write();
    await start;
    h.names = ["Built-in Mic"];
    capture.proc.emit("close", code);
    await new Promise(setImmediate);
    assert.equal(notify.mock.callCount(), 1);
    assert.deepEqual(notify.mock.calls[0].arguments, []);
    assert.equal(h.rt.isRecording(), false);
    assert.equal(h.transcribed, undefined);
    assert.ok(fs.existsSync(capture.file));
    await assert.rejects(h.rt.start(), { code: "VOICE_TAKE_PENDING" });
    h.names.push(iphone);
    const file = await h.rt.stop();
    assert.equal(file, capture.file);
    assert.deepEqual(h.rt.interruptedMicrophone, { name: iphone });
    const model = getModel("whisper-small");
    const modelFile = getModelPath(model, h.options, h.options);
    fs.mkdirSync(path.dirname(modelFile), { recursive: true });
    fs.writeFileSync(modelFile, "");
    assert.equal(
      await h.rt.transcribe(file, model, { ...h.options, voiceEnhance: false }),
      "partial speech",
    );
    assert.equal(h.transcribed.readUInt32LE(40), 56);
    assert.deepEqual(h.transcribed.subarray(44), Buffer.alloc(56, 123));
    assert.equal(fs.existsSync(file), false);
  });
}

test("default take ignores added inputs; unplug with FFmpeg still waiting ends that capture only", async (t) => {
  const h = setup(t, ["USB  [uid:one]"]);
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const interrupted = Promise.withResolvers();
  const start = h.rt.start({}, interrupted.resolve);
  const capture = await h.started.promise;
  capture.opened("USB");
  capture.write();
  t.mock.timers.tick(100);
  await start;
  h.names.unshift("Bluetooth");
  t.mock.timers.tick(2000);
  await new Promise(setImmediate);
  assert.ok(h.rt.isRecording());
  assert.equal(h.captures.length, 1);
  h.names = ["Bluetooth", "USB  [uid:replacement]"];
  t.mock.timers.tick(2000);
  await interrupted.promise;
  assert.equal(h.rt.isRecording(), false);
  assert.equal(h.captures.length, 1);
  assert.equal(await h.rt.stop(), capture.file);
  assert.deepEqual(h.rt.interruptedMicrophone, { name: "USB" });
});

test("scan failure does not interrupt a live take or flag a normal stop", async (t) => {
  const h = setup(t);
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const notify = t.mock.fn();
  const start = h.rt.start({ mic: `:${iphone}` }, notify);
  const capture = await h.started.promise;
  capture.opened(iphone);
  capture.write();
  t.mock.timers.tick(100);
  await start;
  h.onList = (proc) => queueMicrotask(() => proc.emit("close", 1));
  t.mock.timers.tick(2000);
  await new Promise(setImmediate);
  assert.ok(h.rt.isRecording());
  assert.equal(await h.rt.stop(), capture.file);
  assert.equal(h.rt.interruptedMicrophone, null);
  assert.equal(notify.mock.callCount(), 0);
});

test("stop checks fresh inventory after an in-flight scan sampled the still-connected mic", async (t) => {
  const h = setup(t, ["USB"]);
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const start = h.rt.start({ mic: ":USB" });
  const capture = await h.started.promise;
  capture.opened("USB");
  capture.write();
  t.mock.timers.tick(100);
  await start;
  const scan = Promise.withResolvers();
  h.onList = (proc) => {
    proc.stderr.write(listing(h.names));
    scan.resolve(proc);
  };
  t.mock.timers.tick(2000);
  const stale = await scan.promise;
  h.names = [];
  h.onList = undefined;
  const stopped = h.rt.stop();
  await new Promise(setImmediate);
  stale.emit("close", 1);
  assert.equal(await stopped, capture.file);
  assert.deepEqual(h.rt.interruptedMicrophone, { name: "USB" });
});

test("a late opened-device log binds the default take without restarting capture", async (t) => {
  const h = setup(t, ["USB  [uid:original]"]);
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const notify = t.mock.fn();
  const start = h.rt.start({}, notify);
  const capture = await h.started.promise;
  capture.write();
  t.mock.timers.tick(100);
  await start;
  capture.opened("USB");
  await new Promise(setImmediate);
  h.names.push("Bluetooth");
  t.mock.timers.tick(2000);
  await new Promise(setImmediate);
  assert.ok(h.rt.isRecording());
  h.names = ["USB  [uid:replacement]", "Bluetooth"];
  t.mock.timers.tick(2000);
  await new Promise(setImmediate);
  assert.equal(notify.mock.callCount(), 1);
  assert.equal(await h.rt.stop(), capture.file);
  assert.deepEqual(h.rt.interruptedMicrophone, { name: "USB" });
  assert.equal(h.captures.length, 1);
});

test("default mic opened then lost before first PCM never falls back to SoX", async (t) => {
  const h = setup(t);
  const oldPath = process.env.PATH;
  fs.writeFileSync(path.join(h.dir, "sox"), "", { mode: 0o700 });
  process.env.PATH = [h.dir, oldPath].join(path.delimiter);
  t.after(() => {
    process.env.PATH = oldPath;
  });
  const start = h.rt.start();
  const capture = await h.started.promise;
  capture.opened(iphone);
  capture.proc.emit("close", 1);
  await assert.rejects(start, { code: "VOICE_MIC_UNAVAILABLE", microphone: iphone });
  assert.equal(h.captures.length, 1);
  assert.equal(fs.existsSync(path.dirname(capture.file)), false);
});

test("empty disconnected take reports loss but leaves no WAV", async (t) => {
  const h = setup(t);
  const notify = t.mock.fn();
  const start = h.rt.start({ mic: `:${iphone}` }, notify);
  const capture = await h.started.promise;
  capture.opened(iphone);
  capture.write(0);
  await start;
  h.names = [];
  await assert.rejects(h.rt.stop(), { code: "VOICE_RECORDING_EMPTY" });
  assert.deepEqual(h.rt.interruptedMicrophone, { name: iphone });
  assert.equal(notify.mock.callCount(), 0);
  assert.equal(fs.existsSync(capture.file), false);
  await h.rt.cancel();
  assert.equal(h.rt.interruptedMicrophone, null);
});

test("unexpected EOF before the first readiness tick preserves verified audio", async (t) => {
  const h = setup(t);
  const notify = t.mock.fn();
  const start = h.rt.start({ mic: `:${iphone}` }, notify);
  const capture = await h.started.promise;
  capture.opened(iphone);
  capture.write();
  capture.proc.emit("close", 0);
  assert.equal(await start, capture.file);
  assert.equal(await h.rt.stop(), capture.file);
  assert.equal(notify.mock.callCount(), 1);
  assert.equal(h.captures.length, 1);
});

test("early default EOF keeps partial audio even without an opened-device log", async (t) => {
  const h = setup(t);
  const notify = t.mock.fn();
  const start = h.rt.start({}, notify);
  const capture = await h.started.promise;
  capture.write();
  capture.proc.emit("close", 0);
  assert.equal(await start, capture.file);
  assert.equal(await h.rt.stop(), capture.file);
  assert.equal(notify.mock.callCount(), 1);
  assert.equal(h.listings, 0);
  assert.equal(h.captures.length, 1);
});

test("absent named iPhone cannot open a prefix match or a default recorder", async (t) => {
  const h = setup(t, [`${iphone} 2`, "Built-in Mic"]);
  await assert.rejects(h.rt.start({ mic: `:${iphone}` }), {
    code: "VOICE_MIC_UNAVAILABLE",
    microphone: iphone,
    message: new RegExp(`${iphone}.*/voice-settings`),
  });
  assert.equal(h.captures.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(h.dir, "recordings")), []);
});

test("legacy-selector-looking device names round trip without selecting that index or default", async (t) => {
  const h = setup(t, ["2", "default", ":Studio"]);
  assert.deepEqual(listMicrophoneChoices(h.options), [
    { title: "2", value: "::2" },
    { title: "default", value: "::default" },
    { title: ":Studio", value: ":::Studio" },
  ]);
  const start = h.rt.start({ mic: "::2" });
  const capture = await h.started.promise;
  assert.equal(capture.input, ":0");
  capture.opened("2");
  capture.write();
  assert.equal(await start, capture.file);
});

test("cancelling named-input discovery waits for FFmpeg without starting capture", async (t) => {
  const h = setup(t);
  const listing = Promise.withResolvers();
  h.onList = listing.resolve;
  const start = h.rt.start({ mic: `:${iphone}` });
  const proc = await listing.promise;
  const close = Promise.withResolvers();
  proc.kill = () => close.promise.then(() => proc.emit("close", null, "SIGKILL"));
  const rejected = assert.rejects(start, { name: "AbortError" });
  const cancelled = h.rt.cancel();
  assert.equal(fs.readdirSync(path.join(h.dir, "recordings")).length, 1);
  close.resolve();
  await Promise.all([rejected, cancelled]);
  assert.equal(h.captures.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(h.dir, "recordings")), []);
});

for (const [mic, expected] of [
  ["", ":default"],
  [":default", ":default"],
  [":2", ":2"],
  ["2", ":2"],
]) {
  test(`macOS ${JSON.stringify(mic)} uses ${expected} without listing or waiting 650ms`, async (t) => {
    const h = setup(t);
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const start = h.rt.start({ mic });
    const capture = await h.started.promise;
    assert.equal(capture.input, expected);
    assert.equal(h.listings, 0);
    capture.write();
    t.mock.timers.tick(100);
    assert.equal(await start, capture.file);
  });
}

test("iPhone can start after 2s; return as soon as verified input creates the WAV", async (t) => {
  const h = setup(t);
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const start = h.rt.start({ mic: `:${iphone}` });
  const capture = await h.started.promise;
  assert.equal(capture.input, `:${iphone}`);
  capture.opened(iphone);
  t.mock.timers.tick(2100);
  assert.equal(h.rt.isRecording(), false);
  capture.write();
  t.mock.timers.tick(50);
  assert.equal(await start, capture.file);
  assert.equal(await h.rt.stop(), capture.file);
});

test("ambiguous AVFoundation prefix uses exact listed index; reject hot-plug mismatch", async (t) => {
  const h = setup(t, [`${iphone} 2`, iphone]);
  const start = h.rt.start({ mic: `:${iphone}` });
  const capture = await h.started.promise;
  assert.equal(capture.input, ":1");
  capture.write();
  capture.opened(`${iphone} 2`);
  await assert.rejects(start, {
    code: "VOICE_MIC_UNAVAILABLE",
    message: /instead of the selected/,
  });
  assert.equal(h.captures.length, 1);
  assert.equal(fs.existsSync(path.dirname(capture.file)), false);
});

test("AVFoundation logging an input failure without exiting rejects immediately", async (t) => {
  const h = setup(t);
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const start = h.rt.start({ mic: `:${iphone}` });
  const capture = await h.started.promise;
  capture.opened(iphone);
  capture.proc.stderr.write(
    "[avfoundation @ 0x123] Failed to create AV capture input device: busy\n",
  );
  await assert.rejects(start, {
    code: "VOICE_MIC_UNAVAILABLE",
    message: /capture input device: busy/,
  });
  assert.equal(h.captures.length, 1);
  assert.equal(fs.existsSync(path.dirname(capture.file)), false);
});

for (const cancel of [false, true]) {
  test(`stalled AVFoundation startup: ${cancel ? "cancel" : "deadline"} releases the take and process`, async (t) => {
    const h = setup(t);
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const start = h.rt.start({ mic: `:${iphone}` });
    const capture = await h.started.promise;
    capture.opened(iphone);
    const rejected = assert.rejects(
      start,
      cancel ? { name: "AbortError" } : { code: "VOICE_MIC_UNAVAILABLE" },
    );
    if (cancel) await h.rt.cancel();
    else t.mock.timers.tick(10000);
    await rejected;
    assert.equal(h.captures.length, 1);
    assert.equal(fs.existsSync(path.dirname(capture.file)), false);
    assert.equal(h.rt.isRecording(), false);
  });
}
