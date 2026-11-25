import { useRust } from "./rust-binding.js";
import { VoiceRuntime as Reference } from "./engine.js";

export * from "./engine.js";
export const VoiceRuntime = useRust()
  ? (await import("../src/native-runtime.js")).NativeRuntime
  : Reference;
