/**
 * Phase 1 HTTP server for companion health, vault registration, scan jobs,
 * stats, index management, and vector search.
 *
 * Uses node:http directly to avoid pulling express into the spike. All
 * responses are JSON. Optional bearer-token auth.
 */
import * as http from "node:http";

import { loadConfig, type CompanionConfig } from "./config.js";
import { embedQuery } from "./index/embedder.js";
import { VectorStore } from "./index/store.js";
import type {
  HealthResponse,
  IndexedFilesResponse,
  RegisterVaultRequest,
  ScanRequest,
  ScanStartResponse,
  ScanStatusResponse,
  SearchRequest,
  VectorSearchResult,
  VaultStatsResponse,
} from "./protocol/types.js";
import { VaultScanner, validateVaultRootPath } from "./vault/scanner.js";

const COMPANION_VERSION = "0.1.0-phase1";
const MAX_BODY_BYTES = 64 * 1024; // 64 KiB; queries are tiny in the spike.
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Authorize a request when COMPANION_TOKEN is configured; otherwise pass. */
function authorize(req: http.IncomingMessage, cfg: CompanionConfig): boolean {
  if (!cfg.token) return true;
  const header = req.headers["authorization"];
  if (typeof header !== "string") return false;
  const expected = `Bearer ${cfg.token}`;
  // Constant-time comparison is overkill for loopback, but cheap.
  if (header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < header.length; i++) {
    diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Read at most MAX_BODY_BYTES of the request body into a UTF-8 string and
 * parse as JSON. Resolves with `null` if the body is empty.
 */
async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    req.on("error", reject);
  });
}

function toSearchResult(hit: ReturnType<VectorStore["search"]>[number]): VectorSearchResult {
  return {
    id: hit.id,
    score: hit.score,
    content: hit.content,
    metadata: {
      path: hit.path,
      title: hit.title ?? undefined,
      chunkIndex: hit.chunkIndex,
      mtime: hit.mtime ?? undefined,
    },
  };
}

function parseVaultId(pathname: string): string | null {
  // Matches /vaults/:id/search; :id may contain url-safe chars.
  const match = pathname.match(/^\/vaults\/([^/]+)\/search\/?$/);
  return match ? decodeURIComponent(match[1]!) : null;
}

/**
 * Parse /vaults/:id/index path.
 */
function parseVaultIndexPath(pathname: string): string | null {
  const match = pathname.match(/^\/vaults\/([^/]+)\/index\/?$/);
  return match ? decodeURIComponent(match[1]!) : null;
}

/**
 * Parse /vaults/:id/stats path.
 */
function parseVaultStatsPath(pathname: string): string | null {
  const match = pathname.match(/^\/vaults\/([^/]+)\/stats\/?$/);
  return match ? decodeURIComponent(match[1]!) : null;
}

/**
 * Parse /vaults/:id/indexed-files path.
 */
function parseVaultIndexedFilesPath(pathname: string): string | null {
  const match = pathname.match(/^\/vaults\/([^/]+)\/indexed-files\/?$/);
  return match ? decodeURIComponent(match[1]!) : null;
}

/**
 * Parse /vaults/:id/scan path.
 */
function parseVaultScanPath(pathname: string): string | null {
  const match = pathname.match(/^\/vaults\/([^/]+)\/scan\/?$/);
  return match ? decodeURIComponent(match[1]!) : null;
}

/**
 * Parse /vaults/:id/scan/:jobId path.
 */
function parseVaultScanStatusPath(pathname: string): { vaultId: string; jobId: string } | null {
  const match = pathname.match(/^\/vaults\/([^/]+)\/scan\/([^/]+)\/?$/);
  if (!match) {
    return null;
  }
  return {
    vaultId: decodeURIComponent(match[1]!),
    jobId: decodeURIComponent(match[2]!),
  };
}

/**
 * Normalize model ids so stored vault metadata always includes provider prefix.
 */
function normalizeEmbeddingModelId(rawModel: string, cfg: CompanionConfig): string {
  const trimmed = rawModel.trim();
  if (trimmed.startsWith("openai:") || trimmed.startsWith("ollama:")) {
    return trimmed;
  }
  return `${cfg.defaultEmbeddingProvider}:${trimmed}`;
}

function buildServer(cfg: CompanionConfig, store: VectorStore): http.Server {
  const scanner = new VaultScanner(store, cfg);

  return http.createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", `http://${cfg.host}:${cfg.port}`);

      if (method === "GET" && url.pathname === "/health") {
        // Health is intentionally unauthenticated so the plugin can probe it
        // before the user has entered their token.
        const body: HealthResponse = {
          status: "ok",
          version: COMPANION_VERSION,
          embeddingDimension: null,
          indexedChunks: store.count(),
        };
        sendJson(res, 200, body);
        return;
      }

      if (!authorize(req, cfg)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      if (method === "POST" && url.pathname === "/vaults/register") {
        let body: RegisterVaultRequest;
        try {
          body = (await readJsonBody(req)) as RegisterVaultRequest;
        } catch (e) {
          sendJson(res, 400, { error: `invalid body: ${(e as Error).message}` });
          return;
        }

        if (!body || typeof body.vaultId !== "string" || body.vaultId.trim().length === 0) {
          sendJson(res, 400, { error: "vaultId is required" });
          return;
        }
        if (!body.rootPath || typeof body.rootPath !== "string") {
          sendJson(res, 400, { error: "rootPath is required" });
          return;
        }

        const embeddingModel = normalizeEmbeddingModelId(
          typeof body.embeddingModel === "string" && body.embeddingModel.trim().length > 0
            ? body.embeddingModel
            : cfg.defaultEmbeddingModel,
          cfg
        );

        try {
          await validateVaultRootPath(body.rootPath);
        } catch (error) {
          sendJson(res, 400, { error: (error as Error).message });
          return;
        }

        const existing = store.getVault(body.vaultId);
        if (
          existing &&
          existing.embeddingModel !== embeddingModel &&
          existing.embeddingDimension !== null &&
          !body.force
        ) {
          sendJson(res, 409, {
            error: "embedding model mismatch; resend register with force=true to clear and rebuild",
            currentModel: existing.embeddingModel,
            requestedModel: embeddingModel,
          });
          return;
        }

        store.registerVault({
          vaultId: body.vaultId,
          rootPath: body.rootPath,
          inclusions: Array.isArray(body.inclusions) ? body.inclusions : [],
          exclusions: Array.isArray(body.exclusions) ? body.exclusions : [],
          embeddingModel,
        });

        if (existing && existing.embeddingModel !== embeddingModel && body.force) {
          store.resetVaultEmbeddings(body.vaultId, embeddingModel);
        }

        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST") {
        const vaultId = parseVaultId(url.pathname);
        if (vaultId) {
          const vault = store.getVault(vaultId);
          if (!vault) {
            sendJson(res, 404, { error: `vault ${vaultId} is not registered` });
            return;
          }

          let body: SearchRequest;
          try {
            body = (await readJsonBody(req)) as SearchRequest;
          } catch (e) {
            sendJson(res, 400, { error: `invalid body: ${(e as Error).message}` });
            return;
          }
          if (!body || typeof body.query !== "string" || body.query.trim().length === 0) {
            sendJson(res, 400, { error: "`query` is required" });
            return;
          }
          const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(body.limit ?? DEFAULT_LIMIT)));
          const minScore = typeof body.minScore === "number" ? body.minScore : 0;
          const embedded = await embedQuery(body.query, vault.embeddingModel, cfg);
          if (
            vault.embeddingDimension !== null &&
            embedded.dimension !== vault.embeddingDimension
          ) {
            sendJson(res, 409, {
              error: "query embedding dimension mismatch; trigger a full scan to rebuild",
              expected: vault.embeddingDimension,
              actual: embedded.dimension,
            });
            return;
          }

          const hits = store
            .search(vaultId, embedded.vectors[0]!, limit)
            .filter((h) => h.score >= minScore)
            .map(toSearchResult);
          sendJson(res, 200, hits);
          return;
        }

        const scanVaultId = parseVaultScanPath(url.pathname);
        if (scanVaultId) {
          if (!store.getVault(scanVaultId)) {
            sendJson(res, 404, { error: `vault ${scanVaultId} is not registered` });
            return;
          }

          let body: ScanRequest | null = null;
          try {
            body = (await readJsonBody(req)) as ScanRequest | null;
          } catch (e) {
            sendJson(res, 400, { error: `invalid body: ${(e as Error).message}` });
            return;
          }
          const full = Boolean(body?.full);
          const response: ScanStartResponse = {
            jobId: scanner.startScan(scanVaultId, full),
          };
          sendJson(res, 200, response);
          return;
        }
      }

      if (method === "GET") {
        const statsVaultId = parseVaultStatsPath(url.pathname);
        if (statsVaultId) {
          if (!store.getVault(statsVaultId)) {
            sendJson(res, 404, { error: `vault ${statsVaultId} is not registered` });
            return;
          }
          const stats: VaultStatsResponse = store.getVaultStats(statsVaultId);
          sendJson(res, 200, stats);
          return;
        }

        const filesVaultId = parseVaultIndexedFilesPath(url.pathname);
        if (filesVaultId) {
          if (!store.getVault(filesVaultId)) {
            sendJson(res, 404, { error: `vault ${filesVaultId} is not registered` });
            return;
          }
          const files: IndexedFilesResponse = {
            files: store.getIndexedFiles(filesVaultId),
          };
          sendJson(res, 200, files);
          return;
        }

        const scanStatus = parseVaultScanStatusPath(url.pathname);
        if (scanStatus) {
          const status = scanner.getJobStatus(scanStatus.vaultId, scanStatus.jobId);
          if (!status) {
            sendJson(res, 404, { error: "scan job not found" });
            return;
          }
          const response: ScanStatusResponse = status;
          sendJson(res, 200, response);
          return;
        }
      }

      if (method === "DELETE") {
        const vaultId = parseVaultIndexPath(url.pathname);
        if (vaultId) {
          if (!store.getVault(vaultId)) {
            sendJson(res, 404, { error: `vault ${vaultId} is not registered` });
            return;
          }
          store.clearVaultIndex(vaultId);
          sendJson(res, 200, { ok: true });
          return;
        }
      }

      sendJson(res, 404, { error: `no route for ${method} ${url.pathname}` });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("companion: unhandled error", err);
      sendJson(res, 500, { error: "internal error" });
    }
  });
}

function main(): void {
  const cfg = loadConfig();
  const store = new VectorStore(cfg.dbPath);
  const server = buildServer(cfg, store);

  server.listen(cfg.port, cfg.host, () => {
    // eslint-disable-next-line no-console
    console.log(
      `companion: listening on http://${cfg.host}:${cfg.port} ` +
        `(provider=${cfg.defaultEmbeddingProvider}, chunks=${store.count()}, auth=${cfg.token ? "on" : "off"})`
    );
  });

  const shutdown = (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`companion: ${signal} received, shutting down`);
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
