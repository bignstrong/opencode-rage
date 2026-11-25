import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { downloadModel } from "../lib/download.js";
import { getModelPath, isModelDownloaded } from "../lib/models.js";

const weights = Buffer.from("synthetic voice model");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-model-safe-"));
  t.after(() => fs.rm(downloadDir, { recursive: true, force: true }));
  const options = { downloadDir, downloadRetries: 1 };
  const model = {
    implemented: true,
    name: "test",
    filename: "fixture.bin",
    url: "https://models.example/fixture",
    sha256: hash(weights),
    sizeMB: 1,
  };
  const file = getModelPath(model, options);
  const dir = path.dirname(file);
  await fs.mkdir(dir);
  return { model, options, file, dir, run: (hooks) => downloadModel(model, options, {}, hooks) };
}

test("overlapping downloads cannot modify a verified file through an open partial", async (t) => {
  const { run, file, dir, model, options } = await fixture(t);
  let writer;
  const progress = Promise.withResolvers();
  t.mock.method(globalThis, "fetch", async () =>
    writer
      ? new Response(weights)
      : new Response(
          new ReadableStream({
            start(controller) {
              writer = controller;
              controller.enqueue(Buffer.from("partial "));
            },
          }),
        ),
  );
  const interrupted = run({
    onProgress: ({ state, downloaded }) => {
      if (state === "downloading" && downloaded > 0) progress.resolve();
    },
  });
  try {
    await progress.promise;
    assert.equal(await run(), file);
    assert.deepEqual(await fs.readFile(file), weights);
  } finally {
    writer.enqueue(Buffer.from("fixture"));
    writer.close();
    await assert.rejects(interrupted, /SHA256 mismatch/);
  }
  assert.deepEqual(await fs.readFile(file), weights);
  assert.equal(isModelDownloaded(model, options), true);
  assert.deepEqual((await fs.readdir(dir)).sort(), ["fixture.bin", "fixture.bin.sha256"]);
});

test("a short response leaves a resumable checkpoint for the next call", async (t) => {
  const { run, file } = await fixture(t);
  const split = 7;
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    return new Response(weights.subarray(0, split), {
      headers: { "content-length": String(weights.length) },
    });
  });
  await assert.rejects(run(), /Download incomplete/);
  assert.deepEqual(await fs.readFile(`${file}.partial`), weights.subarray(0, split));
  fetch.mock.mockImplementation(async (_url, { headers }) => {
    assert.equal(headers.Range, `bytes=${split}-`);
    return new Response(weights.subarray(split), {
      status: 206,
      headers: { "content-range": `bytes ${split}-${weights.length - 1}/${weights.length}` },
    });
  });
  await run();
  assert.deepEqual(await fs.readFile(file), weights);
  await assert.rejects(fs.stat(`${file}.partial`), { code: "ENOENT" });
});

test("size limit covers response headers, unannounced bytes and oversized old checkpoints", async (t) => {
  const { run, file } = await fixture(t);
  const tooLarge = 3 * 1024 * 1024;
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    return new Response(weights, { headers: { "content-length": String(tooLarge) } });
  });
  await assert.rejects(run(), /exceeds size limit/);
  fetch.mock.mockImplementation(async () => new Response(Buffer.alloc(tooLarge)));
  await assert.rejects(run(), /exceeds size limit/);
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
  await assert.rejects(fs.stat(`${file}.partial`), { code: "ENOENT" });

  const seedSize = 1024 * 1024;
  await fs.writeFile(`${file}.partial`, "");
  await fs.truncate(`${file}.partial`, seedSize);
  fetch.mock.mockImplementation(async (_url, { headers }) => {
    assert.equal(headers.Range, `bytes=${seedSize}-`);
    return new Response(Buffer.alloc(2 * seedSize), {
      status: 206,
      headers: { "content-range": `bytes ${seedSize}-${tooLarge - 1}/*` },
    });
  });
  await assert.rejects(run(), /exceeds size limit/);
  await assert.rejects(fs.stat(`${file}.partial`), { code: "ENOENT" });

  await fs.writeFile(`${file}.partial`, "");
  await fs.truncate(`${file}.partial`, tooLarge);
  fetch.mock.mockImplementation(async (_url, { headers }) => {
    assert.equal(headers, undefined);
    return new Response(weights);
  });
  await run();
  assert.deepEqual(await fs.readFile(file), weights);
});

test("legacy markers reverify locally once; replacing a same-size file invalidates its receipt", async (t) => {
  const { model, options, file, run } = await fixture(t);
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("unexpected fetch"));
  await fs.writeFile(file, weights);
  await fs.writeFile(`${file}.sha256`, `${model.sha256}\n`);
  assert.equal(isModelDownloaded(model, options), false);
  await run();
  assert.equal(isModelDownloaded(model, options), true);
  assert.equal(fetch.mock.callCount(), 0);
  const other = `${file}.replacement`;
  await fs.writeFile(other, Buffer.alloc(weights.length));
  await fs.rename(other, file);
  assert.equal(isModelDownloaded(model, options), false);
});
