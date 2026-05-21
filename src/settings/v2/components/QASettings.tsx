import React from "react";

import { Notice } from "obsidian";

import { RebuildIndexConfirmModal } from "@/components/modals/RebuildIndexConfirmModal";
import { SemanticSearchToggleModal } from "@/components/modals/SemanticSearchToggleModal";
import { useApp } from "@/context";
import { HelpTooltip } from "@/components/ui/help-tooltip";
import { getModelDisplayWithIcons } from "@/components/ui/model-display";
import { SettingItem } from "@/components/ui/setting-item";
import { Button } from "@/components/ui/button";
import { VAULT_VECTOR_STORE_STRATEGIES } from "@/constants";
import { DEFAULT_SEMANTIC_INDEX_FOLDER } from "@/constants";
import { logError } from "@/logger";
import { CompanionVectorClient } from "@/search/companion/CompanionVectorClient";
import { buildClientConfig } from "@/search/companion/companionRegistry";
import { getModelKeyFromModel, updateSetting, useSettingsValue } from "@/settings/model";
import { PatternListEditor } from "@/settings/v2/components/PatternListEditor";

export const QASettings: React.FC = () => {
  const app = useApp();
  const settings = useSettingsValue();
  const isMiyoSearchActive = settings.enableMiyo;
  const visibleEmbeddingModels = settings.activeEmbeddingModels;

  const handleSetDefaultEmbeddingModel = async (modelKey: string) => {
    if (modelKey === settings.embeddingModelKey) return;

    if (settings.enableSemanticSearchV3) {
      // Persist only after user confirms rebuild
      new RebuildIndexConfirmModal(app, async () => {
        updateSetting("embeddingModelKey", modelKey);
        const VectorStoreManager = (await import("@/search/vectorStoreManager")).default;
        await VectorStoreManager.getInstance().indexVaultToVectorStore(false, {
          userInitiated: true,
        });
      }).open();
      return;
    }

    // Persist without rebuild when semantic search is disabled
    updateSetting("embeddingModelKey", modelKey);
    new Notice("Embedding model saved. Enable Semantic Search to build the index.");
  };

  // Partitions are automatically managed in v3 (150MB per JSONL partition).
  // Remove UI control; keep handler stub to avoid accidental usage.
  // const handlePartitionsChange = (_value: string) => {};

  return (
    <div className="tw-space-y-4">
      <section>
        <div className="tw-space-y-4">
          {/* Enable Semantic Search (v3) */}
          <SettingItem
            type="switch"
            title="Enable Semantic Search"
            description="Enable semantic search for meaning-based document retrieval. When disabled, uses fast lexical search only. Use 'Refresh Vault Index' or 'Force Reindex Vault' to build the embedding index."
            checked={settings.enableSemanticSearchV3}
            onCheckedChange={(checked) => {
              // Show confirmation modal with appropriate message
              new SemanticSearchToggleModal(
                app,
                async () => {
                  updateSetting("enableSemanticSearchV3", checked);
                  if (!checked && settings.enableMiyo) {
                    updateSetting("enableMiyo", false);
                  }
                  if (checked) {
                    const VectorStoreManager = (await import("@/search/vectorStoreManager"))
                      .default;
                    await VectorStoreManager.getInstance().indexVaultToVectorStore(false, {
                      userInitiated: true,
                    });
                  }
                },
                checked // true = enabling, false = disabling
              ).open();
            }}
          />

          {/* Enable Inline Citations */}
          <SettingItem
            type="switch"
            title="Enable Inline Citations (experimental)"
            description="When enabled, AI responses will include footnote-style citations within the text and numbered sources at the end. This is an experimental feature and may not work as expected for all models."
            checked={settings.enableInlineCitations}
            onCheckedChange={(checked) => updateSetting("enableInlineCitations", checked)}
          />

          <SettingItem
            type="select"
            title="Embedding Model"
            description={
              <div className="tw-space-y-2">
                <div className="tw-flex tw-items-center tw-gap-1.5">
                  <span className="tw-font-medium tw-leading-none tw-text-accent">
                    Powers Semantic Vault Search and Relevant Notes. Enable Semantic Search to use
                    it.
                  </span>
                  <HelpTooltip
                    content={
                      <div className="tw-flex tw-max-w-96 tw-flex-col tw-gap-2">
                        <div className="tw-pt-2 tw-text-sm tw-text-muted">
                          This model converts text into vector representations, essential for
                          semantic search and Question Answering (QA) functionality. Changing the
                          embedding model will:
                        </div>
                        <ul className="tw-pl-4 tw-text-sm tw-text-muted">
                          <li>Require rebuilding your vault&#39;s vector index</li>
                          <li>Affect semantic search quality</li>
                          <li>Impact Question Answering feature performance</li>
                        </ul>
                      </div>
                    }
                  />
                </div>
                {isMiyoSearchActive && (
                  <div className="tw-text-sm tw-text-muted">
                    Miyo search is enabled, so embeddings are generated by Miyo and this setting is
                    ignored.
                  </div>
                )}
              </div>
            }
            value={settings.embeddingModelKey}
            onChange={handleSetDefaultEmbeddingModel}
            options={visibleEmbeddingModels.map((model) => ({
              label: getModelDisplayWithIcons(model),
              value: getModelKeyFromModel(model),
            }))}
            placeholder="Model"
            disabled={isMiyoSearchActive}
          />

          {/* Auto-Index Strategy */}
          <SettingItem
            type="select"
            title="Auto-Index Strategy"
            description={
              <div className="tw-flex tw-items-center tw-gap-1.5">
                <span className="tw-leading-none">
                  Decide when you want the vault to be indexed.
                </span>
                <HelpTooltip
                  content={
                    <div className="tw-space-y-2 tw-py-2">
                      <div className="tw-space-y-1">
                        <div className="tw-text-sm tw-text-muted">
                          Choose when to index your vault:
                        </div>
                        <ul className="tw-list-disc tw-space-y-1 tw-pl-2 tw-text-sm">
                          <li>
                            <div className="tw-flex tw-items-center tw-gap-1">
                              <strong className="tw-inline-block tw-whitespace-nowrap">
                                NEVER:
                              </strong>
                              <span>Manual indexing via command or refresh only</span>
                            </div>
                          </li>
                          <li>
                            <div className="tw-flex tw-items-center tw-gap-1">
                              <strong className="tw-inline-block tw-whitespace-nowrap">
                                ON STARTUP:
                              </strong>
                              <span>Index updates when plugin loads or reloads</span>
                            </div>
                          </li>
                          <li>
                            <div className="tw-flex tw-items-center tw-gap-1">
                              <strong className="tw-inline-block tw-whitespace-nowrap">
                                ON MODE SWITCH:
                              </strong>
                              <span>Updates when entering QA mode (Recommended)</span>
                            </div>
                          </li>
                        </ul>
                      </div>
                      <p className="tw-text-sm tw-text-callout-warning">
                        Warning: Cost implications for large vaults with paid models
                      </p>
                    </div>
                  }
                />
              </div>
            }
            value={settings.indexVaultToVectorStore}
            onChange={(value) => {
              updateSetting("indexVaultToVectorStore", value);
            }}
            options={VAULT_VECTOR_STORE_STRATEGIES.map((strategy) => ({
              label: strategy,
              value: strategy,
            }))}
            placeholder="Strategy"
          />

          {/* Max Sources */}
          <SettingItem
            type="slider"
            title="Max Sources"
            description="Copilot goes through your vault to find relevant notes and passes the top N to the LLM. Default for N is 30. Increase if you want more notes included in the answer generation step."
            min={1}
            max={128}
            step={1}
            value={settings.maxSourceChunks}
            onChange={(value) => updateSetting("maxSourceChunks", value)}
          />

          {/* Embedding-related settings - Only shown when semantic search is enabled */}
          {settings.enableSemanticSearchV3 && (
            <>
              {/* Requests per Minute */}
              <SettingItem
                type="slider"
                title="Requests per Minute"
                description="Default is 60. Decrease if you are rate limited by your embedding provider."
                min={10}
                max={60}
                step={10}
                value={Math.min(settings.embeddingRequestsPerMin, 60)}
                onChange={(value) => updateSetting("embeddingRequestsPerMin", value)}
              />

              {/* Embedding batch size */}
              <SettingItem
                type="slider"
                title="Embedding Batch Size"
                description="Default is 16. Increase if you are rate limited by your embedding provider."
                min={1}
                max={128}
                step={1}
                value={settings.embeddingBatchSize}
                onChange={(value) => updateSetting("embeddingBatchSize", value)}
              />

              {/* Number of Partitions */}
              <SettingItem
                type="select"
                title="Number of Partitions"
                description="Number of partitions for Copilot index. Default is 1. Increase if you have issues indexing large vaults. Warning: Changes require clearing and rebuilding the index!"
                value={String(settings.numPartitions || 1)}
                onChange={(value) => updateSetting("numPartitions", Number(value))}
                options={[
                  { label: "1", value: "1" },
                  { label: "2", value: "2" },
                  { label: "4", value: "4" },
                  { label: "8", value: "8" },
                  { label: "16", value: "16" },
                  { label: "32", value: "32" },
                  { label: "40", value: "40" },
                ]}
                placeholder="Select partitions"
              />
            </>
          )}

          {/* Lexical Search RAM Limit */}
          <SettingItem
            type="slider"
            title="Lexical Search RAM Limit"
            description="Maximum RAM usage for full-text search index. Lower values use less memory but may limit search performance on large vaults. Default is 100 MB."
            min={20}
            max={1000}
            step={20}
            value={settings.lexicalSearchRamLimit || 100}
            onChange={(value) => updateSetting("lexicalSearchRamLimit", value)}
            suffix=" MB"
          />

          {/* Enable Folder and Graph Boosts */}
          <SettingItem
            type="switch"
            title="Enable Folder and Graph Boosts"
            description="Enable folder and graph-based relevance boosts for lexical search results. When disabled, provides pure keyword-based relevance scoring without folder or connection-based adjustments."
            checked={settings.enableLexicalBoosts}
            onCheckedChange={(checked) => updateSetting("enableLexicalBoosts", checked)}
          />

          {/* Exclusions */}
          <SettingItem
            type="custom"
            title="Exclusions"
            description="Exclude folders, tags, note titles or file extensions from being indexed. Previously indexed files will remain until a force re-index is performed."
          >
            <PatternListEditor
              value={settings.qaExclusions}
              onChange={(value) => updateSetting("qaExclusions", value)}
            />
          </SettingItem>

          {/* Inclusions */}
          <SettingItem
            type="custom"
            title="Inclusions"
            description="Index only the specified paths, tags, or note titles. Exclusions take precedence over inclusions. Previously indexed files will remain until a force re-index is performed."
          >
            <PatternListEditor
              value={settings.qaInclusions}
              onChange={(value) => updateSetting("qaInclusions", value)}
            />
          </SettingItem>

          {/* Semantic index folder */}
          <SettingItem
            type="text"
            title="Semantic index folder"
            description={
              <div className="tw-space-y-1">
                <p className="tw-leading-none">
                  Vault-relative folder where embedding index files are stored and loaded. Leave
                  empty to use the defaults below.
                </p>
                <p className="tw-text-sm tw-text-muted">
                  Empty + Sync on: <code>{app.vault.configDir}</code>. Empty + Sync off:{" "}
                  <code>.copilot-index</code> at vault root. Changing this folder does not move an
                  existing index — reindex or copy files manually.
                </p>
              </div>
            }
            value={settings.semanticIndexFolder}
            onChange={(value) => {
              const next = value.trim();
              const prev = settings.semanticIndexFolder.trim();
              if (next === prev) return;

              const apply = () => updateSetting("semanticIndexFolder", next);

              if (settings.enableSemanticSearchV3 && prev !== next) {
                new RebuildIndexConfirmModal(app, apply).open();
                return;
              }
              apply();
            }}
            placeholder={DEFAULT_SEMANTIC_INDEX_FOLDER || "(default)"}
          />

          {/* Enable Obsidian Sync */}
          <SettingItem
            type="switch"
            title="Enable Obsidian Sync for Copilot index"
            description={`When the index folder above is empty, store the semantic index in ${app.vault.configDir} so it syncs with Obsidian Sync. When disabled, store it under .copilot-index at the vault root.`}
            checked={settings.enableIndexSync}
            disabled={settings.semanticIndexFolder.trim().length > 0}
            onCheckedChange={(checked) => {
              if (settings.semanticIndexFolder.trim().length > 0) return;
              updateSetting("enableIndexSync", checked);
            }}
          />

          {/* Disable index loading on mobile */}
          <SettingItem
            type="switch"
            title="Disable index loading on mobile"
            description="When enabled, Copilot index won't be loaded on mobile devices to save resources. Only chat mode will be available. Any existing index from desktop sync will be preserved. Uncheck to enable QA modes on mobile."
            checked={settings.disableIndexOnMobile}
            onCheckedChange={(checked) => updateSetting("disableIndexOnMobile", checked)}
          />
        </div>
      </section>

      <VectorCompanionSection />
    </div>
  );
};

/**
 * Phase 1 settings panel for the localhost vector companion. Hidden behind
 * its own enable switch so it stays out of the way until users opt in.
 *
 * The "Test connection" button issues a one-off `/health` probe using the
 * current (possibly unsaved) form values, so users get feedback without
 * having to toggle the feature on first.
 */
const VectorCompanionSection: React.FC = () => {
  const settings = useSettingsValue();
  const [testing, setTesting] = React.useState(false);

  const handleTest = async () => {
    setTesting(true);
    try {
      const client = new CompanionVectorClient(buildClientConfig(settings));
      const health = await client.health();
      if (!health) {
        new Notice(
          "Vector companion: connection failed. " +
            "Check that the service is running and the host/port/token match."
        );
        return;
      }
      const dimensionText =
        typeof health.embeddingDimension === "number"
          ? String(health.embeddingDimension)
          : "unknown";
      new Notice(
        `Vector companion OK — version ${health.version}, ` +
          `dim ${dimensionText}, ${health.indexedChunks} chunks indexed.`
      );
    } catch (err) {
      logError("VectorCompanionSection: test connection failed", err);
      new Notice(`Vector companion: ${(err as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <section>
      <div className="tw-space-y-4">
        <SettingItem
          type="switch"
          title="Enable Vector Companion (experimental, Phase 1)"
          description="Route semantic search to a localhost companion service that holds the vector index out-of-process. Requires the companion to be running. Lexical search is unaffected."
          checked={settings.enableVectorCompanion}
          onCheckedChange={(checked) => updateSetting("enableVectorCompanion", checked)}
        />

        <SettingItem
          type="text"
          title="Companion host"
          description="Loopback recommended. The companion binds 127.0.0.1 by default."
          value={settings.vectorCompanionHost}
          onChange={(value) => updateSetting("vectorCompanionHost", value.trim() || "127.0.0.1")}
          placeholder="127.0.0.1"
        />

        <SettingItem
          type="number"
          title="Companion port"
          description="TCP port the companion is listening on (default 7261)."
          value={settings.vectorCompanionPort}
          onChange={(value) => {
            const port = Number.parseInt(value, 10);
            if (Number.isFinite(port) && port > 0 && port <= 65535) {
              updateSetting("vectorCompanionPort", port);
            }
          }}
          placeholder="7261"
        />

        <SettingItem
          type="password"
          title="Companion token"
          description="Optional shared-secret bearer token. Leave empty if the companion was started without COMPANION_TOKEN."
          value={settings.vectorCompanionToken}
          onChange={(value) => updateSetting("vectorCompanionToken", value)}
          placeholder="(none)"
        />

        <SettingItem
          type="text"
          title="Vault id"
          description="Logical vault identifier sent to the companion. Defaults to 'default'."
          value={settings.vectorCompanionVaultId}
          onChange={(value) => updateSetting("vectorCompanionVaultId", value.trim() || "default")}
          placeholder="default"
        />

        <SettingItem
          type="custom"
          title="Test connection"
          description="Probes /health on the configured endpoint."
        >
          <Button onClick={handleTest} disabled={testing}>
            {testing ? "Testing…" : "Test connection"}
          </Button>
        </SettingItem>
      </div>
    </section>
  );
};
