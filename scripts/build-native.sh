#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
cargo build --locked --release --manifest-path native/Cargo.toml
cargo build --locked --release --manifest-path native/host/Cargo.toml
cp native/host/target/release/librage_host.dylib native/rage.node.tmp
mv native/rage.node.tmp native/rage.node
node scripts/build-runtime.mjs
