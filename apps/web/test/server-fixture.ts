/**
 * Starts the Node adapter for browser tests with a selected view.
 * JVC_FIXTURE=seeded publishes the synthetic two-root fixture from seed.ts.
 * Otherwise it publishes an empty-root view, as the earlier tests expect.
 */
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import {
  initializeCore,
  createEvent,
} from "../../../packages/core/src/index.ts";
import { admit, buildFixture } from "./seed.ts";
/**
 * The test readiness signal. The runner waits for this listener to answer
 * 200, which happens only after every fixture record is admitted and the
 * fixture file is complete. The API's own routes answer earlier, while
 * preparation is still running, so they are not the signal. A preparation
 * failure ends this process with the error, and the runner reports it.
 */
const readyPort = process.env.JVC_READY_PORT;
let prepared = false;
if (readyPort) {
  const listener = createServer((request, response) => {
    if (request.url !== "/ready") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(prepared ? 200 : 503, { "content-type": "text/plain" });
    response.end(prepared ? "ready\n" : "preparing the fixture\n");
  });
  listener.unref();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(Number(readyPort), "127.0.0.1", resolve);
  });
}
process.on("unhandledRejection", (error) => {
  console.error("Fixture preparation failed:", error);
  process.exit(1);
});
await initializeCore(
  await readFile(
    new URL(
      "../../../packages/core/generated/jvc_runtime_bg.wasm",
      import.meta.url,
    ),
  ),
);
const origin = `http://127.0.0.1:${process.env.PORT ?? 8797}`;
const seeded = process.env.JVC_FIXTURE === "seeded";
let events: { envelope: { id: string } }[] = [];
let view: { envelope: { id: string }; body: unknown };
let fixture: unknown = null;
let selection: string | undefined;
if (seeded) {
  const built = await buildFixture(origin);
  events = built.events;
  view = built.view;
  fixture = built.fixture;
  selection = built.selection;
} else {
  const fixtureSeed = new Uint8Array(32).fill(37);
  view = createEvent(
    fixtureSeed,
    [],
    "e".repeat(32),
    { kind: "view.publish", parents: [] },
    {
      name: "Browser test view",
      description: [],
      roots: [],
      rafsi_threshold: { numerator: 1, denominator: 1 },
      H: { numerator: 3, denominator: 1 },
      alpha: { numerator: 1, denominator: 2 },
      excluded: [],
      calculation: "simple-routes-bounds-v1",
      work: 1000,
      import_sets: [],
      account_witnesses: [],
      account_authority: false,
      notes: [],
    },
  );
  fixtureSeed.fill(0);
}
/** The browser fixture uses a disposable provider on loopback. It never uses an operator key. */
const provider = createServer(async (request, response) => {
  if (request.url !== "/chat/completions" || request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  let raw = "";
  for await (const chunk of request) {
    raw += String(chunk);
    if (raw.length > 1024 * 1024) {
      response.writeHead(413).end();
      return;
    }
  }
  const body = JSON.parse(raw);
  const corrected = body.messages.some(
    (m: { role: string }) => m.role === "tool",
  );
  const componentTask = Object.hasOwn(
    body.tools?.[0]?.function?.parameters?.properties ?? {},
    "components",
  );
  const sourceTask = Object.hasOwn(
    body.tools?.[0]?.function?.parameters?.properties ?? {},
    "word_ipa",
  );
  const supplied =
    componentTask || sourceTask
      ? JSON.parse(
          body.messages.find(
            (message: { role: string }) => message.role === "user",
          ).content,
        )
      : null;
  const answer = sourceTask
    ? {
        word: "book",
        sense: "written work",
        stem: "book",
        word_ipa: "bʊk",
        ipa: "bʊk",
        sounds: "buk",
        note: "The whole word is the stem because nothing can be removed.",
      }
    : componentTask
      ? {
          components: [
            {
              spelling: "cukta",
              definition:
                supplied.current.compound?.components.find(
                  (component: { word: { spelling: string } }) =>
                    component.word.spelling === "cukta",
                )?.definition ?? null,
            },
            { spelling: "sinxa", definition: null },
          ],
          reason: "Keep the selected book component and add a sign component.",
        }
      : corrected
        ? { word_type: "cmavo", reason: "A grammar word fits this meaning." }
        : {};
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      model: "mock-browser-model",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: sourceTask
              ? "The local fixture checked the source fields."
              : componentTask
                ? "The local fixture kept the supplied component constraint."
                : "The local fixture considered the word type.",
            reasoning_details: [
              {
                type: "reasoning.summary",
                summary: "Shared local mock reasoning.",
              },
            ],
            tool_calls: [
              {
                id: "fixture-answer",
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
      usage: { prompt_tokens: 20, completion_tokens: 10, cost: 0.0001 },
    }),
  );
});
provider.unref();
await new Promise<void>((resolve, reject) => {
  provider.once("error", reject);
  provider.listen(0, "127.0.0.1", resolve);
});
const providerPort = (provider.address() as { port: number }).port;
const keyPath = resolve(
  dirname(
    process.env.JVC_FIXTURE_OUT ??
      resolve(
        process.env.JVC_DATA_DIR ?? ".cache/browser-tests",
        "fixture.json",
      ),
  ),
  "mock-provider-key",
);
await mkdir(dirname(keyPath), { recursive: true });
await writeFile(keyPath, "browser-fixture-only", { mode: 0o600 });
process.env.JVC_AI_ENABLED = "enabled";
process.env.JVC_AI_BASE_URL = `http://127.0.0.1:${providerPort}`;
process.env.JVC_AI_KEY_FILE = keyPath;
process.env.JVC_AI_PROVIDER_NAME = "Local browser fixture";
process.env.JVC_AI_MODEL = "mock-browser-model";
process.env.JVC_VIEW = view.envelope.id;
await import("../../../apps/server/src/main.ts");
for (let attempt = 0; attempt < 200; attempt++) {
  try {
    const response = await fetch(`${origin}/api/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(view),
    });
    if (!response.ok)
      throw new Error(`Fixture view admission failed (${response.status}).`);
    break;
  } catch (error) {
    if (attempt === 199) throw error;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
if (seeded) {
  // A harness knob for readiness tests: preparation waits this long before
  // the admissions, so a runner that starts early would see no fixture.
  const delay = Number(process.env.JVC_FIXTURE_DELAY_MS ?? 0);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  await admit(origin, events, view, selection);
  if (process.env.JVC_FIXTURE_OUT) {
    // The file appears complete or not at all.
    const partial = `${process.env.JVC_FIXTURE_OUT}.partial`;
    await writeFile(partial, JSON.stringify(fixture, null, 2));
    await rename(partial, process.env.JVC_FIXTURE_OUT);
  }
}
prepared = true;
