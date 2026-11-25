import fs from "node:fs";
import { assetRequest, nativeAssets } from "./rust-assets.js";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getModelPath, getModelsDir, getModelVerificationPath, modelVerificationStamp } from "./models.js";

const DEFAULT_DOWNLOAD_RETRIES = 5;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

export async function sha256(file) {
  if (nativeAssets()) return assetRequest("sha256", {file});
  return digestStream(fs.createReadStream(file));
}

async function digestStream(input) {
  const hash = createHash("sha256");
  for await (const chunk of input) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyModel(model, file) {
  if (nativeAssets()) return assetRequest("verifyModel", {model, file});
  if (!model.sha256) return true;
  const actual = await sha256(file);
  return actual === model.sha256;
}

export async function writeModelVerificationMarker(model, file, options = {}, settings = {}, stat) {
  if (!model.sha256) return;
  const marker = getModelVerificationPath(model, options, settings);
  const tmp = `${marker}.${randomUUID()}.tmp`;
  try {
    const stamp = modelVerificationStamp(model.sha256, stat || await fs.promises.stat(file, { bigint: true }));
    await fs.promises.writeFile(tmp, `${stamp}\n`, { flag: "wx", mode: 0o600 });
    await replaceFile(tmp, marker);
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  let timer;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), timeoutMs);
  };
  const clear = () => clearTimeout(timer);
  reset();

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { response, signal: controller.signal, reset, clear, abort: () => controller.abort() };
  } catch (error) {
    clear();
    if (error?.name === "AbortError") throw new Error(`Download timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw error;
  }
}

function downloadError(error, url, timeoutMs) {
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR") {
    return new Error(`Download timed out or stalled from ${url} after ${Math.round(timeoutMs / 1000)}s`);
  }
  return error;
}

function modelUrls(model) {
  return [...new Set([...(Array.isArray(model.urls) ? model.urls : []), model.url].filter(Boolean))];
}

function contentRangeStart(value) {
  const match = /^bytes\s+(\d+)-/i.exec(value || "");
  return match ? Number(match[1]) : null;
}

export async function replaceFile(source, destination) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await fs.promises.rename(source, destination);
      return;
    } catch (error) {
      if (attempt >= 5 || !["EBUSY", "EPERM", "EACCES"].includes(error?.code)) throw error;
      await sleep(100 * attempt);
    }
  }
}

async function verifyAndPublish(model, source, file, maxBytes, options, settings) {
  const handle = await fs.promises.open(source, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !before.size || before.size > maxBytes) return false;
    const input = handle.createReadStream({ autoClose: false, end: Number(before.size) - 1 });
    if (await digestStream(input) !== model.sha256) return false;
    const verified = await handle.stat({ bigint: true });
    if (modelVerificationStamp(model.sha256, before) !== modelVerificationStamp(model.sha256, verified)) return false;
    if (source !== file) await replaceFile(source, file);
    // Rename changes ctime. Read the receipt from the verified inode, not a racing destination path.
    await writeModelVerificationMarker(model, file, options, settings, source === file ? verified : await handle.stat({ bigint: true }));
    return true;
  } finally {
    await handle.close();
  }
}

async function downloadModelOnce(model, sourceUrl, partial, maxBytes, options, settings, hooks, attempt, attempts) {
  const file = getModelPath(model, options, settings);
  const partialSize = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
  const headers = partialSize > 0 ? { Range: `bytes=${partialSize}-` } : undefined;
  const timeoutMs = Number(options.downloadTimeoutMs || hooks.timeoutMs || DEFAULT_DOWNLOAD_TIMEOUT_MS);
  const request = await fetchWithTimeout(sourceUrl, { headers }, timeoutMs);
  const response = request.response;

  try {
    if (response.status === 416 && partialSize > 0) {
      await fs.promises.unlink(partial);
      return downloadModelOnce(model, sourceUrl, partial, maxBytes, options, settings, hooks, attempt, attempts);
    }

    if (!response.ok && response.status !== 206) {
      throw new Error(`Download failed from ${sourceUrl}: HTTP ${response.status}`);
    }

    const append = response.status === 206 && partialSize > 0;
    const rangeStart = append ? contentRangeStart(response.headers.get("content-range")) : null;
    if (append && rangeStart !== partialSize) {
      await fs.promises.unlink(partial).catch(() => {});
      throw new Error(`Download resume mismatch from ${sourceUrl}: expected byte ${partialSize}, got ${rangeStart}`);
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    const rangeTotal = Number(/\/(\d+)$/.exec(response.headers.get("content-range") || "")?.[1] || 0);
    const total = rangeTotal || (contentLength > 0 ? contentLength + (append ? partialSize : 0) : 0);
    let downloaded = append ? partialSize : 0;
    const limitError = new Error(`Model download exceeds size limit of ${maxBytes} bytes`);
    if (contentLength > maxBytes - downloaded || rangeTotal > maxBytes) throw limitError;

    hooks.onProgress?.({ state: "downloading", downloaded, total, percent: total ? (downloaded / total) * 100 : 0, attempt, attempts });

    const body = response.body?.getReader ? Readable.fromWeb(response.body) : response.body;
    if (!body) throw new Error("Download failed: empty response body");

    const progress = new Transform({
      transform(chunk, _encoding, callback) {
        request.reset();
        downloaded += chunk.length ?? chunk.byteLength ?? 0;
        if (downloaded > maxBytes) return callback(limitError);
        hooks.onProgress?.({ state: "downloading", downloaded, total, percent: total ? (downloaded / total) * 100 : 0, attempt, attempts });
        callback(null, chunk);
      },
    });

    try {
      await pipeline(body, progress, fs.createWriteStream(partial, { flags: append ? "a" : "w" }), { signal: request.signal });
    } catch (error) {
      if (error === limitError) await fs.promises.rm(partial, { force: true });
      throw downloadError(error, sourceUrl, timeoutMs);
    }
    request.clear();

    const actualSize = fs.statSync(partial).size;
    downloaded = actualSize;
    if (total > 0 && actualSize < total) {
      throw new Error(`Download incomplete from ${sourceUrl}: got ${actualSize} of ${total} bytes`);
    }

    hooks.onProgress?.({ state: "verifying", downloaded, total: total || downloaded, percent: 100, attempt, attempts });

    if (!(await verifyAndPublish(model, partial, file, maxBytes, options, settings))) {
      await fs.promises.unlink(partial).catch(() => {});
      throw new Error(`SHA256 mismatch for ${model.name}`);
    }

    hooks.onProgress?.({ state: "done", downloaded, total: total || downloaded, percent: 100, attempt, attempts });
    return file;
  } finally {
    request.clear();
    request.abort();
  }
}

export async function downloadModel(model, options = {}, settings = {}, hooks = {}) {
  if (nativeAssets(options)) return assetRequest("downloadModel", {model, options: {downloadRetries: hooks.retries, ...options}, settings}, hooks);
  if (!model?.implemented || !model.url || !model.filename) {
    throw new Error(`${model?.name || "Model"} is not supported by the current local engine yet`);
  }
  if (!/^[a-f0-9]{64}$/.test(model.sha256) || !(model.sizeMB > 0)) throw new Error("Model requires a SHA256 digest and size");
  // Catalog sizes are rounded and historically mix decimal and binary megabytes.
  const maxBytes = Math.ceil((model.sizeMB * 1.15 + 1) * 1024 * 1024);
  if (!Number.isSafeInteger(maxBytes)) throw new Error("Invalid model size");
  const urls = modelUrls(model);
  const attempts = Math.max(Number(options.downloadRetries || hooks.retries || DEFAULT_DOWNLOAD_RETRIES), urls.length || 1);
  const file = getModelPath(model, options, settings);
  const present = fs.statSync(file, { throwIfNoEntry: false });
  if (present?.isFile()) {
    hooks.onProgress?.({ state: "verifying", downloaded: present.size, total: present.size, percent: 100, attempt: 1, attempts });
    if (await verifyAndPublish(model, file, file, maxBytes, options, settings)) return file;
  }

  const dir = getModelsDir(options, settings);
  await ensureDir(dir);
  const stage = await fs.promises.mkdtemp(path.join(dir, ".model-"));
  const partial = path.join(stage, "partial");
  const checkpoint = `${file}.partial`;
  try {
    // Claim an idle checkpoint atomically, then copy so even a legacy open writer cannot touch our inode.
    const claimed = path.join(stage, "checkpoint");
    if (fs.lstatSync(checkpoint, { throwIfNoEntry: false })?.isFile()) {
      await fs.promises.rename(checkpoint, claimed).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      const seed = fs.lstatSync(claimed, { throwIfNoEntry: false });
      if (seed?.isFile() && seed.size > 0 && seed.size <= maxBytes) {
        await pipeline(fs.createReadStream(claimed, { end: seed.size - 1 }), fs.createWriteStream(partial, { flags: "wx" }));
        await fs.promises.unlink(claimed);
      }
    }
    for (let attempt = 1; ; attempt++) {
      try {
        return await downloadModelOnce(model, urls[(attempt - 1) % urls.length], partial, maxBytes, options, settings, hooks, attempt, attempts);
      } catch (error) {
        if (!(attempt < attempts)) throw error;
        hooks.onRetry?.({ error, attempt, attempts, nextAttempt: attempt + 1 });
        await sleep(Math.min(1000 * attempt, 3000));
      }
    }
  } catch (error) {
    // Only closed partials are parked here. Other sessions never append to this shared name.
    if (fs.statSync(partial, { throwIfNoEntry: false })?.size) await replaceFile(partial, checkpoint);
    throw error;
  } finally {
    await fs.promises.rm(stage, { recursive: true, force: true });
  }
}
