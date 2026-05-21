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
  /** Spike build identifier; bumped when the wire format changes. */
  version: string;
  /** Dimension of the embedding vectors stored in the index. */
  embeddingDimension: number;
  /** Total rows in the seeded index, across all vaults. */
  indexedChunks: number;
}
