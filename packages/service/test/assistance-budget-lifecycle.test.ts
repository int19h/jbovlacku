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
  type ContextDefinition,
} from "../src/assistance.ts";
import { providerConfig, type ProviderConfig } from "../src/inference.ts";

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
    hourlyBudgetUsd: 1,
    dailyBudgetUsd: 5,
    networkHourlyBudgetUsd: 0.5,
    networkDailyBudgetUsd: 2.5,
    ...overrides,
  };
}
function fixture(
  provider: ProviderConfig,
  options: Partial<AssistanceOptions> = {},
  context: (ids: string[]) => Promise<ContextDefinition[]> = async () => [],
) {
  const instance = new AssistanceService(
    { provider, ...options },
    "budget-test",
    context,
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function accepted(
  app: ReturnType<typeof fixture>,
  network: string,
  cost = true,
) {
  const headers = await app.session(network);
  const response = (await app.route("/assist", headers, draft(), network))!;
  assert.equal(response.status, 202);
  const id = ((await response.json()) as any).job;
  if (cost) {
    assert.equal((await app.poll(id, headers)).state, "completed");
    await app.route(`/jobs/${id}`, headers, undefined, network, "DELETE");
  }
  return { id, headers };
}

test("one network gets half the hourly and daily budget and leaves another network room", async () => {
  for (const period of ["hour", "day"]) {
    const app = fixture(
      config({
        hourlyBudgetUsd: period === "hour" ? 1 : 100,
        dailyBudgetUsd: period === "day" ? 1 : 100,
        networkHourlyBudgetUsd: period === "hour" ? 0.5 : 50,
        networkDailyBudgetUsd: period === "day" ? 0.5 : 50,
        fetch: (async () => Response.json(completion(0.3))) as typeof fetch,
      } as any),
    );
    await accepted(app, "192.0.2.1");
    const response = (await app.route(
      "/assist",
      await app.session("192.0.2.1"),
      draft(),
      "192.0.2.1",
    ))!;
    assert.equal(response.status, 429, period);
    assert.equal(((await response.json()) as any).code, "billing_limit");
    await accepted(app, "192.0.2.2");
  }
});

test("IPv6 retained capacity and spending count both the /64 and the /48", async () => {
  const app = fixture(config());
  const first = await accepted(app, "2001:db8:1:1::/64", false);
  await app.poll(first.id, first.headers);
  const same48 = (await app.route(
    "/assist",
    await app.session("2001:db8:1:2::/64"),
    draft(),
    "2001:db8:1:2::/64",
  ))!;
  assert.equal(same48.status, 429);
  await accepted(app, "2001:db8:2:1::/64");

  const spend = fixture(
    config({
      fetch: (async () => Response.json(completion(0.3))) as typeof fetch,
    }),
  );
  await accepted(spend, "2001:db8:1:1::/64");
  const blocked = (await spend.route(
    "/assist",
    await spend.session("2001:db8:1:2::/64"),
    draft(),
    "2001:db8:1:2::/64",
  ))!;
  assert.equal(blocked.status, 429);
  assert.equal(((await blocked.json()) as any).code, "billing_limit");
  await accepted(spend, "2001:db8:2:1::/64");
});

test("durable network identities are keyed hashes and survive restart", async () => {
  let saved: AssistanceBudgetSnapshot | null = null;
  const options = {
    budgetStore: {
      load: async () => saved,
      save: async (value: AssistanceBudgetSnapshot) => {
        saved = structuredClone(value);
      },
    },
  };
  const provider = config({
    fetch: (async () => Response.json(completion(0.3))) as typeof fetch,
  });
  await accepted(fixture(provider, options), "2001:db8:1:1::/64");
  await new Promise((resolve) => setTimeout(resolve, 1));
  const snapshot = saved as any;
  assert.equal(snapshot.version, 2);
  assert.match(snapshot.networkHashKey, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.entries[0].networkHashes.length, 2);
  for (const hash of snapshot.entries[0].networkHashes)
    assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(snapshot).includes("2001:db8"), false);
  const restarted = fixture(provider, options);
  const blocked = (await restarted.route(
    "/assist",
    await restarted.session("2001:db8:1:2::/64"),
    draft(),
    "2001:db8:1:2::/64",
  ))!;
  assert.equal(blocked.status, 429);
  await accepted(restarted, "2001:db8:2:1::/64");
});

test("an active reservation alone has no promised retry before its costs are known", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const gate = deferred();
  const provider = config({
    timeoutMs: 5000,
    fetch: (async () => {
      await gate.promise;
      return Response.json(completion());
    }) as typeof fetch,
  } as any);
  provider.hourlyBudgetUsd =
    estimateAssistanceCost(draft(), [], provider) * 1.5;
  (provider as any).networkHourlyBudgetUsd = provider.hourlyBudgetUsd;
  const app = fixture(provider);
  const first = await accepted(app, "first", false);
  const response = (await app.route(
    "/assist",
    await app.session("second"),
    draft(),
    "second",
  ))!;
  gate.resolve();
  await app.poll(first.id, first.headers);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), null);
  assert.equal(((await response.json()) as any).code, "billing_pending");
  await accepted(app, "second");
});

test("a running settled charge gives no early promise and its terminal charge uses its actual window", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const gate = deferred();
  const secondTurn = deferred();
  let calls = 0;
  const provider = config({
    timeoutMs: 5000,
    networkHourlyBudgetUsd: 1,
    fetch: (async () => {
      if (++calls === 1) {
        const value = completion(0.95);
        value.choices[0].message.tool_calls[0].function.arguments = "{}";
        return Response.json(value);
      }
      secondTurn.resolve();
      await gate.promise;
      return Response.json(completion(0.001));
    }) as typeof fetch,
  } as any);
  const app = fixture(provider);
  const first = await accepted(app, "first", false);
  await secondTurn.promise;
  const response = (await app.route(
    "/assist",
    await app.session("second"),
    draft(),
    "second",
  ))!;
  t.mock.timers.tick(2000);
  gate.resolve();
  await app.poll(first.id, first.headers);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), null);
  assert.equal(((await response.json()) as any).code, "billing_pending");
  const terminal = (await app.route(
    "/assist",
    await app.session("second"),
    draft(),
    "second",
  ))!;
  assert.equal(terminal.status, 429);
  assert.equal(terminal.headers.get("retry-after"), "3600");
  assert.equal(((await terminal.json()) as any).code, "billing_limit");
});

test("a permanently oversized request has a distinct code and no retry hint", async () => {
  for (const overrides of [
    { maxCostUsd: 0.00001 },
    { hourlyBudgetUsd: 0.00001 },
    { networkDailyBudgetUsd: 0.00001 },
  ]) {
    const app = fixture(config(overrides as any));
    const response = (await app.route(
      "/assist",
      await app.session(),
      draft(),
    ))!;
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), null);
    const error = (await response.json()) as any;
    assert.equal(error.code, "billing_request_too_large");
    assert.doesNotMatch(error.message, /retry|wait|Try again/i);
  }
});

test("context loading protects a session and concurrent loads use separate admission references", async () => {
  const gates = [deferred(), deferred()];
  const starts = [deferred(), deferred()];
  let loads = 0;
  const app = fixture(config(), { networkSessions: 1 }, async () => {
    const index = loads++;
    starts[index].resolve();
    await gates[index].promise;
    if (!index) throw new Error("Synthetic context failure.");
    return [];
  });
  const headers = await app.session();
  const first = app.route("/assist", headers, draft());
  const second = app.route("/assist", headers, draft());
  // Register the expected rejection before the gate opens.
  const failed = assert.rejects(first, /Synthetic context failure/);
  await Promise.all(starts.map((value) => value.promise));
  const duringBoth = (await app.route("/session"))!;
  gates[0].resolve();
  await failed;
  const duringSecond = (await app.route("/session"))!;
  gates[1].resolve();
  const response = (await second)!;
  assert.equal(duringBoth.status, 429);
  assert.equal(duringSecond.status, 429);
  assert.equal(response.status, 202);
  await app.poll(((await response.json()) as any).job, headers);
});

test("terminal results keep their read window and dismissed records permit session replacement", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  for (const dismissed of [false, true]) {
    const app = fixture(config(), { networkSessions: 1 });
    const first = await accepted(app, "local", false);
    await app.poll(first.id, first.headers);
    if (dismissed)
      await app.route(
        `/jobs/${first.id}`,
        first.headers,
        undefined,
        "local",
        "DELETE",
      );
    if (!dismissed) {
      const blocked = (await app.route("/session"))!;
      assert.equal(blocked.status, 429);
      assert.equal(blocked.headers.get("retry-after"), "120");
      assert.ok((await app.poll(first.id, first.headers)).result.log);
      t.mock.timers.tick(120001);
    }
    const next = (await app.route("/session"))!;
    assert.equal(next.status, 200);
    assert.equal((app.instance as any).jobs.size, 0);
  }
});

test("a result discarded after its read window returns a clear private HTTP 410", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const app = fixture(config(), { terminalReadMs: 100 });
  const first = await accepted(app, "first", false);
  await app.poll(first.id, first.headers);
  t.mock.timers.tick(101);
  await assert.rejects(app.route(`/jobs/${first.id}`, first.headers), {
    status: 410,
    code: "result_discarded",
  });
  await assert.rejects(
    app.route(`/jobs/${first.id}`, await app.session("other")),
    { status: 404, code: "missing" },
  );
});

test("an active unknown-cost reservation has no retry promise and retains its full reservation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const gate = deferred();
  const secondTurn = deferred();
  let saved: AssistanceBudgetSnapshot | null = null;
  let calls = 0;
  const provider = config({
    timeoutMs: 5000,
    fetch: (async () => {
      if (++calls === 1) {
        const value = completion(null);
        value.choices[0].message.tool_calls[0].function.arguments = "{}";
        return Response.json(value);
      }
      secondTurn.resolve();
      await gate.promise;
      return Response.json(completion());
    }) as typeof fetch,
  });
  provider.hourlyBudgetUsd =
    estimateAssistanceCost(draft(), [], provider) * 1.5;
  provider.networkHourlyBudgetUsd = provider.hourlyBudgetUsd;
  const app = fixture(provider, {
    budgetStore: {
      load: async () => saved,
      save: async (value) => {
        saved = structuredClone(value);
      },
    },
  });
  const first = await accepted(app, "first", false);
  await secondTurn.promise;
  const response = (await app.route(
    "/assist",
    await app.session("second"),
    draft(),
    "second",
  ))!;
  gate.resolve();
  await app.poll(first.id, first.headers);
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), null);
  assert.equal(((await response.json()) as any).code, "billing_pending");
  assert.equal((saved as any).entries[0].costKnown, false);
  assert.ok((saved as any).entries[0].reservedUsd > 0);
});

test("billing retries wait until every global and network window can fit", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let calls = 0;
  const provider = config({
    hourlyBudgetUsd: 1,
    dailyBudgetUsd: 5,
    networkHourlyBudgetUsd: 0.5,
    networkDailyBudgetUsd: 0.5,
    fetch: (async () =>
      Response.json(completion(++calls === 1 ? 0.2 : 0.7))) as typeof fetch,
  });
  const app = fixture(provider);
  await accepted(app, "192.0.2.1");
  t.mock.timers.tick(100000);
  await accepted(app, "192.0.2.2");
  const response = (await app.route(
    "/assist",
    await app.session("192.0.2.1"),
    draft(),
    "192.0.2.1",
  ))!;
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "86300");
});

test("malformed network hash state fails closed without a provider call", async () => {
  let saved: AssistanceBudgetSnapshot | null = null;
  const options = {
    budgetStore: {
      load: async () => saved,
      save: async (value: AssistanceBudgetSnapshot) => {
        saved = structuredClone(value);
      },
    },
  };
  await accepted(fixture(config(), options), "192.0.2.1");
  await new Promise((resolve) => setTimeout(resolve, 1));
  const good = structuredClone(saved) as any;
  for (const patch of [
    (value: any) => {
      delete value.networkHashKey;
    },
    (value: any) => {
      value.networkHashKey = "invalid";
    },
    (value: any) => {
      value.entries[0].networkHashes = ["192.0.2.1"];
    },
    (value: any) => {
      value.entries[0].networkHashes.push(value.entries[0].networkHashes[0]);
    },
    (value: any) => {
      value.entries[0].deadline = -1;
    },
  ]) {
    saved = structuredClone(good);
    patch(saved);
    const app = fixture(
      config({
        fetch: (async () => {
          assert.fail("A corrupt ledger cannot call the provider.");
        }) as typeof fetch,
      }),
      options,
    );
    await assert.rejects(app.route("/assist", await app.session(), draft()), {
      status: 503,
      code: "billing_unavailable",
    });
  }
});

test("pending answers that raise charges or lose cost reporting receive no early retry promise", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  for (const laterCost of [0.4, null]) {
    const gate = deferred();
    const secondTurn = deferred();
    let calls = 0;
    const provider = config({
      timeoutMs: 5000,
      hourlyBudgetUsd: 0.7,
      networkHourlyBudgetUsd: 0.7,
      fetch: (async () => {
        if (++calls === 1) {
          const value = completion(0.1);
          value.choices[0].message.tool_calls[0].function.arguments = "{}";
          return Response.json(value);
        }
        secondTurn.resolve();
        await gate.promise;
        return Response.json(completion(laterCost));
      }) as typeof fetch,
    });
    const app = fixture(provider);
    const first = await accepted(app, "first", false);
    await secondTurn.promise;
    const headers = await app.session("second");
    const response = (await app.route("/assist", headers, draft(), "second"))!;
    t.mock.timers.tick(2000);
    gate.resolve();
    await app.poll(first.id, first.headers);
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), null);
    assert.equal(((await response.json()) as any).code, "billing_pending");
    const terminal = (await app.route("/assist", headers, draft(), "second"))!;
    assert.equal(terminal.status, 429);
    assert.equal(terminal.headers.get("retry-after"), "3600");
    assert.equal(((await terminal.json()) as any).code, "billing_limit");
    t.mock.timers.tick(3600000);
    await accepted(app, "second");
  }
});

test("restart keeps an interrupted reservation until the stored deadline plus its charged window", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const gate = deferred();
  let saved: AssistanceBudgetSnapshot | null = null;
  const original = fixture(
    config({
      timeoutMs: 5000,
      fetch: (async () => {
        await gate.promise;
        return Response.json(completion());
      }) as typeof fetch,
    }),
    {
      budgetStore: {
        load: async () => null,
        save: async (value) => {
          saved = structuredClone(value);
        },
      },
    },
  );
  const first = await accepted(original, "192.0.2.1", false);
  const interrupted = structuredClone(saved);
  const restarted = fixture(config(), {
    budgetStore: {
      load: async () => interrupted,
      save: async (value) => {
        saved = structuredClone(value);
      },
    },
  });
  const blocked = (await restarted.route(
    "/assist",
    await restarted.session("192.0.2.1"),
    draft(),
    "192.0.2.1",
  ))!;
  gate.resolve();
  await original.poll(first.id, first.headers);
  assert.equal(blocked.status, 429);
  assert.equal(((await blocked.json()) as any).code, "billing_limit");
  assert.equal(blocked.headers.get("retry-after"), "3605");
});

test("unreserved terminal failures remain readable until eviction or their read-window expiry", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const app = fixture(
    config({
      key: async () => "",
      fetch: (async () => {
        assert.fail("No credentials must mean no provider call.");
      }) as typeof fetch,
    }),
    { terminalReadMs: 100, networkSessions: 1 },
  );
  const headers = await app.session();
  const response = (await app.route("/assist", headers, draft()))!;
  assert.equal(response.status, 202);
  const id = ((await response.json()) as any).job;
  const failed = await app.poll(id, headers);
  assert.equal(failed.state, "failed");
  assert.equal(failed.error.code, "provider_credentials");
  assert.equal(failed.error.log.answers, 0);
  t.mock.timers.tick(101);
  await assert.rejects(app.route(`/jobs/${id}`, headers), {
    status: 410,
    code: "result_discarded",
  });
  assert.equal((await app.route("/session"))!.status, 200);
});

test("active retained and session capacity retries include the terminal read window", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  for (const limits of [
    { ttlMs: 600000, terminalReadMs: 2000, deadlineMs: 5000, releaseMs: 7000 },
    { ttlMs: 6000, terminalReadMs: 2000, deadlineMs: 4500, releaseMs: 6000 },
    {
      ttlMs: 600000,
      terminalReadMs: 200000,
      deadlineMs: 5000,
      releaseMs: 125000,
    },
    {
      ttlMs: 600000,
      terminalReadMs: 2000,
      deadlineMs: 5000,
      releaseMs: 7000,
      lateCompletionMs: 1,
    },
  ]) {
    const gate = deferred();
    const secondTurn = deferred();
    let calls = 0;
    const app = fixture(
      config({
        timeoutMs: 5000,
        fetch: (async () => {
          if (++calls === 1) {
            const value = completion();
            value.choices[0].message.tool_calls[0].function.arguments = "{}";
            return Response.json(value);
          }
          if (calls === 2) {
            secondTurn.resolve();
            await gate.promise;
          }
          return Response.json(completion());
        }) as typeof fetch,
      }),
      { ...limits, retainedJobs: 1, networkSessions: 1 },
    );
    const first = await accepted(app, "192.0.2.1", false);
    await secondTurn.promise;
    const other = await app.session("192.0.2.2");
    const retained = (await app.route("/assist", other, draft(), "192.0.2.2"))!;
    const session = (await app.route("/session", {}, undefined, "192.0.2.1"))!;
    const completionMs = limits.deadlineMs + (limits.lateCompletionMs ?? 0);
    t.mock.timers.tick(completionMs);
    gate.resolve();
    assert.equal((await app.poll(first.id, first.headers)).state, "completed");
    const stillRetained = (await app.route(
      "/assist",
      other,
      draft(),
      "192.0.2.2",
    ))!;
    const stillProtected = (await app.route(
      "/session",
      {},
      undefined,
      "192.0.2.1",
    ))!;
    assert.equal(
      stillRetained.status,
      429,
      "Completion retains the paid result past the execution deadline.",
    );
    assert.equal(
      stillProtected.status,
      429,
      "The result owner's session stays protected during its read window.",
    );
    assert.equal(retained.status, 429);
    assert.equal(session.status, 429);
    assert.equal(
      retained.headers.get("retry-after"),
      String(limits.releaseMs / 1000),
    );
    assert.equal(
      session.headers.get("retry-after"),
      String(limits.releaseMs / 1000),
    );
    t.mock.timers.tick(limits.releaseMs - completionMs);
    const retried = (await app.route("/assist", other, draft(), "192.0.2.2"))!;
    assert.equal(retried.status, 202);
    await app.poll(((await retried.json()) as any).job, other);
    assert.equal(
      (await app.route("/session", {}, undefined, "192.0.2.1"))!.status,
      200,
    );
  }
});

test("execution concurrency without a retained-capacity block still retries at the execution deadline", async () => {
  const gate = deferred();
  const app = fixture(
    config({
      timeoutMs: 5000,
      concurrency: 1,
      fetch: (async () => {
        await gate.promise;
        return Response.json(completion());
      }) as typeof fetch,
    }),
  );
  const first = await accepted(app, "192.0.2.1", false);
  const response = (await app.route(
    "/assist",
    await app.session("192.0.2.2"),
    draft(),
    "192.0.2.2",
  ))!;
  gate.resolve();
  await app.poll(first.id, first.headers);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "5");
});
