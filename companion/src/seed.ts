/**
 * Hand-seed the spike index with a handful of demo chunks under
 * vault_id="default". Re-running is safe (upsert on conflict).
 *
 * Usage: `npm run seed`
 */
import { loadConfig } from "./config.js";
import { VectorStore } from "./index/store.js";

interface Doc {
  path: string;
  title: string;
  chunkIndex: number;
  content: string;
}

const VAULT_ID = "default";
const DEMO_DOCS: Doc[] = [
  {
    path: "ml-overview.md",
    title: "Machine Learning Overview",
    chunkIndex: 0,
    content:
      "Machine learning is the study of algorithms that improve through experience. " +
      "Supervised learning uses labeled examples; unsupervised learning finds structure " +
      "in unlabeled data.",
  },
  {
    path: "ml-overview.md",
    title: "Machine Learning Overview",
    chunkIndex: 1,
    content:
      "Neural networks are layered models loosely inspired by biology. They are trained " +
      "by backpropagation, adjusting weights to minimize a loss function.",
  },
  {
    path: "obsidian-notes.md",
    title: "Obsidian Notes",
    chunkIndex: 0,
    content:
      "Obsidian is a Markdown-based knowledge management app. Notes live as plain files " +
      "on disk and are linked with wikilinks.",
  },
  {
    path: "recipes/sourdough.md",
    title: "Sourdough",
    chunkIndex: 0,
    content:
      "Sourdough bread relies on a wild yeast starter. Hydration around 75 percent gives " +
      "an open crumb with crisp crust when baked at high heat.",
  },
  {
    path: "ideas/vector-search.md",
    title: "Vector Search Notes",
    chunkIndex: 0,
    content:
      "Approximate nearest neighbor search trades exactness for speed. Index structures " +
      "such as HNSW and IVF make billion-scale similarity search tractable.",
  },
];

function main(): void {
  const cfg = loadConfig();
  const store = new VectorStore(cfg.dbPath);
  const now = Date.now();

  store.registerVault({
    vaultId: VAULT_ID,
    rootPath: process.cwd(),
    inclusions: [],
    exclusions: [],
    embeddingModel: "seed:deterministic",
  });

  const dim = Number.parseInt(process.env.COMPANION_DIM ?? "128", 10);
  store.ensureVaultEmbeddingCompatibility(VAULT_ID, "seed:deterministic", dim, true);

  for (const doc of DEMO_DOCS) {
    const id = `${doc.path}#${doc.chunkIndex}`;
    store.upsert(
      {
        id,
        vaultId: VAULT_ID,
        path: doc.path,
        chunkIndex: doc.chunkIndex,
        content: doc.content,
        title: doc.title,
        mtime: now,
      },
      embedDeterministic(doc.content, dim)
    );
  }
  store.touchVaultScan(VAULT_ID);
  // eslint-disable-next-line no-console
  console.log(`seeded ${DEMO_DOCS.length} chunks into ${cfg.dbPath} (dim=${dim})`);
  store.close();
}

/**
 * Deterministic toy embedder used by the seed helper only.
 */
function embedDeterministic(text: string, dim: number): Float32Array {
  const vec = new Float32Array(dim);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const token of tokens) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const index = Math.abs(hash) % dim;
    vec[index] = (vec[index] as number) + 1;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    norm += (vec[i] as number) * (vec[i] as number);
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      vec[i] = (vec[i] as number) / norm;
    }
  }
  return vec;
}

main();
