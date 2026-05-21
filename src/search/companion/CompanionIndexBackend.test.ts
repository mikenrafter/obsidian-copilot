import type { App } from "obsidian";

import { CompanionIndexBackend } from "@/search/companion/CompanionIndexBackend";
import { companionRegistry } from "@/search/companion/companionRegistry";
import { getSettings } from "@/settings/model";

jest.mock("@/logger");
jest.mock("@/search/searchUtils", () => ({
  getDecodedPatterns: jest.fn((value: string) =>
    value
      .split(",")
      .map((item) => decodeURIComponent(item.trim()))
      .filter(Boolean)
  ),
}));

const mockSetIndexingProgressState = jest.fn();
const mockUpdateIndexingProgressState = jest.fn();

jest.mock("@/aiParams", () => ({
  setIndexingProgressState: (...args: unknown[]): void => {
    mockSetIndexingProgressState(...args);
  },
  updateIndexingProgressState: (...args: unknown[]): void => {
    mockUpdateIndexingProgressState(...args);
  },
  getIndexingProgressState: (): { isCancelled: boolean } => ({ isCancelled: false }),
}));

jest.mock("@/search/companion/companionRegistry", () => ({
  companionRegistry: {
    get: jest.fn(),
  },
}));

jest.mock("@/settings/model", () => ({
  getSettings: jest.fn(),
}));

interface MockCompanionClient {
  registerVault: jest.Mock;
  startScan: jest.Mock;
  getScanStatus: jest.Mock;
  clearVaultIndex: jest.Mock;
  getIndexedFiles: jest.Mock;
  getStats: jest.Mock;
}

/**
 * Create a fake desktop App object with getBasePath support.
 */
function createDesktopApp(basePath = "/tmp/vault"): App {
  return {
    vault: {
      adapter: {
        getBasePath: () => basePath,
      },
    },
  } as unknown as App;
}

/**
 * Build a mock companion client API used by backend tests.
 */
function createMockClient(): MockCompanionClient {
  return {
    registerVault: jest.fn().mockResolvedValue(true),
    startScan: jest.fn().mockResolvedValue("job-1"),
    getScanStatus: jest.fn().mockResolvedValue({
      jobId: "job-1",
      vaultId: "vault-1",
      state: "done",
      indexed: 3,
      total: 3,
      errors: [],
      startedAt: 1,
      updatedAt: 2,
    }),
    clearVaultIndex: jest.fn().mockResolvedValue(true),
    getIndexedFiles: jest.fn().mockResolvedValue(["notes/a.md"]),
    getStats: jest.fn().mockResolvedValue({
      indexedFiles: 1,
      indexedChunks: 3,
      latestFileMtime: 123,
      embeddingModel: "openai:text-embedding-3-small",
      dimension: 1536,
      lastScanAt: 999,
    }),
  };
}

describe("CompanionIndexBackend", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSettings as jest.Mock).mockReturnValue({
      vectorCompanionVaultId: "vault-1",
      qaInclusions: encodeURIComponent("notes/"),
      qaExclusions: encodeURIComponent("archive/"),
      embeddingModelKey: "openai:text-embedding-3-small",
    });
  });

  it("registers vault and completes scan polling", async () => {
    const client = createMockClient();
    (companionRegistry.get as jest.Mock).mockReturnValue(client);

    const backend = new CompanionIndexBackend(createDesktopApp());
    const indexed = await backend.requestIndexRefresh(false);

    expect(indexed).toBe(3);
    expect(client.registerVault).toHaveBeenCalledWith(
      expect.objectContaining({
        vaultId: "vault-1",
        rootPath: "/tmp/vault",
        embeddingModel: "openai:text-embedding-3-small",
      })
    );
    expect(client.startScan).toHaveBeenCalledWith(false);
    expect(mockSetIndexingProgressState).toHaveBeenCalled();
    expect(mockUpdateIndexingProgressState).toHaveBeenCalledWith(
      expect.objectContaining({
        indexedCount: 3,
        totalFiles: 3,
      })
    );
  });

  it("clears index through companion API", async () => {
    const client = createMockClient();
    (companionRegistry.get as jest.Mock).mockReturnValue(client);

    const backend = new CompanionIndexBackend(createDesktopApp());
    await backend.clearIndex(undefined);

    expect(client.clearVaultIndex).toHaveBeenCalledTimes(1);
  });

  it("proxies indexed file lookup", async () => {
    const client = createMockClient();
    (companionRegistry.get as jest.Mock).mockReturnValue(client);

    const backend = new CompanionIndexBackend(createDesktopApp());
    await expect(backend.getIndexedFiles()).resolves.toEqual(["notes/a.md"]);
  });
});
