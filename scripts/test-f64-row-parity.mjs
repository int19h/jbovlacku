import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const target = resolve(process.env.CARGO_TARGET_DIR ?? "target");
const cargo = (args) => execFileSync("cargo", args, { stdio: "inherit" });
cargo([
  "build",
  "-p",
  "jvc-state",
  "--example",
  "f64_rows",
  "--release",
  "--locked",
  "--jobs",
  "2",
]);
cargo([
  "build",
  "-p",
  "jvc-state",
  "--example",
  "f64_rows_wasm",
  "--target",
  "wasm32-unknown-unknown",
  "--release",
  "--locked",
  "--jobs",
  "2",
]);
const native = JSON.parse(
  execFileSync(resolve(target, "release/examples/f64_rows"), {
    encoding: "utf8",
  }),
);
const output = resolve(target, "f64-row-parity");
execFileSync(
  process.env.WASM_BINDGEN ?? "wasm-bindgen",
  [
    "--target",
    "web",
    "--out-dir",
    output,
    resolve(
      target,
      "wasm32-unknown-unknown/release/examples/f64_rows_wasm.wasm",
    ),
  ],
  { stdio: "inherit" },
);
const { initSync } = await import(
  pathToFileURL(resolve(output, "f64_rows_wasm.js"))
);
const bytes = await readFile(resolve(output, "f64_rows_wasm_bg.wasm"));
const exports = initSync({ module: bytes });
const size = exports.prepare_rows();
const pointer = exports.result_pointer();
const wasm = JSON.parse(
  new TextDecoder().decode(
    new Uint8Array(exports.memory.buffer, pointer, size),
  ),
);
const golden = JSON.parse(
  await readFile("crates/jvc-state/tests/fixtures/f64-rows-v1.json", "utf8"),
);
assert.deepEqual(native, golden);
assert.deepEqual(wasm, golden);
console.log(
  JSON.stringify({
    cases: Object.keys(golden.cases).length,
    native_wasm_bits_equal: true,
    contract: golden.contract,
  }),
);
