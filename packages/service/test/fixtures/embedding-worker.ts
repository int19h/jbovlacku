import { providerConfig, AssistanceError } from "../../src/inference.ts";
import { prepareEmbedding, requestEmbedding } from "../../src/embedding.ts";

export default {
  async fetch(request: Request, env: { MOCK_ORIGIN: string }) {
    const mode =
      new URL(request.url).searchParams.get("mode") === "redirect"
        ? "redirect"
        : "good";
    const config = providerConfig(
      {
        JVC_AI_ENABLED: "enabled",
        JVC_AI_BASE_URL: `${env.MOCK_ORIGIN}/${mode}`,
      },
      async () => "disposable-workerd-embedding-key",
    )!;
    let sent = false;
    let costReports = 0;
    try {
      const result = await requestEmbedding(
        prepareEmbedding([new TextEncoder().encode("Public fixture.")], config),
        config,
        AbortSignal.timeout(5000),
        {
          sent() {
            sent = true;
          },
          transportEnded() {},
          async cost() {
            costReports++;
          },
        },
      );
      return Response.json({
        success: true,
        model: result.model,
        dimensions: result.vectors[0].length,
        usage: result.usage,
        sent,
        costReports,
      });
    } catch (failure) {
      return Response.json({
        success: false,
        code:
          failure instanceof AssistanceError ? failure.code : "transport_error",
        sent,
        costReports,
      });
    }
  },
};
