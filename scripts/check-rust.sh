#!/bin/bash
# macOS V2 fixture audit. Build the dirty working tree in scratch, never the checkout.
set -euo pipefail
umask 077
[[ $(uname -s) == Darwin ]] || { echo 'Requires macOS.' >&2; exit 2; }
archive=
case "${1:-fixtures}:$#" in fixtures:0|--release-inputs:1) ;; --release-inputs:2) archive=$(realpath "$2");; *)
  echo 'Usage: bash scripts/check-rust.sh [--release-inputs [trusted-package.tgz]]' >&2; exit 2;;
esac
cd "$(dirname "$0")/.."
base=${TMPDIR:-/tmp}
work=$(mktemp -d "${base%/}/rage-audit.XXXXXX")
# macOS Unix socket paths are limited to 104 bytes (mock fetch uses a socket).
short=$(mktemp -d "${RAGE_IPC_TMPDIR:-/tmp}/rage-ipc.XXXXXX")
trap 'rm -rf "$work" "$short"' EXIT
mkdir -p "$work"/{src,ref,home/.cargo}
profile='(version 1)(allow default)(deny device-microphone)(deny network-outbound (remote ip "*:*"))(deny network-bind (local ip "*:*"))(deny process-exec (literal "/usr/bin/pbcopy")(literal "/usr/bin/pbpaste"))'
run() {
  echo "+ $*" >&2
  /usr/bin/sandbox-exec -p "$profile" /usr/bin/env -i \
    HOME="$work/home" TMPDIR="$short" PATH="$PATH" \
    XDG_CONFIG_HOME="$work/home/config" XDG_STATE_HOME="$work/home/state" \
    XDG_CACHE_HOME="$work/home/cache" XDG_DATA_HOME="$work/home/data" \
    RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}" CARGO_NET_OFFLINE=true npm_config_offline=true RAGE_REFERENCE_ROOT="$work/ref" "$@"
}
verify_archive() (
  cd "$work"
  shasum -a 256 "$1"
  tar -xzf "$1"
  cd package
  for f in src/tui.ts lib/runtime.js src/native-runtime.js rage/core.js; do
    [[ -s $f ]] || { echo "Missing packed file: $f" >&2; exit 1; }
  done
  run node -e 'if (typeof require("./native/rage.node").Session !== "function") process.exit(1)'
  run ./native/target/release/rage-core cli --help
  local missing=0
  for f in native/rage.node native/target/release/rage-core; do
    lipo -archs "$f"
    codesign --verify "$f"
    for arch in arm64 x86_64; do
      lipo -verify_arch "$arch" "$f" || { echo "Missing $arch slice: $f" >&2; missing=1; }
    done
  done
  if (( missing )); then exit "${2:-1}"; fi
)
if [[ -n $archive ]]; then verify_archive "$archive"; exit; fi
if [[ ${1:-} != --release-inputs ]]; then
  bun=${BUN:-$(command -v bun || true)}
  [[ -x $bun ]] || { echo 'Set BUN to an installed Bun with native OpenTUI support.' >&2; exit 2; }
  bun=$(realpath "$bun")
  tar -xzf rust/qa/fixtures/voice-reference.tar.gz -C "$work/ref"
  ln -s "$work/src/node_modules" "$work/ref/node_modules"
fi
git ls-files -co --exclude-standard -z | rsync -a --from0 --files-from=- ./ "$work/src/"
cp -cR node_modules "$work/src/node_modules"
cp -cR "${CARGO_HOME:-$HOME/.cargo}/registry" "$work/home/.cargo/registry"
cd "$work/src"
run sh scripts/build-native.sh
if [[ ${1:-} == --release-inputs ]]; then
  universal=1
  for target in {aarch64,x86_64}-apple-darwin; do
    libdir=$(run rustc --print target-libdir --target "$target")
    if ! compgen -G "$libdir/libstd-*.rlib" >/dev/null; then
      echo "Missing offline Rust target: $target. Checking a host-only package." >&2
      universal=0; break
    fi
  done
  if (( universal )); then
    for target in {aarch64,x86_64}-apple-darwin; do
      for manifest in native/{,host/}Cargo.toml; do
        run cargo build --offline --locked --release --target "$target" --manifest-path "$manifest"
      done
    done
    lipo -create native/target/{aarch64,x86_64}-apple-darwin/release/rage-core -output native/target/release/rage-core
    lipo -create native/host/target/{aarch64,x86_64}-apple-darwin/release/librage_host.dylib -output native/rage.node
    for f in native/target/release/rage-core native/rage.node; do codesign --force --sign - "$f"; done
  fi
  run npm pack --offline --ignore-scripts --loglevel=error --pack-destination "$work"
  verify_archive "$work"/*.tgz "$((2-universal))"
  exit
fi
shasum -a 256 native/rage.node native/target/release/rage-core src/tui.ts src/ensure.ts src/native-runtime.ts
failed=0
check() {
  run "$@" || { echo "FAILED: $*" >&2; failed=1; }
}
# Discovery succeeds; AVFoundation then rejects the pinned input before its first sample.
# Both runtimes must trigger the controller's "choose another microphone" branch.
cat >"$short/fixture-input" <<'SH'
#!/bin/sh
case " $* " in
  *' -list_devices '*) echo 'AVFoundation audio devices:' >&2; echo '[0] Fixture  [uid:1]' >&2; exit 1;;
esac
echo 'capture' >>"$HOME/open-attempts"
echo '[avfoundation @ 0x1] Failed to create AV capture input device' >&2
exit 1
SH
chmod 700 "$short/fixture-input"
for mode in 0 1; do
  check env RAGE_RUST="$mode" RAGE_FFMPEG="$short/fixture-input" node --input-type=module <<'JS'
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
const entry = process.env.RAGE_RUST === "1" ? "./lib/runtime.js"
  : pathToFileURL(`${process.env.RAGE_REFERENCE_ROOT}/lib/engine.js`).href;
const { VoiceRuntime } = await import(entry);
const rt = new VoiceRuntime({ downloadDir: process.env.HOME, ffmpeg: process.env.RAGE_FFMPEG });
const calls = `${process.env.HOME}/open-attempts`;
rmSync(calls, { force: true });
try {
  await assert.rejects(rt.start({ mic: ":uid:1:Fixture" }), e => {
    assert.equal(readFileSync(calls, "utf8"), "capture\n");
    assert.match(e.message, /Failed to create AV capture input device/);
    assert.equal(e.code, "VOICE_MIC_UNAVAILABLE", "pinned open failure must offer a replacement mic");
    return true;
  });
} finally { await rt.cancel(); }
JS
done
check node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
check node --input-type=module -e '
  import assert from "node:assert/strict";
  import { VoiceRuntime } from "@bignstrong/rage/runtime";
  import plugin from "@bignstrong/rage/tui";
  assert.equal(process.env.RAGE_RUST, undefined);
  assert.equal(VoiceRuntime.name, "NativeRuntime");
  assert.equal(typeof plugin.setup, "function");'
check cargo test --offline --locked --manifest-path native/Cargo.toml --bin rage-core -- --skip install::tests::
check cargo test --offline --locked --manifest-path native/Cargo.toml --test capture_inference
check cargo test --offline --locked --manifest-path native/Cargo.toml --test catalog_preferences -- --include-ignored --nocapture
for mode in 0 1; do
  check env RAGE_RUST="$mode" node --test test/{tui-v2,controller-shared,voice-race,agent-activity,recorder-parity,engine-install-security,model-download-safety}.test.js
  check env RAGE_RUST="$mode" "$bun" --conditions=browser test test/{voice-button,live-mic-picker}.test.js
done
check env RAGE_RUST=1 node --test test/rust-domain-parity.test.js rage/core.test.ts
check node rust/orbs-parity.mjs
check node rust/layout-parity.mjs
check node --conditions=browser rust/picker-parity.mjs
check node --experimental-test-module-mocks rust/dialog-extra-parity.mjs
check node rust/readiness-parity.mjs
check node rust/cli-parity.mjs
check node rust/qa/runtime-packed.mjs
(( failed == 0 )) || exit 1
echo 'Offline Mac V2 fixtures passed. Installed TUI and physical devices were not exercised.'
