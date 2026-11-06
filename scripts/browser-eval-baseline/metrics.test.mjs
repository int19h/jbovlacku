import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { distribution, profileSummary } from "./metrics.mjs";
import { rendererLimiter } from "./limits.mjs";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
test("nearest-rank distributions retain zeros and exclude non-finite observations", () => {
  assert.deepEqual(distribution([]), {
    n: 0,
    min: null,
    p50: null,
    p90: null,
    p95: null,
    p99: null,
    max: null,
    mean: null,
  });
  assert.deepEqual(distribution([4, 0, 2, NaN, Infinity]), {
    n: 3,
    min: 0,
    p50: 2,
    p90: 4,
    p95: 4,
    p99: 4,
    max: 4,
    mean: 2,
  });
});
test("profile categories use ancestry callers and keep idle time separate", () => {
  const names = [
    "(root)",
    "jvc_state::graph::Graph::build_cache",
    "memcpy",
    "ed25519_dalek::verify",
    "jvc_rank::rank",
    "(idle)",
    "(garbage collector)",
  ];
  const nodes = names.map((name, id) => ({
    id,
    callFrame: { functionName: name },
    children: id === 0 ? [1, 3, 4, 5, 6] : id === 1 ? [2] : [],
  }));
  const summary = profileSummary({
    nodes,
    samples: [2, 3, 4, 5, 6],
    timeDeltas: [10, 20, 30, 40, 50],
  });
  assert.equal(summary.ancestry_us, 10);
  assert.equal(summary.signature_us, 20);
  assert.equal(summary.ranking_us, 30);
  assert.equal(summary.idle_us, 40);
  assert.equal(summary.gc_us, 50);
});
test("the renderer limiter resumes its owned process after cancellation", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  const state = async () => {
    try {
      return (await readFile(`/proc/${child.pid}/stat`, "utf8"))
        .split(") ")[1]
        .split(" ")[0];
    } catch {
      return null;
    }
  };
  let limiter;
  try {
    limiter = await rendererLimiter(
      {
        send: async () => ({
          processInfo: [{ type: "renderer", id: child.pid }],
        }),
      },
      6,
    );
    for (let i = 0; i < 100 && (await state()) !== "T"; i++) await delay(5);
    assert.equal(await state(), "T");
    await limiter.stop();
    await delay(100);
    assert.notEqual(await state(), "T");
  } finally {
    await limiter?.stop();
    child.kill("SIGCONT");
    child.kill("SIGTERM");
    await once(child, "exit");
  }
});

test("ancestry storage bounds apply only to complete single-parent histories", async () => {
  const { ancestryShape } = await import("./ancestry.mjs");
  const chain = Array.from({ length: 100 }, (_, i) => ({
    id: String(i),
    issuer: "a",
    previous: i ? [String(i - 1)] : [],
    kind: "definition.publish",
  }));
  const m = ancestryShape(chain);
  assert.equal(m.single_parent_model_valid, true);
  assert.equal(m.max_chain_depth, 100);
  assert.equal(m.wasm32_dense_payload_per_closure, 16);
  assert.equal(m.dense_closures, 96);
  assert.equal(m.minimum_identifier_payload_bytes, 1576);
  chain.push({
    id: "join",
    issuer: "a",
    previous: ["1", "2"],
    kind: "definition.publish",
  });
  assert.equal(ancestryShape(chain).minimum_identifier_payload_bytes, null);
});
