import {
  abortable,
  AssistanceError,
  isObject,
  EMBEDDING_MODEL,
  EMBEDDING_ROUTE,
  EMBEDDING_QUOTE_TOKENS,
  validEmbeddingInputPrice,
  type ProviderConfig,
} from "./inference.ts";
import { normalizeVector } from "./semantic/vector.ts";

export {
  EMBEDDING_MODEL,
  EMBEDDING_ROUTE,
  EMBEDDING_QUOTE_TOKENS,
} from "./inference.ts";
export const EMBEDDING_DIMENSIONS = 4096;
export const EMBEDDING_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface EmbeddingUsage {
  inputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
}
export interface EmbeddingResult {
  model: string;
  vectors: Float32Array[];
  usage: EmbeddingUsage;
}
export interface PreparedEmbedding {
  body: string;
  count: number;
  estimatedUsd: number;
}
const error = (code: string, message: string) =>
  new AssistanceError(502, code, message);

/** Accept only the router slug and the observed upstream model name. */
export function qwenResponseModel(value: unknown): value is string {
  return value === EMBEDDING_MODEL || value === "Qwen/Qwen3-Embedding-8B";
}

/** Inputs already include the exact prefix from the selected profile. */
export function prepareEmbedding(
  inputs: readonly Uint8Array[],
  config: ProviderConfig,
): PreparedEmbedding {
  const embedding = config.embedding;
  if (
    !embedding ||
    embedding.model !== EMBEDDING_MODEL ||
    embedding.route !== EMBEDDING_ROUTE ||
    !validEmbeddingInputPrice(embedding.inputPrice) ||
    !Number.isFinite(config.maxPrice) ||
    config.maxPrice <= 0
  )
    throw new AssistanceError(
      503,
      "embedding_configuration",
      config.embeddingDisabledReason ??
        "The embedding configuration is unavailable.",
    );
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 8)
    throw new AssistanceError(
      400,
      "embedding_input",
      "An embedding batch needs one through eight inputs.",
    );
  let texts: string[];
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let bytes = 0;
    texts = inputs.map((input) => {
      if (
        !(input instanceof Uint8Array) ||
        !input.length ||
        input.byteLength > 4096
      )
        throw new Error();
      bytes += input.byteLength;
      if (bytes > 32768) throw new Error();
      return decoder.decode(input);
    });
  } catch {
    throw new AssistanceError(
      400,
      "embedding_input",
      "The embedding input is invalid or exceeds its byte limit.",
    );
  }
  const body = JSON.stringify({
    model: embedding.model,
    input: texts,
    encoding_format: "float",
    provider: {
      order: [embedding.route],
      only: [embedding.route],
      allow_fallbacks: false,
      max_price: { prompt: Math.min(embedding.inputPrice, config.maxPrice) },
    },
    usage: { include: true },
  });
  if (new TextEncoder().encode(body).byteLength > 65536)
    throw new AssistanceError(
      400,
      "embedding_input",
      "The encoded embedding request exceeds its byte limit.",
    );
  return {
    body,
    count: inputs.length,
    // A byte count alone does not bound tokens after provider normalization.
    estimatedUsd:
      (inputs.length * EMBEDDING_QUOTE_TOKENS * embedding.inputPrice) / 1000000,
  };
}

async function responseText(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const cancel = () => {
    void response.body?.cancel().catch(() => {});
  };
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > EMBEDDING_RESPONSE_BYTES)
  ) {
    cancel();
    throw error(
      "embedding_response_size",
      "The embedding response exceeds its byte limit.",
    );
  }
  if (!response.body)
    throw error(
      "embedding_response",
      "The embedding provider returned no response body.",
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await abortable(reader.read(), signal);
      if (item.done) break;
      size += item.value.byteLength;
      if (size > EMBEDDING_RESPONSE_BYTES)
        throw error(
          "embedding_response_size",
          "The embedding response exceeds its byte limit.",
        );
      chunks.push(item.value);
    }
    signal.throwIfAborted();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (failure) {
    void reader.cancel().catch(() => {});
    throw failure;
  } finally {
    reader.releaseLock();
  }
}

function normalizedVector(value: unknown): Float32Array {
  if (
    !Array.isArray(value) ||
    value.length !== EMBEDDING_DIMENSIONS ||
    !value.every((item) => typeof item === "number" && Number.isFinite(item))
  )
    throw error(
      "embedding_vector",
      "The embedding vector has invalid dimensions or values.",
    );
  try {
    return normalizeVector(value, EMBEDDING_DIMENSIONS);
  } catch {
    throw error(
      "embedding_vector",
      "The embedding vector cannot use unit normalization.",
    );
  }
}

/** The budget service owns dispatch, the deadline, and all callbacks. No retries occur. */
export async function requestEmbedding(
  prepared: PreparedEmbedding,
  config: ProviderConfig,
  signal: AbortSignal,
  callbacks: {
    sent(): void;
    transportEnded(): void;
    cost(usage: EmbeddingUsage): Promise<void>;
  },
): Promise<EmbeddingResult> {
  let key: string;
  try {
    key = (await abortable(config.key(), signal)).trim();
  } catch {
    signal.throwIfAborted();
    throw new AssistanceError(
      503,
      "provider_credentials",
      "The provider key is unavailable.",
    );
  }
  if (!key || /\s/.test(key))
    throw new AssistanceError(
      503,
      "provider_credentials",
      "The provider key is unavailable.",
    );
  signal.throwIfAborted();
  callbacks.sent();
  // Keep the transport separate from the deadline race. An ignored abort holds
  // its execution slot until the original transport actually ends.
  const transport = (async () => {
    const response = await (config.fetch ?? fetch)(
      `${config.baseUrl}/embeddings`,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: prepared.body,
        signal,
      },
    );
    if (signal.aborted) {
      void response.body?.cancel().catch(() => {});
      signal.throwIfAborted();
    }
    if (
      response.redirected ||
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400)
    ) {
      void response.body?.cancel().catch(() => {});
      throw error(
        "embedding_provider",
        "The embedding provider returned a redirect.",
      );
    }
    const value: unknown = JSON.parse(await responseText(response, signal));
    const rawUsage =
      isObject(value) && isObject(value.usage) ? value.usage : null;
    const count = (item: unknown) =>
      typeof item === "number" && Number.isSafeInteger(item) && item >= 0
        ? item
        : null;
    const usage: EmbeddingUsage = {
      inputTokens: count(rawUsage?.prompt_tokens),
      totalTokens: count(rawUsage?.total_tokens),
      costUsd:
        typeof rawUsage?.cost === "number" &&
        Number.isFinite(rawUsage.cost) &&
        rawUsage.cost >= 0
          ? rawUsage.cost
          : null,
    };
    await callbacks.cost(usage);
    signal.throwIfAborted();
    if (!response.ok || !isObject(value) || value.error)
      throw error(
        "embedding_provider",
        "The embedding provider refused the request.",
      );
    if (!qwenResponseModel(value.model))
      throw error(
        "embedding_model_mismatch",
        "The embedding response model differs from the configured model.",
      );
    if (!Array.isArray(value.data) || value.data.length !== prepared.count)
      throw error(
        "embedding_response",
        "The embedding response does not match the requested batch.",
      );
    const vectors: Float32Array[] = new Array(prepared.count);
    for (const item of value.data) {
      if (
        !isObject(item) ||
        !Number.isInteger(item.index) ||
        item.index < 0 ||
        item.index >= prepared.count ||
        vectors[item.index]
      )
        throw error(
          "embedding_response",
          "The embedding response has invalid or repeated input indices.",
        );
      vectors[item.index] = normalizedVector(item.embedding);
    }
    return { model: value.model, vectors, usage };
  })();
  const tracked = transport.finally(callbacks.transportEnded);
  return abortable(tracked, signal);
}
