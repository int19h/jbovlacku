import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  initializeCore,
  coreCheckpointVersion,
} from "../../../packages/core/src/index.ts";
import { AssistanceService } from "../../../packages/service/src/assistance.ts";
import { DictionaryService } from "../../../packages/service/src/service.ts";
import { SemanticIndexer } from "../../../packages/service/src/semantic/indexer.ts";
import { createQwenProfile } from "../../../packages/service/src/semantic/profile.ts";
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
  "Use semantic-cli.ts --data DIRECTORY --command prepare|run|status|recover|retry|publish|rollback|retire [--job ID] [--batch ID] [--after BATCH_ID] [--max-batches N] [--concurrency N] [--pages N]. Stop the server for this directory first.";
const allowed = new Set([
  "data",
  "command",
  "job",
  "batch",
  "max-batches",
  "concurrency",
  "pages",
  "after",
]);
function argumentsForCommand() {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, "");
    if (
      !args[i].startsWith("--") ||
      !allowed.has(key) ||
      values.has(key) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      throw new Error(usage);
    values.set(key, args[i + 1]);
  }
  if (!values.has("data") || !values.has("command")) throw new Error(usage);
  return values;
}
const output = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");

async function prepare(
  directory: string,
  vectors: SqliteVectorStore,
  job: string | undefined,
  pages: number,
) {
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
  const profile = job ? await vectors.profile(job) : createQwenProfile();
  const generation = job ? await vectors.generation(job) : null;
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
    return prepared;
  } finally {
    await service.prepareEvaluationShutdown();
    await runtime.close();
    index.close();
    coordinator.close();
  }
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
      "publish",
      "rollback",
      "retire",
    ].includes(command)
  )
    throw new Error(usage);
  const job = args.get("job");
  if (command !== "prepare" && !job) throw new Error(usage);
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
        )
      ).id;
    else if (command === "run") {
      budget = new SqliteAssistanceBudgetStore(
        join(directory, "assistance-spending.sqlite"),
      );
      const options = nodeAssistance(process.env, budget);
      if (options.provider?.baseUrl !== "https://openrouter.ai/api/v1")
        throw new Error(
          "The application profile requires the configured OpenRouter endpoint.",
        );
      assistance = new AssistanceService(
        options,
        "semantic-index-operator",
        async () => [],
      );
      const concurrency = positive(
        "concurrency",
        options.provider?.concurrency ?? 2,
      );
      if (!options.provider || concurrency > options.provider.concurrency)
        throw new Error(
          "Enable the provider and keep index concurrency within its shared execution slots.",
        );
      const started = performance.now();
      const result = await new SemanticIndexer(vectors, assistance).run(id!, {
        concurrency,
        maxBatches: positive("max-batches", Number.MAX_SAFE_INTEGER),
        signal: stop.signal,
      });
      output({
        event: "run",
        ...result,
        summary: await vectors.summary(id!),
        elapsed_ms: performance.now() - started,
      });
    } else if (command === "recover") await vectors.recover(id!);
    else if (command === "retry") {
      const batch = args.get("batch");
      if (!batch) throw new Error(usage);
      const owned = (await vectors.batches(id!)).some(
        (value) => value.id === batch,
      );
      // A batch can fall outside the first diagnostics page. Walk the bounded pages.
      let found = owned;
      let after: string | null = null;
      while (!found) {
        const page = await vectors.batches(id!, after);
        if (!page.length) break;
        found = page.some((value) => value.id === batch);
        after = page.at(-1)!.id;
      }
      if (!found)
        throw new Error("The batch does not belong to this generation.");
      await vectors.retry(batch);
    } else if (command === "publish") {
      const generation = await vectors.generation(id!);
      const old = await vectors.current(generation.profile, generation.view);
      if (!(await vectors.publish(id!, old)))
        throw new Error(
          "The semantic publication changed. Read its status before another attempt.",
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
    const generation = await vectors.generation(id!);
    const batches = await vectors.batches(id!, args.get("after") ?? null);
    output({
      event: "status",
      generation,
      coverage:
        generation.state === "retired" ? null : await vectors.coverage(id!),
      summary: await vectors.summary(id!),
      compatibility: await vectors.compatibility(generation.profile),
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
