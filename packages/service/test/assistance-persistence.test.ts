import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { serialize } from "node:v8";
import {
  nodeAssistance,
  SqliteAssistanceBudgetStore,
} from "../../../apps/server/src/assistance.ts";
import { workerAssistanceBudgetStore } from "../../../apps/worker/src/assistance.ts";
import type { AssistanceBudgetSnapshot } from "../src/assistance.ts";
import {
  AssistanceService,
  type AssistanceBudgetStore,
} from "../src/assistance.ts";
import { providerConfig } from "../src/inference.ts";
import { initializeCore } from "../../core/src/index.ts";

const enabled = {
  JVC_AI_ENABLED: "enabled",
  JVC_AI_KEY_FILE: "/synthetic-only/unread-key",
};

test("Node assistance receives the durable spending store", () => {
  const store = {
    async load() {
      return null;
    },
    async save() {},
  };
  const options = nodeAssistance(enabled, store);
  assert.equal(options.budgetStore, store);
});

test("enabled Node assistance requires a durable spending store", () => {
  assert.throws(() => nodeAssistance(enabled), /durable spending store/);
  assert.deepEqual(nodeAssistance({}), {});
});

const reserved = (): AssistanceBudgetSnapshot => ({
  version: 1,
  entries: [
    {
      id: "synthetic-reservation",
      at: Date.now(),
      reservedUsd: 0.5,
      settledUsd: 0,
      active: true,
    },
  ],
});

function memoryStorage(
  values = new Map<string, unknown>(),
  options: {
    sync?: () => Promise<void>;
    beforePut?: (key: string, value: unknown) => void;
  } = {},
) {
  let tail = Promise.resolve();
  const operations = (target: Map<string, unknown>) => ({
    async get<T>(key: string) {
      return structuredClone(target.get(key)) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      options.beforePut?.(key, value);
      target.set(key, structuredClone(value));
    },
    async delete(key: string) {
      return target.delete(key);
    },
  });
  return {
    ...operations(values),
    async transaction<T>(
      operation: (transaction: ReturnType<typeof operations>) => Promise<T>,
    ): Promise<T> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        const staged = structuredClone(values);
        const result = await operation(operations(staged));
        values.clear();
        for (const [key, value] of staged) values.set(key, value);
        return result;
      } finally {
        release();
      }
    },
    async sync() {
      await options.sync?.();
    },
  };
}

function boundedSnapshot(): AssistanceBudgetSnapshot {
  return JSON.parse(
    JSON.stringify({
      version: 2,
      networkHashKey: Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString("hex"),
      entries: Array.from({ length: 16384 }, (_, index) => ({
        id: Array.from(index.toString(16), (digit) =>
          String.fromCharCode(16 + parseInt(digit, 16)),
        )
          .join("")
          .padStart(128, "\0"),
        at: Number.MAX_SAFE_INTEGER,
        deadline: Number.MAX_SAFE_INTEGER,
        reservedUsd: 0.0000012345678901234567,
        settledUsd: 0.0000012345678901234567,
        active: false,
        costKnown: false,
        networkHashes: ["a".repeat(64), "b".repeat(64)],
      })),
    }),
  );
}

test("Worker spending storage splits the bounded ledger into values below 128 KiB", async () => {
  const values = new Map<string, unknown>();
  let largestValue = 0;
  const storage = memoryStorage(values, {
    beforePut(_key, value) {
      const bytes = serialize(value).byteLength;
      largestValue = Math.max(largestValue, bytes);
      if (bytes > 131072)
        throw new Error("Synthetic storage value exceeds 128 KiB.");
    },
  });
  const snapshot = boundedSnapshot();
  assert.ok(serialize(snapshot).byteLength > 2 * 1024 * 1024);
  const store = workerAssistanceBudgetStore(storage);
  await store.save(snapshot);
  assert.equal(
    JSON.stringify(await workerAssistanceBudgetStore(storage).load()) ===
      JSON.stringify(snapshot),
    true,
  );
  assert.ok(largestValue <= 131072);
  assert.ok(values.size > 1);
});

test("Worker spending storage rolls back partial writes and removes stale parts after a smaller snapshot", async () => {
  const values = new Map<string, unknown>();
  let fail = false;
  let writes = 0;
  const storage = memoryStorage(values, {
    beforePut() {
      if (fail && ++writes === 3)
        throw new Error("Synthetic part write failure.");
    },
  });
  const snapshot = boundedSnapshot();
  const store = workerAssistanceBudgetStore(storage);
  await store.save(snapshot);
  const before = serialize(values);
  fail = true;
  const changed = structuredClone(snapshot);
  changed.entries[0].settledUsd = 1;
  await assert.rejects(store.save(changed), /Synthetic part write failure/);
  assert.equal(serialize(values).equals(before), true);
  assert.equal(
    JSON.stringify(await store.load()) === JSON.stringify(snapshot),
    true,
  );
  fail = false;
  await store.save(reserved());
  assert.equal(values.size, 2);
});

test("Worker spending storage upgrades the old value only after every new part commits", async () => {
  const legacy = reserved();
  const values = new Map<string, unknown>([["assistance-spending-v1", legacy]]);
  let fail = true;
  const storage = memoryStorage(values, {
    beforePut(key) {
      if (fail && key === "assistance-spending-manifest-v1")
        throw new Error("Synthetic manifest write failure.");
    },
  });
  const store = workerAssistanceBudgetStore(storage);
  assert.deepEqual(await store.load(), legacy);
  await assert.rejects(store.save(legacy), /Synthetic manifest write failure/);
  assert.deepEqual(await store.load(), legacy);
  assert.equal(values.size, 1);
  fail = false;
  await store.save(legacy);
  assert.equal(values.has("assistance-spending-v1"), false);
  assert.deepEqual(await workerAssistanceBudgetStore(storage).load(), legacy);
});

test("Worker spending storage refuses missing, corrupt, and oversized parts without a legacy fallback", async () => {
  for (const damage of [
    "missing",
    "checksum",
    "manifest",
    "missing-manifest",
  ] as const) {
    const values = new Map<string, unknown>();
    const store = workerAssistanceBudgetStore(memoryStorage(values));
    await store.save(reserved());
    values.set("assistance-spending-v1", reserved());
    if (damage === "missing") values.delete("assistance-spending-part-v1:0");
    else if (damage === "checksum")
      (values.get("assistance-spending-part-v1:0") as Uint8Array)[0] ^= 1;
    else if (damage === "missing-manifest")
      values.delete("assistance-spending-manifest-v1");
    else
      values.set("assistance-spending-manifest-v1", {
        version: 1,
        bytes: 33554433,
        parts: 513,
        sha256: "a".repeat(64),
      });
    await assert.rejects(store.load(), /spending storage/);
  }
});

test("Node spending reservations survive process exit and reported costs survive reopening", async () => {
  const scratch = resolve(
    process.env.JVC_TEST_ROOT ?? ".cache/browser-tests",
    "assistance-persistence",
  );
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, "node-"));
  const path = join(directory, "assistance-spending.sqlite");
  const snapshot = reserved();
  // Exit without close to make sure that the write itself commits the reservation.
  const source = `
    import { SqliteAssistanceBudgetStore } from ${JSON.stringify(new URL("../../../apps/server/src/assistance.ts", import.meta.url).href)};
    const store = new SqliteAssistanceBudgetStore(process.argv[1]);
    await store.save(JSON.parse(process.argv[2]));
    process.exit(0);
  `;
  await promisify(execFile)(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    source,
    path,
    JSON.stringify(snapshot),
  ]);
  const reopened = new SqliteAssistanceBudgetStore(path);
  assert.deepEqual(await reopened.load(), snapshot);
  const settled = structuredClone(snapshot);
  settled.entries[0].settledUsd = 0.23;
  settled.entries[0].active = false;
  await reopened.save(settled);
  reopened.close();
  const afterSettlement = new SqliteAssistanceBudgetStore(path);
  assert.deepEqual(await afterSettlement.load(), settled);
  afterSettlement.close();
});

test("Worker spending storage survives adapter reconstruction and awaits durable writes", async () => {
  const durable = new Map<string, unknown>();
  let syncStarted = false;
  let entered!: () => void;
  const syncEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const synced = new Promise<void>((resolve) => {
    release = resolve;
  });
  const storage = memoryStorage(durable, {
    async sync() {
      syncStarted = true;
      entered();
      await synced;
    },
  });
  const first = workerAssistanceBudgetStore(storage);
  assert.equal(await first.load(), null);
  const snapshot = reserved();
  let saved = false;
  const pending = first.save(snapshot).then(() => {
    saved = true;
  });
  await syncEntered;
  assert.equal(syncStarted, true);
  assert.equal(saved, false);
  release();
  await pending;
  snapshot.entries[0].reservedUsd = 900;
  const second = workerAssistanceBudgetStore(storage);
  assert.equal((await second.load())!.entries[0].reservedUsd, 0.5);
  const settled = (await second.load())!;
  settled.entries[0].settledUsd = 0.17;
  settled.entries[0].active = false;
  await second.save(settled);
  assert.deepEqual(await workerAssistanceBudgetStore(storage).load(), settled);
  assert.deepEqual([...durable.keys()].sort(), [
    "assistance-spending-manifest-v1",
    "assistance-spending-part-v1:0",
  ]);
});

test("Worker spending storage propagates load and durability failures", async () => {
  const unavailable = workerAssistanceBudgetStore({
    ...memoryStorage(),
    async get<T>(): Promise<T | undefined> {
      throw new Error("synthetic read failure");
    },
    async transaction() {
      throw new Error("synthetic read failure");
    },
    async sync() {
      throw new Error("synthetic sync failure");
    },
  });
  await assert.rejects(unavailable.load(), /synthetic read failure/);
  const syncFailure = workerAssistanceBudgetStore(
    memoryStorage(new Map(), {
      async sync() {
        throw new Error("synthetic sync failure");
      },
    }),
  );
  await assert.rejects(syncFailure.save(reserved()), /synthetic sync failure/);
});

test("both persistent adapters reserve before inference and enforce settled spending after recreation", async () => {
  await initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  );
  const scratch = resolve(
    process.env.JVC_TEST_ROOT ?? ".cache/browser-tests",
    "assistance-persistence",
  );
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, "service-"));
  const path = join(directory, "assistance-spending.sqlite");
  let node = new SqliteAssistanceBudgetStore(path);
  const workerValues = new Map<string, unknown>();
  const workerStorage = memoryStorage(workerValues);
  const adapters = [
    {
      store: node,
      recreate() {
        node.close();
        node = new SqliteAssistanceBudgetStore(path);
        return node;
      },
    },
    {
      store: workerAssistanceBudgetStore(workerStorage),
      recreate() {
        return workerAssistanceBudgetStore(workerStorage);
      },
    },
  ];
  for (const adapter of adapters) {
    let calls = 0;
    const config = providerConfig(
      {
        JVC_AI_ENABLED: "enabled",
        JVC_AI_HOURLY_BUDGET_USD: "1",
        JVC_AI_DAILY_BUDGET_USD: "5",
        JVC_AI_NETWORK_HOURLY_BUDGET_USD: "0.5",
        JVC_AI_NETWORK_DAILY_BUDGET_USD: "2.5",
      },
      async () => "disposable-only-key",
    )!;
    config.fetch = (async () => {
      calls++;
      const persisted = await adapter.store.load();
      assert.equal(persisted!.entries.length, 1);
      assert.equal(persisted!.entries[0].active, true);
      assert.ok(persisted!.entries[0].reservedUsd > 0);
      return Response.json({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: [
                {
                  id: "answer",
                  type: "function",
                  function: {
                    name: "submit_answer",
                    arguments: JSON.stringify({
                      word_type: "gismu",
                      reason: "Root.",
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50, cost: 2 },
      });
    }) as typeof fetch;
    const fixture = (store: AssistanceBudgetStore) => {
      const service = new AssistanceService(
        { provider: config, budgetStore: store },
        "persistence-test",
        async () => [],
      );
      const route = (
        path: string,
        headers: Record<string, string> = {},
        body?: unknown,
      ) =>
        service.route(
          new Request(`http://localhost${path}`, {
            method: body ? "POST" : "GET",
            headers: { origin: "http://localhost", ...headers },
            body: body ? JSON.stringify(body) : undefined,
          }),
          path,
          async () => new TextEncoder().encode(JSON.stringify(body)),
          "local",
        );
      const session = async () => {
        const response = (await route("/session"))!;
        return {
          cookie: response.headers.get("set-cookie")!.split(";")[0],
          "x-csrf-token": ((await response.json()) as { csrf: string }).csrf,
        };
      };
      return { route, session };
    };
    const draft = {
      operation: "type",
      draft_revision: "private-draft-marker",
      language: "en",
      meaning: "Private meaning marker.",
      current: {
        word_type: null,
        classification: null,
        spelling: null,
        text: [],
        frame: null,
        glosses: [],
        formation: null,
        compound: null,
      },
      context: [],
      profile: "default",
    };
    const first = fixture(adapter.store);
    const headers = await first.session();
    const accepted = (await first.route("/assist", headers, draft))!;
    assert.equal(accepted.status, 202);
    const job = ((await accepted.json()) as { job: string }).job;
    let state = "queued";
    for (let attempt = 0; attempt < 100; attempt++) {
      state = (
        (await (await first.route(`/jobs/${job}`, headers))!.json()) as {
          state: string;
        }
      ).state;
      if (!["queued", "running"].includes(state)) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(state, "completed");
    let settled = (await adapter.store.load())!;
    for (
      let attempt = 0;
      attempt < 100 && settled.entries[0].active;
      attempt++
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      settled = (await adapter.store.load())!;
    }
    assert.equal(settled.entries[0].active, false);
    assert.equal(settled.entries[0].settledUsd, 2);
    assert.doesNotMatch(
      JSON.stringify(settled),
      /private-draft-marker|Private meaning marker|disposable-only-key/,
    );
    const recreatedStore = adapter.recreate();
    const reopened = (await recreatedStore.load())!;
    assert.equal(settled.version, 2);
    assert.equal(reopened.version, 2);
    if (settled.version !== 2 || reopened.version !== 2)
      throw new Error("The spending snapshot did not upgrade.");
    assert.equal(settled.networkHashKey === reopened.networkHashKey, true);
    assert.equal(/^[a-f0-9]{64}$/.test(reopened.networkHashKey), true);
    assert.equal(
      JSON.stringify(settled.entries[0].networkHashes) ===
        JSON.stringify(reopened.entries[0].networkHashes),
      true,
    );
    const second = fixture(recreatedStore);
    const blocked = (await second.route(
      "/assist",
      await second.session(),
      draft,
    ))!;
    assert.equal(blocked.status, 429);
    assert.equal(
      ((await blocked.json()) as { code: string }).code,
      "billing_limit",
    );
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
    assert.equal(calls, 1);
  }
  node.close();
});
