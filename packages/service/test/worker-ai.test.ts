import { test } from "node:test";

test("invalid Worker AI settings preserve manual routes with the real shared service", async () => {
  await import("../../../scripts/test-worker-ai-r4.ts");
});
