import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium, firefox, webkit } from "@playwright/test";
import { BROWSER_HEADERS } from "../apps/server/src/security.ts";

const wasm = await readFile(
  new URL("../packages/core/generated/jvc_runtime_bg.wasm", import.meta.url),
);
const module = await readFile(
  new URL("../packages/core/generated/jvc_runtime.js", import.meta.url),
);
const probe = `import init, { runtime_canonicalize } from '/runtime.js';
await init({module_or_path:'/runtime.wasm'});
let blocked = false;
try { Function('return 1')(); } catch { blocked = true; }
window.probe = { canonical: runtime_canonicalize(new TextEncoder().encode('{"b":2,"a":1}')), blocked };
`;
const server = createServer((request, response) => {
  for (const [name, value] of Object.entries(BROWSER_HEADERS))
    response.setHeader(name, value);
  const path = request.url;
  if (path === "/runtime.js" || path === "/probe.js") {
    response.setHeader("content-type", "text/javascript");
    response.end(path === "/runtime.js" ? module : probe);
  } else if (path === "/runtime.wasm") {
    response.setHeader("content-type", "application/wasm");
    response.end(wasm);
  } else {
    response.setHeader("content-type", "text/html");
    response.end(
      path === "/frame"
        ? '<iframe src="/"></iframe>'
        : '<script>window.inlineRan=true</script><script type="module" src="/probe.js"></script>',
    );
  }
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
try {
  for (const [name, engine, executablePath] of [
    ["chromium", chromium, process.env.JVC_CHROMIUM],
    ["firefox", firefox, process.env.JVC_FIREFOX],
    ["webkit", webkit, process.env.JVC_WEBKIT],
  ] as const) {
    if (
      process.env.JVC_SECURITY_BROWSERS &&
      !process.env.JVC_SECURITY_BROWSERS.split(",").includes(name)
    )
      continue;
    const browser = await engine.launch({
      executablePath,
      headless: true,
      timeout: 15_000,
    });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(15_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.goto(origin);
      try {
        await page.waitForFunction(() => (window as any).probe !== undefined);
      } catch (error) {
        throw new Error(
          `${name} failed to load the Wasm probe: ${errors.join("\n")}`,
          { cause: error },
        );
      }
      assert.deepEqual(await page.evaluate(() => (window as any).probe), {
        canonical: '{"a":1,"b":2}',
        blocked: true,
      });
      assert.equal(
        await page.evaluate(() => (window as any).inlineRan),
        undefined,
      );
      await page.goto(origin + "/frame");
      await page.waitForTimeout(250);
      const loaded = await page.evaluate(() => {
        try {
          return Boolean(
            (document.querySelector("iframe")!.contentWindow as any).probe,
          );
        } catch {
          return false;
        }
      });
      assert.equal(loaded, false);
      console.log(
        `${name}: real Wasm works; JavaScript eval, inline scripts, and framing are blocked.`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise<void>((done) => server.close(() => done()));
}
