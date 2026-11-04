import type { Page } from "@playwright/test";

/** Hold the real search queue until it acknowledges a queued cancellation. */
export async function installSearchWorkerGate(page: Page) {
  await page.addInitScript(() => {
    const Original = Worker;
    const acknowledgments: any[] = [];
    const waiters = new Set<() => void>();
    let worker: Worker;
    let gate = 0;
    let lastRequest: number;
    (window as any).searchWorkers = 0;
    const wait = (kind: string, request?: number) =>
      new Promise<void>((resolve, reject) => {
        const current = gate;
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`The search queue did not acknowledge ${kind}.`));
        }, 10000);
        const check = () => {
          if (
            acknowledgments.some(
              (message) =>
                message.gate === current &&
                message.kind === kind &&
                (request === undefined || message.request === request),
            )
          ) {
            waiters.delete(check);
            clearTimeout(timer);
            resolve();
          }
        };
        waiters.add(check);
        check();
      });
    (window as any).searchGate = {
      async hold() {
        gate++;
        worker.postMessage({ testSearchGate: "hold", gate });
        await wait("enabled");
      },
      async queued() {
        const request = lastRequest;
        await wait("queued", request);
        await wait("held");
        return request;
      },
      canceled: (request: number) => wait("canceled", request),
      async release() {
        worker.postMessage({ testSearchGate: "release", gate });
        await wait("released");
      },
    };
    window.Worker = class extends Original {
      constructor(target: string | URL, options?: WorkerOptions) {
        const search = String(target).includes("package-search-worker");
        let url = target;
        if (search) {
          // Pause the existing drain timer after the real handler queues requests.
          const source = `
            const nativeTimer = globalThis.setTimeout.bind(globalThis);
            const send = self.postMessage.bind(self);
            let receive, gate = 0, holding = false;
            const early = [], held = [];
            Object.defineProperty(self, 'onmessage', {
              configurable: true, get: () => receive, set: value => receive = value
            });
            globalThis.setTimeout = (fn, delay, ...args) => {
              if (holding && delay === 0) {
                held.push(() => nativeTimer(fn, delay, ...args));
                send({ testSearchGate: true, gate, kind: 'held' });
                return 0;
              }
              return nativeTimer(fn, delay, ...args);
            };
            const forward = event => {
              receive(event);
              if (holding) {
                if (event.data.request !== undefined)
                  send({ testSearchGate: true, gate, kind: 'queued', request: event.data.request });
                if (event.data.cancel !== undefined)
                  send({ testSearchGate: true, gate, kind: 'canceled', request: event.data.cancel });
              }
            };
            self.addEventListener('message', event => {
              const data = event.data;
              if (data.testSearchGate === 'hold') {
                gate = data.gate; holding = true;
                send({ testSearchGate: true, gate, kind: 'enabled' });
              } else if (data.testSearchGate === 'release') {
                holding = false;
                for (const run of held.splice(0)) run();
                send({ testSearchGate: true, gate, kind: 'released' });
              } else if (receive) forward(event);
              else early.push(event);
            });
            await import(${JSON.stringify(new URL(String(target), location.href).href)});
            for (const event of early.splice(0)) forward(event);
          `;
          url = URL.createObjectURL(
            new Blob([source], { type: "text/javascript" }),
          );
        }
        super(url, options);
        if (search) {
          worker = this;
          (window as any).searchWorkers++;
        }
        const property = Object.getOwnPropertyDescriptor(
          Original.prototype,
          "onmessage",
        )!;
        Object.defineProperty(this, "onmessage", {
          get: () => property.get?.call(this),
          set: (handler) =>
            property.set?.call(this, (event: MessageEvent) => {
              if (event.data.testSearchGate) {
                acknowledgments.push(event.data);
                for (const check of waiters) check();
                return;
              }
              if (event.data.result && (window as any).abortPlainOnReply) {
                const abort = (window as any).abortPlainOnReply;
                delete (window as any).abortPlainOnReply;
                abort();
              }
              handler?.call(this, event);
            }),
        });
      }
      postMessage(message: any, options?: any) {
        if (message.request !== undefined) lastRequest = message.request;
        return Original.prototype.postMessage.call(this, message, options);
      }
    };
  });
}
