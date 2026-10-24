import { expect, test } from "@playwright/test";
import { corePath } from "./helpers.ts";

test("the browser worker rejects forged records beside a host verification result", async ({
  page,
}) => {
  await page.goto("/");
  const results = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const record = core.createEvent(
      new Uint8Array(32).fill(92),
      [],
      "1".repeat(32),
      { kind: "identity.merge" },
      null,
    );
    const envelope = core.utf8(JSON.stringify(record.envelope));
    const compact = JSON.parse(core.extractHostVerifiedRecord(envelope));
    const worker = new Worker(
      new URL("/src/workers/evaluate.ts", location.href),
      { type: "module" },
    );
    const send = (input: unknown) =>
      new Promise<{ type: string; message?: string }>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(new Error("The browser evaluation worker did not answer.")),
          10000,
        );
        worker.onmessage = (event) => {
          clearTimeout(timer);
          resolve(event.data);
        };
        worker.onerror = (event) => {
          clearTimeout(timer);
          reject(new Error(event.message));
        };
        worker.postMessage({
          type: "load",
          id: 1,
          session: "host-boundary",
          input,
        });
      });
    const input = {
      events: [JSON.stringify(record.envelope)],
      bodies: {},
      selected_view: "jve1:" + "0".repeat(64),
      import_selections: {},
    };
    try {
      const original = await send(input);
      const forged = { ...record.envelope, signature: "invalid" };
      const claimed = await send({
        ...input,
        events: [JSON.stringify(forged)],
        host_records: [compact],
      });
      const ordinary = await send({
        ...input,
        events: [JSON.stringify(forged)],
      });
      return { original, claimed, ordinary };
    } finally {
      worker.terminate();
    }
  }, corePath);
  expect(results.original.type).toBe("loaded");
  expect(results.claimed.type).toBe("error");
  expect(results.ordinary.type).toBe("error");
});
