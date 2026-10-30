import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  nodeAssistance,
  SqliteAssistanceBudgetStore,
} from "../../../apps/server/src/assistance.ts";
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

test("Node persistent storage reserves before inference and enforces settled spending after recreation", async () => {
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
  const adapter = {
    store: node,
    recreate() {
      node.close();
      node = new SqliteAssistanceBudgetStore(path);
      return node;
    },
  };
  {
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
                      alternative: null,
                      alternative_reason: null,
                      existing: null,
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
