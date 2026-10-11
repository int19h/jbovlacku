import { readFile } from "node:fs/promises";
import {
  initializeCore,
  createEvent,
} from "../../../packages/core/src/index.ts";
await initializeCore(
  await readFile(
    new URL(
      "../../../packages/core/generated/jvc_runtime_bg.wasm",
      import.meta.url,
    ),
  ),
);
const fixtureSeed = new Uint8Array(32).fill(37);
const view = createEvent(
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
process.env.JVC_VIEW = view.envelope.id;
await import("../../../apps/server/src/main.ts");
const origin = `http://127.0.0.1:${process.env.PORT ?? 8797}`;
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
