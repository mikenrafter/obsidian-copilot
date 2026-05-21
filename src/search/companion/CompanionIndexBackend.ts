import {
  getIndexingProgressState,
  setIndexingProgressState,
  updateIndexingProgressState,
} from "@/aiParams";
import { logInfo, logWarn } from "@/logger";
import { CompanionScanStatus } from "@/search/companion/CompanionVectorClient";
import { companionRegistry } from "@/search/companion/companionRegistry";
import type {
  SemanticIndexBackend,
  SemanticIndexDocument,
} from "@/search/indexBackend/SemanticIndexBackend";
import { getDecodedPatterns } from "@/search/searchUtils";
import { getSettings } from "@/settings/model";
import { Embeddings } from "@langchain/core/embeddings";
import { App, FileSystemAdapter } from "obsidian";

const SCAN_POLL_INTERVAL_MS = 500;
const SCAN_POLL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Companion-backed semantic index backend.
 *
 * Companion owns chunking, embedding generation, and vector storage. The plugin
 * keeps semantic-index lifecycle integration and progress UI updates.
 */
export class CompanionIndexBackend implements SemanticIndexBackend {
  /**
   * Create a companion backend tied to the current app instance.
   */
  constructor(private readonly app: App) {}

  /**
   * Ensure the companion has the current vault registration.
   */
  async initialize(_embeddingInstance: Embeddings | undefined): Promise<void> {
    await this.registerVault(false);
  }

  /**
   * Clear remote index for the current vault.
   */
  async clearIndex(_embeddingInstance: Embeddings | undefined): Promise<void> {
    const client = this.getClient();
    if (!client) {
      return;
    }
    await this.registerVault(false);
    await client.clearVaultIndex();
  }

  /**
   * Companion handles embeddings server-side.
   */
  requiresEmbeddings(): boolean {
    return false;
  }

  /**
   * Direct upserts are intentionally disabled in companion mode.
   */
  async upsert(doc: SemanticIndexDocument): Promise<SemanticIndexDocument | undefined> {
    logInfo(`CompanionIndexBackend: skipping direct upsert for ${doc.path}`);
    return undefined;
  }

  /**
   * Direct batch upserts are intentionally disabled in companion mode.
   */
  async upsertBatch(docs: SemanticIndexDocument[]): Promise<number> {
    if (docs.length > 0) {
      logInfo(`CompanionIndexBackend: skipping direct batch upsert for ${docs.length} docs`);
    }
    return 0;
  }

  /**
   * File lifecycle is handled by full/incremental scans on companion side.
   */
  async removeByPath(path: string): Promise<void> {
    logInfo(`CompanionIndexBackend: skipping direct removeByPath for ${path}`);
  }

  /**
   * Return indexed files from companion stats API.
   */
  async getIndexedFiles(): Promise<string[]> {
    const client = this.getClient();
    if (!client) {
      return [];
    }
    await this.registerVault(false);
    return await client.getIndexedFiles();
  }

  /**
   * Return latest indexed mtime reported by companion.
   */
  async getLatestFileMtime(): Promise<number> {
    const client = this.getClient();
    if (!client) {
      return 0;
    }
    await this.registerVault(false);
    const stats = await client.getStats();
    return stats?.latestFileMtime ?? 0;
  }

  /**
   * Return true when no files are currently indexed.
   */
  async isIndexEmpty(): Promise<boolean> {
    const client = this.getClient();
    if (!client) {
      return true;
    }
    await this.registerVault(false);
    const stats = await client.getStats();
    return (stats?.indexedFiles ?? 0) === 0;
  }

  /**
   * Return true when the given file path appears in indexed file list.
   */
  async hasIndex(path: string): Promise<boolean> {
    const files = await this.getIndexedFiles();
    return files.includes(path);
  }

  /**
   * Companion does not expose per-document payloads yet.
   */
  async getDocumentsByPath(_path: string): Promise<SemanticIndexDocument[]> {
    return [];
  }

  /**
   * Embedding model changes are managed by register(force=true) + scan.
   */
  async checkAndHandleEmbeddingModelChange(_embeddingInstance?: Embeddings): Promise<boolean> {
    return false;
  }

  /**
   * No local save step required.
   */
  async save(): Promise<void> {
    return;
  }

  /**
   * No local integrity check required.
   */
  async checkIndexIntegrity(): Promise<void> {
    return;
  }

  /**
   * Companion handles garbage collection during scans.
   */
  async garbageCollect(): Promise<number> {
    return 0;
  }

  /**
   * Missing-embedding tracking is not used in companion mode.
   */
  markFileMissingEmbeddings(_path: string): void {
    return;
  }

  /**
   * Missing-embedding tracking is not used in companion mode.
   */
  clearFilesMissingEmbeddings(): void {
    return;
  }

  /**
   * Missing-embedding tracking is not used in companion mode.
   */
  getFilesMissingEmbeddings(): string[] {
    return [];
  }

  /**
   * Dirty-state tracking is not used in companion mode.
   */
  markUnsavedChanges(): void {
    return;
  }

  /**
   * Unload hook is a no-op for companion mode.
   */
  onunload(): void {
    return;
  }

  /**
   * Companion is a remote backend from plugin perspective.
   */
  isRemoteBackend(): boolean {
    return true;
  }

  /**
   * Trigger a companion scan and poll progress until completion.
   */
  async requestIndexRefresh(force = false): Promise<number> {
    const client = this.getClient();
    if (!client) {
      logWarn("CompanionIndexBackend: requestIndexRefresh skipped (client unavailable)");
      return 0;
    }

    const registered = await this.registerVault(force);
    if (!registered) {
      throw new Error("CompanionIndexBackend: failed to register vault before scan");
    }

    const jobId = await client.startScan(Boolean(force));
    if (!jobId) {
      throw new Error("CompanionIndexBackend: scan start failed (missing job id)");
    }

    setIndexingProgressState({
      isActive: true,
      isPaused: false,
      isCancelled: false,
      indexedCount: 0,
      totalFiles: 0,
      errors: [],
      completionStatus: "none",
    });

    const startedAt = Date.now();
    while (Date.now() - startedAt < SCAN_POLL_TIMEOUT_MS) {
      const status = await client.getScanStatus(jobId);
      if (!status) {
        throw new Error("CompanionIndexBackend: scan status polling failed");
      }

      this.applyScanProgress(status);

      if (status.state === "done") {
        updateIndexingProgressState({
          isActive: false,
          completionStatus: "success",
        });
        return status.indexed;
      }

      if (status.state === "error") {
        updateIndexingProgressState({
          isActive: false,
          completionStatus: "error",
          errors: status.errors,
        });
        throw new Error(status.errors[0] || "Companion scan failed");
      }

      if (getIndexingProgressState().isCancelled) {
        updateIndexingProgressState({
          isActive: false,
          completionStatus: "cancelled",
        });
        return status.indexed;
      }

      await sleep(SCAN_POLL_INTERVAL_MS);
    }

    updateIndexingProgressState({
      isActive: false,
      completionStatus: "error",
      errors: ["Companion scan timed out"],
    });
    throw new Error("Companion scan timed out");
  }

  /**
   * Push current scan counters into shared indexing progress state.
   */
  private applyScanProgress(status: CompanionScanStatus): void {
    updateIndexingProgressState({
      indexedCount: status.indexed,
      totalFiles: status.total,
      errors: status.errors,
    });
  }

  /**
   * Register current vault and patterns with companion service.
   */
  private async registerVault(force: boolean): Promise<boolean> {
    const client = this.getClient();
    if (!client) {
      return false;
    }

    const rootPath = this.getVaultBasePath();
    if (!rootPath) {
      throw new Error("Companion mode is only supported on desktop file-system vaults");
    }

    const settings = getSettings();
    return await client.registerVault({
      vaultId: settings.vectorCompanionVaultId || "default",
      rootPath,
      inclusions: parsePatternList(settings.qaInclusions),
      exclusions: parsePatternList(settings.qaExclusions),
      embeddingModel: settings.embeddingModelKey,
      force,
    });
  }

  /**
   * Resolve current companion client from registry.
   */
  private getClient() {
    const client = companionRegistry.get();
    if (!client) {
      logWarn("CompanionIndexBackend: companion client is unavailable");
    }
    return client;
  }

  /**
   * Return current vault filesystem root path when available.
   */
  private getVaultBasePath(): string | null {
    const adapter = this.app.vault.adapter;
    if (typeof FileSystemAdapter === "function" && adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    const adapterWithPath = adapter as unknown as { getBasePath?: () => string; basePath?: string };
    if (typeof adapterWithPath.getBasePath === "function") {
      return adapterWithPath.getBasePath();
    }
    if (typeof adapterWithPath.basePath === "string") {
      return adapterWithPath.basePath;
    }
    return null;
  }
}

/**
 * Parse encoded pattern settings string into decoded pattern array.
 */
function parsePatternList(value: string): string[] {
  if (!value) {
    return [];
  }
  return getDecodedPatterns(value);
}

/**
 * Sleep helper used for scan polling.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
