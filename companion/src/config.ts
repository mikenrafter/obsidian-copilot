/**
 * Resolved companion runtime configuration. Centralized so server.ts and
 * seed.ts agree on dimension and DB location.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type CompanionEmbeddingProvider = "openai" | "ollama";

export interface CompanionConfig {
  host: string;
  port: number;
  token: string;
  dbPath: string;
  /** Default provider used when model id does not encode a provider prefix. */
  defaultEmbeddingProvider: CompanionEmbeddingProvider;
  /** Default model id used when register payload omits one. */
  defaultEmbeddingModel: string;
  /** OpenAI API key for provider="openai". */
  openAIApiKey: string;
  /** Optional OpenAI-compatible base URL for self-hosted endpoints. */
  openAIBaseUrl: string;
  /** Base URL for Ollama embedding requests. */
  ollamaHost: string;
}

const DEFAULT_DB_DIR = path.resolve(process.cwd(), "data");
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, "companion.db");

/**
 * Build config from env vars, applying defaults. Creates the data directory
 * lazily so DB open succeeds on first run.
 */
export function loadConfig(): CompanionConfig {
  const host = process.env.COMPANION_HOST?.trim() || "127.0.0.1";
  const port = Number.parseInt(process.env.COMPANION_PORT ?? "7261", 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid COMPANION_PORT: ${process.env.COMPANION_PORT}`);
  }

  const token = process.env.COMPANION_TOKEN?.trim() ?? "";
  const dbPath = process.env.COMPANION_DB?.trim() || DEFAULT_DB_PATH;

  const providerRaw = process.env.COMPANION_EMBEDDING_PROVIDER?.trim().toLowerCase() || "openai";
  if (providerRaw !== "openai" && providerRaw !== "ollama") {
    throw new Error(
      `Invalid COMPANION_EMBEDDING_PROVIDER: ${process.env.COMPANION_EMBEDDING_PROVIDER}`
    );
  }

  const defaultEmbeddingModel =
    process.env.COMPANION_EMBEDDING_MODEL?.trim() ||
    (providerRaw === "openai" ? "text-embedding-3-small" : "nomic-embed-text");
  const openAIApiKey = process.env.OPENAI_API_KEY?.trim() || "";
  const openAIBaseUrl = process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com";
  const ollamaHost = process.env.OLLAMA_HOST?.trim() || "http://127.0.0.1:11434";

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return {
    host,
    port,
    token,
    dbPath,
    defaultEmbeddingProvider: providerRaw,
    defaultEmbeddingModel,
    openAIApiKey,
    openAIBaseUrl,
    ollamaHost,
  };
}
