import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "jsonc-parser";
import { applyRageTheme } from "../src/preset.ts";

test("theme activation preserves CLI settings, comments and permissions, and rejects broken JSON", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rage-preset-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  mkdirSync(join(dir, "opencode"));
  const file = join(dir, "opencode", "cli.json");
  writeFileSync(file, '{\n// Keep this\n"plugins":["other"],"theme":{"mode":"light"},\n}\n', {
    mode: 0o600,
  });
  applyRageTheme();
  const result = readFileSync(file, "utf8");
  assert.match(result, /\/\/ Keep this/);
  assert.deepEqual(parse(result), { plugins: ["other"], theme: { mode: "light", name: "orng" } });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  writeFileSync(file, "{broken");
  assert.throws(applyRageTheme, /Invalid cli.json/);
  assert.equal(readFileSync(file, "utf8"), "{broken");
});
