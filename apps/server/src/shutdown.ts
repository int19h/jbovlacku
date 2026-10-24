interface ShutdownOptions {
  activeRequests: Set<Promise<void>>;
  stopAccepting(): Promise<void>;
  closeConnections(): void;
  flush(): Promise<void>;
  prepareEvaluationShutdown?(): Promise<void>;
  stopEvaluation(): Promise<void>;
  closeStorage(): Promise<void>;
  graceMs?: number;
}

/** A closed socket does not mean that its durable admission handler finished. */
export async function shutdownHost(options: ShutdownOptions): Promise<void> {
  const connectionsClosed = options.stopAccepting();
  let expired = false;
  let stopped: Promise<void> | undefined;
  const stopEvaluation = () =>
    (stopped ??= (async () => {
      // Export and save the completed worker before termination can reject it.
      try {
        await options.prepareEvaluationShutdown?.();
      } finally {
        await options.stopEvaluation();
      }
    })());
  let timer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      options.closeConnections();
      stopEvaluation().then(resolve, reject);
    }, options.graceMs ?? 10000);
  });
  // A deadline can expire while a durable request still drains.
  void deadline.catch(() => {});
  let flushing: Promise<void> | undefined;
  const flush = () => (flushing ??= options.flush());
  const drainRequests = async () => {
    while (options.activeRequests.size)
      await Promise.allSettled([...options.activeRequests]);
  };
  try {
    await drainRequests();
    if (!expired)
      await Promise.race([
        flush().catch((error) => {
          if (!expired) throw error;
        }),
        deadline,
      ]);
  } finally {
    try {
      try {
        await stopEvaluation();
      } finally {
        await drainRequests();
        await connectionsClosed;
        // Termination bounds core work. Durable writes and checkpoint I/O must settle
        // before their SQLite connections and the data lock close.
        try {
          await flush();
        } catch (error) {
          if (!expired) throw error;
        } finally {
          await options.closeStorage();
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
