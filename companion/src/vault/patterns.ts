/**
 * Pattern categorization and file-match semantics for companion-side vault scans.
 * Mirrors plugin categories (#tag, *.ext, [[note]], folder) as closely as possible.
 */

import * as path from "node:path";

/** Categorized include/exclude pattern buckets. */
export interface PatternCategory {
  tagPatterns: string[];
  extensionPatterns: string[];
  folderPatterns: string[];
  notePatterns: string[];
}

/** Input used when evaluating whether a file should be indexed. */
export interface FilePatternContext {
  relativePath: string;
  basename: string;
  extension: string;
  tags: string[];
}

/**
 * Split raw patterns into their semantic categories.
 */
export function categorizePatterns(patterns: string[]): PatternCategory {
  const tagPatterns: string[] = [];
  const extensionPatterns: string[] = [];
  const folderPatterns: string[] = [];
  const notePatterns: string[] = [];

  const tagRegex = /^#[^\s#]+$/;
  const extensionRegex = /^\*\.([a-zA-Z0-9.]+)$/;
  const noteRegex = /^\[\[(.*?)\]\]$/;

  for (const pattern of patterns) {
    if (tagRegex.test(pattern)) {
      tagPatterns.push(pattern);
      continue;
    }
    if (extensionRegex.test(pattern)) {
      extensionPatterns.push(pattern);
      continue;
    }
    if (noteRegex.test(pattern)) {
      notePatterns.push(pattern);
      continue;
    }
    folderPatterns.push(pattern);
  }

  return { tagPatterns, extensionPatterns, folderPatterns, notePatterns };
}

/**
 * Return true if a file passes inclusion/exclusion checks.
 */
export function shouldIndexFile(
  file: FilePatternContext,
  inclusions: PatternCategory | null,
  exclusions: PatternCategory | null
): boolean {
  if (exclusions && matchesPatternCategory(file, exclusions)) {
    return false;
  }
  if (inclusions && !matchesPatternCategory(file, inclusions)) {
    return false;
  }
  return true;
}

/**
 * Extract frontmatter tags from a markdown body.
 *
 * Matches plugin indexing semantics: `#tag` patterns are evaluated against
 * frontmatter `tags`, not arbitrary inline tags in the note body.
 */
export function extractMarkdownTags(content: string): string[] {
  const tags = new Set<string>();
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) {
    return [];
  }

  const lines = frontmatter.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line?.match(/^tags:\s*(.*)$/);
    if (!match) {
      continue;
    }

    const inlineValue = match[1]?.trim() ?? "";
    if (inlineValue.length > 0) {
      addTagValues(tags, inlineValue);
      continue;
    }

    for (let j = i + 1; j < lines.length; j++) {
      const childLine = lines[j];
      if (!childLine) {
        continue;
      }
      if (/^\S/.test(childLine)) {
        break;
      }
      const itemMatch = childLine.match(/^\s*-\s*(.+?)\s*$/);
      if (!itemMatch) {
        continue;
      }
      addTagValues(tags, itemMatch[1] ?? "");
    }
  }

  return Array.from(tags.values());
}

/**
 * Extract YAML frontmatter body, or null when absent/invalid.
 */
function extractFrontmatter(content: string): string | null {
  if (!content.startsWith("---")) {
    return null;
  }
  const closingMatch = content.match(/\n---(\r?\n|$)/);
  if (!closingMatch || closingMatch.index === undefined) {
    return null;
  }
  return content.slice(3, closingMatch.index);
}

/**
 * Add one or more YAML tag values to the normalized tag set.
 */
function addTagValues(tags: Set<string>, rawValue: string): void {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return;
  }

  const values =
    trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed
          .slice(1, -1)
          .split(",")
          .map((value) => value.trim())
      : [trimmed];

  for (const value of values) {
    const normalized = value
      .replace(/^['\"]|['\"]$/g, "")
      .replace(/^#/, "")
      .trim()
      .toLowerCase();
    if (!normalized) {
      continue;
    }
    tags.add(normalized);
  }
}

/**
 * Build normalized path metadata for matching.
 */
export function createFilePatternContext(relativePath: string, tags: string[]): FilePatternContext {
  const normalizedPath = normalizePath(relativePath);
  const parsed = path.posix.parse(normalizedPath);
  return {
    relativePath: normalizedPath,
    basename: parsed.name,
    extension: parsed.ext.toLowerCase(),
    tags: tags.map((tag) => tag.toLowerCase()),
  };
}

/**
 * Normalize path separators and strip leading './'.
 */
export function normalizePath(inputPath: string): string {
  const normalized = inputPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized;
}

/**
 * Test whether the given file matches any pattern in a category.
 */
function matchesPatternCategory(file: FilePatternContext, patterns: PatternCategory): boolean {
  return (
    matchesTags(file, patterns.tagPatterns) ||
    matchesExtensions(file, patterns.extensionPatterns) ||
    matchesNotes(file, patterns.notePatterns) ||
    matchesFolders(file, patterns.folderPatterns)
  );
}

/**
 * Match #tag style patterns.
 */
function matchesTags(file: FilePatternContext, tagPatterns: string[]): boolean {
  if (tagPatterns.length === 0) {
    return false;
  }
  return tagPatterns.some((pattern) => {
    const normalizedPattern = pattern.slice(1).toLowerCase();
    return file.tags.includes(normalizedPattern);
  });
}

/**
 * Match *.ext style patterns.
 */
function matchesExtensions(file: FilePatternContext, extensionPatterns: string[]): boolean {
  if (extensionPatterns.length === 0) {
    return false;
  }
  return extensionPatterns.some((pattern) => {
    const normalizedPattern = pattern.slice(1).toLowerCase();
    return file.relativePath.toLowerCase().endsWith(normalizedPattern);
  });
}

/**
 * Match [[Note Title]] style patterns.
 */
function matchesNotes(file: FilePatternContext, notePatterns: string[]): boolean {
  if (notePatterns.length === 0) {
    return false;
  }
  return notePatterns.some((pattern) => {
    const noteName = pattern.slice(2, -2);
    return noteName === file.basename;
  });
}

/**
 * Match folder-style prefix patterns.
 */
function matchesFolders(file: FilePatternContext, folderPatterns: string[]): boolean {
  if (folderPatterns.length === 0) {
    return false;
  }

  return folderPatterns.some((pattern) => {
    const normalizedPattern = normalizePath(pattern).replace(/\/$/, "");
    if (normalizedPattern.length === 0) {
      return false;
    }
    if (!file.relativePath.startsWith(normalizedPattern)) {
      return false;
    }
    return (
      file.relativePath.length === normalizedPattern.length ||
      file.relativePath[normalizedPattern.length] === "/"
    );
  });
}
