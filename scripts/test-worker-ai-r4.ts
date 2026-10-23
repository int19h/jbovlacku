import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { resolve, join } from "node:path";

const scratch = join(
  resolve(process.env.JVC_TEST_ROOT ?? ".cache"),
  "worker-ai-r4",
);
await mkdir(scratch, { recursive: true });
const directory = await mkdtemp(`${scratch}/case-`);
const outfile = `${directory}/worker.mjs`;
await build({
  entryPoints: ["apps/worker/src/index.ts"],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2023",
  loader: { ".wasm": "binary" },
  plugins: [
    {
      name: "local-durable-object-host",
      setup(builder) {
        builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
          path: "cloudflare:workers",
          namespace: "test",
        }));
        builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({
          contents:
            "export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }",
        }));
      },
    },
  ],
});
const { AdmissionCoordinator } = await import(pathToFileURL(outfile).href);
const context = {
  storage: {
    sql: {
      exec() {
        return {
          toArray() {
            return [];
          },
        };
      },
    },
    transactionSync(operation: () => unknown) {
      return operation();
    },
  },
  waitUntil() {},
};
const env = {
  OBJECTS: {},
  INDEX: {},
  SERVER_ID: "synthetic-worker",
  JVC_LOCAL_WORKER: "enabled",
  JVC_AI_ENABLED: "enabled",
  JVC_AI_MAX_TOKENS: "64",
  JVC_AI_KEY: "disposable-worker-key",
};
const coordinator = new AdmissionCoordinator(context, env);
const live = await coordinator.fetch(
  new Request("http://localhost/api/health/live"),
);
assert.equal(
  live.status,
  200,
  "manual routes stay available with invalid AI settings",
);
const capabilities = await coordinator.fetch(
  new Request("http://localhost/api/v1/capabilities"),
);
assert.equal((await capabilities.json()).features.assistance, false);
console.log(
  "Worker invalid AI settings preserve manual health and capabilities routes.",
);
