import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, createServer, get } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shutdownHost } from "../../../apps/server/src/shutdown.ts";
import { NodeEvaluationRuntime } from "../../../apps/server/src/evaluation.ts";
import { FileCheckpointStore } from "../../../apps/server/src/checkpoint.ts";
import {
  FileObjectStore,
  SqliteCoordinator,
} from "../../../apps/server/src/storage.ts";
import { lockDataDirectory } from "../../importer/src/load-lock.ts";
import { DictionaryService } from "../src/service.ts";
import {
  createEvent,
  identityFromSeed,
  initializeCore,
  utf8,
} from "../../core/src/index.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
for (const interrupted of [false, true]) {
  test(
    `Node shutdown keeps storage open until an active POST settles${interrupted ? " after the deadline" : " before flushing"}`,
    { timeout: 3000 },
    async () => {
      const database = new DatabaseSync(":memory:");
      database.exec("CREATE TABLE admissions(value TEXT)");
      const entered = deferred();
      const commit = deferred();
      const evaluatorStopped = deferred();
      const active = new Set<Promise<void>>();
      const order: string[] = [];
      let closed = false;
      let stopping = false;
      const server = createServer((incoming, outgoing) => {
        outgoing.once("finish", () => {
          if (stopping) server.closeIdleConnections();
        });
        const handled = (async () => {
          try {
            if (stopping) {
              outgoing.writeHead(503);
              outgoing.end();
              return;
            }
            for await (const _ of incoming) {
              /* Consume this POST before its durable write. */
            }
            entered.resolve();
            await commit.promise;
            database
              .prepare("INSERT INTO admissions VALUES(?)")
              .run("accepted");
            order.push("commit");
            outgoing.end("accepted");
          } catch {
            outgoing.destroy();
          }
        })();
        active.add(handled);
        void handled.finally(() => active.delete(handled));
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address() as { port: number };
      const posted = fetch(`http://127.0.0.1:${address.port}/events`, {
        method: "POST",
        body: "record",
      }).catch(() => null);
      let shutdown: Promise<void> | undefined;
      try {
        await entered.promise;
        const options = {
          activeRequests: active,
          stopAccepting: () => {
            stopping = true;
            const closed = new Promise<void>((resolve) =>
              server.close(() => resolve()),
            );
            server.closeIdleConnections();
            return closed;
          },
          closeConnections: () => server.closeAllConnections(),
          flush: async () => {
            order.push("flush");
          },
          stopEvaluation: async () => {
            order.push("stop");
            evaluatorStopped.resolve();
          },
          closeStorage: async () => {
            order.push("close");
            assert.equal(
              database.prepare("SELECT COUNT(*) AS n FROM admissions").get()!.n,
              1,
            );
            database.close();
            closed = true;
          },
          graceMs: interrupted ? 25 : 2000,
        };
        // This mode reproduces the earlier cleanup order, before handler drainage.
        shutdown =
          process.env.JVC_TEST_EARLY_STORAGE_CLOSE === "1"
            ? (async () => {
                await options.flush();
                await options.stopEvaluation();
                await options.closeStorage();
              })()
            : shutdownHost(options);
        void shutdown.catch(() => {});
        if (interrupted) await evaluatorStopped.promise;
        else await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(closed, false);
        assert.ok(!order.includes("close"));
        assert.ok(!order.includes("flush"));
        commit.resolve();
        await shutdown;
        assert.equal(closed, true);
        assert.ok(order.indexOf("commit") < order.indexOf("close"));
        if (!interrupted)
          assert.ok(order.indexOf("commit") < order.indexOf("flush"));
        else assert.ok(order.indexOf("stop") < order.indexOf("flush"));
      } finally {
        commit.resolve();
        server.closeAllConnections();
        server.close();
        await Promise.allSettled([...active]);
        await posted;
        await shutdown?.catch(() => {});
        if (!closed) database.close();
      }
    },
  );
}

test(
  "Node shutdown waits for a mocked durable save after stopping evaluation",
  { timeout: 3000 },
  async () => {
    const saving = deferred();
    const finishSave = deferred();
    const stopped = deferred();
    const order: string[] = [];
    let storageClosed = false;
    const shuttingDown = shutdownHost({
      activeRequests: new Set(),
      stopAccepting: async () => {},
      closeConnections: () => {
        order.push("connections");
      },
      flush: async () => {
        order.push("save");
        saving.resolve();
        await finishSave.promise;
        assert.equal(storageClosed, false);
        order.push("pin");
      },
      stopEvaluation: async () => {
        order.push("stop");
        stopped.resolve();
      },
      closeStorage: async () => {
        storageClosed = true;
        order.push("close");
      },
      graceMs: 25,
    });
    try {
      await saving.promise;
      await stopped.promise;
      assert.equal(storageClosed, false);
      finishSave.resolve();
      await shuttingDown;
      assert.deepEqual(order, ["save", "connections", "stop", "pin", "close"]);
    } finally {
      finishSave.resolve();
      await shuttingDown;
    }
  },
);

test(
  "Node shutdown stops workers and drains durable handlers when checkpoint preparation throws",
  { timeout: 3000 },
  async () => {
    const database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE admissions(value TEXT)");
    const stopped = deferred();
    const active = new Set<Promise<void>>();
    const order: string[] = [];
    let storageClosed = false;
    const handler = stopped.promise.then(() => {
      database.prepare("INSERT INTO admissions VALUES(?)").run("accepted");
      order.push("handler");
    });
    active.add(handler);
    void handler.finally(() => active.delete(handler));
    const failure = new Error("injected checkpoint preparation failure");
    const shuttingDown = shutdownHost({
      activeRequests: active,
      stopAccepting: async () => {},
      closeConnections: () => {
        order.push("connections");
      },
      prepareEvaluationShutdown: async () => {
        order.push("prepare");
        throw failure;
      },
      stopEvaluation: async () => {
        order.push("stop");
        stopped.resolve();
      },
      flush: async () => {
        assert.equal(active.size, 0);
        order.push("flush");
      },
      closeStorage: async () => {
        assert.equal(
          database.prepare("SELECT COUNT(*) AS n FROM admissions").get()!.n,
          1,
        );
        order.push("close");
        database.close();
        storageClosed = true;
      },
      graceMs: 25,
    });
    let timer!: ReturnType<typeof setTimeout>;
    const bounded = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              "Shutdown cleanup did not finish after preparation failed.",
            ),
          ),
        1000,
      );
    });
    try {
      await assert.rejects(
        Promise.race([shuttingDown, bounded]),
        (error) => error === failure,
      );
      assert.equal(storageClosed, true);
      assert.deepEqual(order, [
        "connections",
        "prepare",
        "stop",
        "handler",
        "flush",
        "close",
      ]);
    } finally {
      clearTimeout(timer);
      stopped.resolve();
      await shuttingDown.catch(() => {});
      if (!storageClosed) database.close();
    }
  },
);

test(
  "Node shutdown exports the completed worker checkpoint during a blocked rebuild and restores without cold evaluation",
  { timeout: 15000 },
  async () => {
    const root = process.env.JVC_TEST_ROOT ?? tmpdir();
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "shutdown-checkpoint-"));
    const wasm = await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    );
    await initializeCore(wasm);
    const gate = new Int32Array(new SharedArrayBuffer(12));
    const runtime = new NodeEvaluationRuntime(wasm, {
      workerFactory: (data) =>
        new Worker(
          new URL("./fixtures/shutdown-evaluation-worker.ts", import.meta.url),
          {
            workerData: { ...data, entry: "test", gate: gate.buffer },
            execArgv: ["--experimental-transform-types"],
          },
        ),
    });
    const seed = new Uint8Array(32).fill(73);
    const view = createEvent(
      seed,
      [],
      "1".repeat(32),
      { kind: "view.publish", parents: [] },
      {
        name: "Shutdown checkpoint",
        description: [],
        roots: [
          {
            identity: identityFromSeed(seed),
            q: { numerator: 1, denominator: 1 },
          },
        ],
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
    const profile = (n: number, parents: string[] = []) =>
      createEvent(
        seed,
        parents,
        String(n).repeat(32),
        { kind: "identity.profile" },
        {
          name: `Author ${n}`,
          bio: [],
          links: [],
        },
      );
    const first = profile(2);
    const latest = profile(3, [first.envelope.id]);
    const pending = profile(4, [latest.envelope.id]);
    const path = join(directory, "coordinator.sqlite");
    let coordinator = new SqliteCoordinator(path);
    const files = new FileObjectStore(join(directory, "objects"));
    const reads: string[] = [];
    const objects = {
      get(hash: string) {
        reads.push(hash);
        return files.get(hash);
      },
      put(hash: string, bytes: Uint8Array) {
        return files.put(hash, bytes);
      },
    };
    let release = await lockDataDirectory(directory, "shutdown-test");
    const store = new FileCheckpointStore(
      join(directory, "evaluation-cache"),
      coordinator,
    );
    const saving = deferred();
    const finishSave = deferred();
    const stopped = deferred();
    const order: string[] = [];
    let holdSave = false;
    let savedBytes = 0;
    let savedSnapshot: string | undefined;
    let storageClosed = false;
    const options = {
      serverId: "shutdown-test",
      policyUrl: "https://example.invalid/policy",
      selectedView: view.envelope.id,
      asyncMaterialization: true,
      coreVersion: "shutdown-test-core",
      checkpointIntervalMs: 60000,
    };
    const service = new DictionaryService(objects, coordinator, {
      ...options,
      evaluationRuntime: runtime,
      checkpoints: {
        load: (binding) => store.load(binding),
        latestBinding: () => store.latestBinding(),
        async save(binding, payload) {
          if (holdSave) {
            savedBytes = payload.core.byteLength;
            savedSnapshot = binding.snapshot;
            order.push("export");
            saving.resolve();
            await finishSave.promise;
          }
          assert.equal(storageClosed, false);
          await store.save(binding, payload);
          if (holdSave) order.push("pin");
        },
      },
    });
    const settle = async (value: DictionaryService) => {
      while ((value as any).background) await (value as any).background;
    };
    const admit = (record: ReturnType<typeof createEvent>) =>
      service.admitMany([utf8(JSON.stringify(record))]);
    let shuttingDown: Promise<void> | undefined;
    let restarted: DictionaryService | undefined;
    let replacement: NodeEvaluationRuntime | undefined;
    try {
      await service.admitMany(
        [view, first].map((record) => utf8(JSON.stringify(record))),
      );
      await service.flushMaterialization();
      const previousPin = coordinator.checkpointPin();
      await admit(latest);
      await settle(service);
      const completed = (await coordinator.loadMetadata())
        .materialized_snapshot!;
      assert.deepEqual(
        coordinator.checkpointPin(),
        previousPin,
        "The minute interval keeps the latest completed checkpoint pending.",
      );
      holdSave = true;
      Atomics.store(gate, 2, 1);
      await admit(pending);
      const until = Date.now() + 3000;
      while (!Atomics.load(gate, 0)) {
        assert.ok(
          Date.now() < until,
          "The second worker did not enter its blocked finish.",
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(runtime.liveWorkers, 2);
      shuttingDown = shutdownHost({
        activeRequests: new Set(),
        stopAccepting: async () => {},
        closeConnections: () => order.push("connections"),
        prepareEvaluationShutdown: () => service.prepareEvaluationShutdown(),
        flush: () => service.flushMaterialization(),
        stopEvaluation: async () => {
          order.push("stop");
          await runtime.close();
          stopped.resolve();
        },
        closeStorage: async () => {
          order.push("close");
          assert.equal(
            coordinator.checkpointPin()?.binding.includes(completed),
            true,
          );
          coordinator.close();
          await release();
          storageClosed = true;
        },
        graceMs: 100,
      });
      void shuttingDown.catch(() => {});
      await Promise.race([
        saving.promise,
        stopped.promise.then(() =>
          assert.fail(
            "Shutdown stopped the completed worker before exporting its checkpoint.",
          ),
        ),
      ]);
      assert.ok(savedBytes > 0);
      assert.equal(savedSnapshot, completed);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(
        runtime.liveWorkers,
        2,
        "The save barrier keeps the completed worker alive past the deadline.",
      );
      assert.equal(storageClosed, false);
      await assert.rejects(
        lockDataDirectory(directory, "shutdown-contender"),
        /lock|already/i,
      );
      finishSave.resolve();
      await shuttingDown;
      assert.equal(runtime.liveWorkers, 0);
      assert.ok(order.indexOf("export") < order.indexOf("pin"));
      assert.ok(order.indexOf("pin") < order.indexOf("stop"));
      assert.ok(order.indexOf("stop") < order.indexOf("close"));
      assert.equal(
        Atomics.load(gate, 1),
        0,
        "Shutdown terminates the rebuild without releasing its finish gate.",
      );

      coordinator = new SqliteCoordinator(path);
      storageClosed = false;
      release = await lockDataDirectory(directory, "shutdown-restart");
      replacement = new NodeEvaluationRuntime(wasm);
      let coldCreates = 0;
      let restores = 0;
      reads.length = 0;
      const resumedStore = new FileCheckpointStore(
        join(directory, "evaluation-cache"),
        coordinator,
      );
      restarted = new DictionaryService(objects, coordinator, {
        ...options,
        checkpoints: resumedStore,
        evaluationRuntime: {
          create(value) {
            coldCreates++;
            return replacement!.create(value);
          },
          restore(bytes, binding) {
            restores++;
            return replacement!.restore(bytes, binding);
          },
        },
      });
      await restarted.initialize();
      await restarted.flushMaterialization();
      assert.equal(restores, 1);
      assert.equal(
        coldCreates,
        0,
        "Restart uses the saved completed state as its calculation base.",
      );
      for (const record of [view, first, latest])
        assert.equal(
          reads.includes(record.envelope.header.content!.hash),
          false,
          "Restart must not reread a completed body for cold authentication.",
        );
      const metadata = await coordinator.loadMetadata();
      assert.equal(metadata.materialized_snapshot, metadata.snapshot);
      const response = await restarted.fetch(
        new Request(
          "http://localhost/api/v1/identities/" + identityFromSeed(seed),
        ),
      );
      assert.equal(response.status, 200);
    } finally {
      finishSave.resolve();
      Atomics.store(gate, 1, 1);
      Atomics.notify(gate, 1);
      await shuttingDown?.catch(() => {});
      if (restarted) await restarted.flushMaterialization().catch(() => {});
      await replacement?.close();
      await runtime.close();
      if (!storageClosed) coordinator.close();
      await release();
      await rm(directory, { recursive: true });
    }
  },
);

test(
  "Node shutdown flushes while a drained request leaves a keep-alive socket open",
  { timeout: 3000 },
  async () => {
    const entered = deferred();
    const respond = deferred();
    const active = new Set<Promise<void>>();
    const agent = new Agent({ keepAlive: true });
    let expired = false;
    let flushedBeforeDeadline = false;
    const server = createServer((_incoming, outgoing) => {
      const handled = (async () => {
        entered.resolve();
        await respond.promise;
        outgoing.writeHead(200, { connection: "keep-alive" });
        outgoing.end("ready");
      })();
      active.add(handled);
      void handled.finally(() => active.delete(handled));
    });
    server.keepAliveTimeout = 1000;
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as { port: number };
    const response = new Promise<void>((resolve, reject) => {
      get(`http://127.0.0.1:${address.port}/`, { agent }, (incoming) => {
        incoming.resume();
        incoming.once("end", resolve);
      }).once("error", reject);
    });
    let shuttingDown: Promise<void> | undefined;
    try {
      await entered.promise;
      shuttingDown = shutdownHost({
        activeRequests: active,
        stopAccepting: () =>
          new Promise<void>((resolve) => server.close(() => resolve())),
        closeConnections: () => {
          expired = true;
          server.closeAllConnections();
        },
        flush: async () => {
          flushedBeforeDeadline = !expired;
          await response;
          server.closeIdleConnections();
        },
        stopEvaluation: async () => {},
        closeStorage: async () => {},
        graceMs: 100,
      });
      respond.resolve();
      await response;
      await shuttingDown;
      assert.equal(
        flushedBeforeDeadline,
        true,
        "Idle sockets must not consume the core grace period.",
      );
    } finally {
      respond.resolve();
      agent.destroy();
      server.closeAllConnections();
      server.close();
      await shuttingDown?.catch(() => {});
    }
  },
);

for (const stalled of [false, true])
  test(
    stalled
      ? "Node shutdown closes a stalled response at the deadline after evaluation flushes"
      : "Node shutdown finishes an active response body before closing its socket",
    { timeout: 3000 },
    async () => {
      const active = new Set<Promise<void>>();
      const entered = deferred();
      const respond = deferred();
      const reading = deferred();
      const agent = new Agent({ keepAlive: true });
      const payload = Buffer.alloc(8 * 1024 * 1024, 97);
      let forcedClosures = 0;
      const server = createServer((_incoming, outgoing) => {
        outgoing.once("finish", () => server.closeIdleConnections());
        const handled = (async () => {
          entered.resolve();
          await respond.promise;
          outgoing.writeHead(200, { connection: "keep-alive" });
          outgoing.end(payload);
        })();
        active.add(handled);
        void handled.finally(() => active.delete(handled));
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address() as { port: number };
      const response = new Promise<number>((resolve, reject) => {
        get(`http://127.0.0.1:${address.port}/`, { agent }, (incoming) => {
          let length = 0;
          incoming.on("data", (bytes: Buffer) => {
            length += bytes.length;
          });
          incoming.once("end", () => resolve(length));
          incoming.once("error", reject);
          incoming.pause();
          reading.resolve();
          if (!stalled) setTimeout(() => incoming.resume(), 50);
        }).once("error", reject);
      });
      void response.catch(() => {});
      let shuttingDown: Promise<void> | undefined;
      try {
        await entered.promise;
        shuttingDown = shutdownHost({
          activeRequests: active,
          stopAccepting: () => {
            const closed = new Promise<void>((resolve) =>
              server.close(() => resolve()),
            );
            server.closeIdleConnections();
            return closed;
          },
          closeConnections: () => {
            forcedClosures++;
            server.closeAllConnections();
          },
          flush: async () => {},
          stopEvaluation: async () => {},
          closeStorage: async () => {},
          graceMs: stalled ? 100 : 1000,
        });
        respond.resolve();
        await reading.promise;
        if (stalled) {
          await shuttingDown;
          agent.destroy();
          await assert.rejects(response, /aborted|socket hang up/);
        } else assert.equal(await response, payload.byteLength);
        await shuttingDown;
        assert.equal(forcedClosures, stalled ? 1 : 0);
      } finally {
        respond.resolve();
        agent.destroy();
        server.closeAllConnections();
        server.close();
        await shuttingDown?.catch(() => {});
      }
    },
  );
