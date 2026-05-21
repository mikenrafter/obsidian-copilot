# Localhost Vector Companion (Phase 1)

A localhost-only Node service that pull-indexes an Obsidian vault and serves
semantic vector search to the Copilot plugin. The plugin sends the vault root
path and search settings; the companion reads files from disk, chunks markdown,
calls the configured embedding provider, and stores vectors in `sqlite-vec`.

The companion binds to `127.0.0.1` by default. Keep it loopback-only unless you
are deliberately operating a private trusted network.

## Run

```bash
cd companion
npm install
npm run dev
```

For production-style startup after building:

```bash
cd companion
npm run build
npm run start
```

Health check:

```bash
curl -s http://127.0.0.1:7261/health
```

Register a vault and start a full scan:

```bash
curl -s -X POST http://127.0.0.1:7261/vaults/register \
  -H 'Content-Type: application/json' \
  -d '{"vaultId":"default","rootPath":"/absolute/path/to/vault","embeddingModel":"openai:text-embedding-3-small"}'

curl -s -X POST http://127.0.0.1:7261/vaults/default/scan \
  -H 'Content-Type: application/json' \
  -d '{"full":true}'
```

Poll the returned scan job:

```bash
curl -s http://127.0.0.1:7261/vaults/default/scan/<jobId>
```

Search after the scan completes:

```bash
curl -s -X POST http://127.0.0.1:7261/vaults/default/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"machine learning","limit":3}'
```

## Endpoints

| Method | Path                        | Purpose                                                                                     |
| ------ | --------------------------- | ------------------------------------------------------------------------------------------- |
| GET    | `/health`                   | Liveness and global chunk count.                                                            |
| POST   | `/vaults/register`          | Register or update `{ vaultId, rootPath, inclusions, exclusions, embeddingModel, force? }`. |
| POST   | `/vaults/:id/scan`          | Start an async scan; returns `{ jobId }`.                                                   |
| GET    | `/vaults/:id/scan/:jobId`   | Poll scan progress.                                                                         |
| GET    | `/vaults/:id/stats`         | Indexed file/chunk count, embedding model, dimension, last scan time.                       |
| GET    | `/vaults/:id/indexed-files` | List indexed vault-relative markdown paths.                                                 |
| DELETE | `/vaults/:id/index`         | Clear vectors for one vault.                                                                |
| POST   | `/vaults/:id/search`        | `{ query, limit, minScore?, filter? }` → `VectorSearchResult[]`.                            |

Response `VectorSearchResult` mirrors `src/search/selfHostRetriever.ts` in the
plugin:

```jsonc
{
  "id": "note.md#0",
  "score": 0.83,
  "content": "...",
  "metadata": {
    "path": "note.md",
    "title": "Note",
    "chunkIndex": 0,
    "mtime": 1700000000000,
  },
}
```

## Config

Environment variables:

Use `.env.example` as a starting point if you run the service through a shell
that loads environment files.

| Var                            | Default                  | Purpose                                                          |
| ------------------------------ | ------------------------ | ---------------------------------------------------------------- |
| `COMPANION_HOST`               | `127.0.0.1`              | Bind address. Keep loopback.                                     |
| `COMPANION_PORT`               | `7261`                   | TCP port.                                                        |
| `COMPANION_TOKEN`              | empty                    | If set, requests must send `Authorization: Bearer <token>`.      |
| `COMPANION_DB`                 | `./data/companion.db`    | sqlite-vec database path.                                        |
| `COMPANION_EMBEDDING_PROVIDER` | `openai`                 | Default provider for unprefixed model ids: `openai` or `ollama`. |
| `COMPANION_EMBEDDING_MODEL`    | provider default         | Default embedding model when registration omits one.             |
| `OPENAI_API_KEY`               | empty                    | Required for OpenAI embeddings.                                  |
| `OPENAI_BASE_URL`              | `https://api.openai.com` | OpenAI-compatible embeddings base URL.                           |
| `OLLAMA_HOST`                  | `http://127.0.0.1:11434` | Ollama server URL.                                               |

Embedding model ids may be provider-prefixed, for example
`openai:text-embedding-3-small` or `ollama:nomic-embed-text`. Unprefixed model
ids use `COMPANION_EMBEDDING_PROVIDER`.

## Plugin setup

1. Start the companion service.
2. In Obsidian, enable **Settings → Copilot → QA → Enable Vector Companion**.
3. Confirm host, port, token, and vault id match the companion.
4. Use **Test connection**.
5. Run **Force reindex vault** for the initial companion scan.

Existing local Orama semantic indexes are not migrated into the companion. Turn
companion mode off to return to the existing local semantic path.

## Troubleshooting

- **Connection succeeds but search returns no results**: register the vault and
  run a full scan. Check `/vaults/:id/stats` and scan job status.
- **Embedding model mismatch**: re-register with `force=true` or clear the vault
  index, then run a full scan.
- **OpenAI key errors**: set `OPENAI_API_KEY` in the companion environment.
- **Ollama errors**: confirm `OLLAMA_HOST` is reachable and the embedding model
  is installed.

## Validation

```bash
npm --prefix companion run test
npm --prefix companion run typecheck
```
