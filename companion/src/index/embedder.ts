/**
 * Provider-backed embedding adapter used by the companion indexer and query path.
 */

import type { CompanionConfig } from "../config.js";

interface EmbeddingResolution {
  provider: "openai" | "ollama";
  modelName: string;
  modelId: string;
}

/** Result payload from embedding one or more texts. */
export interface EmbeddedBatch {
  vectors: Float32Array[];
  dimension: number;
  modelId: string;
}

/**
 * Embed one query string.
 */
export async function embedQuery(
  query: string,
  modelHint: string,
  config: CompanionConfig
): Promise<EmbeddedBatch> {
  return embedTexts([query], modelHint, config);
}

/**
 * Embed many texts using the configured provider/model.
 */
export async function embedTexts(
  texts: string[],
  modelHint: string,
  config: CompanionConfig
): Promise<EmbeddedBatch> {
  if (texts.length === 0) {
    throw new Error("embedTexts requires at least one input text");
  }

  const resolution = resolveEmbeddingModel(modelHint, config);
  if (resolution.provider === "openai") {
    return embedWithOpenAI(texts, resolution, config);
  }
  return embedWithOllama(texts, resolution, config);
}

/**
 * Resolve provider + model from a model hint string and runtime config.
 */
function resolveEmbeddingModel(modelHint: string, config: CompanionConfig): EmbeddingResolution {
  const candidate = modelHint?.trim() || config.defaultEmbeddingModel;

  if (candidate.startsWith("openai:")) {
    const modelName = candidate.slice("openai:".length).trim();
    if (!modelName) {
      throw new Error("openai model id is empty");
    }
    return { provider: "openai", modelName, modelId: `openai:${modelName}` };
  }

  if (candidate.startsWith("ollama:")) {
    const modelName = candidate.slice("ollama:".length).trim();
    if (!modelName) {
      throw new Error("ollama model id is empty");
    }
    return { provider: "ollama", modelName, modelId: `ollama:${modelName}` };
  }

  const provider = config.defaultEmbeddingProvider;
  if (provider === "openai") {
    return { provider, modelName: candidate, modelId: `openai:${candidate}` };
  }
  return { provider, modelName: candidate, modelId: `ollama:${candidate}` };
}

/**
 * Call OpenAI-compatible embeddings API.
 */
async function embedWithOpenAI(
  texts: string[],
  resolution: EmbeddingResolution,
  config: CompanionConfig
): Promise<EmbeddedBatch> {
  if (!config.openAIApiKey) {
    throw new Error("OPENAI_API_KEY is required for openai embeddings");
  }

  const url = `${config.openAIBaseUrl.replace(/\/$/, "")}/v1/embeddings`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openAIApiKey}`,
    },
    body: JSON.stringify({
      model: resolution.modelName,
      input: texts,
      encoding_format: "float",
    }),
  });

  if (!response.ok) {
    const detail = await safeResponseText(response);
    throw new Error(`OpenAI embeddings failed (${response.status}): ${detail}`);
  }

  const payload = (await response.json()) as {
    data?: Array<{ embedding?: number[]; index?: number }>;
  };

  const items = payload.data ?? [];
  if (items.length !== texts.length) {
    throw new Error(`OpenAI returned ${items.length} embeddings for ${texts.length} inputs`);
  }

  const vectors = items
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((item, idx) => {
      if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
        throw new Error(`OpenAI response missing embedding at index ${idx}`);
      }
      return Float32Array.from(item.embedding);
    });

  const dimension = vectors[0]?.length ?? 0;
  if (dimension <= 0) {
    throw new Error("OpenAI returned zero-length embedding vectors");
  }

  for (const vector of vectors) {
    if (vector.length !== dimension) {
      throw new Error("OpenAI returned inconsistent embedding dimensions");
    }
  }

  return {
    vectors,
    dimension,
    modelId: resolution.modelId,
  };
}

/**
 * Call Ollama /api/embeddings endpoint for each text.
 */
async function embedWithOllama(
  texts: string[],
  resolution: EmbeddingResolution,
  config: CompanionConfig
): Promise<EmbeddedBatch> {
  const url = `${config.ollamaHost.replace(/\/$/, "")}/api/embeddings`;
  const vectors: Float32Array[] = [];

  for (const text of texts) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: resolution.modelName,
        prompt: text,
      }),
    });

    if (!response.ok) {
      const detail = await safeResponseText(response);
      throw new Error(`Ollama embeddings failed (${response.status}): ${detail}`);
    }

    const payload = (await response.json()) as { embedding?: number[] };
    if (!Array.isArray(payload.embedding) || payload.embedding.length === 0) {
      throw new Error("Ollama response missing embedding vector");
    }
    vectors.push(Float32Array.from(payload.embedding));
  }

  const dimension = vectors[0]?.length ?? 0;
  if (dimension <= 0) {
    throw new Error("Ollama returned zero-length embedding vectors");
  }

  for (const vector of vectors) {
    if (vector.length !== dimension) {
      throw new Error("Ollama returned inconsistent embedding dimensions");
    }
  }

  return {
    vectors,
    dimension,
    modelId: resolution.modelId,
  };
}

/**
 * Safely parse error response text with a short cap.
 */
async function safeResponseText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return "(failed to parse response body)";
  }
}
