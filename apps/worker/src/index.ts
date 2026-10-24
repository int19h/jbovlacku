import type {
  StoredVerifiedRecord,
  VerifiedRecordBinding,
} from "../../../packages/service/src/verified-records.ts";
import { D1IndexStore } from "./index-store.ts";
import { workerAssistanceBudgetStore } from "./assistance.ts";
import { SqlRowsCoordinator } from "../../../packages/service/src/sql-coordinator.ts";
import { DurableObject } from "cloudflare:workers";
import wasmModule from "../../../packages/core/generated/jvc_runtime_bg.wasm";
import { initializeCore } from "../../../packages/core/src/index.ts";
import { DictionaryService } from "../../../packages/service/src/service.ts";
import {
  providerConfig,
  workerClientNetwork,
  type ProviderConfig,
} from "../../../packages/service/src/inference.ts";
// The local launcher sets its provenance binding. Edge trust requires operator opt-in.
type IdentityEnv = Env & {
  JVC_LOCAL_WORKER?: string;
  JVC_TRUST_CF_CONNECTING_IP?: string;
};
import {
  emptyState,
  type State,
  type Coordinator,
  type Snapshot,
  type ObjectStore,
} from "../../../packages/service/src/storage.ts";
class R2ObjectStore implements ObjectStore {
  operations = { get: 0, put: 0 };
  constructor(private bucket: R2Bucket) {}
  async get(hash: string): Promise<Uint8Array | null> {
    this.operations.get++;
    const object = await this.bucket.get(hash);
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  }
  async put(hash: string, bytes: Uint8Array): Promise<void> {
    this.operations.get++;
    const old = await this.bucket.get(hash);
    if (old) {
      const previous = new Uint8Array(await old.arrayBuffer());
      if (
        previous.length !== bytes.length ||
        previous.some((v, i) => v !== bytes[i])
      )
        throw new Error("Object hash collision.");
      return;
    }
    this.operations.put++;
    await this.bucket.put(hash, bytes);
  }
}
export class AdmissionCoordinator
  extends DurableObject<Env>
  implements Coordinator
{
  private coordinator: SqlRowsCoordinator;
  private service: DictionaryService;
  private objects: R2ObjectStore;
  private diagnostics: boolean;
  private localIdentity: boolean;
  private trustEdgeIdentity: boolean;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.coordinator = new SqlRowsCoordinator(
      {
        exec(sql, ...bindings) {
          return ctx.storage.sql.exec(sql, ...bindings).toArray();
        },
        transaction(operation) {
          return ctx.storage.transactionSync(operation);
        },
      },
      Number(env.SNAPSHOT_LIMIT ?? 16),
    );
    this.objects = new R2ObjectStore(env.OBJECTS);
    this.diagnostics = String(env.PROTOTYPE_BATCH) === "enabled";
    this.localIdentity = (env as IdentityEnv).JVC_LOCAL_WORKER === "enabled";
    this.trustEdgeIdentity =
      (env as IdentityEnv).JVC_TRUST_CF_CONNECTING_IP === "enabled";
    let provider: ProviderConfig | undefined;
    try {
      provider = providerConfig(env, async () => env.JVC_AI_KEY ?? "");
      if (provider?.embeddingDisabledReason)
        console.warn(provider.embeddingDisabledReason);
      if (!this.localIdentity && !this.trustEdgeIdentity) provider = undefined;
      if (provider) provider.concurrency = Math.min(provider.concurrency, 2);
    } catch {
      console.error(
        "AI assistance is unavailable because its configuration is invalid.",
      );
    }
    this.service = new DictionaryService(this.objects, this, {
      assistance: {
        provider,
        budgetStore: workerAssistanceBudgetStore(ctx.storage),
        retainedJobs: 2,
        waitUntil: (promise) => this.ctx.waitUntil(promise),
      },
      serverId: env.SERVER_ID,
      index: new D1IndexStore(env.INDEX),
      selectedView: env.SELECTED_VIEW || undefined,
      policyUrl: "https://example.invalid/jbovlacku-prototype-policy",
      publicOrigin: env.PUBLIC_ORIGIN || undefined,
      allowPrototypeBatch: String(env.PROTOTYPE_BATCH) === "enabled",
    });
  }
  load() {
    return this.coordinator.load();
  }
  getSnapshot(id: string) {
    return this.coordinator.getSnapshot(id);
  }
  getVerifiedRecord(binding: VerifiedRecordBinding) {
    return this.coordinator.getVerifiedRecord(binding);
  }
  saveVerifiedRecords(records: StoredVerifiedRecord[]) {
    return this.coordinator.saveVerifiedRecords(records);
  }
  compareAndSwap(
    revision: number,
    state: State,
    snapshot?: Snapshot,
    changedIds?: string[],
    verifiedRecords?: StoredVerifiedRecord[],
    verifiedStage?: string,
  ) {
    return this.coordinator.compareAndSwap(
      revision,
      state,
      snapshot,
      changedIds,
      verifiedRecords,
      verifiedStage,
    );
  }
  async fetch(request: Request): Promise<Response> {
    const runtime = (await initializeCore(wasmModule)) as {
      memory: WebAssembly.Memory;
    };
    const before = { ...this.objects.operations };
    if (this.diagnostics)
      console.log(
        JSON.stringify({
          prototype_io: "before",
          path: new URL(request.url).pathname,
          wasm_linear_bytes: runtime.memory.buffer.byteLength,
        }),
      );
    try {
      return await this.service.fetch(
        request,
        workerClientNetwork(
          request.headers.get("cf-connecting-ip"),
          Boolean(request.cf),
          this.trustEdgeIdentity,
          this.localIdentity,
        ),
      );
    } finally {
      if (this.diagnostics)
        console.log(
          JSON.stringify({
            prototype_io: "after",
            path: new URL(request.url).pathname,
            r2_get: this.objects.operations.get - before.get,
            r2_put: this.objects.operations.put - before.put,
            wasm_linear_bytes: runtime.memory.buffer.byteLength,
          }),
        );
    }
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return env.COORDINATOR.get(
      env.COORDINATOR.idFromName("admission-v1"),
    ).fetch(request);
  },
} satisfies ExportedHandler<Env>;
