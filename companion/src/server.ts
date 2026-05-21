/**
 * Phase 0 HTTP server: /health and /vaults/:id/search on 127.0.0.1.
 *
 * Uses node:http directly to avoid pulling express into the spike. All
 * responses are JSON. Optional bearer-token auth.
 */
import * as http from "node:http";

import { loadConfig, type CompanionConfig } from "./config.js";
import { embed } from "./index/embedder.js";
import { VectorStore } from "./index/store.js";
import type { HealthResponse, SearchRequest, VectorSearchResult } from "./protocol/types.js";

const SPIKE_VERSION = "0.0.1-phase0";
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

function toSearchResult(
  hit: ReturnType<VectorStore["search"]>[number]
): VectorSearchResult {
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

function buildServer(cfg: CompanionConfig, store: VectorStore): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", `http://${cfg.host}:${cfg.port}`);

      if (method === "GET" && url.pathname === "/health") {
        // Health is intentionally unauthenticated so the plugin can probe it
        // before the user has entered their token.
        const body: HealthResponse = {
          status: "ok",
          version: SPIKE_VERSION,
          embeddingDimension: cfg.dim,
          indexedChunks: store.count(),
        };
        sendJson(res, 200, body);
        return;
      }

      if (!authorize(req, cfg)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      if (method === "POST") {
        const vaultId = parseVaultId(url.pathname);
        if (vaultId) {
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
          const limit = Math.max(
            1,
            Math.min(MAX_LIMIT, Math.floor(body.limit ?? DEFAULT_LIMIT))
          );
          const minScore = typeof body.minScore === "number" ? body.minScore : 0;
          const queryVec = embed(body.query, cfg.dim);
          const hits = store
            .search(vaultId, queryVec, limit)
            .filter((h) => h.score >= minScore)
            .map(toSearchResult);
          sendJson(res, 200, hits);
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
  const store = new VectorStore(cfg.dbPath, cfg.dim);
  const server = buildServer(cfg, store);

  server.listen(cfg.port, cfg.host, () => {
    // eslint-disable-next-line no-console
    console.log(
      `companion: listening on http://${cfg.host}:${cfg.port} ` +
        `(dim=${cfg.dim}, chunks=${store.count()}, auth=${cfg.token ? "on" : "off"})`
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
