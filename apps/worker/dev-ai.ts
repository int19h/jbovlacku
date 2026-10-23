import { readFile } from "node:fs/promises";
import { unstable_dev } from "wrangler";
import { nodeAssistanceIdentityAvailable } from "../../packages/service/src/inference.ts";

// This local launcher reads the operator's key file into a Worker binding.
// It never writes the key to a file or passes it through command arguments.
const names = [
  "JVC_AI_ENABLED",
  "JVC_AI_BASE_URL",
  "JVC_AI_MODEL",
  "JVC_AI_PROVIDER_ROUTE",
  "JVC_AI_PROVIDER_NAME",
  "JVC_AI_REASONING_EFFORT",
  "JVC_AI_DECISION_REPORTS",
  "JVC_AI_MAX_TOKENS",
  "JVC_AI_TIMEOUT_MS",
  "JVC_AI_CONCURRENCY",
  "JVC_AI_MAX_COST_USD",
  "JVC_AI_MAX_PRICE",
  "JVC_AI_OPERATIONS",
  "JVC_TRUST_CF_CONNECTING_IP",
  "SERVER_ID",
  "SELECTED_VIEW",
  "PUBLIC_ORIGIN",
  "PROTOTYPE_BATCH",
  "SNAPSHOT_LIMIT",
];
try {
  const vars: Record<string, string> = {};
  for (const name of names)
    if (process.env[name] !== undefined) vars[name] = process.env[name]!;
  vars.JVC_LOCAL_WORKER = "enabled";
  if (
    !nodeAssistanceIdentityAvailable(
      process.env.HOST ?? "127.0.0.1",
      process.env.PUBLIC_ORIGIN,
      [],
    )
  )
    vars.JVC_AI_ENABLED = "disabled";
  if (vars.JVC_AI_ENABLED === "enabled") {
    if (!process.env.JVC_AI_KEY_FILE) throw new Error("Missing key file.");
    vars.JVC_AI_KEY = (
      await readFile(process.env.JVC_AI_KEY_FILE, "utf8")
    ).trim();
    if (!vars.JVC_AI_KEY) throw new Error("Empty key file.");
  }
  const worker = await unstable_dev("apps/worker/src/index.ts", {
    config: "apps/worker/wrangler.jsonc",
    ip: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 8790),
    persistTo: process.env.JVC_WORKER_DATA_DIR,
    vars,
    logLevel: "none",
    local: true,
    experimental: {
      disableExperimentalWarning: true,
      watch: false,
      showInteractiveDevSession: false,
    },
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void worker.stop().then(() => process.exit(0));
    });
  console.log(
    JSON.stringify({
      event: "local_worker_listening",
      address: worker.address,
      port: worker.port,
    }),
  );
  await worker.waitUntilExit();
} catch {
  console.error(
    "The local Worker could not start. Make sure that its configuration and key file are available.",
  );
  process.exitCode = 1;
}
