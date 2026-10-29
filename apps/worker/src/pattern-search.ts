import {
  patternBusy,
  scanPatternsChunked,
  type PatternMatch,
  type PatternScanner,
} from "../../../packages/search/src/pattern-scan.ts";
interface WaitingScan {
  start: () => void;
  cancel: () => void;
}
/** Multiple Durable Objects can share one isolate and its Wasm memory. */
class PatternAdmission {
  private active = 0;
  private waiting: WaitingScan[] = [];
  run(work: () => Promise<PatternMatch[]>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.active >= 2 && this.waiting.length >= 8)
      return Promise.reject(patternBusy());
    return new Promise<PatternMatch[]>((resolve, reject) => {
      const waiting: WaitingScan = {
        start: () => {
          signal?.removeEventListener("abort", waiting.cancel);
          this.active++;
          const finish = (error?: unknown, rows?: PatternMatch[]) => {
            this.active--;
            while (this.active < 2 && this.waiting.length)
              this.waiting.shift()!.start();
            if (error !== undefined) reject(error);
            else resolve(rows!);
          };
          try {
            signal?.throwIfAborted();
            work().then((rows) => finish(undefined, rows), finish);
          } catch (error) {
            finish(error);
          }
        },
        cancel: () => {
          const at = this.waiting.indexOf(waiting);
          if (at < 0) return;
          this.waiting.splice(at, 1);
          signal?.removeEventListener("abort", waiting.cancel);
          reject(signal?.reason);
        },
      };
      if (this.active < 2) waiting.start();
      else {
        this.waiting.push(waiting);
        signal?.addEventListener("abort", waiting.cancel, { once: true });
      }
    });
  }
}
const admission = new PatternAdmission();
/** A real read advances the hosted clock. Promise-only yields do not. */
export const workerPatternScanner =
  (index: Pick<D1Database, "prepare">): PatternScanner =>
  (entries, query, signal) =>
    admission.run(
      () =>
        scanPatternsChunked(entries, query, {
          signal,
          yield: () => index.prepare("SELECT 1").first(),
        }),
      signal,
    );
