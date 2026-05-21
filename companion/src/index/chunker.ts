/**
 * Companion-side markdown chunker.
 *
 * Uses the same chunk id format as plugin v3: "note_path#chunk_index".
 * The splitting strategy stays heading-first with a hard character budget.
 */

const CHUNK_SIZE = 6000;
const CHUNK_OVERLAP = 0;
const NOTE_HEADER_PREFIX = "\n\nNOTE TITLE: [[";
const NOTE_HEADER_MIDDLE = "]]\n\nNOTE BLOCK CONTENT:\n\n";

/** Chunk shape emitted by the companion chunker. */
export interface CompanionChunk {
  id: string;
  notePath: string;
  chunkIndex: number;
  content: string;
  title: string;
  heading: string;
  mtime: number;
}

interface HeadingInfo {
  heading: string;
  startOffset: number;
}

/**
 * Split a markdown file into deterministic chunks.
 */
export function chunkMarkdownNote(
  notePath: string,
  title: string,
  content: string,
  mtime: number,
  options?: { maxChars?: number }
): CompanionChunk[] {
  const maxChars = Math.max(256, options?.maxChars ?? CHUNK_SIZE);
  const header = createChunkHeader(title);
  const frontmatterEnd = findFrontmatterEnd(content);
  const contentAfterFrontmatter = content.substring(frontmatterEnd);
  const headings = extractHeadings(content);

  if (!contentAfterFrontmatter.trim()) {
    return [];
  }

  // Keep small notes whole to avoid unnecessary fragmentation.
  if (header.length + contentAfterFrontmatter.length <= maxChars) {
    return processSection(
      notePath,
      title,
      contentAfterFrontmatter,
      headings[0]?.heading ?? "",
      mtime,
      0,
      maxChars
    );
  }

  if (headings.length === 0) {
    return processSection(notePath, title, contentAfterFrontmatter, "", mtime, 0, maxChars);
  }

  const chunks: CompanionChunk[] = [];
  let chunkIndex = 0;

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    if (!heading) {
      continue;
    }
    const nextHeading = headings[i + 1];
    const start = i === 0 ? frontmatterEnd : heading.startOffset;
    const end = nextHeading?.startOffset ?? content.length;
    const sectionContent = content.substring(start, end);

    const sectionChunks = processSection(
      notePath,
      title,
      sectionContent,
      heading.heading,
      mtime,
      chunkIndex,
      maxChars
    );
    chunks.push(...sectionChunks);
    chunkIndex += sectionChunks.length;
  }

  return chunks;
}

/**
 * Split one logical section under a heading into one or more chunks.
 */
function processSection(
  notePath: string,
  title: string,
  sectionContent: string,
  heading: string,
  mtime: number,
  startChunkIndex: number,
  maxChars: number
): CompanionChunk[] {
  const header = createChunkHeader(title);
  const fullContent = header + sectionContent;

  if (fullContent.length <= maxChars) {
    return [
      {
        id: `${notePath}#${startChunkIndex}`,
        notePath,
        chunkIndex: startChunkIndex,
        content: fullContent,
        title,
        heading,
        mtime,
      },
    ];
  }

  const maxSectionChars = Math.max(1, maxChars - header.length);
  const splitBodies = splitTextByBudget(sectionContent, maxSectionChars, CHUNK_OVERLAP);
  const coalescedBodies = coalesceTinyChunks(splitBodies);

  return coalescedBodies.map((body, offset) => {
    const chunkIndex = startChunkIndex + offset;
    return {
      id: `${notePath}#${chunkIndex}`,
      notePath,
      chunkIndex,
      content: header + body,
      title,
      heading,
      mtime,
    };
  });
}

/**
 * Create the chunk header prefix used by plugin semantic chunks.
 */
function createChunkHeader(title: string): string {
  return `${NOTE_HEADER_PREFIX}${title}${NOTE_HEADER_MIDDLE}`;
}

/**
 * Find markdown headings in source text and return byte offsets.
 */
function extractHeadings(content: string): HeadingInfo[] {
  const headingRegex = /^#{1,6}\s+(.+)$/gm;
  const headings: HeadingInfo[] = [];
  let match: RegExpExecArray | null;

  while ((match = headingRegex.exec(content)) !== null) {
    const headingText = match[1]?.trim();
    if (!headingText) {
      continue;
    }
    headings.push({
      heading: headingText,
      startOffset: match.index,
    });
  }

  return headings;
}

/**
 * Return offset immediately after YAML frontmatter, or 0 when absent/invalid.
 */
function findFrontmatterEnd(content: string): number {
  if (!content.startsWith("---")) {
    return 0;
  }
  const closingMatch = content.match(/\n---(\r?\n|$)/);
  if (!closingMatch || closingMatch.index === undefined) {
    return 0;
  }
  return closingMatch.index + closingMatch[0].length;
}

/**
 * Split text using markdown-friendly separators while honoring max chars.
 */
function splitTextByBudget(text: string, maxChars: number, overlap: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }

  const separators = ["\n\n", "\n", ". ", " "];
  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const remaining = text.slice(cursor);
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    let splitPoint = -1;
    for (const separator of separators) {
      const candidate = remaining.lastIndexOf(separator, maxChars);
      if (candidate > 0) {
        splitPoint = candidate + separator.length;
        break;
      }
    }

    if (splitPoint <= 0) {
      splitPoint = maxChars;
    }

    const chunk = remaining.slice(0, splitPoint);
    chunks.push(chunk);

    const step = Math.max(1, splitPoint - overlap);
    cursor += step;
  }

  return chunks;
}

/**
 * Merge tiny heading-only chunks into neighboring chunks when possible.
 */
function coalesceTinyChunks(chunks: string[]): string[] {
  if (chunks.length <= 1) {
    return chunks;
  }

  const merged: string[] = [];
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    const isHeadingOnly = /^#{1,6}\s+\S+\s*$/.test(trimmed);
    if (isHeadingOnly && merged.length > 0) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}\n\n${trimmed}`;
      continue;
    }
    merged.push(chunk);
  }

  return merged;
}
