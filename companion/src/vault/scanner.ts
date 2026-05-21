/**
 * Asynchronous vault scan job manager.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import type { CompanionConfig } from "../config.js";
import { chunkMarkdownNote } from "../index/chunker.js";
import { embedTexts } from "../index/embedder.js";
import type { VectorStore, VaultRecord } from "../index/store.js";
import {
  categorizePatterns,
  createFilePatternContext,
  extractMarkdownTags,
  shouldIndexFile,
} from "./patterns.js";

export type ScanJobState = "queued" | "running" | "done" | "error";

/** Scan progress snapshot returned to API callers. */
export interface ScanJobStatus {
  jobId: string;
  vaultId: string;
  state: ScanJobState;
  indexed: number;
  total: number;
  errors: string[];
  startedAt: number;
  updatedAt: number;
}

interface InternalScanJob extends ScanJobStatus {
  full: boolean;
}

/**
 * Manages in-process scan jobs. One scan per vault runs at a time.
 */
export class VaultScanner {
  private readonly jobs = new Map<string, InternalScanJob>();
  private readonly runningByVault = new Map<string, string>();

  constructor(
    private readonly store: VectorStore,
    private readonly config: CompanionConfig
  ) {}

  /**
   * Start a scan, or return the currently running scan for the same vault.
   */
  startScan(vaultId: string, full: boolean): string {
    const existingJobId = this.runningByVault.get(vaultId);
    if (existingJobId) {
      return existingJobId;
    }

    const now = Date.now();
    const jobId = randomUUID();
    const job: InternalScanJob = {
      jobId,
      vaultId,
      state: "queued",
      indexed: 0,
      total: 0,
      errors: [],
      startedAt: now,
      updatedAt: now,
      full,
    };

    this.jobs.set(jobId, job);
    this.runningByVault.set(vaultId, jobId);

    void this.runJob(job).finally(() => {
      this.runningByVault.delete(vaultId);
    });

    return jobId;
  }

  /**
   * Return current status for a scan job.
   */
  getJobStatus(vaultId: string, jobId: string): ScanJobStatus | null {
    const job = this.jobs.get(jobId);
    if (!job || job.vaultId !== vaultId) {
      return null;
    }
    return {
      jobId: job.jobId,
      vaultId: job.vaultId,
      state: job.state,
      indexed: job.indexed,
      total: job.total,
      errors: [...job.errors],
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
    };
  }

  /**
   * Execute one scan job to completion.
   */
  private async runJob(job: InternalScanJob): Promise<void> {
    this.updateJob(job, { state: "running" });

    try {
      const vault = this.store.getVault(job.vaultId);
      if (!vault) {
        throw new Error(`vault ${job.vaultId} is not registered`);
      }

      if (job.full) {
        this.store.clearVaultIndex(job.vaultId);
      }

      const files = await listVaultMarkdownFiles(vault.rootPath);
      this.updateJob(job, { total: files.length });

      const inclusions = vault.inclusions.length > 0 ? categorizePatterns(vault.inclusions) : null;
      const exclusions = vault.exclusions.length > 0 ? categorizePatterns(vault.exclusions) : null;

      for (const fileInfo of files) {
        const absolutePath = path.join(vault.rootPath, fileInfo.relativePath);
        const noteTitle = path.parse(fileInfo.relativePath).name;
        let content: string;

        try {
          content = await fs.readFile(absolutePath, "utf8");
        } catch (error) {
          this.addError(job, `read failed for ${fileInfo.relativePath}: ${String(error)}`);
          continue;
        }

        const tags = extractMarkdownTags(content);
        const context = createFilePatternContext(fileInfo.relativePath, tags);
        if (!shouldIndexFile(context, inclusions, exclusions)) {
          continue;
        }

        const existingMtime = this.store.getFileMtime(job.vaultId, fileInfo.relativePath);
        if (!job.full && existingMtime !== null && existingMtime >= fileInfo.mtime) {
          continue;
        }

        this.store.removeByPath(job.vaultId, fileInfo.relativePath);

        const chunks = chunkMarkdownNote(
          fileInfo.relativePath,
          noteTitle,
          content,
          fileInfo.mtime,
          { maxChars: 6000 }
        );
        if (chunks.length === 0) {
          this.updateJob(job, { indexed: job.indexed + 1 });
          continue;
        }

        const embedded = await embedTexts(
          chunks.map((chunk) => chunk.content),
          vault.embeddingModel,
          this.config
        );

        this.store.ensureVaultEmbeddingCompatibility(
          vault.vaultId,
          embedded.modelId,
          embedded.dimension,
          false
        );

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (!chunk) {
            continue;
          }
          const embedding = embedded.vectors[i];
          if (!embedding) {
            this.addError(job, `missing embedding for ${chunk.id}`);
            continue;
          }
          this.store.upsert(
            {
              id: chunk.id,
              vaultId: job.vaultId,
              path: chunk.notePath,
              chunkIndex: chunk.chunkIndex,
              content: chunk.content,
              title: chunk.title,
              mtime: chunk.mtime,
            },
            embedding
          );
        }

        this.updateJob(job, { indexed: job.indexed + 1 });
      }

      this.store.touchVaultScan(job.vaultId);
      this.updateJob(job, { state: "done" });
    } catch (error) {
      this.addError(job, `scan failed: ${String(error)}`);
      this.updateJob(job, { state: "error" });
    }
  }

  /**
   * Apply a partial status update and refresh timestamp.
   */
  private updateJob(job: InternalScanJob, update: Partial<InternalScanJob>): void {
    Object.assign(job, update);
    job.updatedAt = Date.now();
    this.jobs.set(job.jobId, job);
  }

  /**
   * Append one job error while capping history size.
   */
  private addError(job: InternalScanJob, errorText: string): void {
    const maxErrors = 100;
    job.errors.push(errorText);
    if (job.errors.length > maxErrors) {
      job.errors.splice(0, job.errors.length - maxErrors);
    }
    this.updateJob(job, {});
  }
}

interface VaultFileEntry {
  relativePath: string;
  mtime: number;
}

/**
 * Recursively walk markdown files under a vault root.
 */
async function listVaultMarkdownFiles(rootPath: string): Promise<VaultFileEntry[]> {
  const entries: VaultFileEntry[] = [];
  await walkDirectory(rootPath, rootPath, entries);
  return entries;
}

/**
 * DFS directory walk helper.
 */
async function walkDirectory(
  rootPath: string,
  currentPath: string,
  out: VaultFileEntry[]
): Promise<void> {
  const dirEntries = await fs.readdir(currentPath, { withFileTypes: true });

  for (const dirEntry of dirEntries) {
    const absolute = path.join(currentPath, dirEntry.name);

    if (dirEntry.isDirectory()) {
      if (dirEntry.name === ".obsidian") {
        continue;
      }
      await walkDirectory(rootPath, absolute, out);
      continue;
    }

    if (!dirEntry.isFile()) {
      continue;
    }

    if (!absolute.toLowerCase().endsWith(".md")) {
      continue;
    }

    const stats = await fs.stat(absolute);
    const relative = path.relative(rootPath, absolute).replace(/\\/g, "/");
    out.push({
      relativePath: relative,
      mtime: stats.mtimeMs,
    });
  }
}

/**
 * Validate root path before registration/scanning.
 */
export async function validateVaultRootPath(rootPath: string): Promise<void> {
  const stats = await fs.stat(rootPath);
  if (!stats.isDirectory()) {
    throw new Error(`vault root is not a directory: ${rootPath}`);
  }
}

/**
 * Build registration payload defaults that keep scan semantics explicit.
 */
export function normalizeVaultRecordInput(input: {
  vaultId: string;
  rootPath: string;
  inclusions?: string[];
  exclusions?: string[];
  embeddingModel: string;
}): VaultRecord {
  return {
    vaultId: input.vaultId,
    rootPath: input.rootPath,
    inclusions: input.inclusions ?? [],
    exclusions: input.exclusions ?? [],
    embeddingModel: input.embeddingModel,
    embeddingDimension: null,
    vecTable: "",
    updatedAt: Date.now(),
    lastScanAt: null,
  };
}
