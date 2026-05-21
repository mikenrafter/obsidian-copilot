import {
  CompanionVectorClient,
  type CompanionRegisterPayload,
} from "@/search/companion/CompanionVectorClient";
import { safeFetch } from "@/utils";

jest.mock("@/logger");
jest.mock("@/utils", () => ({
  safeFetch: jest.fn(),
}));

/**
 * Build a test client with stable defaults.
 */
function createClient(): CompanionVectorClient {
  return new CompanionVectorClient({
    host: "127.0.0.1",
    port: 7261,
    token: "secret",
    vaultId: "vault-a",
  });
}

/**
 * Build a fetch-like response object for safeFetch mocks.
 */
function mockResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  };
}

describe("CompanionVectorClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("registers vault with expected payload", async () => {
    (safeFetch as jest.Mock).mockResolvedValue(mockResponse(200, { ok: true }));

    const client = createClient();
    const payload: CompanionRegisterPayload = {
      vaultId: "vault-a",
      rootPath: "/tmp/vault",
      inclusions: ["notes/"],
      exclusions: ["archive/"],
      embeddingModel: "openai:text-embedding-3-small",
    };

    const ok = await client.registerVault(payload);

    expect(ok).toBe(true);
    expect(safeFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:7261/vaults/register",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(payload),
      })
    );
  });

  it("returns scan status from scan endpoint", async () => {
    (safeFetch as jest.Mock).mockResolvedValue(
      mockResponse(200, {
        jobId: "job-1",
        vaultId: "vault-a",
        state: "running",
        indexed: 2,
        total: 5,
        errors: [],
        startedAt: 1,
        updatedAt: 2,
      })
    );

    const client = createClient();
    const status = await client.getScanStatus("job-1");

    expect(status?.state).toBe("running");
    expect(safeFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:7261/vaults/vault-a/scan/job-1",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("returns indexed files list and falls back to empty list", async () => {
    const client = createClient();

    (safeFetch as jest.Mock).mockResolvedValueOnce(
      mockResponse(200, { files: ["notes/a.md", "notes/b.md"] })
    );
    await expect(client.getIndexedFiles()).resolves.toEqual(["notes/a.md", "notes/b.md"]);

    (safeFetch as jest.Mock).mockResolvedValueOnce(mockResponse(500, { error: "oops" }));
    await expect(client.getIndexedFiles()).resolves.toEqual([]);
  });
});
