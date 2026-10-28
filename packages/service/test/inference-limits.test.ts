import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InferenceRunner,
  newLog,
  providerConfig,
  checkAnswer,
  type TaskCase,
} from "../src/inference.ts";
import * as inferenceModule from "../src/inference.ts";

const key = "disposable-inference-secret";
function config(fetcher: typeof fetch) {
  return {
    ...providerConfig({ JVC_AI_ENABLED: "enabled" }, async () => key)!,
    fetch: fetcher,
  };
}
const completion = (answer: unknown, content = "") => ({
  choices: [
    {
      finish_reason: "tool_calls",
      message: {
        content,
        tool_calls: [
          {
            id: "call",
            type: "function",
            function: {
              name: "submit_answer",
              arguments: JSON.stringify(answer),
            },
          },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 },
});

test("adapter address identity normalizes IPv6 prefixes and mapped IPv4", () => {
  const normalize = (inferenceModule as any).normalizeClientNetwork;
  assert.equal(typeof normalize, "function");
  assert.equal(
    normalize("2001:db8:1:2::1"),
    normalize("2001:0db8:0001:0002:ffff::2"),
  );
  assert.notEqual(normalize("2001:db8:1:2::1"), normalize("2001:db8:1:3::1"));
  assert.equal(normalize("::ffff:192.0.2.5"), normalize("192.0.2.5"));
  assert.equal(normalize("::ffff:c000:205"), normalize("192.0.2.5"));
  assert.equal(normalize("client-set-bucket"), "");
  assert.equal(normalize("::1]/forged"), "");
});

test("Node proxy trust uses one replaced IP header from exact trusted peers only", () => {
  const identify = (inferenceModule as any).nodeClientNetwork;
  assert.equal(typeof identify, "function");
  assert.equal(identify("192.0.2.1", "198.51.100.8", []), "192.0.2.1");
  assert.equal(
    identify("127.0.0.1", "198.51.100.8", ["127.0.0.1"]),
    "198.51.100.8",
  );
  assert.equal(
    identify("::ffff:127.0.0.1", "198.51.100.8", ["127.0.0.1"]),
    "198.51.100.8",
  );
  assert.equal(identify("127.0.0.1", null, ["127.0.0.1"]), "");
  assert.equal(
    identify("127.0.0.1", "198.51.100.8, 198.51.100.9", ["127.0.0.1"]),
    "",
  );
  assert.equal(identify("127.0.0.1", "198.51.100.8", ["::1"]), "");
});

test("Node assistance defaults to direct loopback and requires explicit proxy trust for remote HTTPS", () => {
  const available = (inferenceModule as any).nodeAssistanceIdentityAvailable;
  assert.equal(typeof available, "function");
  assert.equal(available("127.0.0.1", undefined, []), true);
  assert.equal(available("0.0.0.0", undefined, []), false);
  assert.equal(available("127.0.0.1", "https://dictionary.example", []), false);
  assert.equal(
    available("127.0.0.1", "https://dictionary.example", ["127.0.0.1"]),
    true,
  );
});

test("Worker local provenance and explicit edge trust ignore spoofed client headers", () => {
  const identify = (inferenceModule as any).workerClientNetwork;
  assert.equal(typeof identify, "function");
  assert.equal(identify("2001:db8::1", true, false, false), "");
  assert.equal(identify("2001:db8::1", true, true, false), "2001:db8:0:0::/64");
  assert.equal(identify("2001:db8::1", false, true, false), "");
  assert.equal(identify("spoofed", true, true, true), "local");
  assert.equal(identify("192.0.2.1", true, false, true), "local");
});

test("answer checks see exact text while log and correction copies redact secrets", async () => {
  const requests: any[] = [];
  const text = "x1 is a risk-assessment of x2 for task-specific purpose x3.";
  const settings = config((async (_url, init) => {
    requests.push(JSON.parse(String(init!.body)));
    return Response.json(
      completion(
        { text, reason: "task-specific" },
        `${key} sk-proj-1234567890`,
      ),
    );
  }) as typeof fetch);
  const log = newLog("definition", settings, "test");
  let checks = 0;
  const answer = await new InferenceRunner(
    settings,
    log,
    new AbortController().signal,
  ).run({
    task: "definition",
    input: "draft",
    check(value) {
      assert.equal(value.text, text);
      return ++checks === 1 ? ["Try again."] : [];
    },
  });
  assert.equal(answer.text, text);
  assert.equal(answer.reason, "task-specific");
  assert.equal(requests.length, 2);
  assert.equal(JSON.stringify(log).includes(key), false);
  assert.equal(JSON.stringify(log).includes("sk-proj-1234567890"), false);
  assert.equal(JSON.stringify(requests[1]).includes(key), false);
  assert.match(JSON.stringify(log), /risk-assessment/);
});

test("defaults reserve all twelve bounded answers and their correction histories", async () => {
  let turns = 0;
  const padding = '\\"'.repeat(50000);
  const settings = config((async () => {
    turns++;
    return Response.json(
      completion({ text: "definition", reason: "reason" }, padding),
    );
  }) as typeof fetch);
  const log = newLog("places-glosses", settings, "test");
  const runner = new InferenceRunner(
    settings,
    log,
    new AbortController().signal,
  );
  for (let task = 0; task < 4; task++) {
    let attempts = 0;
    const spec: TaskCase = {
      task: "definition",
      input: "x".repeat(262144 + 131072 + 262144),
      check: () => (++attempts < 3 ? ["Correct this answer."] : []),
    };
    await runner.run(spec);
  }
  assert.equal(turns, 12);
  assert.equal(log.answers, 12);
});


test("known secrets in an otherwise valid answer cannot enter a proposal or correction", async () => {
  const requests: any[] = [];
  let checks = 0;
  const checked: string[] = [];
  const settings = config((async (_url, init) => {
    requests.push(JSON.parse(String(init!.body)));
    return Response.json(
      completion({
        text: requests.length === 1 ? key : "safe definition",
        reason: "reason",
      }),
    );
  }) as typeof fetch);
  const log = newLog("definition", settings, "test");
  const answer = await new InferenceRunner(
    settings,
    log,
    new AbortController().signal,
  ).run({
    task: "definition",
    input: "draft",
    check(value) {
      checks++;
      checked.push(value.text);
      return [];
    },
  });
  assert.equal(answer.text, "safe definition");
  assert.deepEqual(checked, [key, "safe definition"]);
  assert.equal(requests.length, 2);
  assert.equal(JSON.stringify(log).includes(key), false);
  assert.equal(JSON.stringify(requests[1]).includes(key), false);
});

test("multiple tool calls receive one bounded correction without duplicated feedback", async () => {
  const requests: any[] = [];
  const settings = config((async (_url, init) => {
    requests.push(JSON.parse(String(init!.body)));
    const value = completion({ text: "safe definition", reason: "reason" });
    if (requests.length === 1)
      value.choices[0].message.tool_calls = Array.from(
        { length: 1000 },
        (_, index) => ({
          ...value.choices[0].message.tool_calls[0],
          id: `call-${index}`,
        }),
      );
    return Response.json(value);
  }) as typeof fetch);
  await new InferenceRunner(
    settings,
    newLog("definition", settings, "test"),
    new AbortController().signal,
  ).run({ task: "definition", input: "draft" });
  assert.ok(requests[1].messages.length <= 4);
  assert.ok(JSON.stringify(requests[1]).length < 32768);
});

test("oversized answer collections return bounded structural diagnostics", () => {
  const problems = checkAnswer(
    { task: "hints", input: "draft", keys: ["x1"] },
    { x1: Array.from({ length: 10000 }, () => ({})) },
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /invalid number/);
});

test("compact response fields preserve raw payloads and immutable request snapshots share messages", async () => {
  const response = completion({ text: "definition", reason: "reason" });
  (response as any).metadata = JSON.parse(
    '{"__proto__":{"marker":"ordinary"},"constructor":{"marker":"constructor"},"authorization":"ordinary metadata"}',
  );
  (response as any).metadata.unknown = Array.from({ length: 1000 }, () => ({
    nested: [],
  }));
  (response.choices[0].message as any).reasoning_details = [
    {
      type: "reasoning.summary",
      summary: "summary",
      unknown: Array.from({ length: 1000 }, () => ({})),
    },
  ];
  const settings = config((async () =>
    Response.json(response)) as typeof fetch);
  const log = newLog("definition", settings, "test");
  let checks = 0;
  await new InferenceRunner(settings, log, new AbortController().signal).run({
    task: "definition",
    input: "draft",
    check: () => (++checks < 3 ? ["Correct this answer."] : []),
  });
  const attempts = log.exchanges[0].attempts;
  assert.equal(
    attempts[0].request.messages[0],
    attempts[2].request.messages[0],
  );
  assert.equal(
    attempts[0].request.messages[1],
    attempts[2].request.messages[1],
  );
  assert.equal(
    attempts[1].request.messages[2],
    attempts[2].request.messages[2],
  );
  assert.equal(
    typeof Object.getOwnPropertyDescriptor(attempts[0], "response")!.get,
    "function",
  );
  assert.equal(
    typeof Object.getOwnPropertyDescriptor(attempts[0], "tool_calls")!.get,
    "function",
  );
  assert.equal(
    typeof Object.getOwnPropertyDescriptor(
      attempts[1].request.messages[2],
      "reasoning_details",
    )!.get,
    "function",
  );
  const raw = JSON.parse(JSON.stringify(log));
  assert.deepEqual(raw.exchanges[0].attempts[0].response, response);
  assert.equal(
    Object.hasOwn(raw.exchanges[0].attempts[0].response.metadata, "__proto__"),
    true,
  );
  assert.equal(
    Object.hasOwn(
      raw.exchanges[0].attempts[0].response.metadata,
      "constructor",
    ),
    true,
  );
  assert.equal(
    Object.getPrototypeOf(raw.exchanges[0].attempts[0].response.metadata),
    Object.prototype,
  );
  assert.deepEqual(
    raw.exchanges[0].attempts[0].tool_calls,
    response.choices[0].message.tool_calls,
  );
  assert.deepEqual(
    raw.exchanges[0].attempts[1].request.messages[2].reasoning_details,
    (response.choices[0].message as any).reasoning_details,
  );
});

test("diagnostics redact complete credentials before their length is bounded", async () => {
  const settings = config((async () =>
    Response.json(
      completion({ text: "definition", reason: "reason" }),
    )) as typeof fetch);
  const log = newLog("definition", settings, "test");
  let checks = 0;
  await new InferenceRunner(settings, log, new AbortController().signal).run({
    task: "definition",
    input: "draft",
    check: () => (++checks === 1 ? ["x".repeat(500) + key] : []),
  });
  assert.equal(JSON.stringify(log).includes("disposable-r"), false);
});

test("deep unknown metadata stays exact without recursive redaction or serialization", async () => {
  const nested = "[".repeat(10000) + "0" + "]".repeat(10000);
  const response = completion({ text: "definition", reason: "reason" });
  (response.choices[0].message as any).reasoning_details = [
    {
      type: "reasoning.summary",
      summary: "summary",
      unknown: "DEPTH_PLACEHOLDER",
    },
  ];
  const rawResponse = JSON.stringify(response).replace(
    '"DEPTH_PLACEHOLDER"',
    nested,
  );
  const requests: any[] = [];
  const settings = config((async (_url, init) => {
    requests.push(JSON.parse(String(init!.body)));
    return new Response(rawResponse, {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  const log = newLog("definition", settings, "test");
  let checks = 0;
  await new InferenceRunner(settings, log, new AbortController().signal).run({
    task: "definition",
    input: "draft",
    check: () => (++checks === 1 ? ["Correct this answer."] : []),
  });
  for (const value of [
    (log.exchanges[0].attempts[0].response as any).choices[0].message
      .reasoning_details[0].unknown,
    requests[1].messages[2].reasoning_details[0].unknown,
  ]) {
    let node = value;
    let depth = 0;
    while (Array.isArray(node)) {
      node = node[0];
      depth++;
    }
    assert.equal(depth, 10000);
    assert.equal(node, 0);
  }
});

test("malformed tool_calls keep the displayed call list empty and the raw response exact", async () => {
  const response = completion({ text: "definition", reason: "reason" });
  (response.choices[0].message as any).tool_calls = "malformed";
  const settings = config((async () =>
    Response.json(response)) as typeof fetch);
  const log = newLog("definition", settings, "test");
  await assert.rejects(
    new InferenceRunner(settings, log, new AbortController().signal).run({
      task: "definition",
      input: "draft",
    }),
    { code: "invalid_answer" },
  );
  assert.deepEqual(log.exchanges[0].attempts[0].tool_calls, []);
  assert.deepEqual(log.exchanges[0].attempts[0].response, response);
});
