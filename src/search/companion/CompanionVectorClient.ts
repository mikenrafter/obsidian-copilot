import { logError, logInfo, logWarn } from "@/logger";
import { VectorSearchBackend, VectorSearchResult } from "@/search/selfHostRetriever";
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
  embeddingDimension: number | null;
  indexedChunks: number;
}

/** Registration payload for companion vault registration endpoint. */
export interface CompanionRegisterPayload {
  vaultId: string;
  rootPath: string;
  inclusions?: string[];
  exclusions?: string[];
  embeddingModel: string;
  force?: boolean;
}

/** Response payload for companion scan status endpoint. */
export interface CompanionScanStatus {
  jobId: string;
  vaultId: string;
  state: "queued" | "running" | "done" | "error";
  indexed: number;
  total: number;
  errors: string[];
  startedAt: number;
  updatedAt: number;
}

/** Response payload for companion stats endpoint. */
export interface CompanionStats {
  indexedFiles: number;
  indexedChunks: number;
  latestFileMtime: number;
  embeddingModel: string;
  dimension: number | null;
  lastScanAt: number | null;
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

  /**
   * Register or update vault settings on the companion.
   */
  async registerVault(payload: CompanionRegisterPayload): Promise<boolean> {
    const response = await this.request<{ ok?: boolean }>(`/vaults/register`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return Boolean(response?.ok);
  }

  /**
   * Trigger an asynchronous scan and return the job id.
   */
  async startScan(full: boolean): Promise<string | null> {
    const vaultId = encodeURIComponent(this.config.vaultId || "default");
    const response = await this.request<{ jobId?: string }>(`/vaults/${vaultId}/scan`, {
      method: "POST",
      body: JSON.stringify({ full }),
    });
    return typeof response?.jobId === "string" ? response.jobId : null;
  }

  /**
   * Fetch progress for an existing scan job.
   */
  async getScanStatus(jobId: string): Promise<CompanionScanStatus | null> {
    const vaultId = encodeURIComponent(this.config.vaultId || "default");
    return this.request<CompanionScanStatus>(
      `/vaults/${vaultId}/scan/${encodeURIComponent(jobId)}`,
      {
        method: "GET",
      }
    );
  }

  /**
   * Clear all indexed vectors for the configured vault.
   */
  async clearVaultIndex(): Promise<boolean> {
    const vaultId = encodeURIComponent(this.config.vaultId || "default");
    const response = await this.request<{ ok?: boolean }>(`/vaults/${vaultId}/index`, {
      method: "DELETE",
    });
    return Boolean(response?.ok);
  }

  /**
   * Return aggregate index stats for the configured vault.
   */
  async getStats(): Promise<CompanionStats | null> {
    const vaultId = encodeURIComponent(this.config.vaultId || "default");
    return this.request<CompanionStats>(`/vaults/${vaultId}/stats`, {
      method: "GET",
    });
  }

  /**
   * Return all indexed file paths for the configured vault.
   */
  async getIndexedFiles(): Promise<string[]> {
    const vaultId = encodeURIComponent(this.config.vaultId || "default");
    const response = await this.request<{ files?: string[] }>(`/vaults/${vaultId}/indexed-files`, {
      method: "GET",
    });
    return Array.isArray(response?.files) ? response.files : [];
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
      const data = await this.request<VectorSearchResult[]>(`/vaults/${vaultId}/search`, {
        method: "POST",
        body: JSON.stringify(body),
      });
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

  /**
   * Generic JSON request helper for companion endpoints.
   */
  private async request<T>(
    path: string,
    options: { method: "GET" | "POST" | "DELETE"; body?: string }
  ): Promise<T | null> {
    try {
      const response = await safeFetch(`${this.baseUrl()}${path}`, {
        method: options.method,
        headers: this.headers(),
        body: options.body,
        throwOnHttpError: false,
      });
      if (!response.ok) {
        logWarn(`CompanionVectorClient: ${options.method} ${path} HTTP ${response.status}`);
        return null;
      }
      return (await response.json()) as T;
    } catch (error) {
      logWarn(`CompanionVectorClient: ${options.method} ${path} failed`, error);
      return null;
    }
  }
}
