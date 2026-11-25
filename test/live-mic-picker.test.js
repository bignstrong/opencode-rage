import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { testRender } from "@opentui/solid";
import { showMicrophonePicker } from "../src/dialogs.ts";
import { watchMicrophones } from "../src/mic-picker-watch.js";

const mic = (name) => ({ title: name, value: `:${name}` });

function controlledScans() {
  let next = Promise.withResolvers();
  let count = 0;
  return {
    next: () => next.promise,
    count: () => count,
    list(signal) {
      count++;
      const pending = Promise.withResolvers();
      const started = next;
      next = Promise.withResolvers();
      started.resolve({ ...pending, signal });
      return pending.promise;
    },
  };
}

test("discovery serializes scans, keeps last good choices, and discards late results after close", async () => {
  const scans = controlledScans();
  const initial = scans.next();
  const snapshots = [];
  const stop = watchMicrophones(scans.list, (rows) => snapshots.push(rows), 1);
  try {
    const first = await initial;
    await delay(10);
    assert.equal(scans.count(), 1, "a slow scan cannot overlap another");
    const rows = [mic("Desk")];
    first.resolve(rows);
    (await scans.next()).resolve([mic("Desk")]);
    (await scans.next()).reject(new Error("transient timeout"));
    (await scans.next()).resolve([]);
    const pending = await scans.next();
    stop();
    assert.equal(pending.signal.aborted, true);
    pending.resolve([mic("Late")]);
    await delay(10);
    assert.equal(scans.count(), 5);
    assert.deepEqual(snapshots, [rows, []]);
  } finally {
    stop();
  }
});

async function withNativePicker(t, check) {
  const scans = controlledScans();
  const initial = scans.next();
  const settings = { uiLanguage: "ru", mic: ":Desk Mic" };
  let render, close;
  let opened = 0;
  const result = showMicrophonePicker(
    {
      dialog: {
        show(component, onClose) {
          opened++;
          render = component;
          close = onClose;
        },
        clear: () => close(),
      },
      options: { platform: "darwin" },
      listMicrophones: (_, signal) => scans.list(signal),
      getSettings: () => settings,
      update: (fn) => fn(settings),
    },
    { standalone: true },
  );
  let screen;
  try {
    screen = await testRender(render, {
      width: 60,
      height: 13,
      kittyKeyboard: true,
      useMouse: true,
    });
    await check({ screen, scans, settings, initial, result, opened: () => opened });
  } catch (error) {
    if (!screen && String(error).includes("OpenTUI native FFI is not available"))
      return t.skip("OpenTUI native FFI unavailable in this Node runtime");
    throw error;
  } finally {
    close();
    screen?.renderer.destroy();
  }
}

for (const unplug of [false, true]) {
  test(
    `native Mac picker preserves filter and selection when the highlighted input ${unplug ? "disconnects" : "moves and is renamed"}`,
    { timeout: 10000 },
    (t) =>
      withNativePicker(t, async ({ screen, scans, settings, initial, result, opened }) => {
        const first = await initial;
        first.resolve([mic("Desk Mic"), { title: "USB Mic", value: ":uid:usb:USB%20Mic" }]);
        await screen.flush();
        assert.match(screen.captureCharFrame(), /Микрофон для записи/);
        await screen.mockInput.typeText("Mic", 0);
        screen.mockInput.pressArrow("down");
        const search = screen.renderer.root.findDescendantById("voice-mic-filter");
        assert.equal(search.value, "Mic");
        const second = await scans.next();
        const renamed = { title: "USB Studio Mic", value: ":uid:usb:USB%20Studio%20Mic" };
        second.resolve([mic("New Mic"), ...(unplug ? [] : [renamed]), mic("Desk Mic")]);
        await screen.flush();
        const frame = screen.captureCharFrame();
        assert.match(frame, /New Mic/);
        assert.doesNotMatch(frame, /Системный микрофон/);
        assert.equal(opened(), 1);
        assert.equal(search.focused, true);
        assert.equal(settings.mic, ":Desk Mic", "discovery never writes settings");
        screen.mockInput.pressEnter();
        if (unplug) {
          assert.equal(
            second.signal.aborted,
            false,
            "Enter must not choose a different microphone",
          );
          screen.mockInput.pressArrow("down");
          screen.mockInput.pressEnter();
        }
        await result;
        assert.equal(settings.mic, unplug ? ":New Mic" : renamed.value);
        assert.equal(second.signal.aborted, true);
      }),
  );
}

test(
  "failed live scan retains the filtered highlight; dismissal ignores the pending scan",
  { timeout: 10000 },
  (t) =>
    withNativePicker(t, async ({ screen, scans, settings, initial, result }) => {
      (await initial).resolve([{ title: "USB microphone", value: ":uid:usb:USB" }]);
      await screen.flush();
      await screen.mockInput.typeText("USB", 0);
      (await scans.next()).reject(new Error("fixture discovery timeout"));
      const pending = await scans.next();
      await screen.flush();
      assert.match(screen.captureCharFrame(), /USB microphone/);
      screen.mockInput.pressEscape();
      await result;
      assert.equal(pending.signal.aborted, true);
      pending.resolve([mic("Late USB")]);
      await delay(0);
      assert.equal(settings.mic, ":Desk Mic");
    }),
);

for (const unplug of [false, true]) {
  test(
    unplug
      ? "mouse release after unplug never selects the replacement row"
      : "ordinary left click selects the microphone under the pointer",
    { timeout: 10000 },
    (t) =>
      withNativePicker(t, async ({ screen, scans, settings, initial, result }) => {
        const first = await initial;
        first.resolve([mic("USB A"), mic("USB B")]);
        await screen.flush();
        const lines = () => screen.captureCharFrame().split("\n");
        const y = lines().findIndex((line) => line.includes("USB A"));
        assert.notEqual(y, -1);
        const x = lines()[y].indexOf("USB A");
        if (unplug) {
          // Ctrl bypasses native text selection, independently exercising mouse ownership.
          const ctrl = { modifiers: { ctrl: true } };
          await screen.mockMouse.pressDown(x, y, 0, ctrl);
          (await scans.next()).resolve([mic("USB B")]);
          await screen.flush();
          assert.match(lines()[y], /USB B/);
          await screen.mockMouse.release(x, y, 0, ctrl);
          assert.equal(first.signal.aborted, false, "the picker must stay open");
          assert.equal(settings.mic, ":Desk Mic");
        }
        await screen.mockMouse.click(x, y);
        assert.equal(first.signal.aborted, true, "a fresh click must close the picker");
        await result;
        assert.equal(settings.mic, unplug ? ":USB B" : ":USB A");
      }),
  );
}
