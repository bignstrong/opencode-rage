#!/usr/bin/env node
// macOS, Node 24+: ./rust/qa/cold-assets.mjs /path/to/trusted-package.tgz
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

async function exercise() {
  const load = file => import(pathToFileURL(resolve("package", file)));
  const { ensureDownloaded, ensureEngineReady } = await load("src/ensure.ts");
  const { getModelPath, isModelDownloaded } = await load("lib/models.js");
  const { getEngineStatus } = await load("lib/engines.js");
  const { rustBinding } = await load("lib/rust-binding.js");
  assert.equal(typeof rustBinding().readiness, "function"); // Default path; no injected installer or fetch.

  // These expected bytes are defined before the server starts, never derived from a response.
  const weights = Buffer.from("Rage QA model v1\n");
  const binary = Buffer.from('#!/bin/sh\n[ "$1" = --help ] || exit 1\necho "--model --file"\n');
  const archive = gzipSync(binary);
  const expected = { "/model": weights, "/engine.gz": archive };
  const hits = { "/model": 0, "/engine.gz": 0 };
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    if (req.method !== "GET" || !Object.hasOwn(expected, req.url)) return res.writeHead(404).end();
    const bytes = Buffer.from(expected[req.url]);
    if (++hits[req.url] <= 2) bytes[0] ^= 1; // Terminal failure, then first half of automatic retry.
    res.writeHead(200, { "Content-Length": bytes.length }).end(bytes);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const engine = "transcribe-cpp";
    const model = { id: "qa", name: "QA", engine, implemented: true, filename: "qa.bin",
      url: `${url}/model`, sha256: hash(weights), sizeMB: 1 };
    const registry = resolve("registry.json");
    const asset = { kind: "single-binary-gzip", url: `${url}/engine.gz`, size: archive.length,
      sha256: hash(archive), binary: { size: binary.length, sha256: hash(binary) } };
    writeFileSync(registry, JSON.stringify({ schema: "opencode-voice.engines.v1",
      engines: { [engine]: { assets: { [`darwin-${process.arch}`]: asset } } } }));
    const downloadDir = resolve("cache");
    assert.ok(!existsSync(downloadDir));
    const options = { engineRegistry: pathToFileURL(registry).href, downloadDir,
      downloadRetries: 1, engineDownloadRetries: 1 };
    const states = [], notices = [];
    const env = { options, settings: { downloadDir, uiLanguage: "en" },
      downloadStatus: (id, status) => { assert.equal(id, model.id); states.push(status); },
      toast: (...args) => notices.push(args) };
    const status = () => getEngineStatus(engine, options);
    const file = getModelPath(model, options);
    const snapshot = () => [states.length, notices.length, requests];

    assert.equal(status().source, "missing", "a system engine would bypass cold acquisition");
    await assert.rejects(ensureDownloaded(env, model), /SHA256 mismatch/);
    assert.equal(states.at(-1).phase, "failed");
    assert.ok(!existsSync(file) && !existsSync(`${file}.sha256`));
    await assert.rejects(ensureEngineReady(env, model), /archive SHA256 mismatch/);
    assert.equal(status().managedInstalled, false);
    assert.equal(status().manifest, null);
    assert.deepEqual(hits, { "/model": 1, "/engine.gz": 1 });

    options.downloadRetries = options.engineDownloadRetries = 2;
    states.length = notices.length = 0;
    assert.equal(await ensureDownloaded(env, model), true);
    assert.ok(states.some(s => s.hint.includes("retrying download") && s.detail.includes("2/2")));
    assert.ok(states.some(s => s.phase === "verifying"));
    assert.equal(states.at(-1).phase, "ready");
    assert.deepEqual(readFileSync(file), weights);
    assert.equal(isModelDownloaded(model, options), true);
    assert.equal(await ensureEngineReady(env, model), true);
    assert.ok(notices.some(([s]) => /Engine install retry 2\/2:.*archive SHA256 mismatch/.test(s)));
    const installed = status();
    assert.equal(installed.source, "managed");
    assert.deepEqual(readFileSync(installed.resolvedBinary), binary);
    assert.equal(installed.manifest.files[0].sha256, hash(binary));
    assert.deepEqual(hits, { "/model": 3, "/engine.gz": 3 });
    assert.equal(requests, 6);

    // Even the registry is unavailable now. Readiness must reuse the receipt and probe the installed binary.
    rmSync(registry);
    const before = snapshot();
    assert.equal(await ensureDownloaded(env, model), true);
    assert.equal(await ensureEngineReady(env, model), true);
    assert.deepEqual(snapshot(), before);
    console.log("PASS: model and engine each rejected bad bytes, retried 2/2, installed expected bytes; warm reuse: 0 GETs.");
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

assert.equal(process.platform, "darwin");
if (process.argv[2] === "--child") {
  assert.equal(process.env.HOME, resolve("home"), "use the tarball argument to create private test state");
  assert.equal(process.env.TMPDIR, resolve("tmp"));
  await exercise();
} else {
  assert.equal(process.argv.length, 3, "pass the trusted npm tarball to test");
  const archive = resolve(process.argv[2]);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rage-cold-")));
  try {
    const home = join(root, "home"), tmp = join(root, "tmp");
    mkdirSync(home); mkdirSync(tmp);
    const env = { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: tmp };
    for (const key of ["CONFIG", "DATA", "STATE", "CACHE"]) env[`XDG_${key}_HOME`] = join(home, key);
    console.log(`tarball SHA256 ${hash(readFileSync(archive))}`);
    execFileSync("/usr/bin/tar", ["-xzf", archive], { cwd: root, env });
    const profile = `(version 1)(allow default)(deny device-microphone)
      (deny network-outbound (remote ip "*:*"))(allow network-outbound (remote ip "localhost:*"))
      (deny network-bind (local ip "*:*"))(allow network-bind (local ip "localhost:*"))`;
    execFileSync("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, import.meta.filename, "--child"],
      { cwd: root, env, stdio: "inherit", timeout: 60000 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
