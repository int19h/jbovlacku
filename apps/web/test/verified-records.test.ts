import { expect, test } from "@playwright/test";
import { corePath } from "./helpers.ts";

test("the browser exposes no host ports and rejects unknown request fields before checking signatures", async ({
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
    const hostPorts = [
      "addHostVerifiedRecord",
      "extractHostVerifiedRecord",
      "checkHostVerifiedRecord",
      "inspectHostStoredBody",
      "restoreHostEvaluationSession",
      "createEvaluationSession",
    ];
    const exportedHostPorts = hostPorts.filter(
      (name) => typeof core[name] !== "undefined",
    );
    const session = core.evaluateSession({
      events: [JSON.stringify(record.envelope)],
      bodies: {},
      selected_view: "jve1:" + "0".repeat(64),
      import_selections: {},
    });
    const unsafeSessionPorts = [
      "fork",
      "checkpoint",
      "addHostVerifiedRecord",
    ].filter((name) => typeof session[name] !== "undefined");
    session.free();
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
        host_records: [],
      });
      const ordinary = await send({
        ...input,
        events: [JSON.stringify(forged)],
      });
      return {
        original,
        claimed,
        ordinary,
        exportedHostPorts,
        unsafeSessionPorts,
      };
    } finally {
      worker.terminate();
    }
  }, corePath);
  expect(results.exportedHostPorts).toEqual([]);
  expect(results.unsafeSessionPorts).toEqual([]);
  expect(results.original.type).toBe("loaded");
  expect(results.claimed.type).toBe("error");
  expect(results.claimed.message).toContain("unknown field `host_records`");
  expect(results.ordinary.type).toBe("error");
});
