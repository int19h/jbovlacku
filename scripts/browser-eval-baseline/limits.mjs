import { readFile } from "node:fs/promises";
export async function rendererLimiter(cdp, rate) {
  const identities = new Map();
  let stopped = false,
    timer = null,
    refresh = null,
    closed = false,
    pending = Promise.resolve();
  const identity = async (pid) => {
    try {
      return (await readFile(`/proc/${pid}/stat`, "utf8"))
        .split(") ")[1]
        .split(" ")[19];
    } catch {
      return null;
    }
  };
  const signal = async (sig) => {
    for (const [pid, start] of identities)
      if ((await identity(pid)) === start) {
        try {
          process.kill(pid, sig);
        } catch {}
      }
  };
  const scan = async () => {
    try {
      for (const p of (await cdp.send("SystemInfo.getProcessInfo")).processInfo)
        if (p.type === "renderer" && !identities.has(p.id)) {
          const start = await identity(p.id);
          if (start) identities.set(p.id, start);
        }
    } catch {}
  };
  const tick = () => {
    pending = (async () => {
      if (closed) return;
      stopped = !stopped;
      await signal(stopped ? "SIGSTOP" : "SIGCONT");
      if (!closed) timer = setTimeout(tick, stopped ? 10 * (rate - 1) : 10);
    })();
  };
  await scan();
  refresh = setInterval(scan, 500);
  timer = setTimeout(tick, 10);
  return {
    sync: scan,
    async stop() {
      closed = true;
      clearTimeout(timer);
      clearInterval(refresh);
      await pending;
      await signal("SIGCONT");
    },
  };
}
