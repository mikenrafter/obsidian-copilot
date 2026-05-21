import assert from "node:assert/strict";
import test from "node:test";

import { chunkMarkdownNote } from "./chunker.js";

test("chunkMarkdownNote strips frontmatter and preserves plugin-compatible ids", () => {
  const chunks = chunkMarkdownNote(
    "notes/example.md",
    "example",
    "---\ntags:\n  - keep\n---\n# Intro\nHello world\n\n## Details\nMore text",
    1234
  );

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.id, "notes/example.md#0");
  assert.equal(chunks[0]?.notePath, "notes/example.md");
  assert.equal(chunks[0]?.chunkIndex, 0);
  assert.equal(chunks[0]?.heading, "Intro");
  assert.equal(chunks[0]?.mtime, 1234);
  assert.match(chunks[0]?.content ?? "", /NOTE TITLE: \[\[example\]\]/);
  assert.doesNotMatch(chunks[0]?.content ?? "", /tags:/);
  assert.match(chunks[0]?.content ?? "", /# Intro/);
});

test("chunkMarkdownNote splits oversized notes with stable sequential chunk ids", () => {
  const body = `# Long\n${"alpha beta gamma. ".repeat(80)}`;
  const chunks = chunkMarkdownNote("long.md", "long", body, 5678, { maxChars: 160 });

  assert.ok(chunks.length > 1);
  assert.deepEqual(
    chunks.map((chunk) => chunk.id),
    chunks.map((_, index) => `long.md#${index}`)
  );
  assert.ok(chunks.every((chunk) => chunk.content.includes("NOTE BLOCK CONTENT:")));
  assert.ok(chunks.every((chunk) => chunk.heading === "Long"));
});

test("chunkMarkdownNote returns no chunks for empty markdown after frontmatter", () => {
  const chunks = chunkMarkdownNote("empty.md", "empty", "---\ntitle: Empty\n---\n   ", 1);

  assert.deepEqual(chunks, []);
});
