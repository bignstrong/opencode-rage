import { RGBA } from "@opentui/core";
import { rustBinding } from "../../lib/rust-binding.js";

export const stillDots = "···";

export const activityInterval = 170;
export const activityWidth = 15;
export const activityOrange = RGBA.fromHex("#ec5b2b");
export const orbCatalog = {
  cycle: { ru: "Вдох и дождь", en: "Breath and rain" },
  breath: { ru: "Цифровой вдох", en: "Digital breath" },
  rain: { ru: "Цифровой дождь", en: "Digital rain" },
} as const;
export type ActivityMode = keyof typeof orbCatalog;

export function centerFrame(frame: string, width: number) {
  const start = Math.max(0, Math.floor((frame.length - width) / 2));
  const visible = frame.slice(start, start + width);
  if (visible.length && !visible.trim()) {
    const mid = Math.floor(visible.length / 2);
    return `${visible.slice(0, mid)}·${visible.slice(mid + 1)}`;
  }
  return visible;
}
// Single-cell glyphs, including halfwidth katakana. Avoid combining and bidi characters.
export const alphabet = [
  ...new Set(
    "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝЖЯЮБФДЛЦШЩЭЗЧЫЙбзфжλΨφΣξΩβγζηθμπτχδΛπÆØÐÞßøæƒµ0123456789@&%#?§±÷≠≈∑∂∇∆∫∝∞∴∵∷※∗⊕⊗⊙⊥∩∪",
  ),
];
const radius = [0, 1, 2, 4, 5, 6, 7, 7, 7, 6, 5, 4, 3, 2, 1, 0];

/** Pull one frame per tick. In cycle mode, breathe twice, then show rain. */
export function createActivity(mode: ActivityMode = "cycle", random = Math.random) {
  const native = random === Math.random && rustBinding();
  if (native) {
    const orb = new native.Orb(mode, 1 + Math.floor(random() * 2147483646));
    return () => orb.frame() as string;
  }
  const pool = [...alphabet];
  let index = pool.length;
  const glyph = () => {
    if (index === pool.length) {
      // Keep the last 24 draws out of the new bag's first 24 positions.
      const tail = pool.splice(-24);
      for (const bag of [pool, tail]) {
        for (let i = bag.length - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1));
          [bag[i], bag[j]] = [bag[j], bag[i]];
        }
      }
      pool.splice(24, 0, ...tail);
      index = 0;
    }
    return pool[index++];
  };
  let tick = 0;
  const middle = (activityWidth - 1) / 2;
  const lanes = Array.from({ length: activityWidth }, () => ({
    age: Math.floor(random() * 9),
    rest: 6 + Math.floor(random() * 6),
    code: glyph(),
  }));
  return () => {
    const t = tick++;
    const breathe = mode === "breath" || (mode === "cycle" && t % 64 < 32);
    const r = radius[t % radius.length];
    if (breathe && t % radius.length === 0) for (const lane of lanes) lane.code = glyph();
    return lanes
      .map((lane, i) => {
        if (breathe) {
          const d = Math.abs(i - middle);
          if (d === 0) return r === 0 ? "·" : r < 4 ? "•" : "●";
          if (d > r) return " ";
          if (d === r) return i < middle ? "⟨" : "⟩";
          return lane.code;
        }
        if (++lane.age >= lane.rest) {
          lane.age = 0;
          lane.code = glyph();
          lane.rest = 6 + Math.floor(random() * 6);
        }
        return ["˙", lane.code, lane.code, "₁", "."][lane.age] ?? " ";
      })
      .join("");
  };
}
