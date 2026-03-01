import type { EndpointRecord } from "@model-manager/shared";
import { fetchCliproxyModels, fetchCliproxyQuotaSnapshot } from "./cliproxy.js";
import type { DataStore } from "./storage.js";

type RefreshReason = "startup" | "poll" | "manual";
type DecryptFn = (ciphertext: string) => string;

export class EndpointPoller {
  private timers = new Map<string, NodeJS.Timeout>();
  private inFlight = new Set<string>();

  constructor(
    private readonly store: DataStore,
    private readonly decryptSecret: DecryptFn,
  ) {}

  async start(): Promise<void> {
    await this.rebuild();
  }

  stop(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  async rebuild(): Promise<void> {
    const endpoints = this.store.listEndpoints();
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();

    for (const endpoint of endpoints) {
      if (!endpoint.enabled || !endpoint.dynamicEnabled) {
        continue;
      }
      const intervalMs = endpoint.pollingIntervalSec * 1000;
      await this.refreshEndpoint(endpoint.id, "startup");
      const timer = setInterval(() => {
        void this.refreshEndpoint(endpoint.id, "poll");
      }, intervalMs);
      this.timers.set(endpoint.id, timer);
    }
  }

  async refreshEndpoint(endpointId: string, _reason: RefreshReason): Promise<void> {
    if (this.inFlight.has(endpointId)) {
      return;
    }
    this.inFlight.add(endpointId);

    try {
      const endpoint = this.store.getEndpointById(endpointId);
      if (!endpoint || !endpoint.enabled || !endpoint.dynamicEnabled) {
        return;
      }
      await this.syncOne(endpoint);
    } finally {
      this.inFlight.delete(endpointId);
    }
  }

  private async syncOne(endpoint: EndpointRecord): Promise<void> {
    try {
      const apiKey = this.decryptSecret(endpoint.apiKeyEncrypted);
      const upstreamModels = await fetchCliproxyModels({
        baseUrl: endpoint.baseUrl,
        apiKey,
      });

      let quotaSnapshot: Awaited<ReturnType<typeof fetchCliproxyQuotaSnapshot>> | null = null;
      const smartRouting = this.store.getSmartRouting();
      const encryptedManagementSecret = smartRouting.signals.management.secretKeyEncrypted;
      const managementSecret = (encryptedManagementSecret
        ? this.decryptSecret(encryptedManagementSecret)
        : "") || process.env.CLIPROXY_MANAGEMENT_KEY || "";
      if (managementSecret) {
        try {
          quotaSnapshot = await fetchCliproxyQuotaSnapshot({
            baseUrl: endpoint.baseUrl,
            managementKey: managementSecret,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown management quota error";
          console.warn(`[poller] quota snapshot skipped: ${message}`);
        }
      }

      await this.store.replaceDynamicModels(
        endpoint.id,
        upstreamModels.map((model) => ({
          modelId: model.modelId,
          displayName: model.displayName,
          provider: model.provider,
          meta: (() => {
            const meta: Record<string, unknown> = { ...model.raw };
            const modelQuota = quotaSnapshot?.byModelId?.[model.modelId];
            const providerKey = (model.provider || "").trim().toLowerCase();
            const providerQuota = providerKey ? quotaSnapshot?.byProvider?.[providerKey] : undefined;
            const quota = modelQuota ?? providerQuota;

            if (quota?.quotaDisplay) {
              meta.quota_display = quota.quotaDisplay;
            }
            if (typeof quota?.remainingFraction === "number") {
              meta.quota_remaining_fraction = quota.remainingFraction;
            }
            if (quota?.resetAt) {
              meta.quota_reset_at = quota.resetAt;
            }
            if (quota?.source) {
              meta.quota_source = quota.source;
            }
            if (quota?.unlimited) {
              meta.quota_unlimited = true;
            }

            if (/iflow/i.test(providerKey)) {
              meta.quota_unlimited = true;
              meta.quota_display = "不限量";
            }

            return meta;
          })(),
        })),
      );
      await this.store.setEndpointSyncStatus(endpoint.id, "ok");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown sync error";
      await this.store.setEndpointSyncStatus(endpoint.id, "error", message);
    }
  }
}
