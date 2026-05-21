/**
 * Deterministic, model-free pseudo-embedder for the Phase 0 spike.
 *
 * WHY: lets the spike run with zero external deps (no API key, no model
 * download) while still exercising the full request → embed → ANN → respond
 * path. Same input string always produces the same vector, so `seed.ts` and
 * the server agree without coordinating on a model.
 *
 * WHAT IT DOES: token-hash bag-of-words projected into a fixed-dim L2-normed
 * float vector. Cosine similarity between two such vectors reflects shared
 * tokens only — it is NOT semantic. Phase 1 replaces this with a real
 * embedding provider (OpenAI / Ollama / etc.) configured server-side.
 */

const TOKEN_REGEX = /[a-z0-9]+/g;

/**
 * Hash a token to a non-negative 32-bit int (FNV-1a). Stable across runs and
 * platforms; do NOT swap this without re-seeding the DB, because changing the
 * hash changes every stored vector.
 */
function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/** Tokenize on ASCII word chars; lowercase. Good enough for the spike. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN_REGEX) ?? [];
}

/**
 * Build a deterministic embedding for `text` of length `dim`.
 *
 * Algorithm: for each token, increment `vec[hash(token) % dim]` by 1, then
 * L2-normalize. Empty input returns a zero vector (cosine == 0 against
 * everything).
 */
export function embed(text: string, dim: number): Float32Array {
  const vec = new Float32Array(dim);
  for (const token of tokenize(text)) {
    const idx = hashToken(token) % dim;
    vec[idx] = (vec[idx] as number) + 1;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    const v = vec[i] as number;
    norm += v * v;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      vec[i] = (vec[i] as number) / norm;
    }
  }
  return vec;
}

/** Pack a Float32Array as the little-endian bytes sqlite-vec expects. */
export function vectorToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}
