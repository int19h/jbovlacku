import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const directory = process.env.JVC_WORD_RESULT_PARITY_DIR;
assert(directory, "Set JVC_WORD_RESULT_PARITY_DIR before generating native rows.");
const generated = resolve("packages/core/generated");
const wasm = await import(pathToFileURL(resolve(generated, "jvc_runtime.js")));
wasm.initSync({ module: await readFile(resolve(generated, "jvc_runtime_bg.wasm")) });
const utf8 = (v) => new TextEncoder().encode(JSON.stringify(v));
const normalize = (v) => {
  delete v.progress.token;
  return v;
};
const files = (await readdir(directory)).filter((f) => f.endsWith(".json")).sort();
assert.equal(files.length, 10, "Generate every native word-result case.");
let comparisons = 0;
for (const file of files) {
  const row = JSON.parse(await readFile(resolve(directory, file), "utf8"));
  const input = JSON.parse(row.input);
  for (const step of [1, 4096]) {
    const fresh = new wasm.EvaluationSession(utf8(input));
    const restored = wasm.EvaluationSession.restore_host_checkpoint(
      fresh.checkpoint("word-result-parity"), "word-result-parity",
    );
    const { events, bodies, ...options } = input;
    const fork = fresh.fork(utf8(options)).finish();
    for (const session of [fresh, restored, fork]) {
      try {
        const state = session.state();
        const descriptor = JSON.parse(session.ranking_descriptor(utf8({
          core_binding: `sha256:${"a".repeat(64)}`,
        })));
        const prepared = JSON.parse(session.prepare_ranking(utf8({
          owner_session: descriptor.owner_session,
          descriptor_binding: descriptor.binding,
          word: row.word,
        })));
        const start = JSON.parse(session.start_word_results(utf8({
          owner_session: descriptor.owner_session,
          descriptor_binding: descriptor.binding,
          preparation_id: prepared.preparation_id,
          policy: row.policy,
        })));
        const before = session.word_result_progress();
        assert.throws(() => session.step_word_results(start.token, 0), /ranking_step/);
        assert.throws(() => session.step_word_results("stale", 1), /stale_binding/);
        assert.equal(session.word_result_progress(), before);
        let progress = start;
        for (let i = 0; progress.phase === "running" && i < 200000; i++) {
          progress = JSON.parse(session.step_word_results(start.token, step));
        }
        assert.equal(progress.phase, "ready", file);
        const bytes = session.take_word_result(start.token);
        const result = normalize(JSON.parse(new TextDecoder().decode(bytes)));
        assert.deepEqual(result, row.expected, `${file}, step ${step}`);
        assert.throws(() => session.take_word_result(start.token), /ranking_result/);
        assert.equal(session.word_result_progress(), "null");
        assert.equal(session.state(), state);
        comparisons += 1;
      } finally {
        session.free();
      }
    }
  }
}
console.log(JSON.stringify({ cases: files.length, step_sizes: 2, session_paths: 3,
  comparisons, native_wasm_word_results_equal: true }));
