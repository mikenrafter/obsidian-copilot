# Vault Search and Indexing

Copilot can search your vault to find relevant notes and answer questions grounded in your own content. This guide explains the two types of search, how to manage the index, and how to configure what gets indexed.

---

## Two Types of Search

### Lexical Search (Keyword-Based)

Lexical search finds notes that contain the exact words you used. It's fast, requires no setup, and works out of the box.

- **Used in**: Vault QA (Basic) mode
- **How it works**: Looks for your exact keywords in note titles and content
- **Strengths**: Fast, precise, no embedding API calls needed
- **Limitations**: Won't find notes that use different words to express the same idea

**RAM Limit**: The lexical search index is held in memory. You can configure the memory limit in **Settings → Copilot → QA → Lexical Search RAM Limit** (default: 100 MB, range: 20–1,000 MB).

**Lexical Boosts**: Copilot can boost search results from notes in the same folder as the current note, or from notes that link to each other. Enable in **Settings → Copilot → QA → Enable Lexical Boosts** (on by default).

### Semantic Search (Meaning-Based)

Semantic search finds notes that are conceptually related, even if they don't share exact words.

- **Used in**: Vault QA and Copilot Plus modes — but **disabled by default**. You must explicitly enable it.
- **How it works**: Converts your notes into numerical vectors (using an embedding model), then finds notes whose vectors are closest to your query
- **Strengths**: Finds notes by concept and meaning, great for "fuzzy" recall
- **Cost**: Requires embedding API calls (costs money for paid embedding models)
- **Enable**: **Settings → Copilot → QA → Enable Semantic Search** — turn this on to activate semantic search

### Vector Companion (Experimental)

Vector Companion is an experimental desktop-only option that moves semantic vector indexing out of Obsidian and into a separate localhost service. Lexical search still runs inside Obsidian.

Use it only if you are comfortable running a companion process alongside Obsidian.

- **Enable**: **Settings → Copilot → QA → Enable Vector Companion**
- **Requires**: the companion service running on the configured host and port (default: `127.0.0.1:7261`)
- **Initial setup**: after enabling it, run **Force reindex vault** so the companion can scan your vault and build its own index
- **No automatic migration**: existing local semantic indexes are not copied into the companion. Turning the companion off restores the regular local semantic index path.
- **Desktop only**: the companion reads your vault from the local filesystem, so it is not intended for mobile use.

If the companion is unavailable, Copilot falls back to local search and shows a notice. Check the companion's health in **Settings → Copilot → QA → Test connection**.

---

## Index Management

The semantic search index stores the vector embeddings of your notes. Manage it from **Settings → Copilot → QA**.

### Auto-Index Strategy

Controls when Copilot automatically updates the index:

| Strategy           | When the index updates                                                 |
| ------------------ | ---------------------------------------------------------------------- |
| **NEVER**          | Manual only — you must trigger indexing yourself                       |
| **ON STARTUP**     | Updates when Obsidian starts or the plugin reloads                     |
| **ON MODE SWITCH** | Updates when you switch to Vault QA or Copilot Plus mode (Recommended) |

The default is **ON MODE SWITCH**.

> **Warning**: For large vaults using paid embedding models, frequent indexing can incur significant costs. Consider using NEVER and indexing manually if cost is a concern.

### Refresh Index (Incremental)

**Command palette → Index (refresh) vault**

Updates only notes that have been added, modified, or deleted since the last index. Faster and cheaper than a full reindex.

### Force Reindex

**Command palette → Force reindex vault**

Rebuilds the entire index from scratch. Use this if:

- You changed your embedding model
- The index seems corrupted or missing results
- You've made many changes and want a clean state

### Garbage Collection

**Command palette → Garbage collect Copilot index (remove files that no longer exist in vault)**

Removes entries from the index for notes that have been deleted from your vault. Keeps the index clean without a full reindex.

### Clear Index

**Command palette → Clear local Copilot index**

Deletes the entire index. You'll need to reindex before semantic search works again.

### Debug Commands

For troubleshooting:

- **List indexed files** — Shows all notes currently in the index
- **Inspect index by note paths** — Check which chunks of specific notes are indexed
- **Count total vault tokens** — Estimates total tokens across your vault
- **Search semantic index** — Run a direct search query against the index

---

## Filtering: What Gets Indexed

Control which notes are included in semantic search.

### Cost Estimation Before Indexing

Before indexing a large vault with a paid embedding model, estimate the cost first:

**Command palette → Count total tokens in your vault**

This shows the total token count across your vault, which you can use to estimate embedding API costs. Embedding costs are generally low, but worth checking for very large vaults.

### Exclusions

**Settings → Copilot → QA → Exclusions**

Comma-separated list of patterns. Notes matching these patterns are excluded. Supports:

- Folder names: `private` — excludes the folder named "private"
- Folder paths: `Work/Confidential` — excludes that specific subfolder
- File extensions: `*.pdf` — excludes all PDF files
- Tags: `#private` — excludes all notes tagged `#private`
- Note titles: `My Secret Note` — excludes that specific note

Example: `private, Work/Confidential, #private` excludes the private folder, a specific work folder, and all notes tagged #private.

> **Note**: Tag matching works with tags in the note's **properties (frontmatter)**, not inline tags within the note body.

The `copilot` folder is always excluded automatically (it contains the plugin's own files).

### Inclusions

**Settings → Copilot → QA → Inclusions**

Comma-separated list. If set, **only** notes matching these patterns are indexed. Useful for indexing a specific area of your vault.

Leave empty to include everything (except exclusions).

---

## Embedding Settings

These settings appear in **Settings → Copilot → QA** when Semantic Search is enabled.

### Requests per Minute

How many embedding API requests to send per minute. Default is 60. Decrease this if you hit rate limit errors from your embedding provider.

Range: 10–60

### Embedding Batch Size

How many text chunks to send per API request. Default is 16. Larger batches are faster but may cause issues with some providers.

### Partitions

The index is split into partitions to handle large vaults. You can control the number of partitions in **Settings → Copilot → QA → Number of Partitions**. If you have a large vault, increase this value to avoid index errors.

> **If you hit a "RangeError: invalid string length" error**: This means your vault is too large for a single partition. Increase the number of partitions in QA settings. A good rule of thumb is that the first partition file (found in `.obsidian/`) should be under ~400 MB.

---

## Inline Citations (Experimental)

When enabled, AI responses in Vault QA include footnote-style citations pointing to the source notes used in the answer.

**Enable**: **Settings → Copilot → QA → Enable Inline Citations**

This is an experimental feature. Not all models handle it well.

---

## Index Storage Location

Control where Copilot saves and loads the semantic (embedding) index:

**Settings → Copilot → QA → Semantic index folder**

- Enter a **vault-relative folder** (for example `copilot/semantic-index` or `.copilot-index`).
- Leave **empty** to use the built-in defaults:
  - **Enable Obsidian Sync for Copilot index** on → index lives in `.obsidian` (syncs with Obsidian Sync).
  - Sync off → index lives in `.copilot-index` at the vault root (hidden from the file explorer).

Changing the folder does not move an existing index. Copy the index files to the new folder or run **Force reindex vault** after changing the setting.

## Obsidian Sync

If you use Obsidian Sync, the vector index can be synced across devices. Leave **Semantic index folder** empty and enable **Settings → Copilot → QA → Enable Obsidian Sync for Copilot index**.

> **Note**: The index can be large (hundreds of MB for big vaults). Keep this in mind for sync limits and mobile data usage.

---

## Mobile Considerations

By default, Copilot **disables indexing on mobile** to save battery and data. The setting is in **Settings → Copilot → QA → Disable index on mobile** (on by default).

On mobile, you can still use Vault QA with lexical search, but semantic search won't update automatically.

---

## Related

- [Agent Mode and Tools](agent-mode-and-tools.md) — How @vault uses the index in Plus mode
- [Models and Parameters](models-and-parameters.md) — Choosing an embedding model
- [Copilot Plus and Self-Host](copilot-plus-and-self-host.md) — Miyo-powered local semantic search
