// Compare the public API on one synthetic file, with the same installed model and engine.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [fixture, model = "whisper-turbo", language = "ru"] = process.argv.slice(2);
if (!fixture) throw Error("Usage: node rust/qa/compare-inference.mjs SYNTHETIC.wav [MODEL_ID] [LANGUAGE]");

if (process.env.RAGE_TIMING_CHILD === "1") {
  const { VoiceRuntime } = await import("../../lib/runtime.js");
  const { getModel } = await import("../../lib/models.js");
  const rt = new VoiceRuntime();
  const start = performance.now();
  const transcript = await rt.transcribe(fixture, getModel(model), {
    language, voiceEnhance: process.env.RAGE_QA_CLEANUP === "1",
  });
  process.stdout.write(JSON.stringify({ ms: Math.round(performance.now() - start), transcript }));
} else {
  const dir = await mkdtemp(join(tmpdir(), "rage-timing-"));
  try {
    const timings = { reference: [], rust: [] };
    let expected;
    // Alternate which backend gets the first invocation of each pair.
    for (const key of ["reference", "rust", "rust", "reference", "reference", "rust", "rust", "reference"]) {
      const path = join(dir, "synthetic.wav");
      await copyFile(fixture, path);
      const p = spawnSync(process.execPath, [fileURLToPath(import.meta.url), path, model, language], {
        env: { ...process.env, RAGE_TIMING_CHILD: "1", RAGE_RUST: key === "rust" ? "1" : "0" },
        encoding: "utf8", timeout: 150_000,
      });
      if (p.error || p.status !== 0) throw p.error || Error(p.stderr);
      const { transcript, ms } = JSON.parse(p.stdout);
      assert.ok(transcript.trim());
      expected ??= transcript;
      assert.equal(transcript, expected);
      timings[key].push(ms);
    }
    console.log(JSON.stringify({ model, language, timings, transcriptsMatched: 8 }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
