# Developing Rage

On macOS, install Cargo, Xcode Command Line Tools and Node.js 24 or newer. From the repository root:

```sh
npm ci
npm run build:native
npm run check
cargo test --manifest-path native/Cargo.toml
```

Run checks locally before submitting a change. Use synthetic audio for recording tests; never commit microphone recordings, downloaded models or credentials.

The [architecture overview](README.md#how-rage-works) identifies the Rust core, native addon and TypeScript host adapter. For tests against a packaged plugin in a real terminal, see [the macOS test guide](rust/qa/README.md).
