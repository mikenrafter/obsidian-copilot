/**
 * Wire-format types shared between the companion service and the Copilot
 * plugin. Keep this file dependency-free so the plugin can copy it verbatim
 * (or, in Phase 3, import it through a shared workspace).
 *
 * Reference: `VectorSearchResult` in `src/search/selfHostRetriever.ts` of the
 * plugin. The shapes here must stay structurally compatible with it.
 */

/** A single search hit returned by the companion. */
export interface VectorSearchResult {
  /** Stable chunk id, e.g. `note.md#0` (0-based, non-padded). */
  id: string;
  /** Similarity in [0, 1]; higher is better. */
  score: number;
  /** Chunk text. */
  content: string;
  metadata: {
    path: string;
    title?: string;
    tags?: string[];
    mtime?: number;
    ctime?: number;
    chunkIndex?: number;
    [key: string]: unknown;
  };
}

/** Body of `POST /vaults/:id/search`. */
export interface SearchRequest {
  query: string;
  limit?: number;
  minScore?: number;
  /** Reserved for Phase 1; currently ignored. */
  filter?: Record<string, unknown>;
}

/** Body of `GET /health`. */
export interface HealthResponse {
  status: "ok";
  /** Companion build identifier; bumped when the wire format changes. */
  version: string;
  /** Default companion embedding dimension when known; null before first scan. */
  embeddingDimension: number | null;
  /** Total indexed chunks across all registered vaults. */
  indexedChunks: number;
}

/** Body of `POST /vaults/register`. */
export interface RegisterVaultRequest {
  vaultId: string;
  rootPath: string;
  inclusions?: string[];
  exclusions?: string[];
  embeddingModel: string;
  /** Force model migration by clearing existing vectors if model changed. */
  force?: boolean;
}

/** Body of `POST /vaults/:id/scan`. */
export interface ScanRequest {
  full?: boolean;
}

/** Response payload of `POST /vaults/:id/scan`. */
export interface ScanStartResponse {
  jobId: string;
}

/** Response payload of `GET /vaults/:id/scan/:jobId`. */
export interface ScanStatusResponse {
  jobId: string;
  vaultId: string;
  state: "queued" | "running" | "done" | "error";
  indexed: number;
  total: number;
  errors: string[];
  startedAt: number;
  updatedAt: number;
}

/** Response payload of `GET /vaults/:id/stats`. */
export interface VaultStatsResponse {
  indexedFiles: number;
  indexedChunks: number;
  latestFileMtime: number;
  embeddingModel: string;
  dimension: number | null;
  lastScanAt: number | null;
}

/** Response payload of `GET /vaults/:id/indexed-files`. */
export interface IndexedFilesResponse {
  files: string[];
}
