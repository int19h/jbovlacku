import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

export const childRunning = (child) =>
  !!child && child.exitCode === null && child.signalCode === null;

const shutdowns = new WeakMap();
export function stopChild(child) {
  if (!child) return Promise.resolve();
  if (shutdowns.has(child)) return shutdowns.get(child);
  if (!childRunning(child)) return Promise.resolve();
  const stopped = new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
  shutdowns.set(child, stopped);
  return stopped;
}

export async function configureWorkerThrottle(cdp, rate, limiter) {
  if (limiter) return "skipped: renderer limiter active";
  try {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    return "applied";
  } catch (error) {
    return String(error);
  }
}

const startTime = (stat) =>
  stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
const identity = async (pid) => {
  try {
    return startTime(await readFile(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
};
const identitySync = (pid) => {
  try {
    return startTime(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
};

export function createRendererLimiter(
  cdp,
  rate,
  { readIdentity = identity } = {},
) {
  const identities = new Map();
  let stopped = false,
    timer = null,
    refresh = null,
    closed = false,
    pending = Promise.resolve(),
    starting = null,
    stopping = null;
  const signal = async (sig) => {
    for (const [pid, start] of identities) {
      if (sig === "SIGSTOP" && closed) return;
      const current = await readIdentity(pid);
      if (sig === "SIGSTOP" && closed) return;
      if (current === start) {
        try {
          process.kill(pid, sig);
        } catch {}
      }
    }
  };
  const scan = async () => {
    if (closed) return;
    try {
      const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
      if (closed) return;
      for (const p of processInfo)
        if (p.type === "renderer" && !identities.has(p.id)) {
          const start = await readIdentity(p.id);
          if (closed) return;
          if (start) identities.set(p.id, start);
        }
    } catch {}
  };
  const tick = () => {
    timer = null;
    pending = (async () => {
      if (closed) return;
      stopped = !stopped;
      await signal(stopped ? "SIGSTOP" : "SIGCONT");
      if (!closed) timer = setTimeout(tick, stopped ? 10 * (rate - 1) : 10);
    })();
  };
  const disable = () => {
    closed = true;
    clearTimeout(timer);
    clearInterval(refresh);
    timer = refresh = null;
  };
  return {
    sync: scan,
    start() {
      return (starting ??= (async () => {
        if (closed) return;
        await scan();
        if (closed) return;
        refresh = setInterval(scan, 500);
        timer = setTimeout(tick, 10);
      })());
    },
    disable,
    stop() {
      disable();
      return (stopping ??= (async () => {
        await pending;
        await signal("SIGCONT");
      })());
    },
    resumeSync() {
      disable();
      for (const [pid, start] of identities)
        if (identitySync(pid) === start) {
          try {
            process.kill(pid, "SIGCONT");
          } catch {}
        }
    },
    get timerCount() {
      return Number(timer !== null) + Number(refresh !== null);
    },
  };
}

export async function rendererLimiter(cdp, rate) {
  const limiter = createRendererLimiter(cdp, rate);
  await limiter.start();
  return limiter;
}
