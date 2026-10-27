import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../../core/src/index.ts";
import {
  AssistanceService,
  minimumAssistanceCost,
  type AssistanceOptions,
  type AssistRequest,
} from "../src/assistance.ts";
import { providerConfig } from "../src/inference.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);
const draft = (): AssistRequest => ({
  operation: "type",
  draft_revision: "session-test",
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
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(
  options: Partial<AssistanceOptions> = {},
  context = async (_: string[]) => [] as any[],
) {
  let calls = 0;
  const provider = {
    ...providerConfig(
      { JVC_AI_ENABLED: "enabled" },
      async () => "disposable-session-key",
    )!,
    fetch: (async () => {
      calls++;
      return Response.json({
        choices: [
          {
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
        usage: { cost: 0, prompt_tokens: 100, completion_tokens: 50 },
      });
    }) as typeof fetch,
  };
  const app = new AssistanceService(
    { provider, sessionJobs: 1000, networkJobs: 1000, ...options },
    "session-test",
    context,
  );
  const route = (
    path: string,
    headers: Record<string, string> = {},
    body?: unknown,
    network = "local",
    method = body ? "POST" : "GET",
    read = async (_signal?: AbortSignal) => bytes(body),
  ) =>
    app.route(
      new Request(`http://localhost${path}`, {
        method,
        headers: { origin: "http://localhost", ...headers },
        body: body ? JSON.stringify(body) : undefined,
      }),
      path,
      read,
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
  const accepted = async (
    headers: Record<string, string>,
    network = "local",
  ) => {
    const response = (await route("/assist", headers, draft(), network))!;
    assert.equal(response.status, 202);
    const id = ((await response.json()) as any).job as string;
    for (let i = 0; i < 100; i++) {
      const job = (await (await route(`/jobs/${id}`, headers))!.json()) as any;
      if (job.state === "completed") {
        await route(`/jobs/${id}`, headers, undefined, network, "DELETE");
        return id;
      }
      await new Promise((done) => setTimeout(done, 1));
    }
    throw new Error("Job did not finish.");
  };
  return { app, route, session, accepted, provider, calls: () => calls };
}

test("a hanging upload cannot protect its session and cannot admit work after eviction", async () => {
  const upload = gate();
  const app = fixture({ networkSessions: 1 });
  const headers = await app.session();
  const pending = app.route(
    "/assist",
    headers,
    draft(),
    "local",
    "POST",
    async () => {
      await upload.promise;
      return bytes(draft());
    },
  );
  const failed = assert.rejects(pending, { status: 401, code: "session" });
  const replacement = (await app.route("/session"))!;
  upload.resolve();
  await failed;
  assert.equal(replacement.status, 200);
  assert.equal(app.calls(), 0);
});

test("a stalled body read times out and aborts the reader without a context load", async () => {
  let loads = 0;
  let signal: AbortSignal | undefined;
  const app = fixture(
    { requestBodyTimeoutMs: 15 } as Partial<AssistanceOptions>,
    async () => {
      loads++;
      return [];
    },
  );
  const headers = await app.session();
  await assert.rejects(
    app.route("/assist", headers, draft(), "local", "POST", (value) => {
      signal = value;
      return new Promise(() => {});
    }),
    { status: 408, code: "request_timeout" },
  );
  assert.equal(signal?.aborted, true);
  assert.equal(loads, 0);
  assert.equal(app.calls(), 0);
  assert.equal((app.app as any).admitting.size, 0);
});

test("invalid JSON and oversized bodies fail before session protection or context loading", async () => {
  let loads = 0;
  const app = fixture({}, async () => {
    loads++;
    return [];
  });
  const headers = await app.session();
  for (const [body, error] of [
    [new TextEncoder().encode("{"), { status: 400, code: "assist_request" }],
    [new Uint8Array(262145), { status: 413, code: "size" }],
  ] as const) {
    await assert.rejects(
      app.route("/assist", headers, draft(), "local", "POST", async () => body),
      error,
    );
    assert.equal((app.app as any).admitting.size, 0);
  }
  assert.equal(loads, 0);
  assert.equal(app.calls(), 0);
});

test("only a parsed request protects the session before context loading", async () => {
  const context = gate();
  const started = gate();
  const app = fixture({ networkSessions: 1 }, async () => {
    started.resolve();
    await context.promise;
    return [];
  });
  const headers = await app.session();
  const pending = app.route("/assist", headers, draft());
  await started.promise;
  assert.equal((await app.route("/session"))!.status, 429);
  context.resolve();
  assert.equal((await pending)!.status, 202);
});

test("unknown and foreign jobs stay missing while owner expiry markers distinguish expired jobs", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const app = fixture({ ttlMs: 4000 });
  const owner = await app.session();
  const other = await app.session("other");
  await assert.rejects(app.route("/jobs/unknown", owner), {
    status: 404,
    code: "missing",
  });
  const id = await app.accepted(owner);
  for (const method of ["GET", "DELETE"])
    await assert.rejects(
      app.route(`/jobs/${id}`, other, undefined, "other", method),
      { status: 404, code: "missing" },
    );
  t.mock.timers.tick(4001);
  for (const method of ["GET", "DELETE"]) {
    await assert.rejects(
      app.route(`/jobs/${id}`, owner, undefined, "local", method),
      { status: 410, code: "job_expired" },
    );
    await assert.rejects(
      app.route(`/jobs/${id}`, other, undefined, "other", method),
      { status: 404, code: "missing" },
    );
  }
  const marker = (app.app as any).expiredJobs.get(id);
  assert.deepEqual(Object.keys(marker).sort(), ["expires", "owner"]);
  t.mock.timers.tick(3500000);
  await app.route("/session", owner);
  t.mock.timers.tick(100000);
  await assert.rejects(app.route(`/jobs/${id}`, owner), {
    status: 404,
    code: "missing",
  });
});

test("session record limits are separate from other sessions and expiry markers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const app = fixture({ ttlMs: 8000 });
  const owner = await app.session();
  const ids: string[] = [];
  for (let i = 0; i < 128; i++) ids.push(await app.accepted(owner));
  t.mock.timers.tick(1100);
  const denied = (await app.route("/assist", owner, draft()))!;
  assert.equal(denied.status, 429);
  assert.equal(((await denied.json()) as any).code, "session_job_limit");
  assert.equal(denied.headers.get("retry-after"), "7");
  await app.accepted(await app.session("other"), "other");
  t.mock.timers.tick(8001);
  const next = await app.accepted(owner);
  assert.equal((app.app as any).expiredJobs.size, 129);
  t.mock.timers.tick(8001);
  await assert.rejects(app.route(`/jobs/${next}`, owner), {
    status: 410,
    code: "job_expired",
  });
  assert.equal((app.app as any).expiredJobs.size, 129);
  const oldest = ids.sort()[0];
  await assert.rejects(app.route(`/jobs/${oldest}`, owner), {
    status: 404,
    code: "missing",
  });
  await assert.rejects(app.route(`/jobs/${ids[1]}`, owner), {
    status: 410,
    code: "job_expired",
  });
});

test("expiry timers keep only owner markers and session replacement removes them", async () => {
  const app = fixture({ ttlMs: 150, networkSessions: 1 });
  const owner = await app.session();
  const id = await app.accepted(owner);
  await new Promise((done) => setTimeout(done, 160));
  assert.equal((app.app as any).jobs.has(id), false);
  assert.equal((app.app as any).expiredJobs.has(id), true);
  const replacement = await app.session();
  assert.equal((app.app as any).expiredJobs.size, 0);
  await assert.rejects(app.route(`/jobs/${id}`, replacement), {
    status: 404,
    code: "missing",
  });
  const restarted = fixture();
  await assert.rejects(
    restarted.route(`/jobs/${id}`, await restarted.session()),
    { status: 404, code: "missing" },
  );
});

test("custom empty spending allowances omit impossible operations without hiding defaults", () => {
  const defaults = fixture();
  assert.deepEqual(
    defaults.app.capabilities()[0].operations,
    defaults.provider.operations,
  );
  for (const field of [
    "hourlyBudgetUsd",
    "dailyBudgetUsd",
    "networkHourlyBudgetUsd",
    "networkDailyBudgetUsd",
    "maxCostUsd",
  ] as const) {
    const provider = { ...defaults.provider, [field]: 0.000001 };
    const app = new AssistanceService(
      { provider },
      "session-test",
      async () => [],
    );
    assert.deepEqual(app.capabilities(), [], field);
  }
  const provider = {
    ...defaults.provider,
    operations: ["type", "gismu-sources"],
  };
  const typeCost = minimumAssistanceCost(provider, "type");
  const sourcesCost = minimumAssistanceCost(provider, "gismu-sources");
  assert.notEqual(typeCost, sourcesCost);
  const allowed = typeCost < sourcesCost ? "type" : "gismu-sources";
  const blocked = typeCost < sourcesCost ? "gismu-sources" : "type";
  provider.maxCostUsd = (typeCost + sourcesCost) / 2;
  const app = new AssistanceService(
    { provider },
    "session-test",
    async () => [],
  );
  assert.deepEqual(app.capabilities()[0].operations, [allowed]);
  const disclosedTasks = app
    .capabilities()[0]
    .disclosure.match(/all declared tasks: ([^.]+)\./)?.[1]
    .split(", ");
  assert.deepEqual(disclosedTasks, [allowed]);
  assert.ok(!disclosedTasks.includes(blocked));
});
