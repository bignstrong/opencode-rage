import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import plugin from "../index.js";
import { MODELS } from "../lib/models.js";
import { showModelPicker } from "../src/dialogs.ts";

async function startupPickers(t, downloadDir) {
  let renderV1;
  let optionsV2;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await plugin.tui(
    {
      kv: { get: (_, fallback) => fallback, set() {} },
      ui: {
        dialog: { setSize() {}, replace: (render) => (renderV1 = render) },
        DialogSelect: ({ options }) => options,
      },
      keymap: { registerLayer() {} },
      lifecycle: { onDispose() {} },
    },
    { downloadDir },
  );
  t.mock.timers.tick(250);
  return {
    V1: renderV1,
    V2: async () => {
      await showModelPicker(
        {
          options: { downloadDir },
          getSettings: () => ({ uiLanguage: "en" }),
          dialog: {
            select: async ({ options }) => {
              optionsV2 = options;
            },
          },
        },
        true,
      );
      return optionsV2;
    },
  };
}

test("each picker lists models once and only stats or reads matching entries", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-inventory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "models");
  const pickers = await startupPickers(t, root);
  const [verified, unmarked, mismatch, empty, missing] = MODELS;
  const planned = { ...verified, id: "planned-test", filename: "planned.bin", implemented: false };
  const unhashed = { ...verified, id: "unhashed-test", filename: "unhashed.bin", sha256: "" };
  const originalLength = MODELS.length;
  MODELS.push(planned, unhashed);
  t.after(() => MODELS.splice(originalLength));

  const calls = [];
  for (const method of ["readdirSync", "statSync", "readFileSync", "existsSync"]) {
    const original = fs[method];
    t.mock.method(fs, method, (file, ...args) => {
      if (file === dir || path.dirname(file) === dir)
        calls.push([method, path.relative(dir, file)]);
      return original(file, ...args);
    });
  }
  async function check(expected, io) {
    for (const [version, render] of Object.entries(pickers)) {
      calls.length = 0;
      const rows = (await render()).filter((row) => row.value !== "__skip");
      assert.deepEqual(calls.slice().sort(), io.slice().sort(), `${version} I/O`);
      const groups = {
        downloaded: "Downloaded models",
        "needs verification": "Pending verification",
        "not downloaded": "Available to download",
        planned: "Planned sidecar models",
      };
      const ids = MODELS.map((model) => model.id);
      const statusOf = (id) => expected.get(id) ?? "not downloaded";
      const ordered =
        version === "V1"
          ? ids
          : Object.keys(groups).flatMap((status) => ids.filter((id) => statusOf(id) === status));
      assert.deepEqual(
        rows.map((row) => row.value),
        ordered,
      );
      for (const row of rows) {
        const status = expected.get(row.value) ?? "not downloaded";
        if (version === "V1") {
          assert.equal(row.details[0].split(" - ").at(-1), status);
          const tag = status === "downloaded" || status === "planned" ? status : "download";
          assert.ok(row.title.startsWith(`[${tag}] `));
        } else {
          assert.equal(row.category, groups[status]);
          assert.equal(row.description, undefined);
        }
        assert.equal(row.disabled, status === "planned");
      }
    }
  }

  const scan = [["readdirSync", ""]];
  const statuses = new Map([[planned.id, "planned"]]);
  await check(statuses, scan); // Fresh install: models directory does not exist.
  fs.mkdirSync(dir);
  const put = (name, value) => fs.writeFileSync(path.join(dir, name), value);
  for (const model of [verified, unmarked, mismatch, unhashed, planned]) put(model.filename, "x");
  put(empty.filename, "");
  put(`${verified.filename}.sha256`, ` ${verified.sha256.toUpperCase()}\n`);
  put(`${mismatch.filename}.sha256`, "wrong");
  put(`${missing.filename}.partial`, "downloading");
  put(`${missing.filename}.sha256`, missing.sha256);
  const sparse = [
    ...scan,
    ...[verified, unmarked, mismatch, empty, unhashed].map((model) => ["statSync", model.filename]),
    ...[verified, mismatch].map((model) => ["readFileSync", `${model.filename}.sha256`]),
  ];
  statuses.set(verified.id, "downloaded");
  statuses.set(unhashed.id, "downloaded");
  statuses.set(mismatch.id, "needs verification");
  statuses.set(unmarked.id, "needs verification");
  await check(statuses, sparse);
  put(`${unmarked.filename}.sha256`, unmarked.sha256);
  statuses.set(unmarked.id, "downloaded");
  await check(statuses, [...sparse, ["readFileSync", `${unmarked.filename}.sha256`]]);
});
