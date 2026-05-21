import { logError, logInfo, logWarn } from "@/logger";
import {
  VectorSearchBackend,
  VectorSearchResult,
} from "@/search/selfHostRetriever";
import { safeFetch } from "@/utils";

/**
 * Configuration for {@link CompanionVectorClient}. All fields are derived
 * from plugin settings and revalidated whenever settings change.
 */
export interface CompanionClientConfig {
  /** Host or IP. Loopback recommended. */
  host: string;
  /** TCP port. */
  port: number;
  /** Optional bearer token; empty means no `Authorization` header. */
  token: string;
  /** Logical vault id sent in the URL path. */
  vaultId: string;
}

/**
 * Health payload returned by the companion. Kept in sync with
 * `companion/src/protocol/types.ts::HealthResponse`.
 */
export interface CompanionHealth {
  status: "ok";
  version: string;
  embeddingDimension: number;
  indexedChunks: number;
}

/**
 * Lightweight client for the localhost vector companion. Implements
 * {@link VectorSearchBackend} so it can be registered via
 * `RetrieverFactory.registerSelfHostedBackend()` and consumed by
 * `SelfHostRetriever` / `MergedSemanticRetriever`.
 *
 * Phase 0 surface: `/health` and `POST /vaults/:id/search`. The dimension
 * reported by `/health` is cached on first successful probe; subsequent
 * `getEmbeddingDimension()` calls return the cached value.
 *
 * Failure modes (advertised on every call):
 *  - Network error → returns `[]` from search and `false` from
 *    `isAvailable()`. Logged at warn level; never throws to callers.
 *  - HTTP non-2xx → same as network error, with status logged.
 *  - Companion offline → `isAvailable()` returns `false`. The retriever
 *    factory will then fall back to its next-best option (lexical-only).
 */
export class CompanionVectorClient implements VectorSearchBackend {
  private static readonly DEFAULT_DIM = 128;
  private config: CompanionClientConfig;
  private cachedDim: number | null = null;

  constructor(config: CompanionClientConfig) {
    this.config = config;
  }

  /**
   * Replace the active configuration in place. Clears the cached dimension
   * so the next probe reflects the new endpoint.
   */
  updateConfig(config: CompanionClientConfig): void {
    this.config = config;
    this.cachedDim = null;
  }

  /** Base URL with no trailing slash. */
  private baseUrl(): string {
    const { host, port } = this.config;
    return `http://${host}:${port}`;
  }

  /** Build request headers, including bearer token when configured. */
  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.token) {
      h.Authorization = `Bearer ${this.config.token}`;
    }
    return h;
  }

  /**
   * GET /health. Returns the parsed payload on success, `null` on any
   * failure. Caches the dimension as a side effect.
   */
  async health(): Promise<CompanionHealth | null> {
    try {
      const res = await safeFetch(`${this.baseUrl()}/health`, {
        method: "GET",
        headers: this.headers(),
        throwOnHttpError: false,
      });
      if (!res.ok) {
        logWarn(`CompanionVectorClient: /health HTTP ${res.status}`);
        return null;
      }
      const body = (await res.json()) as CompanionHealth;
      if (body?.status === "ok" && typeof body.embeddingDimension === "number") {
        this.cachedDim = body.embeddingDimension;
        return body;
      }
      logWarn("CompanionVectorClient: /health returned unexpected payload", body);
      return null;
    } catch (err) {
      logWarn("CompanionVectorClient: /health failed", err);
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    return (await this.health()) !== null;
  }

  /**
   * Returns the cached embedding dimension when known, otherwise a sentinel
   * default (128). Callers that need an authoritative value should call
   * {@link health} first.
   */
  getEmbeddingDimension(): number {
    return this.cachedDim ?? CompanionVectorClient.DEFAULT_DIM;
  }

  async search(
    query: string,
    options: { limit: number; minScore?: number; filter?: Record<string, unknown> }
  ): Promise<VectorSearchResult[]> {
    return this.postSearch({
      query,
      limit: options.limit,
      minScore: options.minScore,
      filter: options.filter,
    });
  }

  /**
   * Phase 0 stub: the companion always embeds server-side, so we have no
   * meaningful way to honor a pre-computed vector. Logs and returns `[]`
   * rather than silently no-op'ing.
   */
  async searchByVector(
    _embedding: number[],
    _options: { limit: number; minScore?: number; filter?: Record<string, unknown> }
  ): Promise<VectorSearchResult[]> {
    logWarn(
      "CompanionVectorClient: searchByVector is not implemented in Phase 0; " +
        "use search(query, ...) instead."
    );
    return [];
  }

  /** Internal: POST to /vaults/:id/search and parse the JSON array. */
  private async postSearch(body: {
    query: string;
    limit: number;
    minScore?: number;
    filter?: Record<string, unknown>;
  }): Promise<VectorSearchResult[]> {
    const vaultId = encodeURIComponent(this.config.vaultId || "default");
    try {
      const res = await safeFetch(`${this.baseUrl()}/vaults/${vaultId}/search`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        throwOnHttpError: false,
      });
      if (!res.ok) {
        logWarn(`CompanionVectorClient: search HTTP ${res.status}`);
        return [];
      }
      const data = (await res.json()) as VectorSearchResult[];
      if (!Array.isArray(data)) {
        logWarn("CompanionVectorClient: search returned non-array payload");
        return [];
      }
      logInfo(`CompanionVectorClient: ${data.length} hits for "${body.query.slice(0, 64)}"`);
      return data;
    } catch (err) {
      logError("CompanionVectorClient: search failed", err);
      return [];
    }
  }
}
