import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  getManagedRecorderBinary,
  installManagedRecorder,
  resolveCommand,
  VoiceRuntime,
} from "../lib/engine.js";
import { getModel, getModelPath } from "../lib/models.js";

test(
  "macOS finds an installed ffmpeg-static only after system candidates",
  { skip: process.platform !== "darwin" },
  (t) => {
    const bundled = fileURLToPath(new URL("../node_modules/ffmpeg-static/ffmpeg", import.meta.url));
    const system = "/opt/homebrew/bin/ffmpeg";
    const available = new Set([bundled]);
    t.mock.method(fs, "accessSync", (file) => {
      if (!available.has(file)) throw new Error("missing executable");
    });
    t.mock.method(fs, "statSync", (file) => ({ isFile: () => available.has(file) }));
    assert.equal(resolveCommand("ffmpeg"), bundled);
    available.add(system);
    assert.equal(resolveCommand("ffmpeg"), system);
  },
);

// All native commands are simulated, including device discovery and Windows probes.
function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-privacy-test-"));
  const options = {
    downloadDir: dir,
    ffmpeg: process.execPath,
    whisperCli: process.execPath,
    transcribeCpp: process.execPath,
    skipFfmpegStaticInstall: true,
  };
  const model = getModel("whisper-small");
  const settings = { downloadDir: dir };
  const modelFile = getModelPath(model, options, settings);
  fs.mkdirSync(path.dirname(modelFile), { recursive: true });
  fs.writeFileSync(modelFile, "");
  const h = { rt: new VoiceRuntime(options), dir, settings, model, bytes: 64 };
  t.mock.method(childProcess, "spawnSync", () => ({
    stderr: h.devices ?? "",
    stdout: "",
    status: 0,
  }));
  t.mock.method(childProcess, "spawn", (_cmd, args, opts) => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.exitCode = proc.signalCode = null;
    function finish(code, signal = null) {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      proc.exitCode = code;
      proc.signalCode = signal;
      proc.emit("exit", code, signal);
      proc.emit("close", code, signal);
    }
    proc.kill = (signal) => {
      queueMicrotask(() => finish(null, signal));
      return true;
    };
    opts.signal?.addEventListener("abort", () => proc.kill("SIGKILL"), { once: true });
    queueMicrotask(() => {
      if (args.includes("-version")) {
        proc.stdout.write("ffmpeg version test");
        finish(0);
      } else if (args.includes("-af")) {
        fs.writeFileSync(args.at(-1), "partial filtered audio");
        if (!h.onFilter) finish(1);
        else h.onFilter();
      } else if (args.includes("-np") || args.includes("--model")) {
        proc.stdout.write("transcribed");
        if (h.onTranscribe) h.onTranscribe(proc, finish, args);
        else finish(0);
      } else {
        fs.writeFileSync(args.at(-1), Buffer.alloc(h.bytes));
        if (h.failStart) finish(1);
        h.onSpawn?.(proc, args);
      }
    });
    return proc;
  });
  syncBuiltinESMExports();
  t.after(async () => {
    try {
      await h.rt.cancel();
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  return h;
}

for (const [platform, mic] of [
  ["linux", "hw:9,0"],
  ["darwin", ":9"],
  ["win32", "My Headset"],
]) {
  test(`${platform}: an unavailable selected mic never falls back to another device`, async (t) => {
    const h = harness(t);
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    const prevPath = process.env.PATH;
    Object.defineProperty(process, "platform", { ...descriptor, value: platform });
    process.env.PATH = `${h.dir}${path.delimiter}${prevPath}`;
    t.after(() => {
      Object.defineProperty(process, "platform", descriptor);
      process.env.PATH = prevPath;
    });
    for (const name of ["sox", "arecord"])
      fs.writeFileSync(path.join(h.dir, name), "", { mode: 0o755 });
    h.devices = '[dshow] "Other Mic" (audio)';
    h.failStart = true;
    const attempts = [];
    h.onSpawn = (_proc, args) => attempts.push(args);
    await assert.rejects(h.rt.start({ ...h.settings, mic }), /Could not start recorder/);
    assert.ok(attempts.length);
    const input = platform === "win32" ? `audio=${mic}` : mic;
    assert.ok(
      attempts.every((args) => args.includes(input)),
      JSON.stringify(attempts),
    );
    attempts.length = 0;
    await assert.rejects(h.rt.start({ ...h.settings, mic: "default" }), /Could not start recorder/);
    assert.ok(
      attempts.some((args) => args[0] === "-d"),
      "SoX remains a default-only fallback",
    );
    if (platform === "win32") assert.ok(attempts.some((args) => args.includes("audio=Other Mic")));
  });
}

test("Whisper receives -l auto by default; the sidecar retains its own auto mode", async (t) => {
  const h = harness(t);
  const file = path.join(h.dir, "input.wav");
  fs.writeFileSync(file, Buffer.alloc(64));
  const calls = [];
  h.onTranscribe = (_proc, finish, args) => {
    calls.push(args);
    finish(0);
  };
  for (const [engine, language, flag, expected] of [
    ["whisper.cpp", undefined, "-l", "auto"],
    ["whisper.cpp", "auto", "-l", "auto"],
    ["whisper.cpp", "ru", "-l", "ru"],
    ["transcribe-cpp", "auto", "--language", undefined],
    ["transcribe-cpp", "ru", "--language", "ru"],
  ]) {
    await h.rt.transcribe(
      file,
      { ...h.model, engine },
      { ...h.settings, voiceEnhance: false, language },
    );
    const args = calls.at(-1);
    const i = args.indexOf(flag);
    assert.equal(i < 0 ? undefined : args[i + 1], expected);
  }
});

test("owned takes use private directories and survive stop only until transcription or discard", async (t) => {
  const { rt, dir, settings, model } = harness(t);
  const root = path.join(dir, "recordings");
  fs.mkdirSync(root);
  const legacy = path.join(root, "voice-123.wav");
  fs.writeFileSync(legacy, "older recording");
  const first = await rt.start(settings);
  assert.notEqual(path.dirname(first), root);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.dirname(first)).mode & 0o077, 0);
  assert.equal(await rt.stop(), first);
  assert.equal(await rt.transcribe(first, model, settings), "transcribed");
  assert.equal(fs.existsSync(path.dirname(first)), false);
  const second = await rt.start(settings);
  assert.notEqual(path.dirname(first), path.dirname(second));
  await rt.stop();
  await Promise.all([rt.cleanupRecording(second), rt.cleanupRecording(second)]);
  await rt.cleanupRecording(legacy);
  assert.deepEqual(fs.readdirSync(root), [path.basename(legacy)]);
});

test("failed startup, empty stop, cancellation and missing model discard owned WAVs", async (t) => {
  const h = harness(t);
  const root = path.join(h.dir, "recordings");
  h.failStart = true;
  await assert.rejects(h.rt.start(h.settings), /Could not start recorder/);
  assert.deepEqual(fs.readdirSync(root), []);
  h.failStart = false;
  h.bytes = 44;
  await h.rt.start(h.settings);
  await assert.rejects(h.rt.stop(), /empty/);
  assert.deepEqual(fs.readdirSync(root), []);
  h.bytes = 64;
  await h.rt.start(h.settings);
  await h.rt.cancel();
  assert.deepEqual(fs.readdirSync(root), []);
  await h.rt.start(h.settings);
  const file = await h.rt.stop();
  await assert.rejects(h.rt.transcribe(file, { ...h.model, filename: "missing.bin" }, h.settings));
  assert.deepEqual(fs.readdirSync(root), []);
});

test("cancelling startup or filtering waits for children and leaves no owned audio", async (t) => {
  const h = harness(t);
  const spawned = Promise.withResolvers();
  h.onSpawn = spawned.resolve;
  const start = h.rt.start(h.settings);
  await spawned.promise;
  await Promise.all([assert.rejects(start), h.rt.cancel()]);
  const root = path.join(h.dir, "recordings");
  assert.deepEqual(fs.readdirSync(root), []);
  await h.rt.start(h.settings);
  const file = await h.rt.stop();
  const filtering = Promise.withResolvers();
  h.onFilter = filtering.resolve;
  const transcribing = h.rt.transcribe(file, h.model, h.settings);
  await filtering.promise;
  await Promise.all([assert.rejects(transcribing), h.rt.cancel()]);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("repeated cancel waits for recognition to close before removing the WAV", async (t) => {
  const h = harness(t);
  const recognizing = Promise.withResolvers();
  const closing = Promise.withResolvers();
  h.onTranscribe = (proc, finish) => {
    proc.kill = () => {
      closing.promise.then(() => finish(null, "SIGKILL"));
      return true;
    };
    recognizing.resolve();
  };
  await h.rt.start(h.settings);
  const file = await h.rt.stop();
  const result = h.rt.transcribe(file, h.model, { ...h.settings, voiceEnhance: false });
  await recognizing.promise;
  const cancelled = [h.rt.cancel(), h.rt.cancel()];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fs.existsSync(file), true);
  closing.resolve();
  await Promise.all([assert.rejects(result), ...cancelled]);
  assert.equal(fs.existsSync(path.dirname(file)), false);
});

test("external WAV and adjacent files stay byte-for-byte intact, including on filter failure", async (t) => {
  const { rt, dir, model, settings } = harness(t);
  const file = path.join(dir, "user.wav");
  const sibling = `${file}.${process.pid}.clean.wav`;
  const wav = Buffer.alloc(64);
  wav.write("RIFF");
  wav.writeUInt32LE(0xffffffff, 4);
  wav.write("WAVEdata", 8);
  wav.writeUInt32LE(0xffffffff, 16);
  fs.writeFileSync(file, wav);
  fs.writeFileSync(sibling, "user-owned");
  assert.equal(await rt.transcribe(file, model, settings), "transcribed");
  await rt.cleanupRecording(file);
  assert.deepEqual(fs.readFileSync(file), wav);
  assert.equal(fs.readFileSync(sibling, "utf8"), "user-owned");
});

test("cleanup does not overwrite or recursively delete a foreign file inside an owned directory", async (t) => {
  const { rt, model, settings } = harness(t);
  await rt.start(settings);
  const raw = await rt.stop();
  const foreign = path.join(path.dirname(raw), "clean.wav");
  fs.writeFileSync(foreign, "caller-owned");
  assert.equal(await rt.transcribe(raw, model, settings), "transcribed");
  assert.equal(fs.existsSync(raw), false);
  assert.equal(fs.readFileSync(foreign, "utf8"), "caller-owned");
});

test("Windows recorder rejects unpinned bytes before probing, and preserves the previous installation", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-recorder-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = {
    downloadDir: dir,
    platform: "win32",
    arch: "arm64",
    recorderDownloadRetries: 1,
  };
  const file = getManagedRecorderBinary(options);
  const current = "previous installation";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, current, { mode: 0o755 });
  const spawn = t.mock.method(childProcess, "spawn", () => {
    throw new Error("must not probe unverified bytes");
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  let surplus = 0;
  const fetch = t.mock.method(globalThis, "fetch", async (url) => {
    assert.match(url, /b6\.1\.1\/ffmpeg-win32-x64\.gz$/);
    const size = 29_581_307;
    let remaining = size + surplus;
    const chunk = new Uint8Array(65536);
    return new Response(
      new ReadableStream({
        pull(controller) {
          const count = Math.min(remaining, chunk.length);
          controller.enqueue(chunk.subarray(0, count));
          remaining -= count;
          if (!remaining) controller.close();
        },
      }),
    );
  });
  assert.notEqual(resolveCommand("ffmpeg", options), file);
  await assert.rejects(installManagedRecorder(options), /archive SHA256 mismatch/);
  surplus = 1;
  await assert.rejects(installManagedRecorder(options), /exceeds pinned size/);
  assert.equal(
    resolveCommand("ffmpeg", { ...options, arch: "ia32", ffmpeg: process.execPath }),
    process.execPath,
  );
  await assert.rejects(
    installManagedRecorder({ ...options, arch: "ia32" }),
    /No managed ffmpeg recorder asset/,
  );
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(spawn.mock.callCount(), 0);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
  assert.equal(fs.readFileSync(file, "utf8"), current);
});
