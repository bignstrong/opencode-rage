import assert from "node:assert/strict";
import test from "node:test";
import { ensureDownloaded, localizeDownloadStatus } from "../src/ensure.ts";

test("a quiet connection keeps the latest byte count visible until verification", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(performance, "now", () => 0);
  const mb = 1024 ** 2;
  const status = [];
  const env = {
    options: {},
    settings: { uiLanguage: "ru" },
    downloadStatus: (_id, message) => status.push(message),
    toast: () => {},
    download: async (_model, _options, _settings, hooks) => {
      hooks.onProgress({ state: "downloading", downloaded: mb, total: 0 });
      hooks.onProgress({ state: "downloading", downloaded: 2 * mb, total: 0 });
      assert.equal(status.at(-1).hint, "Загрузка модели · 1 МБ");
      t.mock.timers.tick(10_000);
      assert.equal(status.at(-1).hint, "Загрузка модели · 2 МБ");
      hooks.onProgress({ state: "verifying" });
      t.mock.timers.tick(10_000);
      assert.equal(status.at(-1).hint, "Проверка…");
    },
  };
  await ensureDownloaded(env, { id: "fixture", name: "Fixture", filename: "fixture.bin" });
});

test("callers share the resolved model path, retry status and failure; a later call can restart", async () => {
  const model = { id: "fixture", name: "Fixture", filename: "fixture.bin" };
  const mb = 1024 ** 2;
  const status = [];
  const joined = [];
  const toasts = [];
  const notice = ["Скачиваю Fixture. Прогресс смотри под полем ввода.", "info"];
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let calls = 0;
  const env = {
    options: { downloadDir: "./unused" },
    settings: { downloadDir: "./fixture-cache", uiLanguage: "ru" },
    downloadStatus: (_id, message) => status.push(message),
    toast: (...args) => toasts.push(args),
    download: async (_model, _options, _settings, hooks) => {
      calls++;
      assert.deepEqual(toasts.at(-1), notice);
      if (calls > 1) return;
      hooks.onProgress({ state: "downloading", downloaded: 2 * mb, total: 8 * mb });
      hooks.onRetry({ error: Error("network"), nextAttempt: 2, attempts: 5 });
      started.resolve();
      await finish.promise;
    },
  };
  const first = ensureDownloaded(env, model);
  await started.promise;
  const second = ensureDownloaded(
    {
      ...env,
      settings: { uiLanguage: "ru" },
      options: { downloadDir: "./x/../fixture-cache" },
      downloadStatus: (_id, message) => joined.push(message),
    },
    model,
  );
  const failed = Promise.all([assert.rejects(first, /network/), assert.rejects(second, /network/)]);
  assert.equal(status.at(-1).hint, "Диктовка · повтор загрузки");
  assert.equal(status.at(-1).detail, "Попытка 2/5 · 2 МБ / 8 МБ");
  assert.equal(joined.at(-1), status.at(-1));
  finish.reject(Error("network"));
  await failed;
  assert.equal(calls, 1);
  assert.equal(status.at(-1).phase, "failed");
  assert.equal(joined.at(-1).detail, "network");
  assert.deepEqual(toasts, [notice]);
  assert.deepEqual(
    await Promise.all([ensureDownloaded(env, model), ensureDownloaded(env, model)]),
    [true, true],
  );
  assert.equal(calls, 2);
  assert.equal(status.at(-1).phase, "ready");
  assert.deepEqual(toasts, [notice, notice]);
});

test("a stalled shared download can be rendered in either subscriber's language", async () => {
  const model = { id: "fixture", name: "Fixture", filename: "fixture.bin" };
  const stalled = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const english = [];
  const russian = [];
  const toasts = [];
  const env = {
    options: {},
    settings: { uiLanguage: "en" },
    downloadStatus: (_id, message) => english.push(message),
    toast: (...args) => toasts.push(args),
    download: async (_model, _options, _settings, hooks) => {
      hooks.onProgress({ state: "downloading", downloaded: 1024 ** 3, total: 0 });
      stalled.resolve();
      await resume.promise;
      hooks.onProgress({ state: "verifying" });
    },
  };
  const first = ensureDownloaded(env, model);
  await stalled.promise;
  const second = ensureDownloaded(
    {
      ...env,
      settings: { uiLanguage: "ru" },
      downloadStatus: (_id, message) => russian.push(message),
    },
    model,
  );
  const snapshot = english.at(-1);
  assert.equal(snapshot.hint, "Downloading model · 1.0 GB");
  assert.equal(localizeDownloadStatus(snapshot, "ru").hint, "Загрузка модели · 1,0 ГБ");
  assert.equal(russian.at(-1).detail, "1,0 ГБ");
  assert.equal(localizeDownloadStatus(russian.at(-1), "en").detail, "1.0 GB");
  resume.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(
    english.slice(-2).map((s) => s.detail),
    ["Verifying SHA256", "Ready"],
  );
  assert.deepEqual(
    russian.slice(-2).map((s) => s.detail),
    ["Проверка SHA256", "Готова"],
  );
  assert.deepEqual(toasts, [["Downloading Fixture. See progress below the input field.", "info"]]);
});
