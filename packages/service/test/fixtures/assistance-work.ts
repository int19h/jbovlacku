import type { AssistanceService } from "../../src/assistance.ts";

/** Wait for detached test jobs and their final durable budget write. */
export async function waitForAssistance(
  service: AssistanceService,
): Promise<void> {
  const state = service as unknown as {
    running: number;
    budgetTail: Promise<void>;
  };
  for (let attempt = 0; attempt < 2000; attempt++) {
    await service.drainEmbeddingTransports();
    if (state.running === 0) {
      await state.budgetTail;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("The mocked assistance jobs did not finish.");
}
