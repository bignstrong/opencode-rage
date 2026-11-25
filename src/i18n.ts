import { useRust } from "../lib/rust-binding.js";
import { resolveUiLanguage as reference } from "../lib/i18n.js";
import { rustDomain } from "../lib/rust-domain.js";

export type UiLanguage = "en" | "ru";

export function resolveUiLanguage(preference?: unknown, env = process.env): UiLanguage {
  if (!useRust()) return reference(preference, env);
  const explicit = preference === "en" || preference === "ru";
  // Preserve short-circuit precedence; do not pass the process environment across the binding.
  const source = explicit ? null : env.LC_ALL || env.LC_MESSAGES || env.LANG;
  return rustDomain("preferences", "resolveUiLanguage", {
    preference: explicit ? preference : null,
    env: { LANG: source ? String(source) : "" },
    fallbackLocale: explicit || source ? undefined : Intl.DateTimeFormat().resolvedOptions().locale,
  });
}
