import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { VoiceRuntime } from "@bignstrong/rage/runtime";

test("packed native capture: only the default input may start SoX without FFmpeg", async (t) => {
  const root = process.env.QA_WORK;
  const bin = join(root, "fake recorders");
  fs.mkdirSync(bin);
  const log = join(bin, "calls.jsonl");
  const ffmpeg = join(bin, "ffmpeg");
  const sox = join(bin, "sox");
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
  for (const path of [sox, ffmpeg]) {
    fs.writeFileSync(path, `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({file: process.argv[1], args: process.argv.slice(2), sox: process.env.RAGE_SOX}) + "\\n");
${path === sox ? "process.stdout.write(Buffer.from([1, 2, 3, 4])); setTimeout(() => process.exit(9), 10000);" : "process.exit(3);"}
`, { mode: 0o700 });
  }
  // Both discovery and child PATH are confined to fixtures: even a broken adapter
  // cannot accidentally invoke a real recorder.
  process.env.PATH = bin;
  fs.renameSync(ffmpeg, ffmpeg + ".off");
  const access = fs.accessSync;
  const visible = new Set([sox]);
  t.mock.method(fs, "accessSync", (p, mode) => {
    if (!visible.has(p)) throw new Error("not a fixture recorder");
    return access(p, mode);
  });
  const rt = new VoiceRuntime({ downloadDir: join(root, "recorder cache") });
  try {
    await assert.rejects(rt.start({ mic: ":uid:3:pinned" }), /FFmpeg is not installed/);
    assert.deepEqual(calls(), []);
    for (const mic of [undefined, "default", ":default"]) {
      const wav = await rt.start({ mic });
      assert.equal(rt.isRecording(), true);
      assert.equal(await rt.stop(), wav);
      assert.equal(rt.interruptedMicrophone, false);
      const bytes = fs.readFileSync(wav);
      assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
      assert.deepEqual(bytes.subarray(44), Buffer.from([1, 2, 3, 4]));
      await rt.cleanupRecording(wav);
      assert.equal(fs.existsSync(wav), false);
    }
    assert.equal(calls().length, 3);
    for (const invocation of calls()) assert.deepEqual(invocation, {
      file: sox, sox, args: ["-d", "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-L", "-t", "raw", "-"],
    });
    // PATH still contains fake SoX. A failed native FFmpeg must respect the
    // adapter's explicit empty sentinel instead of rediscovering it.
    visible.delete(sox);
    fs.renameSync(ffmpeg + ".off", ffmpeg);
    visible.add(ffmpeg);
    await assert.rejects(rt.start({}));
    assert.equal(calls().length, 4);
    assert.equal(calls().at(-1).file, ffmpeg);
    assert.equal(calls().at(-1).sox, "");
  } finally {
    await rt.cancel();
  }
});
