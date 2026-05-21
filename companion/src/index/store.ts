/**
 * sqlite-vec backed vector store for companion Phase 1.
 */

import { createHash } from "node:crypto";

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

export interface VaultRecord {
  vaultId: string;
  rootPath: string;
  inclusions: string[];
  exclusions: string[];
  embeddingModel: string;
  embeddingDimension: number | null;
  vecTable: string;
  updatedAt: number;
  lastScanAt: number | null;
}

export interface VaultStats {
  indexedFiles: number;
  indexedChunks: number;
  latestFileMtime: number;
  embeddingModel: string;
  dimension: number | null;
  lastScanAt: number | null;
}

export interface SearchHit extends ChunkRow {
  /** Cosine similarity in [0, 1]. */
  score: number;
}

interface RegisterVaultInput {
  vaultId: string;
  rootPath: string;
  inclusions: string[];
  exclusions: string[];
  embeddingModel: string;
}

/**
 * sqlite-vec persistence layer.
 */
export class VectorStore {
  private readonly db: DB;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    sqliteVec.load(this.db);
    this.initialize();
  }

  /**
   * Create base metadata tables.
   */
  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vaults (
        vault_id            TEXT PRIMARY KEY,
        root_path           TEXT NOT NULL,
        inclusions_json     TEXT NOT NULL,
        exclusions_json     TEXT NOT NULL,
        embedding_model     TEXT NOT NULL,
        embedding_dimension INTEGER,
        vec_table           TEXT NOT NULL,
        updated_at          INTEGER NOT NULL,
        last_scan_at        INTEGER
      );

      CREATE TABLE IF NOT EXISTS chunks (
        rowid        INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id     TEXT NOT NULL,
        vault_id     TEXT NOT NULL,
        path         TEXT NOT NULL,
        chunk_index  INTEGER NOT NULL,
        content      TEXT NOT NULL,
        title        TEXT,
        mtime        INTEGER,
        UNIQUE(vault_id, chunk_id)
      );

      CREATE INDEX IF NOT EXISTS chunks_by_vault      ON chunks(vault_id);
      CREATE INDEX IF NOT EXISTS chunks_by_vault_path ON chunks(vault_id, path);
    `);
  }

  /**
   * Register (or update) vault metadata.
   */
  registerVault(input: RegisterVaultInput): VaultRecord {
    const existing = this.getVault(input.vaultId);
    const now = Date.now();

    if (existing) {
      this.db
        .prepare(
          `UPDATE vaults
              SET root_path = ?,
                  inclusions_json = ?,
                  exclusions_json = ?,
                  embedding_model = ?,
                  updated_at = ?
            WHERE vault_id = ?`
        )
        .run(
          input.rootPath,
          JSON.stringify(input.inclusions),
          JSON.stringify(input.exclusions),
          input.embeddingModel,
          now,
          input.vaultId
        );
      const updated = this.getVault(input.vaultId);
      if (!updated) {
        throw new Error(`failed to read updated vault ${input.vaultId}`);
      }
      return updated;
    }

    const vecTable = `vec_chunks_${hashId(input.vaultId)}`;
    this.db
      .prepare(
        `INSERT INTO vaults
          (vault_id, root_path, inclusions_json, exclusions_json, embedding_model,
           embedding_dimension, vec_table, updated_at, last_scan_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL)`
      )
      .run(
        input.vaultId,
        input.rootPath,
        JSON.stringify(input.inclusions),
        JSON.stringify(input.exclusions),
        input.embeddingModel,
        vecTable,
        now
      );

    const created = this.getVault(input.vaultId);
    if (!created) {
      throw new Error(`failed to read created vault ${input.vaultId}`);
    }
    return created;
  }

  /**
   * Return vault metadata, or null when missing.
   */
  getVault(vaultId: string): VaultRecord | null {
    const row = this.db
      .prepare(
        `SELECT vault_id,
                root_path,
                inclusions_json,
                exclusions_json,
                embedding_model,
                embedding_dimension,
                vec_table,
                updated_at,
                last_scan_at
           FROM vaults
          WHERE vault_id = ?`
      )
      .get(vaultId) as
      | {
          vault_id: string;
          root_path: string;
          inclusions_json: string;
          exclusions_json: string;
          embedding_model: string;
          embedding_dimension: number | null;
          vec_table: string;
          updated_at: number;
          last_scan_at: number | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      vaultId: row.vault_id,
      rootPath: row.root_path,
      inclusions: parsePatternJson(row.inclusions_json),
      exclusions: parsePatternJson(row.exclusions_json),
      embeddingModel: row.embedding_model,
      embeddingDimension: row.embedding_dimension,
      vecTable: row.vec_table,
      updatedAt: row.updated_at,
      lastScanAt: row.last_scan_at,
    };
  }

  /**
   * Ensure the vault model/dimension is compatible with current scan.
   */
  ensureVaultEmbeddingCompatibility(
    vaultId: string,
    modelId: string,
    dimension: number,
    force: boolean
  ): void {
    const vault = this.getVault(vaultId);
    if (!vault) {
      throw new Error(`vault ${vaultId} is not registered`);
    }

    const modelChanged = vault.embeddingModel !== modelId;
    const dimChanged = vault.embeddingDimension !== null && vault.embeddingDimension !== dimension;
    if ((modelChanged || dimChanged) && !force) {
      throw new Error(
        `embedding model mismatch for ${vaultId}: existing=${vault.embeddingModel}/${vault.embeddingDimension}, new=${modelId}/${dimension}`
      );
    }

    // First scan or forced migration: set (or update) metadata and vec table dimension.
    if (vault.embeddingDimension === null || modelChanged || dimChanged) {
      this.recreateVecTable(vault.vecTable, dimension);
      if (modelChanged || dimChanged) {
        this.clearVaultIndex(vaultId);
      }
      this.db
        .prepare(
          `UPDATE vaults
              SET embedding_model = ?, embedding_dimension = ?, updated_at = ?
            WHERE vault_id = ?`
        )
        .run(modelId, dimension, Date.now(), vaultId);
    }
  }

  /**
   * Insert or replace a chunk row and corresponding vector.
   */
  upsert(row: ChunkRow, embedding: Float32Array): void {
    const vault = this.getVault(row.vaultId);
    if (!vault || !vault.embeddingDimension) {
      throw new Error(`vault ${row.vaultId} has no embedding dimension; register + scan first`);
    }
    if (embedding.length !== vault.embeddingDimension) {
      throw new Error(`embedding dim ${embedding.length} != vault dim ${vault.embeddingDimension}`);
    }

    const vectorTable = assertSafeIdentifier(vault.vecTable);
    const blob = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);

    const tx = this.db.transaction((chunk: ChunkRow, vectorBlob: Buffer) => {
      const existing = this.db
        .prepare(`SELECT rowid FROM chunks WHERE vault_id = ? AND chunk_id = ?`)
        .get(chunk.vaultId, chunk.id) as { rowid: number | bigint } | undefined;

      let rowid: bigint;
      if (existing) {
        rowid = BigInt(existing.rowid);
        this.db
          .prepare(
            `UPDATE chunks
                SET path = ?, chunk_index = ?, content = ?, title = ?, mtime = ?
              WHERE rowid = ?`
          )
          .run(chunk.path, chunk.chunkIndex, chunk.content, chunk.title, chunk.mtime, rowid);
        this.db.prepare(`DELETE FROM ${vectorTable} WHERE rowid = ?`).run(rowid);
      } else {
        const info = this.db
          .prepare(
            `INSERT INTO chunks (chunk_id, vault_id, path, chunk_index, content, title, mtime)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            chunk.id,
            chunk.vaultId,
            chunk.path,
            chunk.chunkIndex,
            chunk.content,
            chunk.title,
            chunk.mtime
          );
        rowid = BigInt(info.lastInsertRowid);
      }

      this.db
        .prepare(`INSERT INTO ${vectorTable}(rowid, embedding) VALUES (?, ?)`)
        .run(rowid, vectorBlob);
    });

    tx(row, blob);
  }

  /**
   * Remove all chunks for one vault/path.
   */
  removeByPath(vaultId: string, relativePath: string): void {
    const vault = this.getVault(vaultId);
    if (!vault) {
      return;
    }
    const vectorTable = assertSafeIdentifier(vault.vecTable);
    const rowids = this.db
      .prepare(`SELECT rowid FROM chunks WHERE vault_id = ? AND path = ?`)
      .all(vaultId, relativePath) as Array<{ rowid: number | bigint }>;

    const tx = this.db.transaction(() => {
      for (const row of rowids) {
        this.db.prepare(`DELETE FROM ${vectorTable} WHERE rowid = ?`).run(BigInt(row.rowid));
      }
      this.db
        .prepare(`DELETE FROM chunks WHERE vault_id = ? AND path = ?`)
        .run(vaultId, relativePath);
    });

    tx();
  }

  /**
   * KNN search inside one vault.
   */
  search(vaultId: string, queryVec: Float32Array, limit: number): SearchHit[] {
    const vault = this.getVault(vaultId);
    if (!vault || !vault.embeddingDimension) {
      return [];
    }
    if (queryVec.length !== vault.embeddingDimension) {
      throw new Error(`query dim ${queryVec.length} != vault dim ${vault.embeddingDimension}`);
    }

    const vectorTable = assertSafeIdentifier(vault.vecTable);
    const rows = this.db
      .prepare(
        `SELECT c.chunk_id    AS id,
                c.vault_id    AS vaultId,
                c.path        AS path,
                c.chunk_index AS chunkIndex,
                c.content     AS content,
                c.title       AS title,
                c.mtime       AS mtime,
                v.distance    AS distance
           FROM ${vectorTable} v
           JOIN chunks c ON c.rowid = v.rowid
          WHERE c.vault_id = ?
            AND v.embedding MATCH ?
            AND k = ?
          ORDER BY v.distance ASC
          LIMIT ?`
      )
      .all(
        vaultId,
        Buffer.from(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength),
        limit,
        limit
      ) as Array<ChunkRow & { distance: number }>;

    return rows.map((row) => {
      const cosine = 1 - (row.distance * row.distance) / 2;
      const score = Math.max(0, Math.min(1, cosine));
      return {
        id: row.id,
        vaultId: row.vaultId,
        path: row.path,
        chunkIndex: row.chunkIndex,
        content: row.content,
        title: row.title,
        mtime: row.mtime,
        score,
      };
    });
  }

  /**
   * Delete all chunks/vectors for one vault.
   */
  clearVaultIndex(vaultId: string): void {
    const vault = this.getVault(vaultId);
    if (!vault) {
      return;
    }

    const vectorTable = assertSafeIdentifier(vault.vecTable);
    const rowids = this.db
      .prepare(`SELECT rowid FROM chunks WHERE vault_id = ?`)
      .all(vaultId) as Array<{ rowid: number | bigint }>;

    const tx = this.db.transaction(() => {
      for (const row of rowids) {
        this.db.prepare(`DELETE FROM ${vectorTable} WHERE rowid = ?`).run(BigInt(row.rowid));
      }
      this.db.prepare(`DELETE FROM chunks WHERE vault_id = ?`).run(vaultId);
    });

    tx();
  }

  /**
   * Return all indexed relative paths for a vault.
   */
  getIndexedFiles(vaultId: string): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT path FROM chunks WHERE vault_id = ? ORDER BY path ASC`)
      .all(vaultId) as Array<{ path: string }>;
    return rows.map((row) => row.path);
  }

  /**
   * Return indexed mtime for a single file path.
   */
  getFileMtime(vaultId: string, relativePath: string): number | null {
    const row = this.db
      .prepare(`SELECT MAX(mtime) AS mtime FROM chunks WHERE vault_id = ? AND path = ?`)
      .get(vaultId, relativePath) as { mtime: number | null };
    return row?.mtime ?? null;
  }

  /**
   * Return latest indexed mtime for one vault.
   */
  getLatestFileMtime(vaultId: string): number {
    const row = this.db
      .prepare(`SELECT MAX(mtime) AS mtime FROM chunks WHERE vault_id = ?`)
      .get(vaultId) as { mtime: number | null };
    return row?.mtime ?? 0;
  }

  /**
   * Return stats for one vault.
   */
  getVaultStats(vaultId: string): VaultStats {
    const vault = this.getVault(vaultId);
    if (!vault) {
      return {
        indexedFiles: 0,
        indexedChunks: 0,
        latestFileMtime: 0,
        embeddingModel: "",
        dimension: null,
        lastScanAt: null,
      };
    }

    const countRow = this.db
      .prepare(
        `SELECT COUNT(*) AS indexedChunks,
                COUNT(DISTINCT path) AS indexedFiles,
                MAX(mtime) AS latestFileMtime
           FROM chunks
          WHERE vault_id = ?`
      )
      .get(vaultId) as {
      indexedChunks: number;
      indexedFiles: number;
      latestFileMtime: number | null;
    };

    return {
      indexedFiles: countRow.indexedFiles,
      indexedChunks: countRow.indexedChunks,
      latestFileMtime: countRow.latestFileMtime ?? 0,
      embeddingModel: vault.embeddingModel,
      dimension: vault.embeddingDimension,
      lastScanAt: vault.lastScanAt,
    };
  }

  /**
   * Update the last scan timestamp for a vault.
   */
  touchVaultScan(vaultId: string): void {
    this.db
      .prepare(`UPDATE vaults SET last_scan_at = ?, updated_at = ? WHERE vault_id = ?`)
      .run(Date.now(), Date.now(), vaultId);
  }

  /**
   * Force-reset embedding metadata for one vault and clear indexed vectors.
   */
  resetVaultEmbeddings(vaultId: string, embeddingModel: string): void {
    this.clearVaultIndex(vaultId);
    this.db
      .prepare(
        `UPDATE vaults
            SET embedding_model = ?, embedding_dimension = NULL, updated_at = ?
          WHERE vault_id = ?`
      )
      .run(embeddingModel, Date.now(), vaultId);
  }

  /** Number of stored chunks across all vaults. */
  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }

  /**
   * Drop/recreate a vault vector table with the given dimension.
   */
  private recreateVecTable(vecTable: string, dimension: number): void {
    const safeTable = assertSafeIdentifier(vecTable);
    this.db.exec(`DROP TABLE IF EXISTS ${safeTable};`);
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${safeTable} USING vec0(embedding float[${dimension}]);`
    );
  }
}

/**
 * Parse stored pattern list JSON robustly.
 */
function parsePatternJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

/**
 * Hash stable id strings for table-name suffixes.
 */
function hashId(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

/**
 * Restrict dynamic SQL identifiers to safe ASCII subset.
 */
function assertSafeIdentifier(identifier: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(identifier)) {
    throw new Error(`unsafe SQL identifier: ${identifier}`);
  }
  return identifier;
}
