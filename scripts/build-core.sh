#!/usr/bin/env bash
set -euo pipefail
jvc_target_root=${CARGO_TARGET_DIR:-target}
jvc_target_dir=$jvc_target_root
jvc_revision=
jvc_source_dirty=
if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  jvc_revision=$(git rev-parse HEAD)
  jvc_source_dirty=$(git status --porcelain)
  jvc_target_dir=$jvc_target_root/wasm-$jvc_revision
fi
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
export JVC_REVISION="$jvc_revision"
export JVC_SOURCE_DIRTY="$jvc_source_dirty"
node -e '
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const metadata = {
  schema: 1,
  source_revision: process.env.JVC_REVISION || null,
  source_dirty: process.env.JVC_SOURCE_DIRTY ?? null,
  wasm_sha256: createHash("sha256")
    .update(readFileSync("packages/core/generated/jvc_runtime_bg.wasm"))
    .digest("hex"),
};
writeFileSync(
  "packages/core/generated/jvc_runtime_build.json",
  JSON.stringify(metadata, null, 2) + "\n",
);
'
if [[ -n $jvc_revision ]]; then
  for old_target in "$jvc_target_root"/wasm-*; do
    old_name=${old_target##*/}
    if [[ -d $old_target && $old_target != "$jvc_target_dir" && $old_name =~ ^wasm-[0-9a-fA-F]{40}$ ]]; then
      rm -rf -- "$old_target"
    fi
  done
fi
