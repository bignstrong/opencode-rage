import assert from "node:assert/strict";
import test from "node:test";
import { TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { jsx } from "@opentui/solid/jsx-runtime";
import { createSignal } from "solid-js";
import { ComposerButtons } from "../src/button/controls.ts";

// Native OpenTUI needs Bun or Node with node:ffi. Use --conditions=browser for client-side Solid.
test("composer buttons ignore hover, show keyboard focus, and guard both actions", async (t) => {
  const [phase, setPhase] = createSignal("idle");
  const [locale, setLocale] = createSignal("en");
  const [animate, setAnimate] = createSignal(false);
  const [canSend, setCanSend] = createSignal(true);
  let toggles = 0;
  let sends = 0;
  let screen;
  try {
    screen = await testRender(
      () =>
        jsx("box", {
          children: [
            jsx("box", {
              flexDirection: "row",
              children: [
                jsx("text", { content: "M", width: 1, flexShrink: 0 }),
                ComposerButtons({
                  get phase() {
                    return phase();
                  },
                  get locale() {
                    return locale();
                  },
                  get animate() {
                    return animate();
                  },
                  get canSend() {
                    return canSend();
                  },
                  startedAt: Date.now() - 65000,
                  toggle: () => toggles++,
                  onSend: () => sends++,
                }),
              ],
            }),
            jsx("input", { id: "prompt", height: 1 }),
          ],
        }),
      { width: 40, height: 2, kittyKeyboard: true },
    );
  } catch (error) {
    if (String(error).includes("OpenTUI native FFI is not available"))
      return t.skip("OpenTUI native FFI unavailable in this Node runtime");
    throw error;
  }
  try {
    const frame = async () => {
      await screen.flush();
      const line = screen.captureCharFrame().split("\n")[0];
      assert.equal(line[0], "M", "composer model metadata remains visible");
      return line.slice(1).trim();
    };
    assert.match(await frame(), /^↑\s+●$/);
    const attributes = (glyph) =>
      screen.captureSpans().lines[0].spans.find((span) => span.text.includes(glyph)).attributes;
    assert.ok(attributes("↑") & TextAttributes.BOLD);
    assert.ok(attributes("●") & TextAttributes.BOLD);
    const find = (id) => screen.renderer.root.findDescendantById(id);
    const voice = find("voice-button");
    const send = find("voice-send");
    const prompt = find("prompt");
    assert.equal(send.parent, find("voice-controls"));
    assert.equal(voice.parent, send.parent);
    assert.equal(voice.x + voice.width, 40);
    const [vx, sx] = [voice.x + 1, send.x + 1];
    const { mockInput: keys, mockMouse: mouse } = screen;

    prompt.focus();
    const idle = await frame();
    await mouse.moveTo(sx, 0);
    assert.equal(await frame(), idle);
    await mouse.moveTo(vx, 0);
    assert.equal(await frame(), idle);
    assert.equal(voice.x + 1, vx);
    await mouse.pressDown(vx, 0);
    await frame();
    assert.ok(attributes("●") & TextAttributes.INVERSE);
    assert.equal(toggles, 0);
    await mouse.release(vx, 0);
    await frame();
    assert.equal(attributes("●") & TextAttributes.INVERSE, 0);
    await mouse.click(vx, 0);
    assert.equal(toggles, 1);
    assert.equal(prompt.focused, true);

    await mouse.click(sx, 0, 2);
    await mouse.drag(sx, 0, sx + 1, 0);
    assert.equal(sends, 0);
    await mouse.doubleClick(sx, 0);
    assert.equal(sends, 1);
    assert.equal(prompt.focused, true);
    await mouse.moveTo(0, 1);
    send.focus();
    assert.match(await frame(), /^Send\s+↑\s+●$/);
    keys.pressEnter({ shift: true });
    assert.equal(sends, 1);
    keys.pressEnter();
    keys.pressKey(" ");
    assert.equal(sends, 3);

    setLocale("ru");
    assert.match(await frame(), /^Отправить\s+↑\s+●$/);
    prompt.focus();
    setCanSend(false);
    await frame();
    assert.ok(attributes("↑") & TextAttributes.DIM);
    assert.equal(send.focusable, false);
    await mouse.click(sx, 0);
    assert.equal(sends, 3);
    assert.equal(prompt.focused, true);
    setCanSend(true);
    await mouse.moveTo(0, 1);
    for (const state of ["recording", "starting", "stopping", "transcribing", "sending"]) {
      setPhase(state);
      await frame();
      assert.equal(send.x + 1, sx);
      assert.equal(send.focusable, false);
      await mouse.click(sx, 0);
      assert.equal(sends, 3);
      await mouse.moveTo(vx, 0);
      if (state === "recording") {
        assert.match(await frame(), /^\p{Script=Braille}{3} 01:0\d\s+↑\s+■$/u);
        voice.focus();
        keys.pressEnter();
        assert.equal(toggles, 2);
        prompt.focus();
      } else {
        assert.equal(voice.focusable, false);
        await mouse.click(vx, 0);
        assert.equal(toggles, 2);
      }
      await mouse.moveTo(0, 1);
    }
    setPhase("transcribing");
    const still = await frame();
    assert.match(still, /^↑\s+···$/u);
    assert.equal(attributes("···") & TextAttributes.DIM, 0);
    assert.ok(attributes("↑") & TextAttributes.DIM);
    await new Promise((resolve) => setTimeout(resolve, 220));
    assert.equal(await frame(), still);
    setAnimate(true);
    const moving = await frame();
    assert.match(moving, /^↑\s+\S/u);
    assert.doesNotMatch(moving, /[•●⟨⟩]/u);
    const deadline = performance.now() + 1500;
    let next = moving;
    while (next === moving && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      next = await frame();
    }
    assert.notEqual(next, moving);
    screen.resize(7, 2);
    setPhase("idle");
    assert.match(await frame(), /^↑\s+●$/);
    assert.equal(voice.x + voice.width, 7);
    await mouse.moveTo(voice.x + 1, 0);
    assert.match(await frame(), /^↑\s+●$/);
    assert.equal(voice.x + voice.width, 7);
  } finally {
    screen.renderer.destroy();
  }
});
