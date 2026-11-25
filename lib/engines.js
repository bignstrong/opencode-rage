import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sha256, ensureDir, replaceFile } from "./download.js";
import { getCacheDir } from "./models.js";
import { getBundledEngineDir, resolveCommand } from "./engine.js";

export const DEFAULT_ENGINE_REGISTRY_URL = "https://github.com/ihxnnxs/opencode-voice/releases/download/v0.2.0/registry.json";
// Release assets can be replaced under the same tag. Review this pin with every registry update.
const DEFAULT_ENGINE_REGISTRY_SHA256 = "4cd542a78b0ad73df5e6befc26eff0539e42b33e48b3b7d0462119f45979da3b";
function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export const ENGINES = {
  "whisper.cpp": {
    id: "whisper.cpp",
    command: "whisper-cli",
    probeArgs: ["--help"],
    probeContains: ["--model", "--file"],
  },
  "transcribe-cpp": {
    id: "transcribe-cpp",
    command: "opencode-voice-transcribe",
    probeArgs: ["--help"],
    probeContains: ["--model", "--file"],
  },
};

const DEFAULT_ENGINE_DOWNLOAD_RETRIES = 5;
const DEFAULT_ENGINE_DOWNLOAD_TIMEOUT_MS = 120000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getEngine(engineId) {
  const engine = ENGINES[engineId];
  if (!engine) throw new Error(`Unsupported engine: ${engineId}`);
  return engine;
}

function executableName(engineId, options = {}) {
  const command = getEngine(engineId).command;
  return (options.platform || process.platform) === "win32" ? `${command}.exe` : command;
}

function normalizePlatform(value) {
  if (value === "x64" || value === "arm64") return value;
  if (value === "amd64") return "x64";
  if (value === "aarch64") return "arm64";
  return value;
}

export function getEnginePlatformKey(options = {}) {
  if (nativeAssets(options)) return assetInfo("getEnginePlatformKey", {options});
  return `${options.platform || process.platform}-${normalizePlatform(options.arch || process.arch)}`;
}

function withDownloadDir(options = {}, settings = {}) {
  return { ...options, downloadDir: settings.downloadDir || options.downloadDir };
}

export function getManagedEngineDir(engineId = "whisper.cpp", options = {}, settings = {}) {
  if (nativeAssets(options)) return assetInfo("getManagedEngineDir", {engineId, options, settings});
  return getBundledEngineDir(getEngine(engineId).command, withDownloadDir(options, settings));
}

export function getManagedEngineBinary(engineId = "whisper.cpp", options = {}, settings = {}) {
  if (nativeAssets(options)) return assetInfo("getManagedEngineBinary", {engineId, options, settings});
  return path.join(getManagedEngineDir(engineId, options, settings), executableName(engineId, options));
}

export function getEngineManifestPath(engineId = "whisper.cpp", options = {}, settings = {}) {
  if (nativeAssets(options)) return assetInfo("getEngineManifestPath", {engineId, options, settings});
  return path.join(getManagedEngineDir(engineId, options, settings), "manifest.json");
}

export function readEngineManifest(engineId = "whisper.cpp", options = {}, settings = {}) {
  if (nativeAssets(options)) return assetInfo("readEngineManifest", {engineId, options, settings});
  const file = getEngineManifestPath(engineId, options, settings);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function engineSource(engine, resolved, managedBinary, options = {}) {
  if (!resolved) return "missing";
  if (path.resolve(resolved) === path.resolve(managedBinary)) return "managed";
  const optionKey = engine.id === "whisper.cpp" ? "whisperCli" : "transcribeCpp";
  const envKey = engine.id === "whisper.cpp" ? "OPENCODE_VOICE_WHISPER_CLI" : "OPENCODE_VOICE_TRANSCRIBE_CPP";
  if (options[optionKey] && path.resolve(resolved) === path.resolve(options[optionKey])) return "option";
  if (process.env[envKey] && path.resolve(resolved) === path.resolve(process.env[envKey])) return "env";
  return "system";
}

export function getEngineStatus(engineId = "whisper.cpp", options = {}, settings = {}) {
  if (nativeAssets(options)) return assetInfo("getEngineStatus", {engineId, options, settings});
  const engine = getEngine(engineId);
  const commandOptions = withDownloadDir(options, settings);
  const managedDir = getManagedEngineDir(engineId, commandOptions);
  const managedBinary = getManagedEngineBinary(engineId, commandOptions);
  const manifest = readEngineManifest(engineId, commandOptions);
  const resolvedBinary = resolveCommand(engine.command, commandOptions);

  return {
    id: engineId,
    command: engine.command,
    platform: getEnginePlatformKey(commandOptions),
    cacheDir: getCacheDir(commandOptions),
    managedDir,
    managedBinary,
    managedInstalled: fs.existsSync(managedBinary),
    manifest,
    resolvedBinary,
    source: engineSource(engine, resolvedBinary, managedBinary, commandOptions),
  };
}

function summarizeProbeOutput(output) {
  return String(output || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function engineProbeMessage(message) {
  const text = summarizeProbeOutput(message);
  if (/\b(MSVCP140|VCOMP140|VCRUNTIME140|VCRUNTIME140_1|api-ms-win-crt)\b/i.test(text)) {
    return `${text}; Windows VC++ runtime dependency is missing`;
  }
  return text || "unknown probe failure";
}

export async function probeEngine(engineId = "whisper.cpp", binaryPath, options = {}) {
  if (nativeAssets(options)) return assetRequest("probeEngine", {engineId, binaryPath, options});
  const engine = getEngine(engineId);
  if (!binaryPath) return { ok: false, message: "missing binary" };

  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const localLib = path.join(os.homedir(), ".local", "lib");
    const env = {
      ...process.env,
      PATH: [path.dirname(binaryPath), path.join(os.homedir(), ".local", "bin"), process.env.PATH].filter(Boolean).join(path.delimiter),
      LD_LIBRARY_PATH: [localLib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter),
      DYLD_LIBRARY_PATH: [localLib, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(path.delimiter),
      ...options.env,
    };
    const proc = spawn(binaryPath, engine.probeArgs, { stdio: ["ignore", "pipe", "pipe"], env });
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
    proc.on("error", (error) => {
      finish({ ok: false, message: engineProbeMessage(error.message) });
    });
    proc.on("exit", (code, signal) => {
      const ok = engine.probeContains.every((item) => output.includes(item));
      const detail = summarizeProbeOutput(output) || `exit ${code ?? signal ?? "unknown"}`;
      finish({ ok, message: ok ? "ok" : engineProbeMessage(`unexpected ${engine.command} help output: ${detail}`) });
    });
  });
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`Engine download timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function engineDownloadTimeoutMs(options = {}, hooks = {}) {
  return Number(options.engineDownloadTimeoutMs || options.downloadTimeoutMs || hooks.timeoutMs || DEFAULT_ENGINE_DOWNLOAD_TIMEOUT_MS);
}

function engineDownloadTimeoutError(url, timeoutMs) {
  return new Error(`Engine download stalled after ${Math.round(timeoutMs / 1000)}s: ${url}`);
}

async function readRegistry(url, options) {
  if (!/^https?:\/\//i.test(url)) {
    return fs.promises.readFile(url.startsWith("file://") ? new URL(url) : path.resolve(url));
  }
  if (!/^https:\/\//i.test(url)) throw new Error("Remote engine registry requires HTTPS");
  const pin = url === DEFAULT_ENGINE_REGISTRY_URL
    ? DEFAULT_ENGINE_REGISTRY_SHA256
    : options.engineRegistrySha256 || process.env.OPENCODE_VOICE_ENGINE_REGISTRY_SHA256;
  if (!isSha256(pin)) throw new Error("Custom HTTPS engine registry requires engineRegistrySha256 or OPENCODE_VOICE_ENGINE_REGISTRY_SHA256");
  const response = await fetch(url, { signal: AbortSignal.timeout(Number(options.timeoutMs || 60000)) });
  if (!response.ok) throw new Error(`Engine registry failed: HTTP ${response.status}`);
  if (!response.body) throw new Error("Engine registry response is empty");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Engine registry exceeds 1 MiB");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (createHash("sha256").update(bytes).digest("hex") !== pin) throw new Error("Engine registry SHA256 mismatch");
  return bytes;
}

export function getEngineRegistryUrl(options = {}) {
  if (nativeAssets(options)) return assetInfo("getEngineRegistryUrl", {options});
  return options.engineRegistry || process.env.OPENCODE_VOICE_ENGINE_REGISTRY || DEFAULT_ENGINE_REGISTRY_URL;
}

export async function loadEngineRegistry(options = {}) {
  if (nativeAssets(options)) return assetRequest("loadEngineRegistry", {options});
  const url = getEngineRegistryUrl(options);
  const registry = JSON.parse((await readRegistry(url, options)).toString("utf8"));
  if (registry?.schema !== "opencode-voice.engines.v1") throw new Error("Unsupported engine registry schema");
  return { url, registry };
}

function engineDefinition(registry, engineId) {
  if (Array.isArray(registry.engines)) return registry.engines.find((engine) => engine.id === engineId);
  return registry.engines?.[engineId];
}

function selectEngineAsset(registry, engineId, platform, registryUrl) {
  const engine = engineDefinition(registry, engineId);
  if (!engine) throw new Error(`Engine not found in registry: ${engineId}`);
  const asset = engine.assets?.[platform];
  if (!asset) throw new Error(`No managed ${engineId} engine asset for ${platform}`);
  if (asset.kind !== "single-binary-gzip") throw new Error(`Unsupported engine asset kind: ${asset.kind}`);
  if (!isSha256(asset.sha256) || !isSha256(asset.binary?.sha256)) {
    throw new Error("Engine registry must provide archive and binary SHA256 digests");
  }
  if (typeof asset.url !== "string" || !asset.url) throw new Error("Missing engine asset URL");
  if (/^https:\/\//i.test(registryUrl) && !asset.url.startsWith("https://")) {
    throw new Error("Remote engine registry requires HTTPS assets");
  }
  return { engine, asset };
}

async function downloadAsset(asset, compressedFile, hooks = {}, attempt = 1, attempts = 1, options = {}) {
  // Official registry sizes are exact. Bound older custom registries without a size too.
  const maxBytes = Number.isSafeInteger(asset.size) && asset.size > 0 ? asset.size : 256 * 1024 * 1024;
  if (asset.url.startsWith("file://") || !/^https?:\/\//.test(asset.url)) {
    const source = asset.url.startsWith("file://") ? new URL(asset.url) : path.resolve(asset.url);
    const stat = await fs.promises.stat(source);
    let downloaded = 0;
    hooks.onProgress?.({ state: "downloading", downloaded, total: stat.size, percent: 0, attempt, attempts });
    const progress = new Transform({
      transform(chunk, _encoding, callback) {
        downloaded += chunk.length ?? chunk.byteLength ?? 0;
        if (downloaded > maxBytes) return callback(new Error("Engine archive exceeds size limit"));
        hooks.onProgress?.({ state: "downloading", downloaded, total: stat.size, percent: stat.size ? (downloaded / stat.size) * 100 : 0, attempt, attempts });
        callback(null, chunk);
      },
    });
    await pipeline(fs.createReadStream(source), progress, fs.createWriteStream(compressedFile));
    return;
  }

  const timeoutMs = engineDownloadTimeoutMs(options, hooks);
  const response = await fetchWithTimeout(asset.url, {}, timeoutMs);
  if (!response.ok) throw new Error(`Engine download failed: HTTP ${response.status}`);

  const contentLength = Number(response.headers.get("content-length") || asset.size || 0);
  let downloaded = 0;
  hooks.onProgress?.({ state: "downloading", downloaded, total: contentLength, percent: 0, attempt, attempts });

  const body = response.body?.getReader ? Readable.fromWeb(response.body) : response.body;
  if (!body) throw new Error("Engine download failed: empty response body");

  const controller = new AbortController();
  let stallTimer;
  const resetStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), timeoutMs);
  };

  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      resetStallTimer();
      downloaded += chunk.length ?? chunk.byteLength ?? 0;
      if (downloaded > maxBytes) return callback(new Error("Engine archive exceeds size limit"));
      hooks.onProgress?.({ state: "downloading", downloaded, total: contentLength, percent: contentLength ? (downloaded / contentLength) * 100 : 0, attempt, attempts });
      callback(null, chunk);
    },
  });

  resetStallTimer();
  try {
    await pipeline(body, progress, fs.createWriteStream(compressedFile), { signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw engineDownloadTimeoutError(asset.url, timeoutMs);
    throw error;
  } finally {
    clearTimeout(stallTimer);
  }
}

async function publishEngine(engineId, stagedBinary, managedBinary, source, options = {}) {
  const engine = getEngine(engineId);
  const hash = await sha256(stagedBinary);
  const stat = await fs.promises.stat(stagedBinary);
  const manifest = {
    schema: "opencode-voice.engine-install.v1",
    id: engineId,
    kind: "cli",
    command: engine.command,
    platform: getEnginePlatformKey(options),
    version: source.version || "local-import",
    source,
    files: [{ path: path.basename(managedBinary), sha256: hash, size: stat.size }],
    installedAt: new Date().toISOString(),
  };

  const stagedManifest = path.join(path.dirname(stagedBinary), "manifest.json");
  await fs.promises.writeFile(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  const dir = path.dirname(managedBinary);
  const lock = path.join(dir, ".publish-lock");
  try {
    await fs.promises.mkdir(lock);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another engine installation owns ${lock}. If it was interrupted, remove the stale lock and retry.`);
    throw error;
  }
  try {
    await replaceFile(stagedBinary, managedBinary);
    await replaceFile(stagedManifest, path.join(dir, "manifest.json"));
  } finally {
    await fs.promises.rmdir(lock);
  }
  return manifest;
}

export async function installManagedEngine(engineId = "whisper.cpp", options = {}, settings = {}, hooks = {}) {
  if (nativeAssets(options)) return assetRequest("installManagedEngine", {engineId, options: {engineDownloadRetries: hooks.retries, ...options}, settings, force: hooks.force}, hooks);
  getEngine(engineId);

  const commandOptions = withDownloadDir(options, settings);
  const managedDir = getManagedEngineDir(engineId, commandOptions);
  const managedBinary = getManagedEngineBinary(engineId, commandOptions);
  if (!hooks.force && fs.existsSync(managedBinary)) {
    const probe = await probeEngine(engineId, managedBinary);
    if (probe.ok) return { manifest: readEngineManifest(engineId, commandOptions), managedBinary, skipped: true };
  }

  hooks.onProgress?.({ state: "registry", downloaded: 0, total: 0, percent: 0, attempt: 1, attempts: 1 });
  const { url: registryUrl, registry } = await loadEngineRegistry(commandOptions);
  const platform = getEnginePlatformKey(commandOptions);
  const { engine, asset } = selectEngineAsset(registry, engineId, platform, registryUrl);

  await ensureDir(managedDir);
  const attempts = Number(commandOptions.engineDownloadRetries || hooks.retries || DEFAULT_ENGINE_DOWNLOAD_RETRIES);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Concurrent installations must not share the bytes being verified and probed.
    const stage = await fs.promises.mkdtemp(path.join(managedDir, ".install-"));
    const compressedFile = path.join(stage, "archive.gz");
    const tmpBinary = path.join(stage, path.basename(managedBinary));
    try {
      await downloadAsset(asset, compressedFile, hooks, attempt, attempts, commandOptions);

      hooks.onProgress?.({ state: "verifying", downloaded: asset.size || 0, total: asset.size || 0, percent: 100, attempt, attempts });
      if ((await sha256(compressedFile)) !== asset.sha256) throw new Error("Engine archive SHA256 mismatch");

      hooks.onProgress?.({ state: "decompressing", downloaded: asset.size || 0, total: asset.size || 0, percent: 100, attempt, attempts });
      await pipeline(fs.createReadStream(compressedFile), createGunzip(), fs.createWriteStream(tmpBinary));

      hooks.onProgress?.({ state: "verifying-binary", downloaded: asset.binary?.size || 0, total: asset.binary?.size || 0, percent: 100, attempt, attempts });
      if ((await sha256(tmpBinary)) !== asset.binary.sha256) throw new Error("Engine binary SHA256 mismatch");
      await fs.promises.chmod(tmpBinary, 0o755);

      hooks.onProgress?.({ state: "probing", downloaded: asset.binary?.size || 0, total: asset.binary?.size || 0, percent: 100, attempt, attempts });
      const probe = await probeEngine(engineId, tmpBinary);
      if (!probe.ok) throw new Error(`Engine probe failed: ${probe.message}`);

      const manifest = await publishEngine(
        engineId,
        tmpBinary,
        managedBinary,
        {
          type: "registry",
          registry: registryUrl,
          url: asset.url,
          version: engine.version || registry.version || "registry",
          upstream: engine.upstream,
        },
        commandOptions,
      );
      hooks.onProgress?.({ state: "done", downloaded: asset.binary?.size || asset.size || 0, total: asset.binary?.size || asset.size || 0, percent: 100, attempt, attempts });
      return { manifest, managedBinary, skipped: false };
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      hooks.onRetry?.({ error, attempt, attempts, nextAttempt: attempt + 1 });
      await sleep(Math.min(1000 * attempt, 3000));
    } finally {
      await fs.promises.rm(stage, { recursive: true, force: true });
    }
  }

  throw lastError;
}

export async function importManagedEngine(engineId = "whisper.cpp", sourcePath, options = {}, settings = {}) {
  if (nativeAssets(options)) return assetRequest("importManagedEngine", {engineId, sourcePath, options, settings});
  const engine = getEngine(engineId);
  if (!sourcePath) throw new Error(`Pass an ${engine.command} path to import`);

  const source = path.resolve(sourcePath.replace(/^~(?=$|\/)/, os.homedir()));
  const stat = await fs.promises.stat(source).catch(() => null);
  if (!stat?.isFile()) throw new Error(`Engine binary not found: ${source}`);

  const commandOptions = withDownloadDir(options, settings);
  const managedDir = getManagedEngineDir(engineId, commandOptions);
  const managedBinary = getManagedEngineBinary(engineId, commandOptions);
  await ensureDir(managedDir);
  const stage = await fs.promises.mkdtemp(path.join(managedDir, ".install-"));
  const tmp = path.join(stage, path.basename(managedBinary));
  try {
    await fs.promises.copyFile(source, tmp);
    await fs.promises.chmod(tmp, 0o755);
    const probe = await probeEngine(engineId, tmp);
    if (!probe.ok) throw new Error(`Imported binary failed probe: ${probe.message}`);
    const manifest = await publishEngine(engineId, tmp, managedBinary, { type: "local-file", path: source }, commandOptions);
    return { manifest, managedBinary };
  } finally {
    await fs.promises.rm(stage, { recursive: true, force: true });
  }
}

export async function removeManagedEngine(engineId = "whisper.cpp", options = {}, settings = {}) {
  if (nativeAssets(options)) return assetRequest("removeManagedEngine", {engineId, options, settings});
  getEngine(engineId);
  const dir = getManagedEngineDir(engineId, options, settings);
  await fs.promises.rm(dir, { recursive: true, force: true });
  return dir;
}
import { assetInfo, assetRequest, nativeAssets } from "./rust-assets.js";
