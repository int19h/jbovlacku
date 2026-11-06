import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createLifecycle, FORCE_EXIT_DELAY_MS } from "./lifecycle.mjs";
import { stopChild } from "./limits.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const life = (options = {}) =>
  createLifecycle({ setExitStatus() {}, forceExit() {}, ...options });
const stat = async (pid) => {
  const text = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  return { state: fields[0], start: fields[19] };
};
const target = () =>
  spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
const waitUntil = async (predicate) => {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await delay(5);
  }
  assert.fail("The expected lifecycle state did not arrive.");
};

test("shutdown before limiter creation refuses setup without starting a timer", async () => {
  const timers = process
    .getActiveResourcesInfo()
    .filter((name) => name === "Timeout").length;
  const owner = life();
  await owner.shutdown();
  let scans = 0;
  await assert.rejects(
    owner.startLimiter(
      {
        send: async () => {
          scans++;
        },
      },
      4,
    ),
    /interrupted/,
  );
  assert.equal(scans, 0);
  assert.equal(owner.limiterCount, 0);
  assert.equal(
    process.getActiveResourcesInfo().filter((name) => name === "Timeout")
      .length,
    timers,
  );
});

test("shutdown owns and disables a limiter during its deferred initial scan", async () => {
  const timers = process
    .getActiveResourcesInfo()
    .filter((name) => name === "Timeout").length;
  const scan = deferred();
  const owner = life();
  const starting = owner.startLimiter({ send: () => scan.promise }, 4);
  const rejected = assert.rejects(starting, /interrupted/);
  assert.equal(owner.limiterCount, 1);
  await owner.shutdown();
  scan.resolve({ processInfo: [] });
  await rejected;
  assert.equal(owner.limiterCount, 0);
  assert.equal(
    process.getActiveResourcesInfo().filter((name) => name === "Timeout")
      .length,
    timers,
  );
});

test(
  "forced resume prevents an awaited stop tick from sending a later SIGSTOP",
  { timeout: 5000 },
  async () => {
    const child = target();
    const reading = deferred(),
      release = deferred(),
      exited = deferred();
    let reads = 0;
    const owner = life({
      closeBrowser: () => new Promise(() => {}),
      forceExit: exited.resolve,
    });
    try {
      const limiter = await owner.startLimiter(
        {
          send: async () => ({
            processInfo: [{ type: "renderer", id: child.pid }],
          }),
        },
        4,
        {
          readIdentity: async (pid) => {
            const value = (await stat(pid)).start;
            if (++reads === 2) {
              reading.resolve();
              await release.promise;
            }
            return value;
          },
        },
      );
      await reading.promise;
      child.kill("SIGSTOP");
      await waitUntil(async () => (await stat(child.pid)).state === "T");
      owner.handleSignal("SIGINT");
      const began = performance.now();
      owner.handleSignal("SIGTERM");
      assert.equal(limiter.timerCount, 0);
      await waitUntil(async () => (await stat(child.pid)).state !== "T");
      release.resolve();
      assert.equal(await exited.promise, 130);
      assert(performance.now() - began < 2000);
      assert.equal(FORCE_EXIT_DELAY_MS, 250);
      await delay(40);
      assert.notEqual((await stat(child.pid)).state, "T");
      assert.equal(limiter.timerCount, 0);
      assert.equal(owner.limiterCount, 0);
    } finally {
      release.resolve();
      child.kill("SIGCONT");
      await stopChild(child);
    }
  },
);

for (const blocked of ["browser", "server"])
  for (const second of ["SIGINT", "SIGTERM"])
    test(
      `a second ${second} exits after resume with ${blocked} shutdown pending`,
      { timeout: 6000 },
      async () => {
        const child = target();
        let probe;
        try {
          const source = `
          import { createLifecycle } from ${JSON.stringify(new URL("./lifecycle.mjs", import.meta.url).href)};
          const blocked = () => { console.log('blocked'); return new Promise(()=>{}); };
          const owner = createLifecycle({
            closeBrowser: ${blocked === "browser" ? "blocked" : "async()=>{}"},
            stopServer: ${blocked === "server" ? "blocked" : "async()=>{}"}
          });
          for(const sig of ['SIGINT','SIGTERM','SIGHUP']) process.on(sig,()=>owner.handleSignal(sig));
          await owner.startLimiter({send:async()=>({processInfo:[{type:'renderer',id:${child.pid}}]})},4);
          setInterval(()=>{},1000);
          console.log('ready');
        `;
          probe = spawn(process.execPath, [
            "--input-type=module",
            "-e",
            source,
          ]);
          let output = "";
          probe.stdout.on("data", (chunk) => {
            output += chunk;
          });
          let stderr = "";
          probe.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          const exited = once(probe, "exit");
          await waitUntil(() => output.includes("ready"));
          await waitUntil(async () => (await stat(child.pid)).state === "T");
          probe.kill("SIGINT");
          await waitUntil(() => output.includes("blocked"));
          const began = performance.now();
          probe.kill(second);
          const [code, signal] = await Promise.race([
            exited,
            delay(2000).then(() => {
              throw Error("Forced exit deadline was missed.");
            }),
          ]);
          assert.equal(code, 130, stderr);
          assert.equal(signal, null);
          assert(performance.now() - began < 2000);
          assert.notEqual((await stat(child.pid)).state, "T");
        } finally {
          if (probe && probe.exitCode === null && probe.signalCode === null) {
            const exited = once(probe, "exit");
            probe.kill("SIGKILL");
            await exited;
          }
          child.kill("SIGCONT");
          await stopChild(child);
        }
      },
    );

test("SIGHUP during setup or between trials refuses later ranking and trial admission", async () => {
  for (const duringSetup of [false, true]) {
    const owner = life();
    let queries = 0,
      actions = 0;
    if (!duringSetup) owner.handleSignal("SIGHUP");
    await assert.rejects(
      owner.runOperation(
        async () => {
          queries++;
          owner.handleSignal("SIGHUP");
        },
        async () => {
          actions++;
        },
      ),
      /SIGHUP/,
    );
    await assert.rejects(
      owner.runOperation(
        async () => {
          queries++;
        },
        async () => {
          actions++;
        },
      ),
      /SIGHUP/,
    );
    assert.equal(queries, Number(duringSetup));
    assert.equal(actions, 0);
    assert.equal(owner.exitStatus, 129);
    await owner.shutdown();
  }
});

test("a cancelled successful word cannot admit another word or output append", async () => {
  const owner = life();
  let queries = 0,
    words = 0,
    appends = 0;
  await assert.rejects(
    owner.runOperation(
      async () => {
        queries++;
      },
      async () => {
        words++;
        owner.fail(Error("ENOSPC"));
        owner.assertActive();
        appends++;
      },
    ),
    /ENOSPC/,
  );
  await assert.rejects(
    owner.runOperation(
      async () => {
        queries++;
      },
      async () => {
        words++;
        appends++;
      },
    ),
    /ENOSPC/,
  );
  assert.equal(queries, 1);
  assert.equal(words, 1);
  assert.equal(appends, 0);
  assert.equal(owner.signalCount, 0);
  assert.equal(owner.exitStatus, 1);
  await owner.shutdown();
});

test("cancellation during a successful action refuses the next word", async () => {
  const owner = life();
  let actions = 0;
  await assert.rejects(
    owner.runOperation(
      async () => {},
      async () => {
        actions++;
        owner.handleSignal("SIGINT");
        return 42;
      },
    ),
    /SIGINT/,
  );
  await assert.rejects(
    owner.runOperation(
      async () => {},
      async () => {
        actions++;
      },
    ),
    /SIGINT/,
  );
  assert.equal(actions, 1);
  await owner.shutdown();
});

test("ordinary word failures leave later operations admissible", async () => {
  const owner = life();
  await assert.rejects(
    owner.runOperation(
      async () => {},
      async () => {
        throw Error("word failure");
      },
    ),
    /word failure/,
  );
  assert.equal(
    await owner.runOperation(
      async () => {},
      async () => 42,
    ),
    42,
  );
  assert.equal(owner.cancelled, false);
  await owner.shutdown();
});

test(
  "output failure is not a signal and keeps status 1 through later escalation",
  { timeout: 3000 },
  async () => {
    const exited = deferred();
    const owner = life({
      closeBrowser: () => new Promise(() => {}),
      forceExit: exited.resolve,
    });
    owner.fail(Error("ENOSPC"));
    owner.handleSignal("SIGINT");
    assert.equal(owner.signalCount, 1);
    owner.handleSignal("SIGTERM");
    assert.equal(await exited.promise, 1);
    assert.equal(owner.signalCount, 2);
  },
);
