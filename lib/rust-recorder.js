import fs from "node:fs";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { rustBinding, useRust } from "./rust-binding.js";

const require = createRequire(import.meta.url);
const packaged = fileURLToPath(new URL("../node_modules/ffmpeg-static/ffmpeg", import.meta.url));
const core = fileURLToPath(new URL("../native/target/release/rage-core", import.meta.url));
const { accessSync, statSync } = fs;

export const nativeRecorder = (options = {}) =>
  useRust() && (options.platform || "darwin") === "darwin";

function packageCandidates() {
  try {
    const file = require("ffmpeg-static");
    if (typeof file === "string" && file !== packaged) return [file, packaged];
  } catch {}
  return [packaged];
}

export function recorderInfo(op, options = {}, settings = {}, command = "ffmpeg") {
  const { platform, arch, downloadDir, ffmpeg, whisperCli, transcribeCpp } = options;
  const args = { options: { platform, arch, downloadDir, ffmpeg, whisperCli, transcribeCpp },
    settings: { downloadDir: settings.downloadDir }, command };
  const lookup = ["resolveCommand", "commandExists", "getRecorderStatus", "ensureManagedRecorder"].includes(op);
  if (lookup && command === "ffmpeg") args.bundled = packageCandidates();
  const binding = rustBinding();
  const call = (method) => JSON.parse(binding.recorderInfo(method, JSON.stringify(args)));
  // Respect an embedder's virtual Node filesystem while keeping native search order.
  if (lookup && (fs.accessSync !== accessSync || fs.statSync !== statSync)) {
    const paths = call("recorderCandidates");
    if (op === "getRecorderStatus" || op === "ensureManagedRecorder") paths.push(call("getManagedRecorderBinary"));
    args.accessible = paths.filter(file => {
      try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); }
      catch { return false; }
    });
  }
  return call(op);
}

export function probeNativeRecorder(binaryPath, { timeoutMs, env } = {}) {
  const childEnv = env && Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
  const ms = Number(timeoutMs || 10_000);
  const body = JSON.stringify({ binaryPath, options: {
    timeoutMs: ms >= 1 && ms <= 2_147_483_647 ? Math.trunc(ms) : 1, env: childEnv,
  } });
  return new Promise((resolve, reject) => {
    const child = execFile(core, ["recorder", "probeRecorder"], { maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) { reject(error); return; }
        try { resolve(JSON.parse(stdout).result); } catch (cause) { reject(cause); }
      });
    child.stdin.on("error", () => {}); // Startup failure is reported by execFile.
    child.stdin.end(body);
  });
}
