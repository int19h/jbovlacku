import { readFile } from "node:fs/promises";
import type { Page, Route } from "@playwright/test";
import {
  initializeCore,
  createEvent,
  utf8,
  wordId,
} from "../../../packages/core/src/index.ts";
import { DictionaryService } from "../../../packages/service/src/service.ts";
import {
  emptyState,
  type State,
  type Snapshot,
} from "../../../packages/service/src/storage.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A real service with disposable memory storage and an explicit evaluation gate. */
export async function acceptedHistoryFixture(page: Page, base = "/api/v1") {
  await initializeCore(
    await readFile(
      new URL(
        "../../../packages/core/generated/jvc_runtime_bg.wasm",
        import.meta.url,
      ),
    ),
  );
  let state = emptyState();
  const snapshots = new Map<string, Snapshot>();
  const bytes = new Map<string, Uint8Array>();
  const service = new DictionaryService(
    {
      async get(hash) {
        return bytes.get(hash)?.slice() ?? null;
      },
      async put(hash, value) {
        bytes.set(hash, value.slice());
      },
    },
    {
      async load() {
        return state;
      },
      async getSnapshot(id) {
        return snapshots.get(id) ?? null;
      },
      async compareAndSwap(revision: number, next: State, snapshot?: Snapshot) {
        if (state.revision !== revision) return false;
        state = next;
        if (snapshot) snapshots.set(snapshot.snapshot, snapshot);
        return true;
      },
      async markMaterialized(snapshot, position) {
        if (state.snapshot !== snapshot || state.position !== position)
          return false;
        state = {
          ...state,
          revision: state.revision + 1,
          materialized_snapshot: snapshot,
          materialized_position: position,
        };
        return true;
      },
    },
    {
      serverId: "accepted-history-test",
      policyUrl: "https://example.invalid/policy",
      asyncMaterialization: true,
      publicOrigin: `http://127.0.0.1:${process.env.JVC_WEB_PORT ?? "5177"}`,
    },
  );
  await service.initialize();
  const view = createEvent(
    new Uint8Array(32).fill(37),
    [],
    "e".repeat(32),
    { kind: "view.publish", parents: [] },
    {
      name: "Accepted history fixture",
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
  service.options.selectedView = view.envelope.id;
  await service.admitMany([utf8(JSON.stringify(view))]);
  await service.flushMaterialization();
  let gate: ReturnType<typeof deferred> | null = null;
  let entered = deferred();
  const internals = service as any;
  const compute = internals.computeEvaluation.bind(service);
  internals.computeEvaluation = async (...args: any[]) => {
    if (gate) {
      entered.resolve();
      await gate.promise;
    }
    return compute(...args);
  };
  const route = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith(base + "/")) return route.fallback();
    url.pathname = "/api/v1" + url.pathname.slice(base.length);
    const response = await service.fetch(
      new Request(url, {
        method: request.method(),
        headers: request.headers(),
        ...(request.postData() ? { body: request.postData() } : {}),
      }),
    );
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  };
  const pattern = `**${base}/**`;
  await page.route(pattern, route);
  return {
    async watchSignatures() {
      await page.evaluate(() => {
        const sign = crypto.subtle.sign.bind(crypto.subtle);
        (window as any).__lifecycleSignatures = 0;
        crypto.subtle.sign = (...args: Parameters<SubtleCrypto["sign"]>) => {
          (window as any).__lifecycleSignatures++;
          return sign(...args);
        };
      });
    },
    async signatures() {
      return page.evaluate(
        () => (window as any).__lifecycleSignatures as number,
      );
    },
    async admit(transport: unknown) {
      await service.admitMany([utf8(JSON.stringify(transport))]);
      if (!gate) await service.flushMaterialization();
    },
    hold() {
      gate = deferred();
      entered = deferred();
    },
    async pending() {
      await entered.promise;
      if (state.snapshot === state.materialized_snapshot)
        throw new Error("The fixture did not retain pending accepted history.");
      return {
        accepted: state.snapshot,
        completed: state.materialized_snapshot,
      };
    },
    async ordinary() {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Promise.all(
            [
              "/manifest",
              "/search?q=klama&language=jbo",
              `/words/${wordId({ language: "jbo", spelling: "klama" })}`,
            ].map(async (path) => {
              const response = await service.fetch(
                new Request("http://localhost/api/v1" + path),
              );
              if (!response.ok) throw new Error(await response.text());
              return ((await response.json()) as { snapshot: string }).snapshot;
            }),
          ),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  new Error("Ordinary reads waited for accepted history."),
                ),
              1000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    },
    async close() {
      gate?.resolve();
      gate = null;
      await service.flushMaterialization();
      if (!page.isClosed()) await page.unroute(pattern, route);
    },
  };
}
