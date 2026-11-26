import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

// OpenCode exposes its resolved theme read-only; it watches cli.json for edits.
export function applyRageTheme() {
  let file = join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "opencode",
    "cli.json",
  );
  let original: string | undefined;
  let mode = 0o600;
  try {
    file = realpathSync(file);
    original = readFileSync(file, "utf8");
    mode = statSync(file).mode & 0o777;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const text = original ?? "{}\n";
  const errors: ParseError[] = [];
  const config = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !config || typeof config !== "object" || Array.isArray(config)) {
    throw Error("Invalid cli.json");
  }
  if (config.theme?.name === "orng") return;
  const updated = applyEdits(
    text,
    modify(text, ["theme", "name"], "orng", {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  );
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, updated, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, mode);
    if (original !== undefined && original !== readFileSync(file, "utf8"))
      throw Error("cli.json changed");
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}
