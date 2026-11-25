import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { rustBinding, useRust } from "./rust-binding.js";

const core = fileURLToPath(new URL("../native/target/release/rage-core", import.meta.url));
const defaultFetch = globalThis.fetch;
export const nativeAssets = (options = {}) =>
  useRust() && (options.platform || process.platform) === "darwin";

export function assetInfo(op, args) {
  return JSON.parse(rustBinding().assetInfo(op, JSON.stringify(args)));
}

// Embedders can supply fetch. Route its byte stream through the same native verifier as curl.
async function fetchSocket(fetch) {
  const dir = await mkdtemp(join(tmpdir(), "rage-fetch-"));
  const socket = join(dir, "http");
  const server = createServer(async (req, res) => {
    const url = req.headers["x-rage-url"];
    if (req.method !== "GET" || req.url !== "/transfer" || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      res.writeHead(400).end();
      return;
    }
    const stop = new AbortController();
    res.on("close", () => stop.abort());
    try {
      const headers = req.headers.range ? { Range: req.headers.range } : undefined;
      const response = await fetch(url, { headers, signal: stop.signal });
      res.statusCode = response.status;
      for (const key of ["content-length", "content-range"]) {
        const value = response.headers.get(key);
        if (value !== null) res.setHeader(key, value);
      }
      res.setHeader("connection", "close");
      if (response.body) await pipeline(Readable.fromWeb(response.body), res);
      else res.end();
    } catch {
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    }
  });
  const close = async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  };
  try {
    server.listen(socket);
    await once(server, "listening");
    return { socket, close };
  } catch (err) {
    await close();
    throw err;
  }
}

export async function assetRequest(op, args, hooks = {}) {
  const fetch = hooks.fetch ?? globalThis.fetch;
  const bridge = fetch !== defaultFetch ? await fetchSocket(fetch) : undefined;
  try {
    return await request(op, args, hooks, bridge?.socket);
  } finally {
    await bridge?.close();
  }
}

async function request(op, args, hooks, socket) {
  const body = JSON.stringify({ ...args, stream: Boolean(hooks.onProgress || hooks.onRetry) });
  const env = { ...process.env };
  delete env.RAGE_HOST_FETCH_SOCKET;
  if (socket) env.RAGE_HOST_FETCH_SOCKET = socket;
  const child = spawn(core, ["asset", op], { stdio: ["pipe", "pipe", "pipe"], env });
  const closed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  closed.catch(() => {});
  let error = "", received = false, result;
  child.stderr.on("data", chunk => { error = (error + chunk).slice(-8192); });
  child.stdin.on("error", () => {}); // A startup failure is reported on close.
  child.stdin.end(body);
  try {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      const event = JSON.parse(line);
      if (event.progress) hooks.onProgress?.(event.progress);
      if (event.retry) hooks.onRetry?.({ ...event.retry, error: new Error(event.retry.error) });
      if (Object.hasOwn(event, "result")) {
        received = true;
        result = event.result;
      }
    }
    if ((await closed) !== 0 || !received) throw new Error(error.trim() || `No result for ${op}`);
    return result;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
}
