#!/usr/bin/env bash
set -euo pipefail
jvc_target_dir=${CARGO_TARGET_DIR:-target}/wasm-$(git rev-parse HEAD)
jvc_bindgen=${JVC_WASM_BINDGEN:-wasm-bindgen}
if ! command -v "$jvc_bindgen" >/dev/null 2>&1; then
  echo 'Install wasm-bindgen-cli 0.2.105, or set JVC_WASM_BINDGEN to its executable path.' >&2
  exit 1
fi
if [[ $("$jvc_bindgen" --version) != 'wasm-bindgen 0.2.105' ]]; then
  echo 'This build needs wasm-bindgen-cli 0.2.105 to match the Rust dependency.' >&2
  exit 1
fi
cargo build --release --locked --target wasm32-unknown-unknown --target-dir "$jvc_target_dir" -p jvc-runtime --lib --jobs 2
"$jvc_bindgen" "$jvc_target_dir/wasm32-unknown-unknown/release/jvc_runtime.wasm" --target web --out-dir packages/core/generated --out-name jvc_runtime
cp "$(rustc --print sysroot)/share/doc/rust/COPYRIGHT-library.html" packages/core/generated/rust-standard-library-notices.html
node -e '
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const metadata = {
  schema: 1,
  source_revision: git("rev-parse", "HEAD"),
  source_dirty: git("status", "--porcelain"),
  wasm_sha256: createHash("sha256")
    .update(readFileSync("packages/core/generated/jvc_runtime_bg.wasm"))
    .digest("hex"),
};
writeFileSync(
  "packages/core/generated/jvc_runtime_build.json",
  JSON.stringify(metadata, null, 2) + "\n",
);
'
