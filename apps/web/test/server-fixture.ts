/**
 * Starts the Node adapter for browser tests with a selected view.
 * JVC_FIXTURE=seeded publishes the synthetic two-root fixture from seed.ts.
 * Otherwise it publishes an empty-root view, as the earlier tests expect.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import {
  initializeCore,
  createEvent,
} from "../../../packages/core/src/index.ts";
import { admit, buildFixture } from "./seed.ts";
/**
 * The test readiness signal. The runner waits for this listener to answer
 * 200, which happens only after every fixture record is admitted and the
 * fixture file is complete. The API's own routes answer earlier, while
 * preparation is still running, so they are not the signal. A preparation
 * failure ends this process with the error, and the runner reports it.
 */
const readyPort = process.env.JVC_READY_PORT;
let prepared = false;
if (readyPort) {
  const listener = createServer((request, response) => {
    if (request.url !== "/ready") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(prepared ? 200 : 503, { "content-type": "text/plain" });
    response.end(prepared ? "ready\n" : "preparing the fixture\n");
  });
  listener.unref();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(Number(readyPort), "127.0.0.1", resolve);
  });
}
process.on("unhandledRejection", (error) => {
  console.error("Fixture preparation failed:", error);
  process.exit(1);
});
await initializeCore(
  await readFile(
    new URL(
      "../../../packages/core/generated/jvc_runtime_bg.wasm",
      import.meta.url,
    ),
  ),
);
const origin = `http://127.0.0.1:${process.env.PORT ?? 8797}`;
const seeded = process.env.JVC_FIXTURE === "seeded";
let events: { envelope: { id: string } }[] = [];
let view: { envelope: { id: string }; body: unknown };
let fixture: unknown = null;
let selection: string | undefined;
if (seeded) {
  const built = await buildFixture(origin);
  events = built.events;
  view = built.view;
  fixture = built.fixture;
  selection = built.selection;
} else {
  const fixtureSeed = new Uint8Array(32).fill(37);
  view = createEvent(
    fixtureSeed,
    [],
    "e".repeat(32),
    { kind: "view.publish", parents: [] },
    {
      name: "Browser test view",
      description: [],
      roots: [],
      rafsi_threshold: { numerator: 1, denominator: 1 },
      H: { numerator: 3, denominator: 1 },
      alpha: { numerator: 1, denominator: 2 },
      excluded: [],
      calculation: "simple-routes-bounds-v1",
      work: 1000,
      import_sets: [],
      account_witnesses: [],
      account_authority: false,
      notes: [],
    },
  );
  fixtureSeed.fill(0);
}
process.env.JVC_VIEW = view.envelope.id;
await import("../../../apps/server/src/main.ts");
for (let attempt = 0; attempt < 200; attempt++) {
  try {
    const response = await fetch(`${origin}/api/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(view),
    });
    if (!response.ok)
      throw new Error(`Fixture view admission failed (${response.status}).`);
    break;
  } catch (error) {
    if (attempt === 199) throw error;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
if (seeded) {
  // A harness knob for readiness tests: preparation waits this long before
  // the admissions, so a runner that starts early would see no fixture.
  const delay = Number(process.env.JVC_FIXTURE_DELAY_MS ?? 0);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  await admit(origin, events, view, selection);
  if (process.env.JVC_FIXTURE_OUT) {
    // The file appears complete or not at all.
    const partial = `${process.env.JVC_FIXTURE_OUT}.partial`;
    await writeFile(partial, JSON.stringify(fixture, null, 2));
    await rename(partial, process.env.JVC_FIXTURE_OUT);
  }
}
prepared = true;
