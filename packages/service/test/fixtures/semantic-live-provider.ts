/** Disposable provider for the real Node host test. No network request leaves this process. */
let calls = 0;
const gates: (() => void)[] = [];
process.on("message", (message: { release?: boolean; stats?: boolean }) => {
  if (message.release) gates.splice(0).forEach((resolve) => resolve());
  if (message.stats) process.send?.({ event: "provider_stats", calls });
});
globalThis.fetch = async (input, init) => {
  if (String(input) !== "https://openrouter.ai/api/v1/embeddings")
    throw new Error("Unexpected network request in the semantic host fixture.");
  calls++;
  const body = JSON.parse(String(init?.body));
  const route = process.env.JVC_TEST_EMBEDDING_ROUTE ?? "nebius";
  if (
    JSON.stringify(body.provider?.only) !== JSON.stringify([route]) ||
    JSON.stringify(body.provider?.order) !== JSON.stringify([route]) ||
    body.provider?.allow_fallbacks !== false
  )
    throw new Error("The semantic host used a different profile route.");
  if (body.input.some((text: string) => text.includes("new traveler"))) {
    const gate = new Promise<void>((resolve) => gates.push(resolve));
    process.send?.({ event: "index_pending" });
    await gate;
  }
  return Response.json({
    model: "qwen/qwen3-embedding-8b",
    data: body.input.map((_: unknown, index: number) => ({
      index,
      embedding: Array.from({ length: 4096 }, (_, i) => (i ? 0 : 1)),
    })),
    usage: { prompt_tokens: 1, total_tokens: 1, cost: 0.00000001 },
  });
};
