import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkAnswer,
  InferenceRunner,
  newLog,
  providerConfig,
  schemaFor,
  taskMessages,
  type TaskCase,
} from "../src/inference.ts";

const spec: TaskCase = {
  task: "glosses",
  input: "One word and two places.",
  keys: ["word", "x1", "x2"],
};
const answer = {
  word: { gloss: "teach", sense: "instruct a learner" },
  x1: { gloss: "teacher", sense: "" },
  x2: { gloss: "subject", sense: "" },
};

test("correction feedback names missing and unknown answer fields", async () => {
  const { x2, ...partial } = answer;
  const wrong = { ...partial, x3: x2 };
  const nested = { ...answer, word: { ...answer.word, note: "extra" } };
  assert.deepEqual(checkAnswer(spec, wrong), [
    "answer.x2 is missing.",
    "answer.x3 is not allowed.",
  ]);
  assert.deepEqual(checkAnswer(spec, nested), [
    "answer.word.note is not allowed.",
  ]);
  let turn = 0;
  const config = providerConfig(
    { JVC_AI_ENABLED: "enabled", JVC_AI_BASE_URL: "http://127.0.0.1:9999" },
    async () => "disposable-feedback-secret",
  )!;
  config.fetch = (async (_url: unknown, init: any) => {
    const request = JSON.parse(init.body);
    if (turn === 1) {
      const feedback = request.messages.at(-1).content;
      assert.match(feedback, /answer\.x2 is missing\./);
      assert.match(feedback, /answer\.x3 is not allowed\./);
    }
    return Response.json({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: `call-${turn}`,
                type: "function",
                function: {
                  name: "submit_answer",
                  arguments: JSON.stringify(turn++ ? answer : wrong),
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.00001 },
    });
  }) as typeof fetch;
  const log = newLog("places-glosses", config, "feedback-fixture");
  const runner = new InferenceRunner(config, log, AbortSignal.timeout(2000));
  assert.deepEqual(await runner.run(spec), answer);
  assert.equal(log.corrections, 1);
});

test("field diagnostics keep missing fields while bounding hostile unknown names", () => {
  const longName = "unknown-" + "Q".repeat(10000);
  const problems = checkAnswer(spec, {
    ...Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`${longName}-${index}`, null]),
    ),
  });
  assert.ok(problems.includes("answer.word is missing."));
  assert.ok(problems.includes("answer.x2 is missing."));
  assert.ok(problems.some((problem) => problem.includes("unknown-")));
  assert.ok(problems.every((problem) => problem.length <= 512));
  assert.ok(problems.length <= 32);
  assert.equal(problems.join("\n").includes("Q".repeat(65)), false);
});

test("mapping tool schemas teach studied spellings and the checker names permitted places", () => {
  const mapping: TaskCase = {
    task: "mappings",
    input: "",
    keys: ["x1"],
    components: ["klama[2]", "karce[3]"],
  };
  const schema = schemaFor(mapping);
  assert.match(
    schema.properties.x1.items.properties.component.description,
    /such as klama\[2\]/,
  );
  assert.equal(schema.properties.x1.items.properties.component.enum, undefined);
  assert.deepEqual(
    checkAnswer(mapping, {
      x1: [
        { component: "klama[2]", reason: "direct: the travel destination." },
      ],
    }),
    [],
  );
  const problems = checkAnswer(mapping, {
    x1: [{ component: "c2[1]", reason: "direct: an internal label." }],
  });
  assert.match(problems[0], /Use klama\[2\], karce\[3\], none, or unclear/);
});

const largeMappingCase: TaskCase = {
  task: "mappings",
  input: "{}",
  keys: Array.from({ length: 256 }, (_, index) => `x${index + 1}`),
  components: Array.from({ length: 64 }, (_, component) =>
    Array.from(
      { length: 256 },
      (_, place) => `${"k".repeat(250)}${component}[${place + 1}]`,
    ),
  ).flat(),
};

test("mapping schemas stay small with every admitted place and component", () => {
  const schema = schemaFor(largeMappingCase);
  assert.ok(JSON.stringify(schema.properties.x1).length < 4096);
  assert.ok(JSON.stringify(schema).length < 131072);
});

test("mapping legends group repeated spellings and use an available full name as the example", () => {
  const prepared = taskMessages({ decisionReports: false }, largeMappingCase);
  assert.ok(prepared.input.length < 131072);
  assert.ok(
    prepared.input.includes(`for example ${largeMappingCase.components![0]}`),
  );
});
