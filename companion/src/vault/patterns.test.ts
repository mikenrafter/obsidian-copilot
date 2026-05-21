import assert from "node:assert/strict";
import test from "node:test";

import {
  categorizePatterns,
  createFilePatternContext,
  extractMarkdownTags,
  shouldIndexFile,
} from "./patterns.js";

test("categorizePatterns mirrors plugin pattern buckets", () => {
  const patterns = categorizePatterns(["#project", "*.md", "[[Daily Note]]", "areas/work"]);

  assert.deepEqual(patterns.tagPatterns, ["#project"]);
  assert.deepEqual(patterns.extensionPatterns, ["*.md"]);
  assert.deepEqual(patterns.notePatterns, ["[[Daily Note]]"]);
  assert.deepEqual(patterns.folderPatterns, ["areas/work"]);
});

test("shouldIndexFile applies exclusions before inclusions", () => {
  const inclusions = categorizePatterns(["areas/work"]);
  const exclusions = categorizePatterns(["#private"]);
  const publicFile = createFilePatternContext("areas/work/plan.md", ["project"]);
  const privateFile = createFilePatternContext("areas/work/secret.md", ["private"]);
  const outsideFile = createFilePatternContext("areas/personal/todo.md", ["project"]);

  assert.equal(shouldIndexFile(publicFile, inclusions, exclusions), true);
  assert.equal(shouldIndexFile(privateFile, inclusions, exclusions), false);
  assert.equal(shouldIndexFile(outsideFile, inclusions, exclusions), false);
});

test("shouldIndexFile respects folder boundaries", () => {
  const inclusions = categorizePatterns(["notes"]);
  const matchingFile = createFilePatternContext("notes/a.md", []);
  const siblingPrefixFile = createFilePatternContext("notes-archive/a.md", []);

  assert.equal(shouldIndexFile(matchingFile, inclusions, null), true);
  assert.equal(shouldIndexFile(siblingPrefixFile, inclusions, null), false);
});

test("extractMarkdownTags normalizes frontmatter tags and ignores inline tags", () => {
  const tags = extractMarkdownTags(
    "---\ntags:\n  - '#Project'\n  - topic/subtopic\n---\n#inline should not count"
  );

  assert.deepEqual(tags.sort(), ["project", "topic/subtopic"].sort());
});

test("extractMarkdownTags handles inline YAML tag arrays", () => {
  const tags = extractMarkdownTags("---\ntags: [alpha, '#Beta']\n---\n#ignored");

  assert.deepEqual(tags.sort(), ["alpha", "beta"].sort());
});
