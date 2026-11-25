// Run after `npm run build:native`. No registry requests or install scripts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "darwin", "requires the macOS native build");
const qa = dirname(fileURLToPath(import.meta.url));
const repo = join(qa, "../..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "rage-packed-runtime-")));
try {
  const app = join(root, "consumer");
  mkdirSync(app);
  const env = {
    PATH: process.env.PATH, HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
    npm_config_cache: join(root, "npm-cache"), npm_config_offline: "true",
    npm_config_globalconfig: "/dev/null",
  };
  for (const dir of [env.HOME, env.TMPDIR]) mkdirSync(dir);
  const npm = (cwd, args) => execFileSync("npm", args, { cwd, env, encoding: "utf8" });
  const [pack] = JSON.parse(npm(repo, ["pack", "--ignore-scripts", "--pack-destination", root, "--json"]));
  // Seed only dependencies from the checkout. Install the plugin itself from the tarball.
  execFileSync("/bin/cp", ["-cR", join(repo, "node_modules"), join(app, "node_modules")]);
  assert.throws(() => realpathSync(join(app, "node_modules/@bignstrong/rage")), { code: "ENOENT" });
  const { dependencies, overrides } = JSON.parse(readFileSync(join(repo, "package.json")));
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "runtime-consumer", private: true, dependencies, overrides }));
  copyFileSync(join(repo, "package-lock.json"), join(app, "package-lock.json"));
  npm(app, ["install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", join(root, pack.filename)]);
  const help = execFileSync(join(app, "node_modules/.bin/rage"), ["--help"], {
    cwd: app, env: { ...env, PATH: "/nonexistent", RAGE_RUST: "0" }, encoding: "utf8",
  });
  assert.match(help, /rage doctor/);
  for (const file of ["runtime-consumer.mjs", "runtime-engine.mjs", "runtime-sox.mjs"]) copyFileSync(join(qa, file), join(app, file));
  for (const mode of ["0", "1"]) {
    const work = join(root, `mode-${mode}`);
    const tmp = join(work, "scratch");
    mkdirSync(tmp, { recursive: true });
    console.log(`Packed ${pack.id}, Node ${process.version}, RAGE_RUST=${mode}`);
    execFileSync(process.execPath, ["--test", "--test-concurrency=1", "runtime-consumer.mjs", ...(mode === "1" ? ["runtime-sox.mjs"] : [])], {
      cwd: app, env: { ...env, RAGE_RUST: mode, QA_WORK: work, TMPDIR: tmp }, stdio: "inherit", timeout: 45_000,
    });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
