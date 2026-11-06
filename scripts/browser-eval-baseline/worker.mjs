// The build adds a read-only session getter to the real evaluation worker.
import "../../apps/web/src/workers/evaluate.ts";
import { initializeCore } from "../../packages/core/src/browser.ts";
let started = 0,
  received = 0,
  wasm;
const original = self.onmessage;
const post = self.postMessage.bind(self);
self.postMessage = (value) =>
  post({
    ...value,
    measurement: {
      worker_ms: performance.now() - started,
      ready_wait_ms: started - received,
      wasm_bytes: wasm.memory.buffer.byteLength,
    },
  });
self.onmessage = async (event) => {
  received = performance.now();
  wasm = await initializeCore();
  started = performance.now();
  return original.call(self, event);
};
self.measurement = async () => ({
  wasm_bytes: (await initializeCore()).memory.buffer.byteLength,
  statistics: self.__measurementSession()?.updateStatistics?.(),
  available: self.__measurementSession()?.state.available,
  reasons: self.__measurementSession()?.state.reasons,
});
