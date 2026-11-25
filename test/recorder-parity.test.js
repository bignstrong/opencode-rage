import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  commandExists,
  ensureManagedRecorder,
  getBundledEngineDir,
  getManagedRecorderBinary,
  getManagedRecorderManifestPath,
  getRecorderStatus,
  installManagedRecorder,
  probeRecorder,
  readManagedRecorderManifest,
  resolveCommand,
} from "../lib/engine.js";

test(
  "macOS recorder honors explicit, env, PATH and managed engine lookup; ensure performs no install",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rage-recorder-parity-"));
    const before = new Map(
      ["PATH", "OPENCODE_VOICE_FFMPEG", "OPENCODE_VOICE_WHISPER_CLI"].map((key) => [
        key,
        process.env[key],
      ]),
    );
    t.after(() => {
      for (const [key, value] of before) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    });
    const bin = (name) => {
      const file = path.join(root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "#!/bin/sh\nexit 61\n", { mode: 0o700 });
      return file;
    };
    const configured = bin("option");
    const fromEnv = bin("environment");
    const fromPath = bin("bin/ffmpeg");
    process.env.PATH = path.dirname(fromPath);
    process.env.OPENCODE_VOICE_FFMPEG = fromEnv;
    delete process.env.OPENCODE_VOICE_WHISPER_CLI;
    const options = {
      arch: "aarch64",
      downloadDir: path.join(root, "option-cache"),
      ffmpeg: configured,
    };
    const settings = { downloadDir: path.join(root, "settings-cache") };
    const managedDir = path.join(settings.downloadDir, "recorders/ffmpeg-static/darwin-arm64");
    const managedBinary = path.join(managedDir, "ffmpeg");
    assert.equal(getManagedRecorderBinary(options, settings), managedBinary);
    assert.equal(
      getManagedRecorderManifestPath(options, settings),
      path.join(managedDir, "manifest.json"),
    );
    assert.equal(resolveCommand("ffmpeg", options), configured);
    fs.chmodSync(configured, 0o600);
    assert.equal(resolveCommand("ffmpeg", options), fromEnv);
    delete process.env.OPENCODE_VOICE_FFMPEG;
    assert.equal(resolveCommand("ffmpeg", options), fromPath);
    assert.equal(commandExists("ffmpeg", options), true);
    assert.equal(commandExists("unavailable-rage-test-command", options), false);
    const status = getRecorderStatus(options, settings);
    assert.deepEqual(status, {
      id: "ffmpeg",
      command: "ffmpeg",
      platform: "darwin-arm64",
      supported: false,
      managedDir,
      managedBinary,
      managedInstalled: false,
      manifest: null,
      resolvedBinary: fromPath,
      source: "system-or-bundled",
    });
    assert.deepEqual(await ensureManagedRecorder(options, settings), {
      ...status,
      ok: true,
      skipped: true,
      unsupported: true,
    });
    await assert.rejects(
      installManagedRecorder(options, settings),
      /only available for Windows, got darwin-arm64/,
    );
    assert.equal(fs.existsSync(settings.downloadDir), false);
    const bundled = getBundledEngineDir("whisper-cli", options);
    assert.equal(bundled, path.join(options.downloadDir, "engines/whisper.cpp/darwin-aarch64"));
    const engine = bin(path.relative(root, path.join(bundled, "whisper-cli")));
    assert.equal(resolveCommand("whisper-cli", options), engine);
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(path.join(managedDir, "manifest.json"), '{"version":"legacy"}');
    assert.deepEqual(readManagedRecorderManifest(options, settings), { version: "legacy" });
  },
);

test(
  "macOS probe runs only fake -version, preserves env, exit status and timeout",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rage-recorder-probe-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "fixture recorder");
    fs.writeFileSync(
      file,
      '#!/bin/sh\n[ "$1" = -version ] || exit 17\nprintf "ffmpeg version %s\\n" "$FIXTURE" >&2\nexit "$EXIT"\n',
      { mode: 0o700 },
    );
    assert.deepEqual(await probeRecorder(file, { env: { FIXTURE: 12, EXIT: 0 } }), {
      ok: true,
      message: "ok",
      versionLine: "ffmpeg version 12",
    });
    assert.deepEqual(await probeRecorder(file, { env: { FIXTURE: "unit", EXIT: "3" } }), {
      ok: false,
      message: "unexpected ffmpeg probe output (exit 3)",
      versionLine: "ffmpeg version unit",
    });
    fs.writeFileSync(file, "#!/bin/sh\nexec /bin/sleep 10\n");
    assert.deepEqual(await probeRecorder(file, { timeoutMs: 50 }), {
      ok: false,
      message: "probe timed out",
    });
    assert.deepEqual(await probeRecorder(""), { ok: false, message: "missing binary" });
  },
);
