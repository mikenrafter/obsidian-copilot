import { logInfo } from "@/logger";
import {
  CompanionClientConfig,
  CompanionVectorClient,
} from "@/search/companion/CompanionVectorClient";
import { CopilotSettings } from "@/settings/model";

/**
 * Plugin-wide registry for the localhost vector companion client.
 *
 * Centralizes the lifecycle: the singleton is created on demand the first
 * time companion mode is enabled, its config is updated in place when the
 * user changes settings, and other callers can fetch the active instance
 * without re-constructing network state.
 */
class CompanionRegistry {
  private client: CompanionVectorClient | null = null;
  private wasEnabled = false;

  /** The current client instance, or null when companion mode is off. */
  get(): CompanionVectorClient | null {
    return this.client;
  }

  /**
   * Reconcile internal state with the latest plugin settings. Idempotent;
   * safe to call from `onload` and from every `subscribeToSettingsChange`
   * tick.
   */
  applySettings(settings: CopilotSettings): void {
    if (!settings.enableVectorCompanion) {
      if (this.wasEnabled) {
        logInfo("CompanionRegistry: companion disabled");
      }
      this.client = null;
      this.wasEnabled = false;
      return;
    }
    const config = buildClientConfig(settings);
    if (!this.client) {
      this.client = new CompanionVectorClient(config);
      logInfo(`CompanionRegistry: created companion client at ${config.host}:${config.port}`);
    } else {
      this.client.updateConfig(config);
      logInfo(
        `CompanionRegistry: updated companion client config for ${config.host}:${config.port}`
      );
    }
    this.wasEnabled = true;
  }
}

/** Translate plugin settings into a {@link CompanionClientConfig}. */
export function buildClientConfig(settings: CopilotSettings): CompanionClientConfig {
  return {
    host: settings.vectorCompanionHost || "127.0.0.1",
    port: settings.vectorCompanionPort || 7261,
    token: settings.vectorCompanionToken ?? "",
    vaultId: settings.vectorCompanionVaultId || "default",
  };
}

export const companionRegistry = new CompanionRegistry();
