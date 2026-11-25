import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ensureDir } from "./download.js";
import { buildFilterChain } from "./enhance.js";
import { getAudioDir, getCacheDir, getEnginesDir, getModelPath } from "./models.js";
import { repairUnfinalizedWavHeader } from "./wav.js";
import { nativeRecorder, probeNativeRecorder, recorderInfo } from "./rust-recorder.js";
import { rustBinding } from "./rust-binding.js";

const require = createRequire(import.meta.url);
const FFMPEG_STATIC_RELEASE = "b6.1.1";
const FFMPEG_STATIC_BASE_URL = "https://github.com/eugeneware/ffmpeg-static/releases/download";
const WINDOWS_FFMPEG = {
  archiveBytes: 29_581_307,
  archiveSha256: "8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77",
  binaryBytes: 82_797_568,
  binarySha256: "04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00",
};
const DEFAULT_RECORDER_DOWNLOAD_RETRIES = 5;
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let verifiedRecorderIdentity;

const RECORDING_MIN_BYTES = 44;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeArch(value) {
  if (value === "amd64") return "x64";
  if (value === "x86") return "ia32";
  if (value === "aarch64") return "arm64";
  return value;
}

function windowsFfmpegPlatform(options = {}) {
  const platform = options.platform || process.platform;
  const arch = normalizeArch(options.arch || process.arch);
  return { platform, arch, key: `${platform}-${arch}` };
}

function isWindows(options = {}) {
  return (options.platform || process.platform) === "win32";
}

function withDownloadDir(options = {}, settings = {}) {
  return { ...options, downloadDir: settings.downloadDir || options.downloadDir };
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function executableExtensions(options = {}) {
  if (!isWindows(options)) return [""];
  return (process.env.PATHEXT || ".EXE;.CMD;.BAT")
    .split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .filter((entry) => entry.startsWith("."));
}

function resolveExecutable(file, options = {}) {
  const normalized = path.resolve(file);
  if (isExecutable(normalized)) return normalized;

  if (path.extname(normalized) || !isWindows(options)) {
    return "";
  }

  for (const ext of executableExtensions(options)) {
    const candidate = `${normalized}${ext}`;
    if (isExecutable(candidate)) return candidate;
  }

  return "";
}

function managedFfmpegDir(options = {}, settings = {}) {
  const platform = windowsFfmpegPlatform(options);
  return path.join(getCacheDir(options, settings), "recorders", "ffmpeg-static", platform.key);
}

export function getManagedRecorderBinary(options = {}, settings = {}) {
  if (nativeRecorder(options)) return recorderInfo("getManagedRecorderBinary", options, settings);
  const platform = windowsFfmpegPlatform(options);
  return path.join(managedFfmpegDir(options, settings), platform.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
}

export function getManagedRecorderManifestPath(options = {}, settings = {}) {
  if (nativeRecorder(options)) return recorderInfo("getManagedRecorderManifestPath", options, settings);
  return path.join(managedFfmpegDir(options, settings), "manifest.json");
}

export function readManagedRecorderManifest(options = {}, settings = {}) {
  if (nativeRecorder(options)) return recorderInfo("readManagedRecorderManifest", options, settings);
  const file = getManagedRecorderManifestPath(options, settings);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function selectManagedRecorderAsset(options = {}) {
  const platform = windowsFfmpegPlatform(options);
  if (platform.platform !== "win32") throw new Error(`Managed ffmpeg recorder is only available for Windows, got ${platform.key}`);

  const assetArch = platform.arch === "arm64" ? "x64" : platform.arch;
  if (assetArch !== "x64") throw new Error(`No managed ffmpeg recorder asset for ${platform.key}`);

  const assetKey = `${platform.platform}-${assetArch}`;
  return {
    platform,
    assetKey,
    emulated: assetArch !== platform.arch,
    url: `${FFMPEG_STATIC_BASE_URL}/${FFMPEG_STATIC_RELEASE}/ffmpeg-${assetKey}.gz`,
  };
}

// resolveCommand is synchronous. Hash an existing managed install only when its file identity changes.
function isPinnedRecorder(file, options) {
  if (!["x64", "arm64"].includes(windowsFfmpegPlatform(options).arch)) return false;
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || Number(stat.size) !== WINDOWS_FFMPEG.binaryBytes) return false;
    const identity = `${file}:${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.mtimeNs}`;
    if (identity === verifiedRecorderIdentity) return true;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let n;
    while ((n = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, n));
    if (hash.digest("hex") !== WINDOWS_FFMPEG.binarySha256) return false;
    verifiedRecorderIdentity = identity;
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function recorderSource(resolved, managedBinary) {
  if (!resolved) return "missing";
  if (!path.relative(managedBinary, resolved)) return "managed";
  return "system-or-bundled";
}

function exactBytes(size, onProgress) {
  let count = 0;
  return new Transform({
    transform(chunk, _encoding, next) {
      count += chunk.length;
      if (count > size) return next(new Error(`Recorder exceeds pinned size (${size} bytes)`));
      onProgress?.(count);
      next(null, chunk);
    },
    flush(next) {
      next(count === size ? null : new Error(`Recorder size mismatch: expected ${size} bytes, received ${count}`));
    },
  });
}

async function downloadRecorderAsset(url, compressedFile, hooks, attempt, attempts, options) {
  const timeoutMs = Number(options.recorderDownloadTimeoutMs || options.downloadTimeoutMs || hooks.timeoutMs || 120000);
  const signal = AbortSignal.timeout(timeoutMs);
  const total = WINDOWS_FFMPEG.archiveBytes;
  let response;
  try {
    response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Recorder download failed from ${url}: HTTP ${response.status}`);
    if (!response.body) throw new Error("Recorder download failed: empty response body");
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) !== total) throw new Error(`Recorder archive size mismatch (expected ${total})`);
    const progress = (downloaded) => hooks.onProgress?.({ state: "downloading", downloaded, total, percent: downloaded / total * 100, attempt, attempts });
    progress(0);
    await pipeline(Readable.fromWeb(response.body), exactBytes(total, progress), fs.createWriteStream(compressedFile), { signal });
  } catch (error) {
    if (signal.aborted) throw new Error(`Recorder download timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw error;
  } finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}

export async function probeRecorder(binaryPath, options = {}) {
  if (nativeRecorder(options)) return probeNativeRecorder(binaryPath, options);
  return probeReferenceRecorder(binaryPath, options);
}

async function probeReferenceRecorder(binaryPath, options = {}) {
  if (!binaryPath) return { ok: false, message: "missing binary" };

  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    let proc;
    try {
      proc = spawn(binaryPath, ["-version"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: [path.dirname(binaryPath), process.env.PATH].filter(Boolean).join(path.delimiter),
          ...options.env,
        },
      });
    } catch (error) {
      finish({ ok: false, message: error instanceof Error ? error.message : String(error) });
      return;
    }

    timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
      finish({ ok: false, message: "probe timed out" });
    }, options.timeoutMs || 10000);

    proc.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    proc.on("error", (error) => finish({ ok: false, message: error.message }));
    proc.on("exit", (code) => {
      const versionLine = output.split(/\r?\n/).filter(Boolean)[0] || "";
      const ok = code === 0 && /ffmpeg version/i.test(output);
      finish({ ok, message: ok ? "ok" : `unexpected ffmpeg probe output${typeof code === "number" ? ` (exit ${code})` : ""}`, versionLine });
    });
  });
}

async function writeManagedRecorderManifest(managedBinary, source, options, manifestFile) {
  const manifest = {
    schema: "opencode-voice.recorder-install.v1",
    id: "ffmpeg",
    kind: "cli",
    command: "ffmpeg",
    platform: windowsFfmpegPlatform(options).key,
    version: FFMPEG_STATIC_RELEASE,
    source,
    files: [{ path: path.basename(managedBinary), sha256: WINDOWS_FFMPEG.binarySha256, size: WINDOWS_FFMPEG.binaryBytes }],
    installedAt: new Date().toISOString(),
  };

  await fs.promises.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// This installer targets Windows, even when a compatibility client runs on a Mac.
async function recorderHash(file) {
  const hash = createHash("sha256");
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

export function getRecorderStatus(options = {}, settings = {}) {
  if (nativeRecorder(options)) return recorderInfo("getRecorderStatus", options, settings);
  const commandOptions = withDownloadDir(options, settings);
  const managedDir = managedFfmpegDir(options, settings);
  const managedBinary = getManagedRecorderBinary(options, settings);
  const manifest = readManagedRecorderManifest(options, settings);
  const resolvedBinary = resolveCommand("ffmpeg", commandOptions);

  return {
    id: "ffmpeg",
    command: "ffmpeg",
    platform: windowsFfmpegPlatform(options).key,
    supported: isWindows(options) && ["x64", "arm64"].includes(windowsFfmpegPlatform(options).arch),
    managedDir,
    managedBinary,
    managedInstalled: isExecutable(managedBinary),
    manifest,
    resolvedBinary,
    source: recorderSource(resolvedBinary, managedBinary),
  };
}

export async function installManagedRecorder(options = {}, settings = {}, hooks = {}) {
  if (nativeRecorder(options)) return recorderInfo("installManagedRecorder", options, settings);
  const commandOptions = withDownloadDir(options, settings);
  const asset = selectManagedRecorderAsset(commandOptions);
  const managedDir = managedFfmpegDir(commandOptions, settings);
  const managedBinary = getManagedRecorderBinary(commandOptions, settings);
  if (!hooks.force && isPinnedRecorder(managedBinary, commandOptions)) {
    const probe = await probeReferenceRecorder(managedBinary);
    if (probe.ok) return { manifest: readManagedRecorderManifest(commandOptions, settings), managedBinary, probe, skipped: true };
  }

  await ensureDir(managedDir);
  const retries = Number(options.recorderDownloadRetries || hooks.retries) || DEFAULT_RECORDER_DOWNLOAD_RETRIES;
  const attempts = Math.min(DEFAULT_RECORDER_DOWNLOAD_RETRIES, Math.max(1, Math.floor(retries)));
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const stage = await fs.promises.mkdtemp(path.join(managedDir, ".install-"));
    const compressedFile = path.join(stage, "archive.gz");
    const tmpBinary = path.join(stage, path.basename(managedBinary));
    const manifestFile = path.join(stage, "manifest.json");
    try {
      await downloadRecorderAsset(asset.url, compressedFile, hooks, attempt, attempts, commandOptions);
      if (await recorderHash(compressedFile) !== WINDOWS_FFMPEG.archiveSha256) throw new Error("Recorder archive SHA256 mismatch");
      const compressedSize = WINDOWS_FFMPEG.archiveBytes;
      hooks.onProgress?.({ state: "decompressing", downloaded: compressedSize, total: compressedSize, percent: 100, attempt, attempts });
      await pipeline(fs.createReadStream(compressedFile), createGunzip(), exactBytes(WINDOWS_FFMPEG.binaryBytes), fs.createWriteStream(tmpBinary));
      if (await recorderHash(tmpBinary) !== WINDOWS_FFMPEG.binarySha256) throw new Error("Recorder binary SHA256 mismatch");
      await fs.promises.chmod(tmpBinary, 0o755);

      hooks.onProgress?.({ state: "probing", downloaded: fs.statSync(tmpBinary).size, total: fs.statSync(tmpBinary).size, percent: 100, attempt, attempts });
      const probe = await probeReferenceRecorder(tmpBinary);
      if (!probe.ok) throw new Error(`Recorder probe failed: ${probe.message}`);

      const manifest = await writeManagedRecorderManifest(
        managedBinary,
        {
          type: "ffmpeg-static-release",
          release: FFMPEG_STATIC_RELEASE,
          url: asset.url,
          assetPlatform: asset.assetKey,
          emulated: asset.emulated,
        },
        commandOptions,
        manifestFile,
      );
      await fs.promises.rename(tmpBinary, managedBinary);
      await fs.promises.rename(manifestFile, getManagedRecorderManifestPath(commandOptions, settings));
      const installedSize = fs.statSync(managedBinary).size;
      hooks.onProgress?.({ state: "done", downloaded: installedSize, total: installedSize, percent: 100, attempt, attempts });
      return { manifest, managedBinary, probe, skipped: false };
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      hooks.onRetry?.({ error, attempt, attempts, nextAttempt: attempt + 1 });
      await sleep(Math.min(1000 * attempt, 3000));
    } finally {
      await fs.promises.rm(stage, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  throw lastError;
}

export async function ensureManagedRecorder(options = {}, settings = {}, hooks = {}) {
  if (nativeRecorder(options)) return recorderInfo("ensureManagedRecorder", options, settings);
  const commandOptions = withDownloadDir(options, settings);
  if (!isWindows(commandOptions)) return { ...getRecorderStatus(commandOptions, settings), ok: true, skipped: true, unsupported: true };

  const current = getRecorderStatus(commandOptions, settings);
  if (current.resolvedBinary) {
    const probe = await probeReferenceRecorder(current.resolvedBinary);
    if (probe.ok) return { ...current, ok: true, probe, skipped: true };
  }

  try {
    const installed = await installManagedRecorder(commandOptions, settings, hooks);
    return { ...getRecorderStatus(commandOptions, settings), ...installed, resolvedBinary: installed.managedBinary, source: "managed", ok: true };
  } catch (error) {
    const resolvedBinary = resolveRecorderFallback(commandOptions, settings);
    if (resolvedBinary) {
      const probe = await probeReferenceRecorder(resolvedBinary);
      if (probe.ok) {
        return {
          ...getRecorderStatus(commandOptions, settings),
          resolvedBinary,
          source: recorderSource(resolvedBinary, getManagedRecorderBinary(commandOptions, settings)),
          ok: true,
          fallback: true,
          managedError: error instanceof Error ? error.message : String(error),
          probe,
        };
      }
    }

    throw new Error(`Windows ffmpeg recorder install failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function executableNames(command, options = {}) {
  const names = [command];
  if (path.extname(command)) return names;

  if (isWindows(options)) {
    const extensions = (process.env.PATHEXT || ".EXE;.CMD;.BAT")
      .split(";")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    for (const extension of extensions) names.push(`${command}${extension}`);
  }

  return [...new Set(names)];
}

function bundledFfmpegPath() {
  try {
    const candidate = require("ffmpeg-static");
    const resolved = typeof candidate === "string" && resolveExecutable(candidate);
    if (resolved) return resolved;
  } catch {}
  return resolveExecutable(path.join(PLUGIN_ROOT, "node_modules", "ffmpeg-static", "ffmpeg"));
}

function platformKey(options = {}) {
  return `${options.platform || process.platform}-${options.arch || process.arch}`;
}

export function getBundledEngineDir(command, options = {}) {
  if (nativeRecorder(options)) return recorderInfo("getBundledEngineDir", options, {}, command);
  const engineId = command === "whisper-cli" ? "whisper.cpp" : command === "opencode-voice-transcribe" ? "transcribe-cpp" : "";
  return engineId ? path.join(getEnginesDir(options, options), engineId, platformKey(options)) : "";
}

function looksLikePath(value) {
  return path.isAbsolute(value) || value.includes("/") || value.includes("\\");
}

function candidateCommands(command, options = {}) {
  const candidates = [];

  if (command === "whisper-cli") {
    if (options.whisperCli) candidates.push(options.whisperCli);
    if (process.env.OPENCODE_VOICE_WHISPER_CLI) candidates.push(process.env.OPENCODE_VOICE_WHISPER_CLI);
  }

  if (command === "opencode-voice-transcribe") {
    if (options.transcribeCpp) candidates.push(options.transcribeCpp);
    if (process.env.OPENCODE_VOICE_TRANSCRIBE_CPP) candidates.push(process.env.OPENCODE_VOICE_TRANSCRIBE_CPP);
  }

  if (command === "ffmpeg") {
    if (options.ffmpeg) candidates.push(options.ffmpeg);
    if (process.env.OPENCODE_VOICE_FFMPEG) candidates.push(process.env.OPENCODE_VOICE_FFMPEG);
    if (isWindows(options)) candidates.push(getManagedRecorderBinary(options, options));
    if (process.platform === "win32" && isWindows(options)) candidates.push(bundledFfmpegPath());
  }

  const bundledDir = getBundledEngineDir(command, options);
  if (bundledDir) {
    for (const name of executableNames(command, options)) candidates.push(path.join(bundledDir, name));
  }

  candidates.push(...executableNames(command, options));

  const fallbackDirs = [
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), ".opencode-voice", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
  ];

  if (isWindows(options)) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    fallbackDirs.unshift(path.join(localAppData, "opencode-voice", "bin"));
  }

  for (const dir of fallbackDirs) {
    for (const name of executableNames(command, options)) candidates.push(path.join(dir, name));
  }

  if (command === "ffmpeg" && process.platform === "darwin" && (options.platform ?? "darwin") === "darwin") {
    candidates.push(bundledFfmpegPath());
  }
  return [...new Set(candidates.filter(Boolean))];
}

export function resolveCommand(command, options = {}) {
  if (nativeRecorder(options)) return recorderInfo("resolveCommand", options, {}, command);
  const managed = command === "ffmpeg" && isWindows(options) ? getManagedRecorderBinary(options, options) : "";
  const allowed = (file) => file && (!managed || path.relative(managed, file) !== "" || isPinnedRecorder(file, options));
  for (const candidate of candidateCommands(command, options)) {
    if (looksLikePath(candidate)) {
      const resolved = resolveExecutable(candidate, options);
      if (allowed(resolved)) return resolved;
      continue;
    }

    for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
      const file = path.join(dir, candidate);
      const resolved = resolveExecutable(file, options);
      if (allowed(resolved)) return resolved;
    }
  }

  return null;
}

function resolveRecorderFallback(options = {}, settings = {}) {
  const managedBinary = path.resolve(getManagedRecorderBinary(options, settings));
  for (const candidate of candidateCommands("ffmpeg", options)) {
    if (looksLikePath(candidate)) {
      const resolved = resolveExecutable(candidate, options);
      if (resolved && path.relative(managedBinary, resolved)) return resolved;
      continue;
    }

    for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
      const file = path.join(dir, candidate);
      const resolved = resolveExecutable(file, options);
      if (resolved && path.relative(managedBinary, resolved)) return resolved;
    }
  }

  return null;
}

export function commandExists(command, options = {}) {
  return Boolean(resolveCommand(command, options));
}

function childEnv(options = {}) {
  const localLib = path.join(os.homedir(), ".local", "lib");
  const localBin = path.join(os.homedir(), ".local", "bin");
  const bundledDirs = [getBundledEngineDir("whisper-cli", options), getBundledEngineDir("opencode-voice-transcribe", options)];
  const pathEntries = [...bundledDirs, localBin, localLib, process.env.PATH].filter(Boolean);
  return {
    ...process.env,
    PATH: pathEntries.join(path.delimiter),
    LD_LIBRARY_PATH: [localLib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter),
    DYLD_LIBRARY_PATH: [localLib, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(path.delimiter),
  };
}

function normalizeWindowsAudioInput(device = "") {
  const value = String(device).trim();
  if (!value || value === "default") return "audio=default";
  if (value.startsWith("audio=") || value.startsWith("video=")) return value;
  return `audio=${value}`;
}

function formatCommand(command, args) {
  const quote = (value) => {
    const text = String(value);
    if (/^[^\s"\\]+$/.test(text)) return text;
    return `"${text.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\*)$/g, "$1$1")}"`;
  };
  return [command, ...args].map(quote).join(" ");
}

function parseWindowsMicrophones(stderr) {
  const devices = new Set();
  for (const line of stderr.split(/\r?\n/)) {
    const match = line.match(/"([^"]+)"\s+\(audio\)/);
    if (match?.[1]) devices.add(match[1]);
  }

  return [...devices].filter(Boolean);
}

const MAC_DEVICE_LIST = ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""];
const MAC_LIST_TIMEOUT_MS = 4000;
const MAC_START_TIMEOUT_MS = 8000;

function macAudioDevices(stderr, strict = false) {
  const devices = [];
  let audio = false;
  for (const line of stderr.split(/\r?\n/)) {
    // Video, screen and audio indices are separate namespaces starting at zero.
    const row = line.replace(/^\s*\[AVFoundation indev[^\]]*\]\s*/i, "").trim();
    if (/^AVFoundation (?:audio|video) devices:$/i.test(row)) {
      audio = /^AVFoundation audio/i.test(row);
    } else if (audio) {
      const match = row.match(/^\[(\d+)\]\s+(.+?)(?:\s{2,}\[uid:([^\]]+)\](?: \[serial:[^\]]+\])?)?$/);
      if (strict && /^\[\d/.test(row) && (!match || /\s{2,}\[uid:/.test(match[2]))) {
        throw new Error("Incomplete AVFoundation audio device entry.");
      }
      if (match) devices.push({ index: match[1], name: match[2], uid: match[3] });
    }
  }
  return devices;
}

// Keep ordinary names readable. Escape names that collide with AVFoundation selectors.
function macMicValue({ name, uid }) {
  if (uid) return `:uid:${encodeURIComponent(uid)}:${encodeURIComponent(name)}`;
  return /^(?:\d+$|default$|:|uid:)/.test(name) ? `::${name}` : `:${name}`;
}

function macMicSelection(value) {
  if (value.startsWith(":uid:")) {
    const match = /^:uid:([^:]+):([^:]+)$/.exec(value);
    if (match) {
      try {
        return { uid: decodeURIComponent(match[1]), name: decodeURIComponent(match[2]) };
      } catch {}
    }
    throw unavailableMicrophone(value, "Invalid device identifier.");
  }
  return { name: value.replace(/^::?/, "") };
}

export function microphoneLabel(value, options = {}) {
  if ((options.platform || process.platform) !== "darwin") return value;
  const native = rustBinding();
  if (native && typeof value === "string") return native.macInputLabel(value);
  try {
    return macMicSelection(value).name;
  } catch {
    return value;
  }
}

export function listMicrophones(options = {}) {
  const platform = options.platform || process.platform;
  const arecordCommand = resolveCommand("arecord", options);
  const ffmpegCommand = resolveCommand("ffmpeg", options);

  if (platform === "linux" && arecordCommand) {
    const result = spawnSync(arecordCommand, ["-L"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const devices = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && !line.includes(" ") && line !== "null");
    return ["default", ...devices.filter((item) => item !== "default")];
  }

  if (platform === "darwin" && ffmpegCommand) {
    const result = spawnSync(ffmpegCommand, MAC_DEVICE_LIST, {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
      timeout: MAC_LIST_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (result.error) return [];
    const native = rustBinding();
    return native ? native.macChoices(result.stderr || "", false) : [...new Set(macAudioDevices(result.stderr || "").map(macMicValue))];
  }

  if (platform === "win32" && ffmpegCommand) {
    const result = spawnSync(ffmpegCommand, ["-hide_banner", "-f", "dshow", "-list_devices", "true", "-i", "dummy"], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });
    const devices = parseWindowsMicrophones(result.stderr || "");
    return ["default", ...devices.filter((device) => device !== "default")];
  }

  return ["default"];
}

export function listMicrophoneChoices(options = {}) {
  return listMicrophones(options)
    .filter((value) => value !== "default")
    .map((value) => ({ title: microphoneLabel(value, options), value }));
}

async function listMacInputs(ffmpeg, settings, signal, waitForCloseOnAbort = true) {
  if (!ffmpeg) throw new Error("FFmpeg is not installed.");
  const deadline = AbortSignal.timeout(MAC_LIST_TIMEOUT_MS);
  const output = await runAudioCommand(ffmpeg, MAC_DEVICE_LIST, settings, signal ? AbortSignal.any([signal, deadline]) : deadline, waitForCloseOnAbort);
  return macAudioDevices(output, true);
}

export async function listMicrophoneChoicesAsync(options = {}, signal) {
  signal?.throwIfAborted();
  if ((options.platform || process.platform) !== "darwin") return listMicrophoneChoices(options);
  const native = rustBinding();
  if (native) {
    const ffmpeg = resolveCommand("ffmpeg", options);
    if (!ffmpeg) throw new Error("FFmpeg is not installed.");
    const deadline = AbortSignal.timeout(MAC_LIST_TIMEOUT_MS);
    const output = await runAudioCommand(ffmpeg, MAC_DEVICE_LIST, options, signal ? AbortSignal.any([signal, deadline]) : deadline, false);
    return native.macChoices(output, true).map((value) => ({ title: native.macInputLabel(value), value }));
  }
  const devices = await listMacInputs(resolveCommand("ffmpeg", options), options, signal, false);
  return [...new Set(devices.map(macMicValue))].map((value) => ({ title: microphoneLabel(value, options), value }));
}

function unavailableMicrophone(name, detail) {
  return Object.assign(new Error(`Microphone "${name}" is unavailable. Choose another microphone in /voice-settings. ${detail}`), {
    code: "VOICE_MIC_UNAVAILABLE",
    microphone: name,
  });
}

async function buildRecorders(file, settings = {}, signal) {
  const platform = settings.platform || process.platform;
  const device = String(settings.mic ?? "").trim();
  const mic = device === "default" || (platform === "darwin" && device === ":default") || (platform === "win32" && device === "audio=default") ? "" : device;
  const recorders = [];
  const arecordCommand = resolveCommand("arecord", settings);
  const ffmpegCommand = resolveCommand("ffmpeg", settings);
  const soxCommand = resolveCommand("sox", settings);

  if (platform === "linux" && arecordCommand) {
    recorders.push({
      label: mic ? `arecord (${mic})` : "arecord (default)",
      command: arecordCommand,
      args: ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "wav", ...(mic ? ["-D", mic] : []), file],
    });
  }

  if (platform === "linux" && ffmpegCommand) {
    if (!mic) {
      recorders.push({
        label: "ffmpeg pulse (default)",
        command: ffmpegCommand,
        args: ["-hide_banner", "-loglevel", "error", "-y", "-f", "pulse", "-i", "default", "-ac", "1", "-ar", "16000", file],
      });
    }

    recorders.push({
      label: `ffmpeg alsa (${mic || "default"})`,
      command: ffmpegCommand,
      args: ["-hide_banner", "-loglevel", "error", "-y", "-f", "alsa", "-i", mic || "default", "-ac", "1", "-ar", "16000", file],
    });
  }

  if (platform === "darwin") {
    const { name: selected, uid } = macMicSelection(mic);
    if (mic && !selected) throw unavailableMicrophone(mic, "Empty microphone selector.");
    const named = (uid || mic.startsWith("::") || !/^\d+$/.test(selected)) ? selected : "";
    let input = `:${selected || "default"}`;
    let target;
    if (named) {
      try {
        const devices = await listMacInputs(ffmpegCommand, settings, signal);
        const matches = devices.filter((d) => uid ? d.uid === uid : d.name === named);
        if (matches.length !== 1) throw new Error(matches.length ? "Multiple matching inputs." : "No matching audio input.");
        [target] = matches;
        // AVFoundation splits on colons, parses leading digits and accepts name prefixes.
        // For ambiguous selectors use the current index; verify the actual opened name below.
        if (target.uid || /^(?:[+-]?\d|none|default)|:/.test(named) || devices.some(({ name }) => name !== named && name.startsWith(named))) {
          input = `:${target.index}`;
        }
      } catch (error) {
        signal.throwIfAborted();
        throw unavailableMicrophone(named, error.message);
      }
    }
    if (ffmpegCommand) {
      recorders.push({
        label: `ffmpeg avfoundation (${input})`,
        command: ffmpegCommand,
        args: ["-hide_banner", "-loglevel", "debug", "-y", "-f", "avfoundation",
          ...(target?.uid ? ["-audio_device_id", `uid:${target.uid}`] : []), "-i", input, "-ac", "1", "-ar", "16000",
          "-fflags", "+bitexact", "-flush_packets", "1", file],
        avfoundation: true,
        named: named ? target.name : "",
        target,
      });
    }
  }

  if (platform === "win32" && ffmpegCommand) {
    // DirectShow does not provide a reliable "audio=default" alias. Try each
    // enumerated device before retaining it as a final fallback for custom setups.
    const inputs = mic ? [normalizeWindowsAudioInput(mic)] : [
      ...listMicrophones(settings).filter((name) => name !== "default").map(normalizeWindowsAudioInput),
      "audio=default",
    ];
    for (const input of new Set(inputs)) {
      recorders.push({
        label: `ffmpeg dshow (${input.replace(/^audio=/, "")})`,
        command: ffmpegCommand,
        args: ["-hide_banner", "-loglevel", "error", "-y", "-f", "dshow", "-i", input, "-ac", "1", "-ar", "16000", file],
      });
    }
  }

  if (!mic && soxCommand) {
    recorders.push({
      label: "sox default",
      command: soxCommand,
      args: ["-d", "-r", "16000", "-c", "1", "-b", "16", file],
    });
  }

  if (!recorders.length && mic) throw new Error(`No recorder available for microphone "${mic}". Choose system default or install a compatible recorder.`);
  if (!recorders.length) throw new Error("No recorder found. Install ffmpeg, arecord, or sox.");
  return recorders;
}

async function removeTake(file) {
  await fs.promises.rm(file, { force: true });
  try {
    await fs.promises.rmdir(path.dirname(file));
  } catch (error) {
    // A caller may have put a file beside ours. Never recursively delete it.
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
  }
}

function runAudioCommand(command, args, commandOptions, signal, waitForCloseOnAbort = true) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const proc = spawn(command, args, {
      env: childEnv(commandOptions), stdio: ["ignore", "pipe", "pipe"], signal, killSignal: "SIGKILL",
    });
    // Inventory-only callers can stop waiting before the killed child's pipes drain.
    const aborted = () => reject(signal.reason);
    if (!waitForCloseOnAbort) {
      if (signal.aborted) aborted();
      else signal.addEventListener("abort", aborted, { once: true });
    }
    let stdout = "";
    let stderr = "";
    let failure;
    proc.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    proc.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    proc.once("error", (error) => { failure = error; });
    // close follows both process exit and pipe drain, including on Windows.
    proc.once("close", (code) => {
      if (!waitForCloseOnAbort) signal.removeEventListener("abort", aborted);
      if (signal.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      // AVFoundation prints its device list on stderr and intentionally exits nonzero.
      else if (args === MAC_DEVICE_LIST) {
        // Some FFmpeg versions return AVERROR(EIO) (-5, shell status 251) after listing.
        if ([0, 1, 251].includes(code) && /^(?:\s*\[AVFoundation indev[^\]]*\]\s*)?AVFoundation audio devices:\s*$/mi.test(stderr)) resolve(stderr);
        else reject(new Error(lastLine(stderr) || "Incomplete AVFoundation device list."));
      }
      else if (code !== 0) reject(new Error(lastLine(stderr) || `${path.basename(command)} exited with code ${code}`));
      else resolve(stdout);
    });
  });
}

function cleanTranscription(text) {
  return text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lastLine(value) {
  return value.trim().split("\n").filter(Boolean).pop() || "";
}

function startRecorder(recorder, file, signal) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    let detail = "";
    let timer;
    let poll;
    let verified = !recorder.named;
    const active = { recorder, file, stderr: () => stderr };
    const clearTimers = () => { clearTimeout(timer); clearInterval(poll); };
    const commandLine = formatCommand(recorder.command, recorder.args);
    const failure = (detail) => {
      const name = recorder.named || active.openedName;
      if (name) return unavailableMicrophone(name, detail);
      return new Error(`${recorder.label}: ${detail}\nCommand: ${commandLine}${stderr.trim() ? `\nffmpeg stderr:\n${stderr.trim()}` : ""}`);
    };

    let proc;
    try {
      signal.throwIfAborted();
      proc = spawn(recorder.command, recorder.args, { stdio: ["ignore", "ignore", "pipe"], signal, killSignal: "SIGKILL" });
    } catch (error) {
      reject(failure(error instanceof Error ? error.message : String(error)));
      return;
    }
    proc.stderr.setEncoding("utf8").on("data", (chunk) => {
      if (!recorder.avfoundation) {
        stderr += chunk;
        return;
      }
      // Keep a bounded tail: named captures use FFmpeg's debug-level opened-device message.
      const output = stderr + chunk;
      stderr = output.slice(-8192);
      if (detail) return;
      if (!active.openedName) {
        const opened = output.match(/^\[(?:in#\d+\/)?avfoundation(?: indev)?(?: @ [^\]]+)?\]\s+audio device '([^\r\n]*)' opened\r?$/mi);
        if (opened) {
          active.openedName = opened[1];
          verified = !recorder.named || active.openedName === recorder.named;
          if (!verified) detail = `FFmpeg opened "${opened[1]}" instead of the selected microphone.`;
          else active.onOpened?.();
        }
      }
      // add_audio_device can log failure and then wait forever for its first sample.
      const failed = output.match(/^\[(?:in#\d+\/)?avfoundation(?: indev)?(?: @ [^\]]+)?\]\s+((?:Audio device not found|Failed to create AV capture input device|can't add audio input to capture session|Failed to init AV audio output|adding audio output to capture session failed)[^\r\n]*)/mi);
      if (failed) detail = failed[1];
      if (detail) proc.kill("SIGKILL");
    });
    proc.once("error", (error) => { detail = error.message; });
    active.proc = proc;
    active.closed = new Promise((done) => {
      proc.once("close", (code) => {
        clearTimers();
        // A short take can finish between writing its first PCM and the readiness tick.
        if (recorder.avfoundation && (active.openedName || code === 0) &&
            fs.statSync(file, { throwIfNoEntry: false })?.size > RECORDING_MIN_BYTES) ready();
        done();
        reject(signal.aborted ? signal.reason : failure(detail || lastLine(stderr) || `exited with code ${code}`));
      });
    });

    const ready = () => {
      if (detail || signal.aborted || !verified || !fs.existsSync(file)) return false;
      clearTimers();
      resolve(active);
      return true;
    };
    if (recorder.avfoundation) poll = setInterval(ready, 40);
    timer = setTimeout(() => {
      if (ready()) return;
      detail ||= verified ? "did not create an audio file" : "could not verify the selected audio input";
      clearTimers();
      proc.kill("SIGKILL");
    }, recorder.avfoundation ? MAC_START_TIMEOUT_MS : 650);
  });
}

function endCapture(active) {
  if (active.ended || active.endRequested) return;
  active.endRequested = true;
  const timer = setTimeout(() => active.proc.kill("SIGKILL"), 3000);
  active.closed.then(() => clearTimeout(timer));
  active.proc.kill("SIGINT");
}

// AVFoundation can wait forever for a sample after unplug. Only compare the input
// opened for this take; a new input or a change of system default is not a reason to stop.
async function monitorMacInput(active, settings, signal) {
  const { recorder } = active;
  let target = recorder.target;
  const controller = new AbortController();
  let pending;
  let finalScan;
  let ambiguous = false;
  active.endMonitor = () => {
    controller.abort();
    return finalScan || pending;
  };
  const scan = () => listMacInputs(recorder.command, settings, AbortSignal.any([signal, controller.signal]));
  const checkInput = () => {
    const name = target?.name || active.openedName;
    if (!name || active.lostInput || controller.signal.aborted || signal.aborted) return Promise.resolve(active.lostInput);
    pending ??= scan().then((devices) => {
      const matches = devices.filter((d) => target?.uid ? target.uid === d.uid : name === d.name);
      ambiguous = !target && matches.length > 1;
      if (!matches.length || ambiguous) active.lostInput = { name };
      else target ??= matches[0];
      return active.lostInput;
    }, () => undefined).finally(() => { pending = null; });
    return pending;
  };
  // A scan already draining its pipes at EOF may predate the disconnect.
  active.finalInput = () => finalScan ??= pending ? pending.then(checkInput) : checkInput();
  const watchInput = () => {
    checkInput().then((lost) => {
      if (lost && !controller.signal.aborted && !active.stopping) endCapture(active);
    });
  };
  if (!target && active.openedName) {
    await checkInput();
    if (ambiguous) throw unavailableMicrophone(active.openedName, "Cannot identify which same-name input opened.");
  }
  // Default/index captures may produce a WAV before their stderr pipe delivers the name.
  active.onOpened = watchInput;
  const watch = setInterval(watchInput, 2000);
  watch.unref?.();
  active.closed.then(() => clearInterval(watch));
}

export class VoiceRuntime {
  #ownedRecordings = new Map();
  #cancelling = null;

  constructor(options = {}) {
    this.options = options;
    this.recording = null;
    this.recordingError = "";
    this.interruptedMicrophone = null;
    this.starting = null;
    this.transcription = null;
    this.pendingSubmit = false;
  }

  isRecording() {
    return Boolean(this.recording && !this.recording.ended);
  }

  isTranscribing() {
    return Boolean(this.transcription);
  }

  async start(settings = {}, onInterrupted) {
    if (this.recording?.ended) throw Object.assign(new Error("Finish or cancel the interrupted recording before starting another."), { code: "VOICE_TAKE_PENDING" });
    if (this.recording) return this.recording.file;
    if (this.starting) return this.starting.done;
    const job = { controller: new AbortController() };
    this.starting = job;
    try {
      job.done = this.#start(settings, job.controller.signal, onInterrupted);
      return await job.done;
    } finally {
      if (this.starting === job) this.starting = null;
    }
  }

  async #start(settings, signal, onInterrupted) {
    this.recordingError = "";
    this.interruptedMicrophone = null;
    const dir = getAudioDir(this.options, settings);
    await ensureDir(dir);
    signal.throwIfAborted();
    const recorderSettings = { ...this.options, ...settings, downloadDir: settings.downloadDir || this.options.downloadDir };
    const recorderReady = await ensureManagedRecorder(recorderSettings, settings).catch((error) => {
      if (isWindows(recorderSettings)) throw error;
      return null;
    });
    if (recorderReady?.resolvedBinary) recorderSettings.ffmpeg = recorderReady.resolvedBinary;

    signal.throwIfAborted();
    const take = await fs.promises.mkdtemp(path.join(dir, "voice-"));
    const file = path.join(take, "recording.wav");
    this.#ownedRecordings.set(file, null);
    try {
      signal.throwIfAborted();
      const errors = [];
      for (const recorder of await buildRecorders(file, recorderSettings, signal)) {
        await fs.promises.rm(file, { force: true });
        signal.throwIfAborted();
        try {
          const active = await startRecorder(recorder, file, signal);
          if (recorder.avfoundation) {
            try {
              await monitorMacInput(active, recorderSettings, signal);
            } catch (error) {
              active.proc.kill("SIGKILL");
              await active.closed;
              throw error;
            }
          }
          if (signal.aborted) {
            active.endMonitor?.();
            await active.closed;
            throw signal.reason;
          }
          this.recording = active;
          active.closed.then(async () => {
            active.ended = true;
            if (this.recording !== active || active.stopping) return;
            if ((recorderSettings.platform || process.platform) === "darwin") {
              // Snapshot at EOF as well as at manual stop: the user may reconnect the mic later.
              void active.finalInput?.();
              this.interruptedMicrophone = active.lostInput || null;
              await onInterrupted?.();
              return;
            }
            this.recording = null;
            this.recordingError = lastLine(active.stderr()) || `${recorder.label} stopped unexpectedly`;
            await this.cleanupRecording(file);
          }).catch((error) => { this.recordingError = error.message; });
          return file;
        } catch (error) {
          signal.throwIfAborted();
          if (error.code === "VOICE_MIC_UNAVAILABLE") throw error;
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      throw new Error(`Could not start recorder. Tried: ${errors.join("; ")}`);
    } catch (error) {
      await this.cleanupRecording(file);
      throw error;
    }
  }

  async stop() {
    const active = this.recording;
    if (!active) {
      if (!this.recordingError) return null;
      const error = this.recordingError;
      this.recordingError = "";
      throw new Error(error);
    }

    active.stopping = true;
    try {
      endCapture(active);
      // Wait for the OS to close recorder file handles before reading the WAV.
      await active.closed;
      if (this.recording !== active) return null;
      const lost = await active.finalInput?.();
      if (this.recording !== active) return null;
      this.interruptedMicrophone = lost || null;
      if (!fs.existsSync(active.file)) {
        throw Object.assign(new Error(lastLine(active.stderr()) || `${active.recorder.label} did not create an audio file`), { code: "VOICE_RECORDING_MISSING" });
      }

      if (fs.statSync(active.file).size <= RECORDING_MIN_BYTES) {
        throw Object.assign(new Error("Recording is empty. Check your microphone input."), { code: "VOICE_RECORDING_EMPTY" });
      }
      return active.file;
    } catch (error) {
      await this.cleanupRecording(active.file);
      throw error;
    } finally {
      active.endMonitor?.();
      if (this.recording === active) this.recording = null;
    }
  }

  async cleanupRecording(file) {
    if (!this.#ownedRecordings.has(file)) return;
    const pending = this.#ownedRecordings.get(file);
    if (pending) return pending;
    const cleanup = removeTake(file).then(
      () => { this.#ownedRecordings.delete(file); },
      (error) => { this.#ownedRecordings.set(file, null); throw error; },
    );
    this.#ownedRecordings.set(file, cleanup);
    return cleanup;
  }

  async cancel() {
    const { starting, recording, transcription } = this;
    const files = [...this.#ownedRecordings.keys()];
    this.starting = this.recording = this.transcription = null;
    this.interruptedMicrophone = null;
    const monitor = recording?.endMonitor?.();
    starting?.controller.abort();
    transcription?.controller.abort();
    recording?.proc.kill("SIGKILL");
    // A second cancel/dispose must also wait for the first one's file handles.
    const done = Promise.allSettled([this.#cancelling, starting?.done, recording?.closed, monitor, transcription?.done])
      .then(() => Promise.all(files.map((file) => this.cleanupRecording(file))));
    this.#cancelling = done;
    try {
      await done;
    } finally {
      if (this.#cancelling === done) this.#cancelling = null;
    }
  }

  async transcribe(audioFile, model, settings = {}) {
    if (this.transcription) throw new Error("Transcription is already running");
    const job = { controller: new AbortController() };
    this.transcription = job;
    try {
      const timeout = AbortSignal.timeout(this.options.transcriptionTimeoutMs || 120000);
      const signal = AbortSignal.any([job.controller.signal, timeout]);
      job.done = this.#transcribe(audioFile, model, settings, signal);
      return await job.done;
    } catch (error) {
      if (error?.name === "TimeoutError") throw new Error("Transcription timed out");
      throw error;
    } finally {
      if (this.transcription === job) this.transcription = null;
      await this.cleanupRecording(audioFile);
    }
  }

  async #transcribe(audioFile, model, settings, signal) {
    const commandOptions = { ...this.options, downloadDir: settings.downloadDir };
    const command = model.engine === "transcribe-cpp" ? "opencode-voice-transcribe" : "whisper-cli";
    const binary = resolveCommand(command, commandOptions);
    if (!binary) throw new Error(`${command} not found. Install the managed ${model.engine} engine or set its OPENCODE_VOICE_* binary path.`);

    const modelFile = getModelPath(model, this.options, settings);
    if (!fs.existsSync(modelFile)) {
      throw new Error(`Model is not downloaded: ${model.name}`);
    }

    // Header repair writes in place. Never repair or create siblings beside caller-owned audio.
    const scratch = this.#ownedRecordings.has(audioFile) ? null : await fs.promises.mkdtemp(path.join(os.tmpdir(), "opencode-voice-"));
    const rawFile = scratch ? path.join(scratch, "recording.wav") : audioFile;
    let filteredFile;
    try {
      let inputFile = rawFile;
      if (scratch) await fs.promises.copyFile(audioFile, rawFile);
      signal.throwIfAborted();
      repairUnfinalizedWavHeader(inputFile);

      // Voice cleanup: pre-filter a copy for every recorder backend. Falls back
      // to the raw file when disabled, when ffmpeg is missing, or on any error —
      // a raw transcription always beats no transcription.
      const chain = buildFilterChain({ enabled: settings.voiceEnhance !== false, cutoffHz: settings.cleanupCutoffHz });
      const ffmpeg = chain && resolveCommand("ffmpeg", commandOptions);
      if (ffmpeg) {
        const filtered = path.join(path.dirname(inputFile), "clean.wav");
        try {
          const handle = await fs.promises.open(filtered, "wx", 0o600);
          filteredFile = filtered;
          await handle.close();
          await runAudioCommand(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", inputFile, "-af", chain, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", filtered], commandOptions, signal);
          if (fs.statSync(filtered).size > RECORDING_MIN_BYTES) inputFile = filtered;
        } catch {
          signal.throwIfAborted();
        }
      }
      const args = model.engine === "transcribe-cpp" ? ["--model", modelFile, "--file", inputFile] : ["-m", modelFile, "-f", inputFile, "-np", "-nt"];
      if (model.engine !== "transcribe-cpp") args.push("-l", settings.language || "auto");
      else if (settings.language && settings.language !== "auto") args.push("--language", settings.language);
      const text = cleanTranscription(await runAudioCommand(binary, args, commandOptions, signal));
      if (!text) throw new Error("Transcription returned empty text");
      return text;
    } finally {
      try {
        if (filteredFile) await fs.promises.rm(filteredFile, { force: true });
      } finally {
        if (scratch) await removeTake(rawFile);
      }
    }
  }
}
