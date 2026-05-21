import { logInfo } from "@/logger";
import {
  CompanionClientConfig,
  CompanionVectorClient,
} from "@/search/companion/CompanionVectorClient";
import { RetrieverFactory } from "@/search/RetrieverFactory";
import { CopilotSettings } from "@/settings/model";

/**
 * Plugin-wide registry for the localhost vector companion client.
 *
 * Centralizes the lifecycle: the singleton is created on demand the first
 * time companion mode is enabled, its config is updated in place when the
 * user changes settings, and {@link RetrieverFactory} is notified whenever
 * the enabled flag flips so it picks up (or releases) the backend without
 * a plugin reload.
 *
 * NOTE: registration with {@link RetrieverFactory.registerSelfHostedBackend}
 * is what makes the existing self-host code path use the companion. The
 * factory still gates on `isSelfHostModeValid()` + `selfHostUrl`, so Phase
 * 1 will need to teach the factory about a dedicated companion key. For
 * Phase 0 the registration is sufficient to let `Test Connection` and any
 * direct callers exercise the backend.
 */
class CompanionRegistry {
  private client: CompanionVectorClient | null = null;
  private registered = false;

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
      if (this.registered) {
        RetrieverFactory.clearSelfHostedBackend();
        this.registered = false;
        logInfo("CompanionRegistry: companion disabled; backend cleared");
      }
      this.client = null;
      return;
    }
    const config = buildClientConfig(settings);
    if (!this.client) {
      this.client = new CompanionVectorClient(config);
    } else {
      this.client.updateConfig(config);
    }
    if (!this.registered) {
      RetrieverFactory.registerSelfHostedBackend(this.client);
      this.registered = true;
      logInfo(`CompanionRegistry: registered companion at ${config.host}:${config.port}`);
    }
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
