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
  files.length >= 19,
  "Generate every native preparation case before this comparison.",
);
let metadataBoundaries = 0;
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
      if (row.error) {
        assert.throws(
          () => session.prepare_ranking(utf8(request)),
          new RegExp(row.error),
        );
        assert.equal(session.state(), state);
        continue;
      }
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
      const refusedPolicy = {
        ...row.policy,
        limits: { ...row.policy.limits, records: 1 },
      };
      assert.throws(
        () => session.ranking_descriptor(utf8(refusedPolicy)),
        /resource_unavailable/,
      );
      assert.equal(session.ranking_preparation(), "null");
      assert.throws(
        () => session.prepare_ranking(utf8(request)),
        /ranking_preparation/,
      );
      const restored = JSON.parse(session.ranking_descriptor(utf8(row.policy)));
      assert.deepEqual(normalize(restored), row.descriptor);
      const recovered = JSON.parse(session.prepare_ranking(utf8(request)));
      assert.deepEqual(normalize(recovered), row.summary);
      const metadataBytes = new TextEncoder().encode(
        session.ranking_preparation(),
      ).length;
      if (
        metadataBytes >
        new TextEncoder().encode(JSON.stringify(restored)).length
      ) {
        const boundaryPolicy = {
          ...row.policy,
          limits: { ...row.policy.limits, metadata_bytes: metadataBytes },
        };
        const boundary = JSON.parse(
          session.ranking_descriptor(utf8(boundaryPolicy)),
        );
        const boundaryRequest = {
          ...request,
          descriptor_binding: boundary.binding,
        };
        session.prepare_ranking(utf8(boundaryRequest));
        assert.equal(
          new TextEncoder().encode(session.ranking_preparation()).length,
          metadataBytes,
        );
        const below = JSON.parse(
          session.ranking_descriptor(
            utf8({
              ...boundaryPolicy,
              limits: {
                ...boundaryPolicy.limits,
                metadata_bytes: metadataBytes - 1,
              },
            }),
          ),
        );
        assert.throws(
          () =>
            session.prepare_ranking(
              utf8({ ...request, descriptor_binding: below.binding }),
            ),
          /resource_unavailable/,
        );
        assert.equal(
          JSON.parse(session.ranking_preparation()).retained_graphs,
          0,
        );
        metadataBoundaries += 1;
      }
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
assert(metadataBoundaries > 0);
console.log(
  JSON.stringify({
    cases: files.length,
    metadata_boundaries: metadataBoundaries,
    session_paths: 5,
    native_wasm_bindings_and_graph_metadata_equal: true,
  }),
);

// Refused evaluations can retain raw overlays that validation never reached.
const resourceRow = JSON.parse(await readFile(resolve(directory, files[0]), "utf8"));
const rawOverlay = { trust: [{ issuer: 1 }] };
const smallPolicy = {
  core_binding: `sha256:${"a".repeat(64)}`,
  limits: { setup_bytes: 1, setup_units: 1 },
};
for (const limits of [{ events: 1 }, { traversal: 0 }]) {
  const input = { ...JSON.parse(resourceRow.input), limits, overlay: rawOverlay };
  const session = new wasm.EvaluationSession(utf8(input));
  try {
    const descriptor = JSON.parse(session.ranking_descriptor(utf8(smallPolicy)));
    assert.equal(descriptor.available, false);
    assert(descriptor.reasons.includes("resource_unavailable"));
    assert.equal(descriptor.setup.setup_bytes, 0);
    assert.equal(descriptor.setup.setup_units, 0);
    assert.equal(JSON.parse(session.state()).available, false);
  } finally {
    session.free();
  }
}
const resourceOriginal = new wasm.EvaluationSession(utf8(JSON.parse(resourceRow.input)));
try {
  const checkpoint = JSON.parse(new TextDecoder().decode(resourceOriginal.checkpoint("raw-overlay")));
  checkpoint.options.overlay = rawOverlay;
  checkpoint.evaluation.overlay = rawOverlay;
  for (const available of [false, true]) {
    checkpoint.evaluation.available = available;
    checkpoint.evaluation.reasons = available ? [] : ["resource_unavailable"];
    const restored = wasm.EvaluationSession.restore_host_checkpoint(utf8(checkpoint), "raw-overlay");
    try {
      if (available) {
        assert.throws(() => restored.ranking_descriptor(utf8(resourceRow.policy)), /invalid_overlay/);
      } else {
        const descriptor = JSON.parse(restored.ranking_descriptor(utf8(smallPolicy)));
        assert.equal(descriptor.available, false);
        assert.equal(descriptor.setup.setup_bytes, 0);
        assert.equal(descriptor.setup.setup_units, 0);
      }
      assert.equal(JSON.parse(restored.state()).available, available);
    } finally {
      restored.free();
    }
  }
} finally {
  resourceOriginal.free();
}
console.log(JSON.stringify({ unavailable_and_malformed_overlay_wasm_cases: 4, session_handles_remain_usable: true }));
