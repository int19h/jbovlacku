import {
  providerConfig,
  AssistanceError,
  InferenceRunner,
  newLog,
  promptVersion,
} from "../../src/inference.ts";
import { prepareEmbedding, requestEmbedding } from "../../src/embedding.ts";

export default {
  async fetch(request: Request, env: { MOCK_ORIGIN: string }) {
    const url = new URL(request.url);
    if (url.pathname === "/generation") {
      const fields = [
        "JVC_AI_EMBEDDING_MODEL",
        "JVC_AI_EMBEDDING_PROVIDER_ROUTE",
        "JVC_AI_EMBEDDING_INPUT_PRICE",
      ];
      const field = fields.find(
        (value) => value === url.searchParams.get("field"),
      );
      if (!field) return new Response(null, { status: 400 });
      const config = providerConfig(
        {
          JVC_AI_ENABLED: "enabled",
          JVC_AI_BASE_URL: `${env.MOCK_ORIGIN}/generation`,
          [field]: "",
        },
        async () => "disposable-workerd-embedding-key",
      )!;
      const log = newLog("type", config, await promptVersion());
      const answer = await new InferenceRunner(
        config,
        log,
        AbortSignal.timeout(5000),
        () => {},
      ).run({ task: "type", input: "Public generation fixture." });
      return Response.json({
        answer,
        embedding: !!config.embedding,
        diagnostic: config.embeddingDisabledReason,
        answers: log.answers,
      });
    }
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
