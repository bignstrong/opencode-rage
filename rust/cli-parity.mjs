// Compare the installed CLI contract, not helper functions. No real OpenCode,
// microphone, remote registry, or user cache is used in either run.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

if (process.platform !== "darwin") throw Error("CLI parity runs on macOS");
const repo = fileURLToPath(new URL("../", import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rage-cli-fixture-"));
const launcher = path.join(scratch, "rage");
try {
  fs.symlinkSync(path.relative(fs.realpathSync(scratch),path.join(repo,"bin/setup-opencode")), launcher);
  let reference = process.env.RAGE_REFERENCE_ROOT;
  if (!reference) {
    reference = path.join(scratch, "reference");
    fs.mkdirSync(reference);
    execFileSync("/usr/bin/tar", ["-xzf", path.join(repo, "rust/qa/fixtures/voice-reference.tar.gz"), "-C", reference]);
  }
  const bin = path.join(scratch, "fixture binaries");
  fs.mkdirSync(bin);
  const put = (name, body) => {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  put("opencode", `printf 'arg=<%s>\\n' "$@"\nexit "\${FIXTURE_EXIT:-0}"`);
  const engine = put("fixture engine", `test "$1" = --help || exit 98\nif test "$BAD_ENGINE" = 1; then echo 'invalid fixture'; exit 4; fi\necho 'fixture --model --file'`);
  const ffmpeg = put("ffmpeg", `case "$*" in
    -version) if test "$BAD_REC" = 1; then echo 'bad recorder' >&2; exit 3; fi; echo 'ffmpeg version fixture';;
    *-list_devices*) printf 'AVFoundation audio devices:\\n[0] Fixture Input\\n[1] Fixture Input\\n' >&2; exit 1;;
    *) echo 'unexpected FFmpeg operation' >&2; exit 98;;
  esac`);
  put("sox", `test "$1" = --help || exit 98\nif test "$BAD_REC" = 1; then exit 3; fi\necho 'fixture sox'`);
  put("arecord", `test "$1" = --help || exit 98\necho 'fixture arecord'`);
  const content = fs.readFileSync(engine);
  const zipped = gzipSync(content);
  const zip = path.join(scratch, "fixture.gz");
  const registry = path.join(scratch, "registry.json");
  fs.writeFileSync(zip, zipped);
  const hash = b => createHash("sha256").update(b).digest("hex");
  const asset = {kind:"single-binary-gzip",url:zip,size:zipped.length,sha256:hash(zipped),binary:{size:content.length,sha256:hash(content)}};
  const engineIds = ["whisper.cpp","transcribe-cpp"];
  fs.writeFileSync(registry, JSON.stringify({schema:"opencode-voice.engines.v1",engines:engineIds.map(id => ({
    id,version:"fixture-1",assets:{[`darwin-${process.arch}`]:asset}
  }))}));
  const cache = path.join(scratch, "cache");
  const home = path.join(scratch, "home");
  fs.mkdirSync(home);
  const env = {HOME:home, PATH:bin, TMPDIR:scratch, LANG:"C", XDG_CONFIG_HOME:home, XDG_CACHE_HOME:cache,
    OPENCODE_VOICE_DIR:cache, OPENCODE_VOICE_ENGINE_REGISTRY:registry,
    RAGE_FFMPEG:ffmpeg, OPENCODE_VOICE_FFMPEG:ffmpeg, OPENCODE_VOICE_WHISPER_CLI:engine,
    OPENCODE_VOICE_TRANSCRIBE_CPP:engine};
  const runtime = (rust) => {
    const cases = [];
    const compare = (args, extra = {}, json = false) => {
      const command = rust ? (process.env.RAGE_CORE ? [process.env.RAGE_CORE,"cli"] : [launcher]) : [process.execPath, path.join(reference,"bin/opencode-voice.js")];
      const {status,stdout,stderr,error,signal} = spawnSync(command[0], [...command.slice(1),...args], {
        cwd:scratch,env:{...env,...extra},encoding:"utf8",timeout:20000,
      });
      if (error) throw error;
      assert.equal(signal, null, args.join(" "));
      const result = json ? JSON.parse(stdout) : stdout;
      if (json && result.manifest?.installedAt) {
        assert.ok(Number.isFinite(Date.parse(result.manifest.installedAt)));
        delete result.manifest.installedAt; // Two distinct installations cannot share a timestamp.
      }
      cases.push({args, status,stdout:result,stderr});
      return {status,result};
    };
    compare([]); compare(["--help"]); compare(["unknown"]); compare(["engine","bad"]); compare(["engine","status","unknown"]);
    compare(["engine","status","--json"]); // The baseline interprets positional --json as an unsupported engine ID.
    compare(["engine","status"]); compare(["engine","status","whisper.cpp","--json"], {}, true);
    compare(["engine","status","transcribe-cpp","--json"], {}, true);
    compare(["engine","status","transcribe-cpp","--json"], {OPENCODE_VOICE_TRANSCRIBE_CPP:""}, true);
    const healthy = compare(["doctor","--json"], {}, true);
    assert.equal(healthy.status,0);
    assert.deepEqual(healthy.result.microphones,[":Fixture Input"]);
    compare(["doctor"]);
    compare(["doctor","--json"],{RAGE_FFMPEG:""},true); // Resolve from original recorder override.
    assert.equal(compare(["doctor","--json"],{BAD_REC:"1"},true).status,1);
    assert.equal(compare(["doctor","--json"],{BAD_ENGINE:"1"},true).status,1);
    assert.equal(compare(["install","--no-engine","--global","a b"]).status,0);
    compare(["update","--ignored","--global"],{OPENCODE_VOICE_PACKAGE:"@test/voice"});
    assert.equal(compare(["install"],{FIXTURE_EXIT:"29"}).status,29);
    assert.equal(compare(["update"],{FIXTURE_EXIT:"42"}).status,42);
    assert.equal(compare(["update"],{PATH:path.join(scratch,"no opencode here")}).status,1);
    for (const id of engineIds) {
      const managedOnly = {OPENCODE_VOICE_WHISPER_CLI:"",OPENCODE_VOICE_TRANSCRIBE_CPP:""};
      assert.equal(compare(["engine","import",id,...(id==="transcribe-cpp"?[engine]:[])]).status,0);
      compare(["engine","status",id,"--json"],managedOnly,true);
      compare(["engine","remove",id]);
      assert.equal(compare(["engine","install",id]).status,0);
      compare(["engine","status",id,"--json"],managedOnly,true);
      compare(["engine","install",id]); // Already ready: no download or progress output.
      compare(["engine","remove",id]);
    }
    assert.equal(compare(["install","--global"]).status,0);
    compare(["engine","remove","whisper.cpp"]);
    return cases;
  };
  const expected = runtime(false);
  fs.rmSync(cache,{recursive:true,force:true});
  const actual = runtime(true);
  for (const [i,result] of actual.entries()) assert.deepEqual(result,expected[i],result.args.join(" "));
  console.log(`${actual.length}/${expected.length} macOS CLI cases matched (argv, exit, stdout, stderr; parsed JSON without install timestamps)`);
} finally {
  fs.rmSync(scratch, {recursive:true,force:true});
}
