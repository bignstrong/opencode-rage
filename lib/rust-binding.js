import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let addon;

// The explicit switch is for replay against the reference implementation.
export function useRust() {
  return process.platform === "darwin" && process.env.RAGE_RUST !== "0";
}

export function rustBinding() {
  if (!useRust()) return null;
  try {
    return addon ??= require("../native/rage.node");
  } catch (cause) {
    throw new Error("Cannot load Rage's macOS addon. Run `npm run build:native` in the plugin checkout.", { cause });
  }
}
