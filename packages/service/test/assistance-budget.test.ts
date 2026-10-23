import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../../core/src/index.ts";
import {
  AssistanceService,
  estimateAssistanceCost,
  type AssistRequest,
  type AssistanceOptions,
  type AssistanceBudgetSnapshot,
} from "../src/assistance.ts";
import {
  providerConfig,
  estimateInferenceCost,
  inferenceTurnCost,
  INFERENCE_CORRECTION_BYTES,
  type ProviderConfig,
} from "../src/inference.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);
const draft = (): AssistRequest => ({
  operation: "type",
  draft_revision: "budget-test",
  language: "en",
  meaning: "A teacher.",
  current: {
    word_type: null,
    classification: null,
    spelling: null,
    text: [["A teacher."]],
    frame: null,
    glosses: [],
    formation: null,
    compound: null,
  },
  context: [],
  profile: "default",
});
const completion = (cost: number | null = 0.001) => ({
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
  usage:
    cost === null ? {} : { prompt_tokens: 100, completion_tokens: 50, cost },
});
function config(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    ...providerConfig(
      { JVC_AI_ENABLED: "enabled" },
      async () => "disposable-budget-key",
    )!,
    fetch: (async () => Response.json(completion())) as typeof fetch,
    ...overrides,
  };
}
function fixture(
  provider: ProviderConfig,
  options: Partial<AssistanceOptions> = {},
) {
  const instance = new AssistanceService(
    { provider, ...options },
    "budget-test",
    async () => [],
  );
  const route = (
    path: string,
    headers: Record<string, string> = {},
    body?: unknown,
    network = "local",
    method = body ? "POST" : "GET",
  ) =>
    instance.route(
      new Request(`http://localhost${path}`, {
        method,
        headers: { origin: "http://localhost", ...headers },
        body: body ? JSON.stringify(body) : undefined,
      }),
      path,
      async () => new TextEncoder().encode(JSON.stringify(body)),
      network,
    );
  const session = async (network = "local") => {
    const response = (await route("/session", {}, undefined, network))!;
    assert.equal(response.status, 200);
    return {
      cookie: response.headers.get("set-cookie")!.split(";")[0],
      "x-csrf-token": ((await response.json()) as any).csrf,
    };
  };
  const poll = async (id: string, headers: Record<string, string>) => {
    for (let i = 0; i < 100; i++) {
      const value = (await (await route(
        `/jobs/${id}`,
        headers,
      ))!.json()) as any;
      if (!["queued", "running", "cancel_requested"].includes(value.state))
        return value;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error("Job did not finish.");
  };
  return { instance, route, session, poll };
}

test("provider configuration uses separate published prices and server spending limits", () => {
  const defaults = config() as any;
  assert.equal(defaults.inputPrice, 0.1);
  assert.equal(defaults.outputPrice, 0.2);
  assert.equal(defaults.hourlyBudgetUsd, 1);
  assert.equal(defaults.dailyBudgetUsd, 5);
  assert.equal(defaults.maxCostUsd, undefined);
  for (const name of [
    "JVC_AI_INPUT_PRICE",
    "JVC_AI_OUTPUT_PRICE",
    "JVC_AI_HOURLY_BUDGET_USD",
    "JVC_AI_DAILY_BUDGET_USD",
  ]) {
    assert.throws(
      () =>
        providerConfig(
          { JVC_AI_ENABLED: "enabled", [name]: "NaN" },
          async () => "test",
        ),
      /Invalid/,
    );
    assert.throws(
      () =>
        providerConfig(
          { JVC_AI_ENABLED: "enabled", [name]: "-1" },
          async () => "test",
        ),
      /Invalid/,
    );
  }
});

test("server budget refuses a new job before acceptance or any paid turn", async () => {
  let calls = 0;
  const app = fixture(
    config({
      hourlyBudgetUsd: 0.000001,
      fetch: (async () => {
        calls++;
        return Response.json(completion());
      }) as typeof fetch,
    } as any),
  );
  const headers = await app.session();
  const response = (await app.route("/assist", headers, draft()))!;
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), null);
  assert.equal(
    ((await response.json()) as any).code,
    "billing_request_too_large",
  );
  assert.equal(calls, 0);
});

test("a reported overspend does not interrupt admitted answers and blocks later jobs across sessions", async () => {
  let calls = 0;
  const provider = config({
    hourlyBudgetUsd: 1,
    dailyBudgetUsd: 5,
    maxCostUsd: 0.5,
    fetch: (async () => {
      calls++;
      const value = completion(calls === 1 ? 2 : 0.001);
      if (calls === 1)
        value.choices[0].message.tool_calls[0].function.arguments = "{}";
      return Response.json(value);
    }) as typeof fetch,
  });
  const app = fixture(provider);
  const headers = await app.session();
  const accepted = (await app.route("/assist", headers, draft()))!;
  assert.equal(accepted.status, 202);
  const id = ((await accepted.json()) as any).job;
  assert.equal((await app.poll(id, headers)).state, "completed");
  assert.equal(calls, 2);
  await app.route(`/jobs/${id}`, headers, undefined, "local", "DELETE");
  const response = (await app.route(
    "/assist",
    await app.session("second"),
    draft(),
    "second",
  ))!;
  assert.equal(response.status, 429);
  assert.equal(((await response.json()) as any).code, "billing_limit");
  assert.equal(calls, 2);
});

test("server reservation counts concurrent jobs before either provider reports cost", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const app = fixture(
    config({
      hourlyBudgetUsd: 0.7,
      fetch: (async () => {
        await gate;
        return Response.json(completion());
      }) as typeof fetch,
    } as any),
    { networkRetainedJobs: 4 },
  );
  const first = await app.session("first");
  const response = (await app.route("/assist", first, draft(), "first"))!;
  assert.equal(response.status, 202);
  const id = ((await response.json()) as any).job;
  const blocked = (await app.route(
    "/assist",
    await app.session("second"),
    draft(),
    "second",
  ))!;
  release();
  await app.poll(id, first);
  assert.equal(blocked.status, 429);
  assert.equal(((await blocked.json()) as any).code, "billing_pending");
});

test("completed IPv6 jobs release global retained slots after their read window", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const app = fixture(config(), {
    retainedJobs: 2,
    terminalReadMs: 100,
  } as any);
  const records: { id: string; headers: Record<string, string> }[] = [];
  for (const network of ["2001:db8:1:1::/64", "2001:db8:2:1::/64"]) {
    const headers = await app.session(network);
    const response = (await app.route("/assist", headers, draft(), network))!;
    assert.equal(response.status, 202);
    const id = ((await response.json()) as any).job;
    assert.equal((await app.poll(id, headers)).state, "completed");
    records.push({ id, headers });
  }
  const third = await app.session("198.51.100.7");
  const blocked = (await app.route("/assist", third, draft(), "198.51.100.7"))!;
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "1");
  t.mock.timers.tick(101);
  const response = (await app.route(
    "/assist",
    third,
    draft(),
    "198.51.100.7",
  ))!;
  assert.equal(response.status, 202);
  await app.poll(((await response.json()) as any).job, third);
  for (const { id, headers } of records) {
    await assert.rejects(app.route(`/jobs/${id}`, headers), {
      status: 410,
      code: "result_discarded",
    });
  }
});

test("a full shared network replaces its oldest idle session", async () => {
  const app = fixture(config(), { networkSessions: 2 });
  const old = await app.session();
  const retained = await app.session();
  await app.session();
  await assert.rejects(app.route("/assist", old, draft()), { code: "session" });
  assert.equal((await app.route("/assist", retained, draft()))!.status, 202);
});

test("reservation arithmetic uses actual UTF-8 requests, both prices and every possible answer", () => {
  const provider = config();
  const small = draft();
  small.meaning = "a";
  const large = structuredClone(small);
  large.meaning += "é".repeat(1000);
  const delta =
    estimateAssistanceCost(large, [], provider) -
    estimateAssistanceCost(small, [], provider);
  assert.ok(
    Math.abs(delta - (2 * 3 * 2000 * provider.inputPrice) / 1000000) < 1e-12,
  );
  const noInput = config({ inputPrice: 0 });
  assert.equal(
    estimateAssistanceCost(small, [], noInput),
    (2 * 3 * noInput.maxTokens * noInput.outputPrice) / 1000000,
  );
  const frame = {
    role: "predicate",
    arity: { mode: "fixed", count: 1 },
    places: [
      {
        index: 1,
        description: [["teacher"]],
        glosses: [],
        type_hints: [],
        defaults: [],
        constraints: [],
        derivation: [],
      },
    ],
    tail: null,
    constraints: [],
  };
  const places = {
    ...small,
    operation: "places-glosses" as const,
    current: { ...small.current, frame },
  };
  const input = JSON.stringify({
    meaning: places.meaning,
    language: places.language,
    current: places.current,
    definitions: [],
  });
  assert.equal(
    estimateAssistanceCost(places, [], provider),
    estimateInferenceCost(provider, {
      task: "glosses",
      input,
      keys: ["word", "x1"],
    }) +
      estimateInferenceCost(provider, { task: "hints", input, keys: ["x1"] }),
  );
  const generated = { ...places, current: { ...places.current, frame: null } };
  assert.ok(
    estimateAssistanceCost(generated, [], provider) >
      estimateAssistanceCost(places, [], provider),
  );
  assert.ok(
    estimateAssistanceCost(generated, [], provider) > provider.hourlyBudgetUsd,
  );
  const correction = INFERENCE_CORRECTION_BYTES;
  assert.ok(
    estimateInferenceCost(provider, { task: "type", input: "" }) >
      inferenceTurnCost(provider, correction) +
        inferenceTurnCost(provider, correction * 2),
  );
});

test("an explicit job ceiling rejects all tasks before the first paid answer", async () => {
  let calls = 0;
  const provider = config({
    maxCostUsd: 0.01,
    hourlyBudgetUsd: 100,
    dailyBudgetUsd: 500,
    fetch: (async () => {
      calls++;
      return Response.json(completion());
    }) as typeof fetch,
  });
  const app = fixture(provider);
  const request = { ...draft(), operation: "places-glosses" as const };
  const response = (await app.route("/assist", await app.session(), request))!;
  assert.equal(response.status, 429);
  assert.equal(
    ((await response.json()) as any).code,
    "billing_request_too_large",
  );
  assert.equal(response.headers.get("retry-after"), null);
  assert.equal(calls, 0);
});

test("hour and day spending windows reset independently across new sessions", async (t) => {
  const initial = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: initial });
  const app = fixture(
    config({
      hourlyBudgetUsd: 1,
      dailyBudgetUsd: 1.5,
      fetch: (async () => Response.json(completion(0.9))) as typeof fetch,
    }),
  );
  const run = async (network: string) => {
    const headers = await app.session(network);
    const response = (await app.route("/assist", headers, draft(), network))!;
    if (response.status === 202) {
      const id = ((await response.json()) as any).job;
      assert.equal((await app.poll(id, headers)).state, "completed");
      await app.route(`/jobs/${id}`, headers, undefined, network, "DELETE");
    }
    return response;
  };
  assert.equal((await run("first")).status, 202);
  const hour = await run("second");
  assert.equal(hour.status, 429);
  assert.equal(hour.headers.get("retry-after"), "3600");
  t.mock.timers.tick(3600001);
  assert.equal((await run("third")).status, 202);
  t.mock.timers.tick(3600001);
  const day = await run("fourth");
  assert.equal(day.status, 429);
  assert.ok(Number(day.headers.get("retry-after")) >= 79199);
  assert.ok(Number(day.headers.get("retry-after")) <= 79200);
  t.mock.timers.tick(22 * 3600000);
  assert.equal((await run("fifth")).status, 202);
});

test("unknown provider usage and transport failure retain estimated charges without inventing log costs", async () => {
  for (const fetcher of [
    async () => Response.json(completion(null)),
    async () => {
      throw new Error("Synthetic transport failure.");
    },
  ]) {
    let saved: AssistanceBudgetSnapshot | null = null;
    const app = fixture(config({ fetch: fetcher as typeof fetch }), {
      budgetStore: {
        load: async () => saved,
        save: async (value) => {
          saved = structuredClone(value);
        },
      },
    });
    const headers = await app.session();
    const id = (
      (await (await app.route("/assist", headers, draft()))!.json()) as any
    ).job;
    const result = await app.poll(id, headers);
    const log = result.result?.log ?? result.error?.log;
    assert.equal(log.cost_usd, null);
    assert.equal(log.unknown_cost_attempts, 1);
    // The terminal state can become visible before its final durable settlement.
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(saved!.entries.length, 1);
    assert.equal(saved!.entries[0].active, false);
    assert.ok(saved!.entries[0].reservedUsd > 0);
    assert.ok(saved!.entries[0].settledUsd > 0);
    assert.equal(JSON.stringify(saved).includes("A teacher"), false);
    assert.equal(
      JSON.stringify(saved).includes("disposable-budget-key"),
      false,
    );
  }
});

test("a full network protects active results through the projected terminal read window", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const app = fixture(
    config({
      timeoutMs: 5000,
      fetch: (async () => {
        await gate;
        return Response.json(completion());
      }) as typeof fetch,
    }),
    { networkSessions: 1 },
  );
  const headers = await app.session();
  const id = (
    (await (await app.route("/assist", headers, draft()))!.json()) as any
  ).job;
  const session = (await app.route("/session"))!;
  assert.equal(session.status, 429);
  const blocked = (await app.route("/assist", headers, draft()))!;
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "125");
  assert.equal(session.headers.get("retry-after"), "125");
  release();
  assert.equal((await app.poll(id, headers)).state, "completed");
});

test("reported charges remain in the hourly window for an hour after the paid answer", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let called!: () => void;
  const started = new Promise<void>((resolve) => (called = resolve));
  const app = fixture(
    config({
      timeoutMs: 540000,
      fetch: (async () => {
        called();
        await gate;
        return Response.json(completion(0.9));
      }) as typeof fetch,
    }),
  );
  const headers = await app.session();
  const response = (await app.route("/assist", headers, draft()))!;
  const id = ((await response.json()) as any).job;
  await started;
  t.mock.timers.tick(300000);
  release();
  assert.equal((await app.poll(id, headers)).state, "completed");
  t.mock.timers.tick(3300001);
  const blocked = (await app.route(
    "/assist",
    await app.session("new"),
    draft(),
    "new",
  ))!;
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "300");
  assert.match(((await blocked.json()) as any).message, /Retry in 300 seconds/);
});

test("idle eviction cannot replace a session while its durable reservation is being saved", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let saving!: () => void;
  const started = new Promise<void>((resolve) => (saving = resolve));
  let saves = 0;
  const app = fixture(config(), {
    networkSessions: 1,
    budgetStore: {
      load: async () => null,
      save: async () => {
        if (++saves === 1) {
          saving();
          await gate;
        }
      },
    },
  });
  const headers = await app.session();
  const admission = app.route("/assist", headers, draft());
  await started;
  const next = (await app.route("/session"))!;
  release();
  const accepted = (await admission)!;
  const id = ((await accepted.json()) as any).job;
  assert.equal(next.status, 429);
  assert.equal((await app.poll(id, headers)).state, "completed");
});

test("concurrent admissions wait for durable reservation and cannot spend the same remaining allowance", async () => {
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => (releaseSave = resolve));
  let saving!: () => void;
  const firstSave = new Promise<void>((resolve) => (saving = resolve));
  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => (releaseFetch = resolve));
  let calls = 0;
  let saves = 0;
  const app = fixture(
    config({
      hourlyBudgetUsd: 0.7,
      fetch: (async () => {
        calls++;
        await fetchGate;
        return Response.json(completion());
      }) as typeof fetch,
    }),
    {
      budgetStore: {
        load: async () => null,
        save: async () => {
          if (++saves === 1) {
            saving();
            await saveGate;
          }
        },
      },
    },
  );
  const one = await app.session("one");
  const two = await app.session("two");
  const first = app.route("/assist", one, draft(), "one");
  await firstSave;
  let secondDone = false;
  const second = app.route("/assist", two, draft(), "two").then((response) => {
    secondDone = true;
    return response;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.equal(saves, 1);
  assert.equal(secondDone, false);
  releaseSave();
  const accepted = (await first)!;
  const refused = (await second)!;
  releaseFetch();
  assert.equal(accepted.status, 202);
  assert.equal(refused.status, 429);
  assert.equal(((await refused.json()) as any).code, "billing_pending");
  assert.equal(
    (await app.poll(((await accepted.json()) as any).job, one)).state,
    "completed",
  );
  assert.equal(calls, 1);
});

test("interrupted durable reservations survive restart and recovery is persisted once", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let saved: AssistanceBudgetSnapshot = {
    version: 1,
    entries: [
      {
        id: "interrupted",
        at: Date.now() - 1800000,
        reservedUsd: 0.95,
        settledUsd: 0.01,
        active: true,
      },
    ],
  };
  let calls = 0;
  const provider = config({
    fetch: (async () => {
      calls++;
      return Response.json(completion());
    }) as typeof fetch,
  });
  const store = {
    load: async () => structuredClone(saved),
    save: async (value: AssistanceBudgetSnapshot) => {
      saved = structuredClone(value);
    },
  };
  const app = fixture(provider, { budgetStore: store });
  const blocked = (await app.route("/assist", await app.session(), draft()))!;
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "3600");
  assert.equal(calls, 0);
  const recovered = (await store.load()) as AssistanceBudgetSnapshot;
  assert.equal(recovered.version, 2);
  assert.match(recovered.networkHashKey, /^[a-f0-9]{64}$/);
  assert.deepEqual(recovered.entries[0].networkHashes, []);
  assert.equal(saved.entries[0].active, false);
  const recoveryTime = saved.entries[0].at;
  t.mock.timers.tick(1800000);
  const again = fixture(provider, { budgetStore: store });
  const stillBlocked = (await again.route(
    "/assist",
    await again.session(),
    draft(),
  ))!;
  assert.equal(stillBlocked.status, 429);
  assert.equal(stillBlocked.headers.get("retry-after"), "1800");
  assert.equal(saved.entries[0].at, recoveryTime);
  t.mock.timers.tick(1800001);
  const accepted = (await again.route(
    "/assist",
    await again.session(),
    draft(),
  ))!;
  assert.equal(accepted.status, 202);
});

test("unavailable or corrupt durable spending state blocks new work before any provider request", async () => {
  let calls = 0;
  const provider = config({
    fetch: (async () => {
      calls++;
      return Response.json(completion());
    }) as typeof fetch,
  });
  for (const store of [
    {
      load: async () => {
        throw new Error("Synthetic load failure.");
      },
      save: async () => {},
    },
    {
      load: async () => null,
      save: async () => {
        throw new Error("Synthetic save failure.");
      },
    },
    {
      load: async () => ({
        version: 1,
        entries: [
          {
            id: "bad",
            at: Date.now(),
            reservedUsd: -1,
            settledUsd: 0,
            active: false,
          },
        ],
      }),
      save: async () => {},
    },
    {
      load: async () => ({ version: 1, entries: [], unexpected: "field" }),
      save: async () => {},
    },
  ]) {
    const app = fixture(provider, { budgetStore: store as any });
    await assert.rejects(app.route("/assist", await app.session(), draft()), {
      status: 503,
      code: "billing_unavailable",
    });
  }
  assert.equal(calls, 0);
});

test("failed terminal jobs discard their private logs when the read window ends", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const app = fixture(
    config({
      fetch: (async () =>
        Response.json({ ...completion(), choices: [] })) as typeof fetch,
    }),
    { terminalReadMs: 100, retainedJobs: 1 },
  );
  const headers = await app.session();
  const id = (
    (await (await app.route("/assist", headers, draft()))!.json()) as any
  ).job;
  const failed = await app.poll(id, headers);
  assert.equal(failed.state, "failed");
  assert.ok(failed.error.log);
  t.mock.timers.tick(101);
  await assert.rejects(app.route(`/jobs/${id}`, headers), {
    status: 410,
    code: "result_discarded",
  });
  assert.equal((await app.route("/assist", headers, draft()))!.status, 202);
});
