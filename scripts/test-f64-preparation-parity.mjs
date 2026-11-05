import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const directory = process.env.JVC_PREPARATION_PARITY_DIR;
assert(
  directory,
  "Set JVC_PREPARATION_PARITY_DIR before generating the native corpus.",
);
const generated = resolve("packages/core/generated");
const wasm = await import(pathToFileURL(resolve(generated, "jvc_runtime.js")));
wasm.initSync({
  module: await readFile(resolve(generated, "jvc_runtime_bg.wasm")),
});
const utf8 = (value) => new TextEncoder().encode(JSON.stringify(value));
const normalize = (value) => {
  const copy = structuredClone(value);
  delete copy.owner_session;
  delete copy.preparation_id;
  return copy;
};
const files = (await readdir(directory))
  .filter((f) => f.endsWith(".json"))
  .sort();
assert(
  files.length >= 8,
  "Generate every native preparation case before this comparison.",
);
for (const file of files) {
  const row = JSON.parse(await readFile(resolve(directory, file), "utf8"));
  const input = JSON.parse(row.input);
  const { events, bodies, ...options } = input;
  const original = new wasm.EvaluationSession(utf8(input));
  const saved = original.checkpoint("preparation-parity");
  const records = input.events.map((envelope) => {
    const id = JSON.parse(envelope).id;
    const body = input.bodies[id];
    return JSON.parse(
      new TextDecoder().decode(
        wasm.extract_host_verified_record(
          new TextEncoder().encode(envelope),
          body === undefined ? undefined : new TextEncoder().encode(body),
        ),
      ),
    );
  });
  const builder = new wasm.EvaluationSessionBuilder(utf8(options));
  for (const record of records) builder.add_host_verified_record(utf8(record));
  const sessions = [
    original,
    builder.finish(),
    original.fork(utf8(options)).finish(),
    wasm.EvaluationSession.restore_host_checkpoint(saved, "preparation-parity"),
    wasm.EvaluationSession.restore_host_result_checkpoint(
      original.result_checkpoint("preparation-parity"),
      "preparation-parity",
      utf8(records),
    ),
  ];
  try {
    for (const session of sessions) {
      assert.equal(session.ranking_preparation(), "null");
      const state = session.state();
      const descriptor = JSON.parse(
        session.ranking_descriptor(utf8(row.policy)),
      );
      assert.deepEqual(normalize(descriptor), row.descriptor, file);
      const request = {
        owner_session: descriptor.owner_session,
        descriptor_binding: descriptor.binding,
        word: row.word,
      };
      const summary = JSON.parse(session.prepare_ranking(utf8(request)));
      assert.deepEqual(normalize(summary), row.summary, file);
      const before = session.ranking_preparation();
      assert.throws(
        () =>
          session.prepare_ranking(utf8({ ...request, owner_session: "stale" })),
        /stale_binding/,
      );
      assert.throws(
        () =>
          session.prepare_ranking(
            utf8({ ...request, descriptor_binding: "stale" }),
          ),
        /stale_binding/,
      );
      assert.equal(session.ranking_preparation(), before);
      assert.equal(session.state(), state);
      assert.throws(() => session.rank(row.word), /unsupported_calculation/);
      session.clear_ranking_preparation();
      session.clear_ranking_preparation();
      assert.equal(
        JSON.parse(session.ranking_preparation()).retained_graphs,
        0,
      );
    }
    assert.deepEqual(original.checkpoint("preparation-parity"), saved);
  } finally {
    for (const session of sessions) session.free();
  }
}
console.log(
  JSON.stringify({
    cases: files.length,
    session_paths: 5,
    native_wasm_bindings_and_graph_metadata_equal: true,
  }),
);
