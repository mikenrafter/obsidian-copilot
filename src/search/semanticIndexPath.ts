/**
 * Resolves where the semantic (embedding) index is stored on disk.
 * Pure logic — callers pass vault paths from Obsidian APIs.
 */

export interface SemanticIndexPathInput {
  /** Vault-relative folder; empty uses legacy defaults below. */
  semanticIndexFolder: string;
  /** When {@link semanticIndexFolder} is empty, use Obsidian config dir (e.g. `.obsidian`). */
  enableIndexSync: boolean;
  /** Obsidian vault config directory path (typically `.obsidian`). */
  vaultConfigDir: string;
  /** Filesystem path to the vault root from `vault.getRoot().path`. */
  vaultRootPath: string;
}

const LEGACY_INDEX_DIR_NAME = ".copilot-index";

/**
 * Returns true when the path must not be used as a vault-relative index folder.
 *
 * @param folderPath - Trimmed folder path from settings.
 */
export function isUnsafeSemanticIndexFolder(folderPath: string): boolean {
  return (
    /(^|[/\\])\.\.[/\\]?/.test(folderPath) ||
    /^[a-zA-Z]:/.test(folderPath) ||
    /^[/\\]/.test(folderPath)
  );
}

/**
 * Normalize a user-provided vault-relative index folder.
 *
 * @param raw - Raw setting value.
 * @returns Normalized path, or empty string when unset/invalid.
 */
export function normalizeSemanticIndexFolder(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!trimmed || isUnsafeSemanticIndexFolder(trimmed)) {
    return "";
  }
  return trimmed;
}

/**
 * Legacy default when sync is off and no custom folder is set.
 *
 * @param vaultRootPath - Vault root filesystem path.
 */
export function resolveLegacyCopilotIndexPath(vaultRootPath: string): string {
  const effectiveRoot = vaultRootPath === "/" ? "" : vaultRootPath;
  const prefix = effectiveRoot === "" || effectiveRoot.startsWith("/") ? "" : "/";
  return `${prefix}${effectiveRoot}/${LEGACY_INDEX_DIR_NAME}`;
}

/**
 * Resolve the base directory for semantic index files (Orama chunked storage).
 *
 * @param input - Vault paths and index folder settings.
 */
export function resolveSemanticIndexBaseDir(input: SemanticIndexPathInput): string {
  const customFolder = normalizeSemanticIndexFolder(input.semanticIndexFolder);
  if (customFolder) {
    return customFolder;
  }

  if (input.enableIndexSync) {
    return input.vaultConfigDir;
  }

  return resolveLegacyCopilotIndexPath(input.vaultRootPath);
}
