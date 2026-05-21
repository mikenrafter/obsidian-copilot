import {
  isUnsafeSemanticIndexFolder,
  normalizeSemanticIndexFolder,
  resolveLegacyCopilotIndexPath,
  resolveSemanticIndexBaseDir,
} from "@/search/semanticIndexPath";

describe("semanticIndexPath", () => {
  const baseInput = {
    semanticIndexFolder: "",
    enableIndexSync: false,
    vaultConfigDir: ".obsidian",
    vaultRootPath: "/home/user/vault",
  };

  describe("resolveSemanticIndexBaseDir", () => {
    it("uses custom vault folder when set", () => {
      expect(
        resolveSemanticIndexBaseDir({
          ...baseInput,
          semanticIndexFolder: "copilot/semantic-index",
        })
      ).toBe("copilot/semantic-index");
    });

    it("uses config dir when sync enabled and folder empty", () => {
      expect(
        resolveSemanticIndexBaseDir({
          ...baseInput,
          enableIndexSync: true,
        })
      ).toBe(".obsidian");
    });

    it("uses legacy root path when sync off and folder empty", () => {
      expect(resolveSemanticIndexBaseDir(baseInput)).toBe("/home/user/vault/.copilot-index");
    });

    it("prefers custom folder over enableIndexSync", () => {
      expect(
        resolveSemanticIndexBaseDir({
          ...baseInput,
          semanticIndexFolder: "indexes/copilot",
          enableIndexSync: true,
        })
      ).toBe("indexes/copilot");
    });
  });

  describe("resolveLegacyCopilotIndexPath", () => {
    it("handles vault root at filesystem root", () => {
      expect(resolveLegacyCopilotIndexPath("/")).toBe("/.copilot-index");
    });
  });

  describe("normalizeSemanticIndexFolder", () => {
    it("rejects path traversal", () => {
      expect(normalizeSemanticIndexFolder("../outside")).toBe("");
    });

    it("trims slashes and backslashes", () => {
      expect(normalizeSemanticIndexFolder(" copilot/index/ ")).toBe("copilot/index");
    });
  });

  describe("isUnsafeSemanticIndexFolder", () => {
    it("flags absolute paths", () => {
      expect(isUnsafeSemanticIndexFolder("/tmp/index")).toBe(true);
    });
  });
});
