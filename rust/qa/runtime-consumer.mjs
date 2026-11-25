import assert from "node:assert/strict";
import { copyFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { VoiceRuntime } from "@bignstrong/rage/runtime";

const entry = fileURLToPath(import.meta.resolve("@bignstrong/rage/runtime"));
assert.equal(realpathSync(entry), join(process.cwd(), "node_modules/@bignstrong/rage/lib/runtime.js"));
assert.equal(VoiceRuntime.name, process.env.RAGE_RUST === "1" ? "NativeRuntime" : "VoiceRuntime");
const work = process.env.QA_WORK;
const caller = join(work, "caller");
const audio = join(caller, "audio with spaces.wav");
const readyPath = join(work, "ready.json");
const cache = join(work, "selected cache");
mkdirSync(join(cache, "models"), { recursive: true });
mkdirSync(caller);
writeFileSync(join(caller, "clean.wav"), "caller's unrelated sibling");
const options = { downloadDir: cache, ffmpeg: "/usr/bin/false" };
for (const [key, name] of [["whisperCli", "whisper"], ["transcribeCpp", "sidecar"]]) {
  const path = join(work, name + ".mjs");
  copyFileSync(new URL("./runtime-engine.mjs", import.meta.url), path);
  chmodSync(path, 0o700);
  options[key] = path;
}

// Valid mono s16le, 16 kHz, with an odd-sized padded chunk before data.
const pcm = Buffer.from([0, 0, 128, 0, 0, 1, 128, 0]);
const valid = Buffer.alloc(54 + pcm.length);
valid.write("RIFF"); valid.writeUInt32LE(valid.length - 8, 4); valid.write("WAVEfmt ", 8);
valid.writeUInt32LE(16, 16); valid.writeUInt16LE(1, 20); valid.writeUInt16LE(1, 22);
valid.writeUInt32LE(16_000, 24); valid.writeUInt32LE(32_000, 28); valid.writeUInt16LE(2, 32); valid.writeUInt16LE(16, 34);
valid.write("JUNK", 36); valid.writeUInt32LE(1, 40); valid[44] = 42;
valid.write("data", 46); valid.writeUInt32LE(pcm.length, 50); pcm.copy(valid, 54);
writeFileSync(join(work, "finalized.wav"), valid);

function prepare(engine, language, behavior, broken) {
  const original = Buffer.from(valid);
  for (const offset of broken) original.writeUInt32LE(0xffffffff, offset);
  writeFileSync(audio, original);
  const stat = statSync(audio, { bigint: true });
  const filename = engine === "transcribe-cpp" ? "fixture sidecar.gguf" : "fixture whisper.bin";
  const model = join(cache, "models", filename);
  writeFileSync(model, engine);
  rmSync(readyPath, { force: true });
  writeFileSync(join(work, "expect.json"), JSON.stringify({ engine, model, language, behavior }));
  return {
    model: { engine, filename, name: filename }, settings: { language, voiceEnhance: false },
    verify() {
      assert.deepEqual(readFileSync(audio), original);
      const after = statSync(audio, { bigint: true });
      assert.deepEqual([after.ino, after.mtimeNs], [stat.ino, stat.mtimeNs]);
      assert.deepEqual(readdirSync(caller).sort(), ["audio with spaces.wav", "clean.wav"]);
      assert.equal(readFileSync(join(caller, "clean.wav"), "utf8"), "caller's unrelated sibling");
      assert.deepEqual(readdirSync(join(work, "scratch")), []);
    },
  };
}

const output = "проверка пройдена";
for (const [engine, language, broken] of [
  ["whisper.cpp", "ru", [4, 50]], ["whisper.cpp", "auto", []],
  ["transcribe-cpp", "auto", [4]], ["transcribe-cpp", "de", [50]],
]) {
  test(`${engine}, ${language}, repair offsets [${broken}]`, async () => {
    const rt = new VoiceRuntime(options);
    const f = prepare(engine, language, "ok", broken);
    assert.equal(await rt.transcribe(audio, f.model, f.settings), output);
    assert.equal(rt.isTranscribing(), false);
    assert.ok(existsSync(readyPath));
    await rt.cleanupRecording(audio);
    f.verify();
  });
}

test("nonzero engine exit preserves caller files and releases the job", async () => {
  const rt = new VoiceRuntime(options);
  const f = prepare("transcribe-cpp", "ru", "fail", [4, 50]);
  await assert.rejects(rt.transcribe(audio, f.model, f.settings), /fixture inference failed/);
  assert.equal(rt.isTranscribing(), false);
  f.verify();
});

for (const reason of ["cancel", "timeout"]) {
  test(`${reason} an active engine, clean scratch, then reuse the runtime`, async () => {
    const rt = new VoiceRuntime({ ...options, transcriptionTimeoutMs: reason === "timeout" ? 1500 : 10_000 });
    const f = prepare("whisper.cpp", "auto", "stall", [4, 50]);
    const done = rt.transcribe(audio, f.model, f.settings).then(() => null, e => e);
    try {
      assert.ok(rt.isTranscribing());
      await assert.rejects(rt.transcribe(audio, f.model, f.settings), /already running/);
      const deadline = Date.now() + 5000;
      while (!existsSync(readyPath)) {
        assert.ok(Date.now() < deadline, "timed out waiting for validated engine input");
        await delay(10);
      }
      const { pid, wav } = JSON.parse(readFileSync(readyPath));
      if (reason === "cancel") await Promise.all([rt.cancel(), rt.cancel()]);
      const error = await done;
      if (reason === "cancel") assert.equal(error?.name, "AbortError");
      else assert.equal(error?.message, "Transcription timed out");
      assert.equal(rt.isTranscribing(), false);
      assert.equal(existsSync(wav), false);
      // Group termination can precede adoption/reaping of an orphan by launchd.
      for (let i = 0; i < 100; i++) {
        try { process.kill(pid, 0); } catch (e) { assert.equal(e.code, "ESRCH"); break; }
        await delay(10);
      }
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      f.verify();
      const next = prepare("whisper.cpp", "auto", "ok", []);
      assert.equal(await rt.transcribe(audio, next.model, next.settings), output);
      next.verify();
    } finally {
      await rt.cancel();
      await done;
    }
  });
}
