/** Resolve terminal message language, independently of the transcription language. */
export function resolveUiLanguage(preference, env = process.env) {
  if (preference === "ru" || preference === "en") return preference;
  const locale = env.LC_ALL || env.LC_MESSAGES || env.LANG || Intl.DateTimeFormat().resolvedOptions().locale;
  return /^ru(?:[-_.@]|$)/i.test(locale) ? "ru" : "en";
}
