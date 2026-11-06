export class WorkerCDP {
  constructor(root, session, { browser, lifecycle } = {}) {
    this.root = root;
    this.session = session;
    this.id = 0;
    this.pending = new Map();
    this.closedReason = null;
    root.on("Target.detachedFromTarget", ({ sessionId }) => {
      if (sessionId === session)
        this.rejectPending(Error("Worker target detached"));
    });
    root.on("Target.receivedMessageFromTarget", ({ sessionId, message }) => {
      if (sessionId !== session) return;
      const value = JSON.parse(message);
      if (value.id) {
        const request = this.pending.get(value.id);
        if (request) {
          this.pending.delete(value.id);
          value.error
            ? request.reject(Error(JSON.stringify(value.error)))
            : request.resolve(value.result);
        }
      }
    });
    browser?.on("disconnected", () =>
      this.rejectPending(Error("Browser disconnected")),
    );
    this.unsubscribe = lifecycle?.onCancel((reason) =>
      this.rejectPending(reason),
    );
  }

  rejectPending(reason = Error("Worker requests cancelled")) {
    this.closedReason ??= reason;
    for (const request of this.pending.values())
      request.reject(this.closedReason);
    this.pending.clear();
    this.unsubscribe?.();
  }

  send(method, params = {}) {
    if (this.closedReason) return Promise.reject(this.closedReason);
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const rejected = (error) => {
        const request = this.pending.get(id);
        this.pending.delete(id);
        request?.reject(error);
      };
      try {
        Promise.resolve(
          this.root.send("Target.sendMessageToTarget", {
            sessionId: this.session,
            message: JSON.stringify({ id, method, params }),
          }),
        ).catch(rejected);
      } catch (error) {
        rejected(error);
      }
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
}
