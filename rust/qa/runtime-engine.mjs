#!/usr/bin/env node
// Installed under two different names: the selected executable must match the model engine.
import assert from "node:assert/strict";
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

const root = process.env.QA_WORK;
const { engine, model, language, behavior } = JSON.parse(readFileSync(join(root, "expect.json")));
const sidecar = engine === "transcribe-cpp";
assert.equal(basename(process.argv[1]), sidecar ? "sidecar.mjs" : "whisper.mjs");
const args = process.argv.slice(2);
const wav = args[3];
assert.deepEqual(args, sidecar
  ? ["--model", model, "--file", wav, ...(language === "auto" ? [] : ["--language", language])]
  : ["-m", model, "-f", wav, "-np", "-nt", "-l", language]);
assert.equal(readFileSync(model, "utf8"), engine);
assert.ok(relative(join(root, "scratch"), wav).split("/")[0].match(/^(rage-stt-|opencode-voice-)/));
assert.notEqual(statSync(wav).ino, statSync(join(root, "caller/audio with spaces.wav")).ino);
assert.deepEqual(readFileSync(wav), readFileSync(join(root, "finalized.wav")), "recognizer received incorrect RIFF, chunk sizes, or PCM");
// An engine modifying its input must never corrupt the caller's file.
writeFileSync(wav, "engine touched its own private input");
const ready = join(root, "ready.json");
writeFileSync(ready + ".tmp", JSON.stringify({ pid: process.pid, wav, dir: dirname(wav) }));
renameSync(ready + ".tmp", ready);
if (behavior === "stall") {
  setTimeout(() => process.exit(67), 15_000);
} else if (behavior === "fail") {
  console.error("fixture inference failed");
  process.exitCode = 4;
} else {
  console.error("fixture diagnostic, not transcript");
  console.log(" [noise] проверка\n (aside) пройдена ");
}
