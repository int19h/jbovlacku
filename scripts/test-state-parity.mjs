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
const files = (await readdir(directory))
  .filter((file) => file.endsWith(".json") && file !== "_wasm-report.json")
  .sort();
assert(files.length > 0, "Generate the native state corpus before this test.");
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
import init, { evaluate_records } from '/jvc_runtime.js';
await init();
window.runCase = async (index) => {
  const { name, input } = await (await fetch('/fixture/' + index)).json();
  const start = performance.now();
  const result = JSON.parse(evaluate_records(new TextEncoder().encode(JSON.stringify(input))));
  return { name, result, milliseconds: performance.now() - start };
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
    if (match && files[Number(match[1])]) {
      const { name, input } = JSON.parse(
        await readFile(join(directory, files[Number(match[1])]), "utf8"),
      );
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ name, input }));
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
  for (let index = 0; index < files.length; index++) {
    const fixture = JSON.parse(
      await readFile(join(directory, files[index]), "utf8"),
    );
    assert(
      fixture.name && fixture.input && fixture.expected,
      `Invalid native fixture: ${files[index]}`,
    );
    let timer;
    const actual = await Promise.race([
      page.evaluate((value) => window.runCase(value), index),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `State calculation exceeded ${timeout} ms: ${fixture.name}`,
              ),
            ),
          timeout,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    try {
      assert.deepStrictEqual(actual.result, fixture.expected);
    } catch (error) {
      throw new Error(
        `Native and browser state differ: ${fixture.name}\n${String(error).slice(0, 3000)}`,
      );
    }
    report.cases.push({
      name: fixture.name,
      file: files[index],
      milliseconds: actual.milliseconds,
    });
    if ((index + 1) % 20 === 0)
      console.log(`State parity: ${index + 1}/${files.length} cases passed.`);
  }
  report.status = "passed";
  console.log(`Native and browser state agree for ${files.length} cases.`);
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
