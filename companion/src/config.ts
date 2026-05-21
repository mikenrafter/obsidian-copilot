/**
 * Resolved companion runtime configuration. Centralized so server.ts and
 * seed.ts agree on dimension and DB location.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface CompanionConfig {
  host: string;
  port: number;
  token: string;
  dbPath: string;
  /** Embedding dimension. Must match the seeded index. */
  dim: number;
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
  const dim = Number.parseInt(process.env.COMPANION_DIM ?? "128", 10);
  if (!Number.isFinite(dim) || dim < 8 || dim > 4096) {
    throw new Error(`Invalid COMPANION_DIM: ${process.env.COMPANION_DIM}`);
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return { host, port, token, dbPath, dim };
}
