// Build the host addon first. Run: node rust/readiness-parity.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { rustBinding } from "../lib/rust-binding.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const original = execFileSync("tar", ["-xOzf", "rust/qa/fixtures/voice-reference.tar.gz", "src/ensure.ts"], {
  cwd: root,
  encoding: "utf8",
});
const source = new URL("../src/ensure.ts", import.meta.url).href;
const oracleURL = `${source}?readiness-oracle`;
const effects = {
  "../lib/engine.js": [
    "VoiceRuntime",
    "getRecorderStatus",
    "probeRecorder",
    "ensureManagedRecorder",
  ],
  "../lib/engines.js": ["getEngineStatus", "probeEngine", "installManagedEngine"],
  "../lib/download.js": ["downloadModel"],
};
// Stub only the asset boundary of ensure.ts (including its dynamic probe import).
// Both implementations still use real cache-path, marker, language and formatter code.
const hooks = registerHooks({
  resolve(spec, ctx, next) {
    if ([source, oracleURL].includes(ctx.parentURL) && Object.hasOwn(effects, spec)) {
      const code = effects[spec]
        .map(
          (name) => `export const ${name}=(...args)=>globalThis.fixtureEffects.${name}(...args);`,
        )
        .join("\n");
      return { url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true };
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    return url === oracleURL
      ? { format: "module-typescript", source: original, shortCircuit: true }
      : next(url, ctx);
  },
});
const dir = mkdtempSync(join(tmpdir(), "rage-readiness-"));
const platform = Object.getOwnPropertyDescriptor(process, "platform");
const file = {
  id: "fixture",
  name: "Fixture 🎤",
  filename: "fixture.bin",
  engine: "transcribe-cpp",
};
const mb = 1024 ** 2;
let count = 0,
  events = 0;
try {
  const oracle = await import(oracleURL),
    port = await import(source);
  const { createVoiceController } = await import("../src/voice.ts");
  async function compare(name, work) {
    async function run(api, mode) {
      process.env.RAGE_RUST = mode;
      globalThis.fixtureEffects = Object.create(null);
      const trace = [];
      try {
        const native = mode === "1" && mock.method(rustBinding(), "readiness");
        await work(api, (...args) => trace.push(structuredClone(args)));
        if (native && process.platform === "darwin")
          assert.ok(native.mock.callCount() > 0, `${name}: expected native readiness decisions`);
      } finally {
        Object.defineProperty(process, "platform", platform);
        mock.restoreAll();
        mock.timers.reset();
      }
      return trace;
    }
    const ref = await run(oracle, "0"),
      actual = await run(port, "1");
    assert.deepEqual(actual, ref, name);
    count++;
    events += ref.length;
  }

  for (const kind of ["engine", "recorder"])
    for (const language of ["en", "ru"]) {
      for (const [outcome, directory] of [
        ["healthy", "custom dir"],
        ["missing", ""],
        ["broken", undefined],
        ["statusError", "custom dir"],
        ["probeError", "custom dir"],
        ["installError", "custom dir"],
        ["override", "custom dir"],
        ...(kind === "recorder" ? [["mac", undefined]] : []),
      ]) {
        await compare(`${kind} ${language} ${outcome}`, async (api, log) => {
          Object.defineProperty(process, "platform", {
            ...platform,
            value: kind === "recorder" && outcome !== "mac" ? "win32" : "darwin",
          });
          const accessor = () => 42,
            fault = Error("fixture outage");
          const options = { downloadDir: join(dir, "options"), opaque: accessor },
            settings = { uiLanguage: language };
          if (directory !== undefined) settings.downloadDir = directory && join(dir, directory);
          let lang = language;
          const inspect = (opts, s) => [
            opts === options,
            opts.opaque === accessor,
            s === settings,
            Object.hasOwn(opts, "downloadDir"),
            opts.downloadDir,
            opts.skipFfmpegStaticInstall,
          ];
          const status = (id, opts, s) => {
            log("status", id, ...inspect(opts, s));
            if (outcome === "statusError") throw fault;
            return { resolvedBinary: outcome === "missing" ? null : "/fixture/bin with space" };
          };
          const probe = (...args) => {
            log("probe", ...args);
            // Install options are a snapshot, while the SDK still receives the original settings object.
            settings.downloadDir = join(dir, "changed after status");
            if (outcome === "probeError") throw fault;
            return { ok: outcome === "healthy" };
          };
          const install = (which, id, opts, s, callbacks) => {
            log(which, id, ...inspect(opts, s), callbacks.retries);
            assert.equal(callbacks.retries, 5);
            lang = language === "en" ? "ru" : "en";
            callbacks.onRetry({ nextAttempt: 2, attempts: 5, error: Error("disk full") });
            callbacks.onRetry({ nextAttempt: 3, attempts: 5, error: "checksum" });
            if (outcome === "installError") throw fault;
          };
          Object.assign(globalThis.fixtureEffects, {
            getEngineStatus: status,
            getRecorderStatus: (o, s) => status("rec", o, s),
            probeEngine: probe,
            probeRecorder: probe,
            installManagedEngine: (...args) => install("sdk", ...args),
            ensureManagedRecorder: (...args) => install("sdk", "rec", ...args),
          });
          const env = {
            options,
            settings,
            getSettings: () => ({ uiLanguage: lang }),
            toast: (...args) => log("toast", ...args),
          };
          if (outcome === "override") {
            env.installEngine = (...args) => install("custom", ...args);
            env.ensureRecorder = (...args) => install("custom", "rec", ...args);
          }
          try {
            const ok =
              kind === "engine"
                ? await api.ensureEngineReady(env, file)
                : await api.ensureRecorderReady(env);
            log("result", ok);
          } catch (error) {
            assert.equal(error, fault);
            log("rejected", error.message);
          }
        });
      }
    }

  for (const language of ["en", "ru"])
    for (const fail of [false, true]) {
      await compare(`shared model ${language} ${fail}`, async (api, log) => {
        mock.timers.enable({ apis: ["setTimeout"] });
        let now = 0;
        mock.method(performance, "now", () => now);
        const tick = (ms) => {
          now += ms;
          mock.timers.tick(ms);
        };
        const entered = Promise.withResolvers(),
          release = Promise.withResolvers();
        let calls = 0,
          lang = language,
          latest;
        const otherLanguage = language === "en" ? "ru" : "en";
        const opaque = Symbol("host option"),
          fault = Error("SHA256 mismatch");
        const options = { downloadDir: join(dir, "options"), opaque };
        const settings = { downloadDir: join(dir, "custom models"), uiLanguage: language };
        const listener = (id, message) => {
          latest = message;
          log("owner", id, message);
          if (message.detail === "Downloading…" || message.detail === "Загрузка…")
            lang = otherLanguage;
        };
        const env = {
          settings,
          options,
          getSettings: () => ({ uiLanguage: lang }),
          downloadStatus: listener,
          toast: (...a) => log("toast", ...a),
          download: async (m, o, s, h) => {
            assert.equal(o, options);
            assert.equal(s, settings);
            assert.equal(m, file);
            log("download", ++calls, o.downloadDir, s.downloadDir, h.retries);
            if (calls > 1) return;
            h.onRetry({ nextAttempt: 2, attempts: 5 });
            const progress = (bytes, total = 0) =>
              h.onProgress({ state: "downloading", downloaded: bytes, total });
            progress(mb);
            progress(2 * mb);
            tick(1499);
            progress(3 * mb);
            tick(1);
            progress(4 * mb);
            h.onProgress({ state: "ignored" });
            h.onRetry({ nextAttempt: 3, attempts: 5 });
            tick(1500);
            progress(3 * mb, 8 * mb);
            progress(4 * mb, 8 * mb);
            h.onProgress({ state: "verifying" });
            h.onProgress({ state: "verifying" });
            tick(1500);
            entered.resolve();
            await release.promise;
            lang = language;
            progress(1024 * mb);
            progress(2048 * mb);
            if (fail) throw fault;
          },
        };
        const alt = {
          ...env,
          settings: { uiLanguage: language },
          options: { downloadDir: `${dir}/unused/../custom models` },
          getSettings: () => ({ uiLanguage: lang }),
          downloadStatus: (id, v) => log("early", id, v, v === latest),
        };
        const first = api.ensureDownloaded(env, file);
        const early = api.ensureDownloaded(alt, file);
        await Promise.race([
          entered.promise,
          first.then(() => {
            throw Error("expected suspended download");
          }),
        ]);
        const repeat = api.ensureDownloaded(env, file);
        const late = api.ensureDownloaded(
          {
            ...alt,
            downloadStatus: (id, v) => log("late", id, v, v === latest),
            getSettings: () => ({ uiLanguage: language }),
          },
          file,
        );
        const distinct = await api.ensureDownloaded(
          {
            ...env,
            options: { downloadDir: join(dir, "independent") },
            settings: { uiLanguage: language },
            download: async () => log("distinct directory"),
            downloadStatus: undefined,
          },
          file,
        );
        log("distinct result", distinct);
        release.resolve();
        for (const result of await Promise.allSettled([first, early, repeat, late])) {
          if (fail) {
            assert.equal(result.status, "rejected");
            assert.equal(result.reason.cause, fault);
            log("error", result.reason instanceof api.ReportedDownloadError, result.reason.message);
          } else log("resolved", result.value);
        }
        tick(9999);
        assert.equal(calls, 1);
        log("restart", await api.ensureDownloaded(env, file));
        assert.equal(calls, 2);
      });
    }
  for (const reported of [false, true])
    for (const cause of [Error("network"), "file moved"]) {
      await compare(`failure ${reported} ${cause}`, async (api, log) => {
        globalThis.fixtureEffects.downloadModel = () => {
          throw cause;
        };
        const env = {
          options: { downloadDir: dir },
          settings: { uiLanguage: "ru" },
          toast: (...a) => log("toast", ...a),
          downloadStatus: reported ? (_id, s) => log(s) : undefined,
        };
        await assert.rejects(api.ensureDownloaded(env, file), (e) => {
          assert.equal(reported ? e.cause : e, cause);
          log(e instanceof api.ReportedDownloadError, String(e));
          return true;
        });
      });
    }
  await compare("installed model bypasses transfer", async (api, log) => {
    const cache = join(dir, "existing");
    mkdirSync(join(cache, "models"), { recursive: true });
    writeFileSync(join(cache, "models", file.filename), "cached");
    log(
      await api.ensureDownloaded(
        {
          settings: { downloadDir: cache },
          options: {},
          toast: assert.fail,
          download: assert.fail,
        },
        file,
      ),
    );
  });
  await compare("translate only changed copy", async (api, log) => {
    const en = { hint: "ready", detail: "ready" },
      ru = { hint: "готова", detail: "готова", opaque: 1n };
    const status = { phase: "ready", ...en, translations: { en, ru } };
    for (const value of [status, { ...status, translations: undefined }])
      for (const language of ["en", "ru"]) {
        const result = api.localizeDownloadStatus(value, language);
        log(language, result, result === value, result.translations === value.translations);
      }
  });

  for (const fail of [false, true])
    await compare(`V2 controller start ${fail}`, async (api, log) => {
      const settings = {
        model: "whisper-tiny",
        uiLanguage: "ru",
        downloadDir: join(dir, "controller cache"),
      };
      const deps = {
        options: { downloadDir: join(dir, "plugin option") },
        getSettings: () => settings,
        getUiLanguage: () => "ru",
        toast: (...a) => log("toast", ...a),
        downloadStatus: (...a) => log("status", ...a),
        runtime: {
          isRecording: () => false,
          isTranscribing: () => false,
          start: (s) => log("fixture start", s.model, s.downloadDir),
        },
        onSetupError: (title, e) => log(title, e.message, e instanceof api.ReportedDownloadError),
        onPhaseChange: (p) => log("phase", p),
      };
      Object.assign(globalThis.fixtureEffects, {
        getEngineStatus: () => ({ resolvedBinary: null }),
        installManagedEngine: (id, o) => log("engine", id, o.downloadDir),
        downloadModel: (m, o, s, h) => {
          log("model", m.id, o.downloadDir, s.downloadDir, h.retries);
          h.onProgress({ state: "verifying" });
          if (fail) throw Error("invalid hash");
        },
      });
      if (api === oracle)
        deps.ready = {
          ensureDownloaded: api.ensureDownloaded,
          ensureEngineReady: api.ensureEngineReady,
          ensureRecorderReady: api.ensureRecorderReady,
        };
      await createVoiceController(deps).start();
    });
  console.log(
    `${count}/${count} readiness traces matched abf76dc (${events} results, calls and status events).`,
  );
} finally {
  hooks.deregister();
  delete globalThis.fixtureEffects;
  rmSync(dir, { recursive: true, force: true });
}
