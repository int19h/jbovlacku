import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { shutdownHost } from "../../../apps/server/src/shutdown.ts";

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
            return new Promise<void>((resolve) =>
              server.close(() => resolve()),
            );
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
  "Node shutdown settles a checkpoint save after terminating a slow evaluation",
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
