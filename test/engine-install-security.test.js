import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import {
  DEFAULT_ENGINE_REGISTRY_URL,
  getEnginePlatformKey,
  getManagedEngineBinary,
  importManagedEngine,
  installManagedEngine,
  loadEngineRegistry,
} from "../lib/engines.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const schema = "opencode-voice.engines.v1";
const custom = "https://registry.example/registry.json";

test("Rage's pinned release mirrors every original engine and platform", async (t) => {
  const directory = new URL("../assets/engines-v1/", import.meta.url);
  const source = await fs.readFile(new URL("upstream-registry.json", directory));
  assert.equal(hash(source), "4cd542a78b0ad73df5e6befc26eff0539e42b33e48b3b7d0462119f45979da3b");
  const expected = JSON.parse(source);
  const release = "https://github.com/bignstrong/opencode-rage/releases/download/engines-v1/";
  assert.equal(DEFAULT_ENGINE_REGISTRY_URL, `${release}registry.json`);
  for (const engine of Object.values(expected.engines)) {
    for (const asset of Object.values(engine.assets)) {
      asset.url = release + path.posix.basename(new URL(asset.url).pathname);
    }
  }
  const bytes = await fs.readFile(new URL("registry.json", directory));
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, DEFAULT_ENGINE_REGISTRY_URL);
    return new Response(bytes);
  });
  assert.deepEqual((await loadEngineRegistry()).registry, expected);
});

test(
  "concurrent imports keep the published binary and its provenance together",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-import-test-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const options = { downloadDir: root };
    const id = "whisper.cpp";
    const sources = ["A", "B"].map((name) => path.join(root, name));
    for (const source of sources) {
      await fs.writeFile(
        source,
        `#!/bin/sh\n# ${path.basename(source)}\nprintf '%s\\n' '--model --file'\n`,
      );
    }
    const results = await Promise.allSettled(
      sources.map((source) => importManagedEngine(id, source, options)),
    );
    assert.ok(results.some((r) => r.status === "fulfilled"));
    for (const result of results) {
      if (result.status === "rejected")
        assert.match(result.reason.message, /Another engine installation/);
    }
    const file = getManagedEngineBinary(id, options);
    const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(file), "manifest.json")));
    const bytes = await fs.readFile(file);
    assert.deepEqual(bytes, await fs.readFile(manifest.source.path));
    assert.equal(hash(bytes), manifest.files[0].sha256);
  },
);

test("remote registry pins authenticate exact bytes before JSON parsing", async (t) => {
  const body = JSON.stringify({ schema, engines: {} });
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(body));
  const pin = hash(body);
  await assert.rejects(
    loadEngineRegistry({ engineRegistry: DEFAULT_ENGINE_REGISTRY_URL, engineRegistrySha256: pin }),
    /registry SHA256 mismatch/,
  );
  await assert.rejects(
    loadEngineRegistry({ engineRegistry: custom, engineRegistrySha256: "invalid" }),
    /requires engineRegistrySha256/,
  );
  await assert.rejects(
    loadEngineRegistry({
      engineRegistry: custom.replace("https:", "http:"),
      engineRegistrySha256: pin,
    }),
    /requires HTTPS/,
  );
  assert.equal(fetch.mock.callCount(), 1);
  const options = { engineRegistry: custom, engineRegistrySha256: pin };
  assert.equal((await loadEngineRegistry(options)).registry.schema, schema);
  fetch.mock.mockImplementation(async () => new Response("invalid JSON"));
  await assert.rejects(loadEngineRegistry(options), /registry SHA256 mismatch/);
});

test("registry install verifies both digests before probing or replacing a binary", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-engine-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = {
    engineRegistry: pathToFileURL(path.join(root, "registry.json")).href,
    downloadDir: root,
    engineDownloadRetries: 1,
  };
  const binary = Buffer.from("#!/bin/sh\nprintf '%s\\n' '--model --file'\n");
  const compressed = gzipSync(binary);
  const archive = path.join(root, "fixture.gz");
  await fs.writeFile(archive, compressed);
  const asset = {
    kind: "single-binary-gzip",
    url: pathToFileURL(archive).href,
    sha256: hash(compressed),
    binary: { sha256: hash(binary) },
  };
  const id = "whisper.cpp";
  const makeRegistry = (value) =>
    JSON.stringify({ schema, engines: { [id]: { assets: { [getEnginePlatformKey()]: value } } } });
  const file = getManagedEngineBinary(id, options);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "previous install");
  for (const [value, error] of [
    [{ ...asset, sha256: undefined }, /must provide/],
    [{ ...asset, size: compressed.length - 1 }, /exceeds size limit/],
    [{ ...asset, binary: { sha256: "invalid" } }, /must provide/],
    [{ ...asset, sha256: hash("different") }, /archive SHA256 mismatch/],
    [{ ...asset, binary: { sha256: hash("different") } }, /binary SHA256 mismatch/],
  ]) {
    await fs.writeFile(new URL(options.engineRegistry), makeRegistry(value));
    const states = [];
    await assert.rejects(
      installManagedEngine(
        id,
        options,
        {},
        {
          force: true,
          onProgress: ({ state }) => states.push(state),
        },
      ),
      error,
    );
    assert.ok(!states.includes("probing"));
    assert.deepEqual(await fs.readdir(path.dirname(file)), [path.basename(file)]);
    assert.equal(await fs.readFile(file, "utf8"), "previous install");
  }
  const body = makeRegistry(asset);
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(body));
  await assert.rejects(
    installManagedEngine(
      id,
      { ...options, engineRegistry: custom, engineRegistrySha256: hash(body) },
      {},
      { force: true },
    ),
    /requires HTTPS assets/,
  );
  assert.equal(fetch.mock.callCount(), 1);
  if (process.platform !== "win32") {
    await fs.writeFile(new URL(options.engineRegistry), body);
    const installed = await installManagedEngine(id, options, {}, { force: true });
    assert.equal(installed.manifest.files[0].sha256, hash(binary));
    assert.deepEqual(await fs.readFile(file), binary);
  }
});
