# Managed engine release: `engines-v1`

Default registry: `https://github.com/bignstrong/opencode-rage/releases/download/engines-v1/registry.json`

| File | SHA-256 |
| --- | --- |
| Original `ihxnnxs/opencode-voice` v0.2.0 registry | `4cd542a78b0ad73df5e6befc26eff0539e42b33e48b3b7d0462119f45979da3b` |
| Rage `registry.json` (exact uploaded bytes, including final LF) | `d2d7dd0f4921f20fb52d00078c2b0250f31e655aa182a9a983f7d53c55e4b406` |
| `ENGINE-LICENSES.zip` | `048c4c09f1b27a784916b7739190ea74fbb8e1b5dfbd4f4726806e7e36e41abb` |

Both installers pin the Rage registry. Only the ten asset URLs changed.
Both engines retain darwin-arm64, darwin-x64, linux-arm64, linux-x64 and win32-x64.
The registry version `v1.8.2` refers to Whisper; the sidecar uses `transcribe-cpp` 0.1.3.
See [NOTICE.txt](../assets/engines-v1/NOTICE.txt) for build provenance and license sources.

## Prepare or verify release files

Run from the repository root. The prepared upload directory is `dist/engines-v1-review/candidate/`.
To recreate it in a new directory, retrieve the original release first:

```sh
set -eu
mkdir -p dist
stage=$(mktemp -d "$PWD/dist/engines-v1-XXXXXX")
gh release download v0.2.0 -R ihxnnxs/opencode-voice -D "$stage" -p 'registry.json' -p '*.gz'
cmp "$stage/registry.json" assets/engines-v1/upstream-registry.json
for name in registry.json NOTICE.txt ENGINE-LICENSES.zip; do
  cp "assets/engines-v1/$name" "$stage/"
done
```

Verify with `stage` pointing at the directory to inspect. The same check works after downloading the published release:

```sh
python3 - "$stage" <<'PY'
import gzip, hashlib, json, sys
from pathlib import Path
stage = Path(sys.argv[1])
metadata = Path("assets/engines-v1")
sha = lambda b: hashlib.sha256(b).hexdigest()
original = (metadata / "upstream-registry.json").read_bytes()
assert sha(original) == "4cd542a78b0ad73df5e6befc26eff0539e42b33e48b3b7d0462119f45979da3b"
current = (stage / "registry.json").read_bytes()
assert sha(current) == "d2d7dd0f4921f20fb52d00078c2b0250f31e655aa182a9a983f7d53c55e4b406"
expected = json.loads(original)
names = {"registry.json", "NOTICE.txt", "ENGINE-LICENSES.zip"}
for engine in expected["engines"].values():
    for platform, asset in engine["assets"].items():
        name = asset["url"].split("/")[-1]
        data = (stage / name).read_bytes()
        assert (len(data), sha(data)) == (asset["size"], asset["sha256"]), name
        binary = gzip.decompress(data)
        assert (len(binary), sha(binary)) == (asset["binary"]["size"], asset["binary"]["sha256"]), name
        names.add(name)
        asset["url"] = "https://github.com/bignstrong/opencode-rage/releases/download/engines-v1/" + name
        print(engine["id"], platform, "archive and binary verified")
assert json.loads(current) == expected
assert {p.name for p in stage.iterdir()} == names
assert (stage / "NOTICE.txt").read_bytes() == (metadata / "NOTICE.txt").read_bytes()
assert sha((stage / "ENGINE-LICENSES.zip").read_bytes()) == "048c4c09f1b27a784916b7739190ea74fbb8e1b5dfbd4f4726806e7e36e41abb"
PY
unzip -tq "$stage/ENGINE-LICENSES.zip"
```

Publish the **verified 13 files** together as `engines-v1` before shipping an installer with this pin.
Do not upload the source registry, review workspace, or an automatically regenerated registry.
Once the owner has reviewed the files and pushed the `engines-v1` tag, the owner can create a draft:

```sh
gh release create engines-v1 -R bignstrong/opencode-rage --verify-tag --draft --latest=false \
  --title 'Managed transcription engines v1' --notes-file "$stage/NOTICE.txt" \
  "$stage/registry.json" "$stage/NOTICE.txt" "$stage/ENGINE-LICENSES.zip" "$stage/"*.gz
```

To verify the public bytes, download into a fresh directory and repeat the check above:

```sh
stage=$(mktemp -d "$PWD/dist/engines-v1-live-XXXXXX")
gh release download engines-v1 -R bignstrong/opencode-rage -D "$stage"
```

## Installer tests and clean-cache smoke check

```sh
RAGE_RUST=0 node --test test/engine-install-security.test.js
# On macOS, rebuild both native consumers of the pin:
npm run build:native
RAGE_RUST=1 node --test test/engine-install-security.test.js
cargo test --locked --manifest-path native/Cargo.toml --bin rage-core install::tests
```

After publication, run on the target OS/architecture. No model or microphone needed:

```sh
(
  set -eu
  unset OPENCODE_VOICE_ENGINE_REGISTRY OPENCODE_VOICE_ENGINE_REGISTRY_SHA256
  export OPENCODE_VOICE_DIR="$(mktemp -d)"
  for engine in whisper.cpp transcribe-cpp; do
    ./bin/rage engine install "$engine"
    ./bin/rage engine status "$engine" --json
  done
)
```

Each new manifest must report the Rage `engines-v1` registry, a Rage asset URL, and the matching binary SHA-256.
Use a new cache per run; a healthy existing engine skips the download.
