// node --conditions=browser rust/picker-parity.mjs [path/to/rage.node]
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createRoot } from "solid-js";
import { nativePicker, referencePicker } from "../src/mic-picker.ts";

const require = createRequire(import.meta.url);
const { pickerState } = require(process.argv[2] ? resolve(process.argv[2]) : "../native/rage.node");
assert.equal(typeof pickerState, "function", "build the host addon with the pickerState export");
const row = (title, value = title) => ({ title, value });
const a = row("Desk USB", ":uid:1:Desk");
const renamed = row("Studio USB", ":uid:1:Studio");
const b = row("Desk USB", ":uid:2:Desk");
const more = Array.from({ length: 14 }, (_, i) => row(`Микрофон ${i}`, `:${i}`));
const all = [a, b, ...more];
const build = (devices) => [row("System default", ""), ...devices, row("Custom", "__custom")];
const highlights = (picker) =>
  picker
    .visible()
    .filter(picker.highlighted)
    .map((row) => row.value);
let transitions = 0;

function trace(current, perform) {
  createRoot((dispose) => {
    const jsChoices = [],
      rustChoices = [];
    const js = referencePicker(current, build, (v) => jsChoices.push(v));
    const rust = nativePicker(current, build, (v) => rustChoices.push(v), pickerState);
    function check(label) {
      assert.deepEqual(rust.visible(), js.visible(), `${label}: window`);
      assert.deepEqual(highlights(rust), highlights(js), `${label}: highlight`);
      assert.deepEqual(rustChoices, jsChoices, `${label}: close/choice`);
    }
    function step(op, ...args) {
      const ref = js[op](...args);
      const actual = rust[op](...args);
      if (op === "key") assert.equal(actual, ref, "event consumption");
      check(`${++transitions} ${op}`);
    }
    try {
      check("init");
      perform(step, rust, rustChoices);
    } finally {
      dispose();
    }
  });
}

for (const value of [
  "",
  ":",
  ":3",
  ":uid::invalid",
  ":uid:a",
  ":uid:a:",
  ":uid:ю:🔴:USB",
  ":uid:a%3Ab:Hi",
]) {
  assert.equal(
    JSON.parse(pickerState("identity", JSON.stringify({ value }))),
    value.match(/^:uid:[^:]+:/)?.[0] ?? value,
  );
}

trace(a.value, (step, picker, choices) => {
  step("refresh", all);
  step("input", "\uFEFFusB ");
  step("down", a.value, true);
  step("refresh", [b]);
  step("up", b.value, true, false); // replacement at same screen coordinate
  step("up", a.value, true, false); // stale renderer holding the removed row
  step("key", "return", false);
  assert.deepEqual(highlights(picker), []);
  assert.deepEqual(choices, []);
  step("refresh", [b, renamed]);
  step("down", renamed.value, true);
  step("refresh", [a, b]); // same UID, new selector
  step("up", renamed.value, true, false);
  assert.deepEqual(choices, [a.value]);
});
trace("", (step, picker, choices) => {
  step("refresh", all);
  step("input", " МИКРОФОН ");
  for (let i = 0; i < 20; i++) step("key", "n", true);
  assert.equal(picker.visible().length, 8);
  assert.deepEqual(highlights(picker), [":13"]);
  step("scroll", "up");
  step("key", "p", true);
  assert.deepEqual(highlights(picker), [":11"]);
  step("input", "not present");
  step("refresh", undefined);
  step("key", "return", false);
  assert.deepEqual(choices, []);
  step("refresh", [row("not present now", ":new")]);
  step("refresh", []);
  step("key", "escape", false);
  assert.deepEqual(choices, [undefined]);
});
trace("", (step, _, choices) => {
  step("refresh", all);
  step("down", b.value, false);
  step("up", b.value, true, false);
  step("down", b.value, true);
  step("up", b.value, true, true);
  step("clear");
  step("up", b.value, true, false);
  step("key", "p", false);
  step("scroll", "left");
  assert.deepEqual(choices, []);
  step("key", "return", false);
  assert.deepEqual(choices, [""]); // default is distinct from Escape
});

let seed = 8141;
const pick = (arr) => arr[(seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % arr.length];
for (let run = 0; run < 100; run++) {
  trace(pick(["", a.value, b.value, ":absent"]), (step, _, choices) => {
    for (let i = 0; i < 50 && !choices.length; i++) {
      const events = [
        ["refresh", pick([all, [], undefined, [renamed, b], [b, a], [b, b]])],
        ["input", pick(["", "Desk", " студ ", "\u0085", "МИК", "Custom"])],
        ["key", pick(["p", "n", "up", "down", "return", "space"]), pick([false, true])],
        ["scroll", pick(["down", "up", "right"])],
        ["down", pick([a, b, renamed]).value, pick([true, false])],
        ["up", pick([b, renamed, a]).value, pick([true, false]), pick([false, true])],
        ["clear"],
      ];
      step(...pick(events));
    }
  });
}
console.log(`${transitions} picker transitions matched the old-mode controller`);
