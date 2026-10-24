import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { createEvent, initializeCore, utf8 } from "../../core/src/index.ts";
import { providerConfig } from "../src/inference.ts";
import { DictionaryService } from "../src/service.ts";
import { emptyState, type Snapshot } from "../src/storage.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);

test("private upload cancellation leaves pending dictionary materialization available", async () => {
  let state = emptyState();
  const objects = new Map<string, Uint8Array>();
  const snapshots = new Map<string, Snapshot>();
  let finishPublication!: () => void;
  const publication = new Promise<void>((resolve) => {
    finishPublication = resolve;
  });
  let beginPublication!: () => void;
  const publishing = new Promise<void>((resolve) => {
    beginPublication = resolve;
  });
  let canceled = false;
  let providerCalls = 0;
  const service = new DictionaryService(
    {
      get: async (hash) => objects.get(hash) ?? null,
      put: async (hash, bytes) => {
        objects.set(hash, bytes);
      },
    },
    {
      load: async () => state,
      getSnapshot: async (id) => snapshots.get(id) ?? null,
      compareAndSwap: async (revision, next, snapshot) => {
        if (revision !== state.revision) return false;
        state = next;
        if (snapshot) snapshots.set(snapshot.snapshot, snapshot);
        return true;
      },
    },
    {
      serverId: "assistance-materialization",
      policyUrl: "https://example.invalid/policy",
      asyncMaterialization: true,
      index: {
        replace: async () => {
          beginPublication();
          await publication;
        },
      },
      assistance: {
        provider: {
          ...providerConfig(
            { JVC_AI_ENABLED: "enabled" },
            async () => "disposable-assistance-materialization-key",
          )!,
          fetch: (async () => {
            providerCalls++;
            assert.fail(
              "An incomplete private upload cannot call the provider.",
            );
          }) as typeof fetch,
        },
        requestBodyTimeoutMs: 15,
      },
    },
  );
  await service.initialize();
  const event = createEvent(
    new Uint8Array(32).fill(81),
    [],
    "1".repeat(32),
    { kind: "identity.merge" },
    null,
  );
  try {
    const admitted = await service.admit(utf8(JSON.stringify(event)));
    assert.equal(admitted.status, 201);
    await publishing;
    const session = await service.fetch(
      new Request("http://localhost/api/v1/session"),
    );
    assert.equal(session.status, 200);
    const cookie = session.headers.get("set-cookie")!.split(";")[0];
    const { csrf } = (await session.json()) as { csrf: string };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(utf8("{"));
      },
      cancel() {
        canceled = true;
      },
    });
    const response = await service.fetch(
      new Request("http://localhost/api/v1/assist", {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
          cookie,
          "x-csrf-token": csrf,
        },
        body,
        duplex: "half",
      } as RequestInit),
    );
    assert.equal(response.status, 408);
    assert.equal(((await response.json()) as any).code, "request_timeout");
    assert.equal(canceled, true);
    assert.equal(body.locked, false);
    assert.equal(providerCalls, 0);
    assert.equal(state.materialized_position, 0);
  } finally {
    finishPublication();
    await service.flushMaterialization();
  }
  assert.equal(state.materialized_position, 1);
  assert.equal(state.materialized_snapshot, state.snapshot);
  const receipt = await service.fetch(
    new Request(`http://localhost/api/v1/receipts/${event.envelope.id}`),
  );
  assert.equal(receipt.status, 200);
  assert.equal(((await receipt.json()) as any).snapshot, state.snapshot);
});
