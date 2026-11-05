import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
const target = resolve(process.env.CARGO_TARGET_DIR ?? "target");
for (const [example, args] of [
  ["f64_kernel", []],
  ["f64_kernel_wasm", ["--target", "wasm32-unknown-unknown"]],
]) {
  execFileSync(
    "cargo",
    [
      "build",
      "-p",
      "jvc-rank",
      "--example",
      example,
      "--release",
      "--locked",
      "--jobs",
      "2",
      ...args,
    ],
    { stdio: "inherit" },
  );
}
const native = execFileSync(resolve(target, "release/examples/f64_kernel"), {
  encoding: "utf8",
});
const bytes = await readFile(
  resolve(
    target,
    "wasm32-unknown-unknown/release/examples/f64_kernel_wasm.wasm",
  ),
);
const module = await WebAssembly.compile(bytes);
assert.deepEqual(WebAssembly.Module.imports(module), []);
const instance = await WebAssembly.instantiate(module);
const length = instance.exports.run_suite();
const pointer = instance.exports.output_pointer();
const wasm = new TextDecoder().decode(
  new Uint8Array(instance.exports.memory.buffer, pointer, length),
);
assert.equal(wasm, native);
console.log(
  JSON.stringify({
    cases: native.trim().split("\n").length,
    native_wasm_bits_and_work_equal: true,
  }),
);
