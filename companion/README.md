# Localhost Vector Companion (Phase 0 spike)

A localhost-only Node service that will eventually pull-index an Obsidian
vault and serve semantic search to the Copilot plugin. This is the **Phase 0
spike**: it boots an HTTP server on `127.0.0.1`, exposes a hand-seeded tiny
`sqlite-vec` index, and answers `/health` and `/vaults/:id/search` so the
plugin's `CompanionVectorClient` can be exercised end-to-end.

What is **deliberately not real yet** (replaced in Phase 1):

- The embedder is a deterministic hash-based pseudo-embedder. No model, no API
  key, no download. Same query string → same vector. Cosine similarity over
  these vectors is mostly meaningless; the spike is for shape, not relevance.
- There is no vault watcher, no chunker, no real scan. `seed.ts` writes ~5
  documents into the DB by hand.
- There is no auth beyond an optional shared-secret `Authorization: Bearer`
  check. The server binds `127.0.0.1` only.

## Run

```bash
cd companion
npm install
npm run seed   # creates ./data/companion.db with the demo index
npm run dev    # listens on 127.0.0.1:7261
```

Health check:

```bash
curl -s http://127.0.0.1:7261/health
```

Search:

```bash
curl -s -X POST http://127.0.0.1:7261/vaults/default/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"machine learning","limit":3}'
```

## Endpoints (MVP surface)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness; reports embedding dimension and store stats |
| POST | `/vaults/:id/search` | `{ query, limit, minScore?, filter? }` → `VectorSearchResult[]` |

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
    "mtime": 1700000000000
  }
}
```

## Config

Environment variables (all optional):

| Var | Default | Purpose |
|---|---|---|
| `COMPANION_HOST` | `127.0.0.1` | Bind address. Keep loopback. |
| `COMPANION_PORT` | `7261` | TCP port. |
| `COMPANION_TOKEN` | `` (empty) | If set, requests must send `Authorization: Bearer <token>`. |
| `COMPANION_DB` | `./data/companion.db` | sqlite-vec database path. |
| `COMPANION_DIM` | `128` | Embedding dimension. Must match the seeded index. |
