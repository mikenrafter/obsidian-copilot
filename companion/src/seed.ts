/**
 * Hand-seed the spike index with a handful of demo chunks under
 * vault_id="default". Re-running is safe (upsert on conflict).
 *
 * Usage: `npm run seed`
 */
import { loadConfig } from "./config.js";
import { embed } from "./index/embedder.js";
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
  const store = new VectorStore(cfg.dbPath, cfg.dim);
  const now = Date.now();
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
      embed(doc.content, cfg.dim)
    );
  }
  // eslint-disable-next-line no-console
  console.log(`seeded ${DEMO_DOCS.length} chunks into ${cfg.dbPath} (dim=${cfg.dim})`);
  store.close();
}

main();
