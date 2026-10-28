import type { ServerResponse } from "node:http";

export async function sendResponseBody(
  body: ReadableStream<Uint8Array>,
  outgoing: ServerResponse,
): Promise<void> {
  const reader = body.getReader();
  let closed = outgoing.destroyed;
  const cancel = () => {
    closed = true;
    void reader.cancel().catch(() => {});
  };
  outgoing.once("close", cancel);
  outgoing.once("error", cancel);
  try {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done || closed) break;
      if (!outgoing.write(value))
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            outgoing.off("drain", drained);
            outgoing.off("close", drained);
            outgoing.off("error", failed);
          };
          const drained = () => {
            cleanup();
            resolve();
          };
          const failed = (error: Error) => {
            cleanup();
            reject(error);
          };
          outgoing.once("drain", drained);
          outgoing.once("close", drained);
          outgoing.once("error", failed);
          if (outgoing.destroyed) drained();
        });
    }
  } finally {
    outgoing.off("close", cancel);
    outgoing.off("error", cancel);
    if (closed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
