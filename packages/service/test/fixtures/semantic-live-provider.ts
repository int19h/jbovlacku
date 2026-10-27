/** Disposable provider for the real Node host test. No network request leaves this process. */
const gates: (() => void)[] = [];
process.on("message", (message: { release?: boolean }) => {
  if (message.release) gates.splice(0).forEach((resolve) => resolve());
});
globalThis.fetch = async (input, init) => {
  if (String(input) !== "https://openrouter.ai/api/v1/embeddings")
    throw new Error("Unexpected network request in the semantic host fixture.");
  const body = JSON.parse(String(init?.body));
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
