/**
 * sqlite-vec backed vector store for the Phase 0 spike.
 *
 * Schema (one DB, multi-vault via the `vault_id` column on chunks):
 *
 *   chunks         — row per indexed chunk, with vault_id, path, chunk_index,
 *                    content, mtime, title
 *   vec_chunks     — virtual table (vec0) keyed by chunks.rowid, holding the
 *                    fixed-dim float vector
 *
 * The virtual table's primary key is the integer `rowid`, which we tie to
 * `chunks.id` so a single `vec_chunks MATCH ?` returns `chunks` rows directly
 * via join. See sqlite-vec docs for the `vec0` virtual table contract.
 */

import Database, { type Database as DB } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

export interface ChunkRow {
  id: string;
  vaultId: string;
  path: string;
  chunkIndex: number;
  content: string;
  title: string | null;
  mtime: number | null;
}

export interface SearchHit extends ChunkRow {
  /** Cosine similarity in [0, 1]. */
  score: number;
}

export class VectorStore {
  private readonly db: DB;
  private readonly dim: number;

  constructor(dbPath: string, dim: number) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    sqliteVec.load(this.db);
    this.dim = dim;
    this.initialize();
  }

  /**
   * Create tables if they do not exist. Idempotent. Throws if a pre-existing
   * `vec_chunks` table has a different dimension than `dim`.
   */
  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        rowid        INTEGER PRIMARY KEY AUTOINCREMENT,
        id           TEXT UNIQUE NOT NULL,
        vault_id     TEXT NOT NULL,
        path         TEXT NOT NULL,
        chunk_index  INTEGER NOT NULL,
        content      TEXT NOT NULL,
        title        TEXT,
        mtime        INTEGER
      );
      CREATE INDEX IF NOT EXISTS chunks_by_vault ON chunks(vault_id);
      CREATE INDEX IF NOT EXISTS chunks_by_path  ON chunks(vault_id, path);
    `);
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[${this.dim}]);`
    );
  }

  /**
   * Insert (or replace) a chunk and its embedding atomically. `embedding`
   * must have exactly `dim` elements.
   */
  upsert(row: ChunkRow, embedding: Float32Array): void {
    if (embedding.length !== this.dim) {
      throw new Error(`embedding dim ${embedding.length} != store dim ${this.dim}`);
    }
    const blob = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    const tx = this.db.transaction((r: ChunkRow, e: Buffer) => {
      // Try update first; if the id exists, reuse its rowid so the embedding
      // table stays aligned. Otherwise insert and use the new rowid.
      const existing = this.db
        .prepare(`SELECT rowid FROM chunks WHERE id = ?`)
        .get(r.id) as { rowid: number | bigint } | undefined;
      let rowid: bigint;
      if (existing) {
        rowid = BigInt(existing.rowid);
        this.db
          .prepare(
            `UPDATE chunks SET vault_id = ?, path = ?, chunk_index = ?,
                                content = ?, title = ?, mtime = ?
              WHERE rowid = ?`
          )
          .run(r.vaultId, r.path, r.chunkIndex, r.content, r.title, r.mtime, rowid);
        this.db.prepare(`DELETE FROM vec_chunks WHERE rowid = ?`).run(rowid);
      } else {
        const info = this.db
          .prepare(
            `INSERT INTO chunks (id, vault_id, path, chunk_index, content, title, mtime)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(r.id, r.vaultId, r.path, r.chunkIndex, r.content, r.title, r.mtime);
        rowid = BigInt(info.lastInsertRowid);
      }
      this.db
        .prepare(`INSERT INTO vec_chunks(rowid, embedding) VALUES (?, ?)`)
        .run(rowid, e);
    });
    tx(row, blob);
  }

  /**
   * KNN search within a single vault. Returns up to `limit` hits with
   * cosine-similarity scores in [0, 1].
   *
   * Notes for reviewers:
   *  - sqlite-vec's `distance` column is L2 by default. Our embedder produces
   *    L2-normed vectors, so cosine_sim ≈ 1 - d^2/2. We compute it explicitly.
   *  - We over-fetch `limit` candidates from vec_chunks and filter by vault
   *    afterward, because vec0 virtual tables can't be filtered by a non-vec
   *    column inside MATCH. Phase 1 should consider per-vault vec tables if
   *    this becomes a hot path.
   */
  search(vaultId: string, queryVec: Float32Array, limit: number): SearchHit[] {
    if (queryVec.length !== this.dim) {
      throw new Error(`query dim ${queryVec.length} != store dim ${this.dim}`);
    }
    // Over-fetch to compensate for post-filtering by vault_id.
    const candidateLimit = Math.max(limit * 4, limit);
    const rows = this.db
      .prepare(
        `SELECT c.id          AS id,
                c.vault_id    AS vaultId,
                c.path        AS path,
                c.chunk_index AS chunkIndex,
                c.content     AS content,
                c.title       AS title,
                c.mtime       AS mtime,
                v.distance    AS distance
           FROM vec_chunks v
           JOIN chunks      c ON c.rowid = v.rowid
          WHERE v.embedding MATCH ?
            AND c.vault_id = ?
            AND k = ?
          ORDER BY v.distance ASC
          LIMIT ?`
      )
      .all(
        Buffer.from(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength),
        vaultId,
        candidateLimit,
        limit
      ) as Array<ChunkRow & { distance: number }>;

    return rows.map((r) => {
      // L2 distance between two unit vectors ∈ [0, 2]; cosine = 1 - d^2/2.
      const cosine = 1 - (r.distance * r.distance) / 2;
      const score = Math.max(0, Math.min(1, cosine));
      const { distance, ...rest } = r;
      void distance;
      return { ...rest, score };
    });
  }

  /** Number of stored chunks across all vaults. */
  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
