import { createRendererLimiter } from "./limits.mjs";

export const FORCE_EXIT_DELAY_MS = 250;

export function createLifecycle({
  closeBrowser = async () => {},
  stopServer = async () => {},
  forceExit = (status) => process.exit(status),
  setExitStatus = (status) => {
    process.exitCode = status;
  },
  reportError = (error) => console.error("Cleanup failed:", error),
} = {}) {
  const limiters = new Set();
  let cancelled = false,
    reason = null,
    signals = 0,
    status = 0,
    graceful = null,
    forced = false;
  const assertActive = () => {
    if (cancelled) throw reason;
  };
  const cancel = (error = Error("Measurement interrupted.")) => {
    cancelled = true;
    reason ??= error;
    for (const limiter of limiters) limiter.disable();
  };
  const stopLimiters = async () => {
    const owned = [...limiters];
    for (const limiter of owned) limiter.disable();
    await Promise.all(
      owned.map(async (limiter) => {
        await limiter.stop();
        limiters.delete(limiter);
      }),
    );
  };
  const shutdown = () => {
    cancel();
    return (graceful ??= (async () => {
      await stopLimiters();
      try {
        await closeBrowser();
      } finally {
        await stopServer();
      }
    })());
  };
  const forceShutdown = () => {
    if (forced) return;
    forced = true;
    cancel();
    setTimeout(() => forceExit(status || 1), FORCE_EXIT_DELAY_MS);
    for (const limiter of limiters) {
      try {
        limiter.resumeSync();
      } catch (error) {
        reportError(error);
      }
    }
  };
  return {
    assertActive,
    cancel,
    shutdown,
    stopLimiters,
    forceShutdown,
    async startLimiter(cdp, rate, options) {
      assertActive();
      const limiter = createRendererLimiter(cdp, rate, options);
      limiters.add(limiter);
      await limiter.start();
      if (cancelled) {
        await limiter.stop();
        limiters.delete(limiter);
        assertActive();
      }
      return limiter;
    },
    async runOperation(before, action) {
      assertActive();
      const prepared = await before();
      assertActive();
      const result = await action(prepared);
      assertActive();
      return result;
    },
    handleSignal(signal) {
      const code = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal];
      if (!code) throw Error("Unsupported termination signal.");
      signals++;
      if (!status) {
        status = code;
        setExitStatus(status);
      }
      cancel(Error(`Measurement interrupted by ${signal}.`));
      if (signals > 1) forceShutdown();
      else void shutdown().catch(reportError);
    },
    fail(error) {
      status = 1;
      setExitStatus(status);
      cancel(error);
      void shutdown().catch(reportError);
    },
    get cancelled() {
      return cancelled;
    },
    get signalCount() {
      return signals;
    },
    get exitStatus() {
      return status;
    },
    get limiterCount() {
      return limiters.size;
    },
  };
}
