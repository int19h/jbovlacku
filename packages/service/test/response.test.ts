import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import assert from "node:assert/strict";
import test from "node:test";
import { sendResponseBody } from "../../../apps/server/src/response.ts";

test("disconnected backpressured response cancels its source", async () => {
  let canceled = false;
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    write() {
      queueMicrotask(() => response.emit("close"));
      return false;
    },
  });
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(1024));
    },
    cancel() {
      canceled = true;
    },
  });
  await sendResponseBody(body, response as unknown as ServerResponse);
  assert.equal(canceled, true);
  assert.equal(response.listenerCount("close"), 0);
  assert.equal(response.listenerCount("drain"), 0);
});
