import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createActivity } from "../src/button/activity.ts";

const core = fileURLToPath(new URL("../native/target/release/rage-core", import.meta.url));
for (const mode of ["breath", "rain", "cycle"]) {
  for (const seed of [1, 15485863, 2147483646]) {
    let state = seed;
    const frame = createActivity(mode, () => (state = (state * 48271) % 2147483647) / 2147483647);
    const count = 1024;
    const rust = JSON.parse(execFileSync(core, ["frames", mode, String(seed), String(count)], { encoding: "utf8" }));
    assert.deepEqual(rust, Array.from({ length: count }, frame), `${mode} seed=${seed}`);
  }
}
console.log("9216/9216 reference frames matched");
