import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  initializeCore,
  coreCheckpointVersion,
} from "../../../packages/core/src/index.ts";
import { AssistanceService } from "../../../packages/service/src/assistance.ts";
import { DictionaryService } from "../../../packages/service/src/service.ts";
import { probeCompatibility } from "../../../packages/service/src/semantic/probe.ts";
import { SemanticIndexer } from "../../../packages/service/src/semantic/indexer.ts";
import {
  createQwenProfile,
  profileId,
  qwenProfileRoute,
  qwenRequestRoute,
} from "../../../packages/service/src/semantic/profile.ts";
import {
  DEFAULT_PROFILE_ROUTE,
  isEmbeddingRoute,
  type EmbeddingRoute,
} from "../../../packages/service/src/inference.ts";
import { lockDataDirectory } from "../../../packages/importer/src/load-lock.ts";
import {
  readLoadedView,
  stateTraversalLimit,
} from "../../../packages/importer/src/load-config.ts";
import { closeSemanticIndexHost, SqliteVectorStore } from "./semantic.ts";
import {
  FileObjectStore,
  SqliteCoordinator,
  SqliteIndexStore,
} from "./storage.ts";
import { nodeAssistance, SqliteAssistanceBudgetStore } from "./assistance.ts";
import { NodeEvaluationRuntime } from "./evaluation.ts";
import { FileCheckpointStore } from "./checkpoint.ts";

const usage =
  "Use semantic-cli.ts --data DIRECTORY --command prepare|run|status|recover|retry|clear-cooldown|publish|unpublish|rollback|retire [--job ID] [--batch ID | --all] [--after BATCH_ID] [--generations-after GENERATION_ID] [--max-batches N] [--concurrency N] [--pages N] [--profile PROFILE_ID] [--route nebius|siliconflow/fp8|deepinfra/us] [--batch-size N] [--batch-bytes N] [--max-cost-usd USD]. Stop the server for this directory first.";
const allowed = new Set([
  "data",
  "command",
  "job",
  "batch",
  "all",
  "max-batches",
  "concurrency",
  "pages",
  "after",
  "generations-after",
  "profile",
  "route",
  "batch-size",
  "batch-bytes",
  "max-cost-usd",
]);
function argumentsForCommand() {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i].replace(/^--/, "");
    if (!args[i].startsWith("--") || !allowed.has(key) || values.has(key))
      throw new Error(usage);
    if (key === "all") {
      values.set(key, "true");
      continue;
    }
    if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(usage);
    values.set(key, args[++i]);
  }
  if (!values.has("data") || !values.has("command")) throw new Error(usage);
  return values;
}
const output = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");

async function withSemanticService<T>(
  directory: string,
  vectors: SqliteVectorStore,
  job: string | undefined,
  action: (
    service: DictionaryService,
    profile: Awaited<ReturnType<SqliteVectorStore["profile"]>>,
    generation: Awaited<ReturnType<SqliteVectorStore["generation"]>> | null,
  ) => Promise<T>,
  selectedProfile?: string,
  selectedRoute?: EmbeddingRoute,
) {
  const profile = job
    ? await vectors.profile(job)
    : selectedProfile
      ? await vectors.storedProfile(selectedProfile)
      : createQwenProfile(undefined, selectedRoute ?? DEFAULT_PROFILE_ROUTE);
  if (selectedProfile) {
    if (profileId(profile) !== selectedProfile)
      throw new Error("The selected profile does not match the saved job.");
    if (qwenProfileRoute(profile) === null)
      throw new Error(
        "The stored profile is incompatible with the current embedding adapter.",
      );
    if (await vectors.compatibility(selectedProfile))
      throw new Error(
        "The stored profile is suspended. Prepare a fresh profile after repairing the provider.",
      );
  }
  if (selectedRoute && qwenProfileRoute(profile) !== selectedRoute)
    throw new Error("The selected route does not match the stored profile.");
  const generation = job ? await vectors.generation(job) : null;
  const coordinator = new SqliteCoordinator(
    join(directory, "coordinator.sqlite"),
  );
  const index = new SqliteIndexStore(join(directory, "indexes.sqlite"), true);
  const core = await readFile(
    new URL(
      "../../../packages/core/generated/jvc_runtime_bg.wasm",
      import.meta.url,
    ),
  );
  const runtime = new NodeEvaluationRuntime(core);
  const loaded = await readLoadedView(directory);
  const traversal = stateTraversalLimit(
    process.env.JVC_STATE_TRAVERSAL_LIMIT ?? loaded?.state_traversal_limit,
  );
  const service = new DictionaryService(
    new FileObjectStore(join(directory, "objects")),
    coordinator,
    {
      serverId: "semantic-index-operator",
      policyUrl: "https://example.invalid/policy",
      selectedView: generation?.view ?? process.env.JVC_VIEW ?? loaded?.view,
      stateLimits:
        traversal === undefined
          ? undefined
          : { events: 200000, traversal, claim_depth: 1024 },
      index,
      evaluationRuntime: runtime,
      asyncMaterialization: true,
      checkpoints: new FileCheckpointStore(
        join(directory, "evaluation-cache"),
        coordinator,
      ),
      coreVersion: `${createHash("sha256").update(core).digest("hex")}:${coreCheckpointVersion()}:service-checkpoint-v1`,
    },
  );
  try {
    await service.initialize();
    return await action(service, profile, generation);
  } finally {
    await service.prepareEvaluationShutdown();
    await runtime.close();
    index.close();
    coordinator.close();
  }
}

async function prepare(
  directory: string,
  vectors: SqliteVectorStore,
  job: string | undefined,
  pages: number,
  selectedProfile?: string,
  selectedRoute?: EmbeddingRoute,
) {
  return withSemanticService(
    directory,
    vectors,
    job,
    async (service, profile, generation) => {
      const source = await service.semanticSource(
        profile,
        generation?.snapshot ?? null,
      );
      const created =
        generation ?? (await vectors.create(source.context, profile));
      output({ event: "generation", generation: created });
      const indexer = new SemanticIndexer(vectors, {
        embed: async () => {
          throw new Error("Preparation sends no inference request.");
        },
      });
      const prepared = await indexer.prepare(created.id, source, pages);
      output({
        event: "prepared",
        generation: prepared,
        reused_inputs: await vectors.reusableInputs(created.id),
      });
      return prepared;
    },
    selectedProfile,
    selectedRoute,
  );
}

async function statusCoverage(
  directory: string,
  vectors: SqliteVectorStore,
  id: string,
) {
  const generation = await vectors.generation(id);
  const coordinator = new SqliteCoordinator(
    join(directory, "coordinator.sqlite"),
  );
  let retained: boolean;
  try {
    retained = Boolean(await coordinator.getSnapshot(generation.snapshot));
  } finally {
    coordinator.close();
  }
  if (!retained) {
    // An expired snapshot cannot prove any current binding.
    return {
      eligible: generation.eligible,
      indexed: 0,
      failed: 0,
      pending: generation.eligible,
    };
  }
  return withSemanticService(directory, vectors, id, async (service) =>
    vectors.coverage(
      id,
      undefined,
      await service.semanticBindings(generation.snapshot, generation.view),
    ),
  );
}

async function main() {
  const args = argumentsForCommand();
  const directory = resolve(args.get("data")!);
  if (!(await stat(join(directory, "coordinator.sqlite"))).isFile())
    throw new Error("The coordinator database must already exist.");
  const command = args.get("command")!;
  if (
    ![
      "prepare",
      "run",
      "status",
      "recover",
      "retry",
      "clear-cooldown",
      "publish",
      "unpublish",
      "rollback",
      "retire",
    ].includes(command)
  )
    throw new Error(usage);
  const job = args.get("job");
  if (command !== "prepare" && !job) throw new Error(usage);
  if (args.has("all") && command !== "retry")
    throw new Error("Use --all only with retry.");
  if (command === "retry" && args.has("all") === args.has("batch"))
    throw new Error("Use either --batch ID or --all with retry.");
  if (args.has("generations-after") && command !== "status")
    throw new Error("Use --generations-after only with status.");
  const selectedProfile = args.get("profile");
  if (selectedProfile && command !== "prepare")
    throw new Error("Use --profile only with prepare.");
  const route = args.get("route");
  if (
    route !== undefined &&
    !["prepare", "run", "status", "clear-cooldown"].includes(command)
  )
    throw new Error(
      "Use --route only with prepare, run, status, or clear-cooldown.",
    );
  if (route !== undefined && !isEmbeddingRoute(route))
    throw new Error(
      "Use nebius, siliconflow/fp8, or deepinfra/us with --route.",
    );
  for (const flag of ["batch-size", "batch-bytes", "max-cost-usd"])
    if (args.has(flag) && command !== "run")
      throw new Error(`Use --${flag} only with run.`);
  const positive = (name: string, fallback: number) => {
    const value = args.get(name);
    if (value !== undefined && !/^[1-9][0-9]*$/.test(value))
      throw new Error(usage);
    const number = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(number)) throw new Error(usage);
    return number;
  };
  const release = await lockDataDirectory(directory, "semantic-index-operator");
  let vectors: SqliteVectorStore | undefined;
  let budget: SqliteAssistanceBudgetStore | undefined;
  let assistance: AssistanceService | undefined;
  const stop = new AbortController();
  const signal = () => stop.abort();
  process.on("SIGINT", signal);
  process.on("SIGTERM", signal);
  try {
    await initializeCore(
      await readFile(
        new URL(
          "../../../packages/core/generated/jvc_runtime_bg.wasm",
          import.meta.url,
        ),
      ),
    );
    vectors = new SqliteVectorStore(join(directory, "semantic-vectors.sqlite"));
    let id = job;
    if (command === "prepare")
      id = (
        await prepare(
          directory,
          vectors,
          job,
          positive("pages", Number.MAX_SAFE_INTEGER),
          selectedProfile,
          route,
        )
      ).id;
    else if (command === "run") {
      const profile = await vectors.profile(id!);
      const requestRoute = qwenRequestRoute(profile, route);
      if (requestRoute === null)
        throw new Error(
          "The selected route is incompatible with the stored profile.",
        );
      budget = new SqliteAssistanceBudgetStore(
        join(directory, "assistance-spending.sqlite"),
      );
      const options = nodeAssistance(process.env, budget);
      if (options.provider?.baseUrl !== "https://openrouter.ai/api/v1")
        throw new Error(
          "The application profile requires the configured OpenRouter endpoint.",
        );
      const concurrency = positive("concurrency", 8);
      const batchSize = positive("batch-size", 32);
      const batchBytes = positive(
        "batch-bytes",
        Math.min(batchSize * 4096, 524288),
      );
      const maximumCost = args.get("max-cost-usd");
      const maxCostUsd =
        maximumCost === undefined ? undefined : Number(maximumCost);
      if (
        concurrency > 32 ||
        batchSize > 128 ||
        batchBytes > 524288 ||
        (maxCostUsd !== undefined &&
          (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(maximumCost!) ||
            !Number.isFinite(maxCostUsd) ||
            maxCostUsd < 0 ||
            maximumCost!.trim() === ""))
      )
        throw new Error(
          "Use at most 32 workers, 128 inputs, 524288 input bytes, and a nonnegative cost ceiling.",
        );
      options.operatorIndexing = { concurrency, maxCostUsd };
      assistance = new AssistanceService(
        options,
        "semantic-index-operator",
        async () => [],
      );
      const started = performance.now();
      const runStore = vectors;
      const references = await runStore.profileReferences(profileId(profile));
      const result = await new SemanticIndexer(vectors, assistance).run(id!, {
        concurrency,
        operator: true,
        route,
        beforeFirstBatch: async () => {
          if (references.length && (await runStore.needsEmbedding(id!)))
            await probeCompatibility(
              runStore,
              assistance!,
              profileId(profile),
              profile,
              requestRoute!,
              references,
              stop.signal,
            );
        },
        batchSize,
        batchBytes,
        adaptive: true,
        onConcurrencyChange: (event) =>
          output({ event: "concurrency", job: id, ...event }),
        maxBatches: positive("max-batches", Number.MAX_SAFE_INTEGER),
        signal: stop.signal,
        onBackoff: ({ attempt, delayMs, batches }) =>
          output({
            event: "backoff",
            job: id,
            attempt,
            delay_ms: delayMs,
            batches,
          }),
      });
      output({
        event: "run",
        ...result,
        summary: await vectors.summary(id!),
        elapsed_ms: performance.now() - started,
      });
    } else if (command === "clear-cooldown") {
      const generation = await vectors.generation(id!);
      await vectors.clearCooldown(generation.profile, route);
    } else if (command === "recover") await vectors.recover(id!);
    else if (command === "retry") {
      const batch = args.get("batch");
      const all = args.has("all");
      if (all && (await vectors.generation(id!)).state !== "paused")
        throw new Error(
          "Pause the generation before selecting batches for retry.",
        );
      let found = false;
      let selected = 0;
      let skipped = 0;
      let after: string | null = null;
      // Retry selection does not change batch IDs or their diagnostics page order.
      for (;;) {
        const page = await vectors.batches(id!, after);
        if (!page.length) break;
        for (const value of page) {
          if (all) {
            if (!["failed", "ambiguous"].includes(value.state)) continue;
            try {
              await vectors.retry(value.id);
              selected++;
            } catch (failure) {
              // Keep the store's ownership check as the authority for replay safety.
              if (
                failure instanceof Error &&
                "code" in failure &&
                failure.code === "semantic_retry" &&
                failure.message === "A later attempt already owns these inputs."
              )
                skipped++;
              else throw failure;
            }
          } else if (value.id === batch) {
            await vectors.retry(value.id);
            found = true;
            break;
          }
        }
        if (found) break;
        after = page.at(-1)!.id;
      }
      if (!all && !found)
        throw new Error("The batch does not belong to this generation.");
      if (all) output({ event: "retry", job: id, selected, skipped });
    } else if (command === "publish") {
      const generation = await vectors.generation(id!);
      const old = await vectors.current(generation.profile, generation.view);
      if (!(await vectors.publish(id!, old)))
        throw new Error(
          "The semantic publication changed. Read its status before another attempt.",
        );
    } else if (command === "unpublish") {
      const generation = await vectors.generation(id!);
      if (!(await vectors.unpublish(generation.profile, generation.view, id!)))
        throw new Error(
          "The named generation is no longer current. Read its status before another attempt.",
        );
    } else if (command === "rollback") {
      const generation = await vectors.generation(id!);
      output({
        rollback: await vectors.rollback(
          generation.profile,
          generation.view,
          id!,
        ),
      });
    } else if (command === "retire") await vectors.retire(id!);
    const generation = await vectors.generation(id!, true);
    const batches = await vectors.batches(id!, args.get("after") ?? null);
    const generations = await vectors.generations(
      generation.profile,
      generation.view,
      args.get("generations-after") ?? null,
    );
    output({
      event: "status",
      generations,
      generations_next:
        generations.length === 64 ? generations.at(-1)!.id : null,
      generation,
      coverage:
        generation.state === "retired"
          ? null
          : await statusCoverage(directory, vectors, id!),
      summary: await vectors.summary(id!),
      compatibility: await vectors.compatibility(generation.profile),
      probe: await vectors.probeEvidence(generation.profile),
      request_route: qwenRequestRoute(
        await vectors.storedProfile(generation.profile),
        route,
      ),
      retry_after: await vectors.retryAfter(generation.profile, route),
      current: await vectors.current(generation.profile, generation.view),
      batches,
      batches_next: batches.length === 64 ? batches.at(-1)!.id : null,
    });
    vectors.checkpoint();
  } finally {
    await closeSemanticIndexHost(assistance, budget, vectors, release);
    process.off("SIGINT", signal);
    process.off("SIGTERM", signal);
  }
}
main().catch((failure) => {
  output({
    event: "error",
    code:
      failure instanceof Error && "code" in failure
        ? String(failure.code)
        : "semantic_operator",
    message:
      failure instanceof Error
        ? failure.message
        : "The indexing command failed.",
  });
  process.exitCode = 1;
});
