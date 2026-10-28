import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const wasmDirectory = resolve(
  process.env.JVC_STATE_PARITY_WASM_DIR ??
    join(root, "packages/core/generated"),
);
const directory = resolve(
  process.env.JVC_STATE_PARITY_DIR ?? join(root, ".cache/state-parity"),
);
async function readCorpus(directory, kind) {
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".json") && file !== "_wasm-report.json")
    .sort();
  assert(
    files.length > 0,
    `Generate the native ${kind} corpus before this test.`,
  );
  return files.map((file) => ({ kind, file, path: join(directory, file) }));
}
const cases = await readCorpus(directory, "state");
if (process.env.JVC_SHUN_PARITY_DIR) {
  const rankings = await readCorpus(
    resolve(process.env.JVC_SHUN_PARITY_DIR),
    "ranking",
  );
  let shunProfile = false;
  const blockReasons = new Set();
  for (const { path } of rankings) {
    const fixture = JSON.parse(await readFile(path, "utf8"));
    shunProfile ||=
      fixture.expected?.calculation?.algorithm === "simple-routes-shun-v1";
    for (const score of fixture.reviewers?.scores ?? []) {
      for (const reviewer of score.reviewers ?? []) {
        blockReasons.add(
          `${reviewer.public_shun_block === true}/${reviewer.private_block === true}`,
        );
      }
    }
  }
  assert(
    shunProfile,
    "The native ranking corpus must include the shun profile.",
  );
  for (const reasons of ["true/false", "false/true", "true/true"]) {
    assert(
      blockReasons.has(reasons),
      `The native ranking corpus must include public_shun_block/private_block = ${reasons}.`,
    );
  }
  cases.push(...rankings);
}
const timeout = Number(process.env.JVC_STATE_PARITY_TIMEOUT_MS ?? 120000);
assert(
  Number.isSafeInteger(timeout) && timeout > 0,
  "The test timeout must be a positive integer.",
);
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><script type="module">
import init, { evaluate_records, rank_word, EvaluationSession, EvaluationSessionBuilder, extract_host_verified_record } from '/jvc_runtime.js';
await init();
window.runCase = async (index) => {
  const { kind, input, word } = await (await fetch('/fixture/' + index)).json();
  const start = performance.now();
  const encoder = new TextEncoder();
  const bytes = encoder.encode(typeof input === 'string' ? input : JSON.stringify(input));
  const request = typeof input === 'string' ? JSON.parse(input) : input;
  const { events, bodies, ...options } = request;
  const builder = new EvaluationSessionBuilder(encoder.encode(JSON.stringify(options)));
  let streamed;
  const trusted = new EvaluationSessionBuilder(encoder.encode(JSON.stringify(options)));
  let host;
  let consumed = false;
  try {
    for (const envelope of events) {
      const body = bodies[JSON.parse(envelope).id];
      const envelopeBytes = encoder.encode(envelope);
      const bodyBytes = body === undefined ? undefined : encoder.encode(body);
      builder.add_record(envelopeBytes, bodyBytes);
      trusted.add_host_verified_record(extract_host_verified_record(envelopeBytes, bodyBytes));
    }
    consumed = true;
    streamed = builder.finish();
    host = trusted.finish();
  } finally {
    if (!consumed) { builder.free(); trusted.free(); }
  }
  try {
    if (kind === 'state') {
      return {
        result: JSON.parse(evaluate_records(bytes)),
        host_state: JSON.parse(host.state()),
        streamed_state: JSON.parse(streamed.state()),
        milliseconds: performance.now() - start,
      };
    }
    const session = new EvaluationSession(bytes);
    try {
      return {
        result: JSON.parse(rank_word(bytes, word)),
        session: JSON.parse(session.rank(word)),
        reviewers: JSON.parse(session.rank_with_reviewers(word, 16)),
        host_state: JSON.parse(host.state()),
        streamed_state: JSON.parse(streamed.state()),
        host_rank: JSON.parse(host.rank(word)),
        streamed_rank: JSON.parse(streamed.rank(word)),
        streamed_reviewers: JSON.parse(streamed.rank_with_reviewers(word, 16)),
        milliseconds: performance.now() - start,
      };
    } finally {
      session.free();
    }
  } finally {
    streamed.free();
    host.free();
  }
};
</script>`);
      return;
    }
    if (
      url.pathname === "/jvc_runtime.js" ||
      url.pathname === "/jvc_runtime_bg.wasm"
    ) {
      response.setHeader(
        "content-type",
        url.pathname.endsWith(".wasm")
          ? "application/wasm"
          : "application/javascript",
      );
      response.end(await readFile(join(wasmDirectory, url.pathname.slice(1))));
      return;
    }
    const match = /^\/fixture\/(\d+)$/.exec(url.pathname);
    if (match && cases[Number(match[1])]) {
      const { kind, path } = cases[Number(match[1])];
      const { input, word } = JSON.parse(await readFile(path, "utf8"));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ kind, input, word }));
      return;
    }
    response.writeHead(404).end();
  } catch (error) {
    console.error(String(error));
    response.writeHead(500).end();
  }
});
await new Promise((done, fail) => {
  server.once("error", fail);
  server.listen(0, "127.0.0.1", done);
});
const report = { status: "failed", cases: [], total_milliseconds: 0 };
const started = performance.now();
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.JVC_CHROMIUM || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => typeof window.runCase === "function");
  for (let index = 0; index < cases.length; index++) {
    const { kind, file, path } = cases[index];
    const fixture = JSON.parse(await readFile(path, "utf8"));
    const name = fixture.name ?? file;
    assert(
      fixture.input &&
        fixture.expected &&
        (kind === "state"
          ? fixture.name
          : fixture.word && fixture.reviewers && fixture.expected_state),
      `Invalid native ${kind} fixture: ${file}`,
    );
    let timer;
    const actual = await Promise.race([
      page.evaluate((value) => window.runCase(value), index),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`${kind} calculation exceeded ${timeout} ms: ${name}`),
            ),
          timeout,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    try {
      assert.deepStrictEqual(actual.result, fixture.expected);
      assert.deepStrictEqual(
        actual.streamed_state,
        kind === "state" ? fixture.expected : fixture.expected_state,
      );
      assert.deepStrictEqual(
        actual.host_state,
        kind === "state" ? fixture.expected : fixture.expected_state,
      );
      if (kind === "ranking") {
        assert.deepStrictEqual(actual.host_rank, fixture.expected);
        assert.deepStrictEqual(actual.session, fixture.expected);
        assert.deepStrictEqual(actual.reviewers, fixture.reviewers);
        assert.deepStrictEqual(actual.streamed_rank, fixture.expected);
        assert.deepStrictEqual(actual.streamed_reviewers, fixture.reviewers);
      }
    } catch (error) {
      throw new Error(
        `Native and browser ${kind} differ: ${name}\n${String(error).slice(0, 3000)}`,
      );
    }
    report.cases.push({
      name,
      kind,
      file,
      milliseconds: actual.milliseconds,
    });
    if ((index + 1) % 20 === 0)
      console.log(
        `State and ranking parity: ${index + 1}/${cases.length} cases passed.`,
      );
  }
  report.status = "passed";
  console.log(`Native and browser results agree for ${cases.length} cases.`);
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  report.total_milliseconds = performance.now() - started;
  await writeFile(
    join(directory, "_wasm-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser?.close();
  await new Promise((done) => server.close(done));
}
