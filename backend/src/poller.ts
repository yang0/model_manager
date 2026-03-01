import type { EndpointRecord, ModelRecord } from "@model-manager/shared";
import { fetchCliproxyModels, fetchCliproxyQuotaSnapshot } from "./cliproxy.js";
import type { DataStore } from "./storage.js";

type RefreshReason = "startup" | "poll" | "manual" | "quota_reset_timer";
type DecryptFn = (ciphertext: string) => string;
type OnModelsSyncedFn = (input: {
  endpointId: string;
  models: ModelRecord[];
  reason: RefreshReason;
}) => Promise<void> | void;

export class EndpointPoller {
  private pollTimers = new Map<string, NodeJS.Timeout>();
  private quotaRefreshTimers = new Map<string, NodeJS.Timeout>();
  private inFlight = new Set<string>();

  constructor(
    private readonly store: DataStore,
    private readonly decryptSecret: DecryptFn,
    private readonly onModelsSynced?: OnModelsSyncedFn,
  ) {}

  async start(): Promise<void> {
    await this.rebuild();
  }

  stop(): void {
    for (const timer of this.pollTimers.values()) {
      clearInterval(timer);
    }
    this.pollTimers.clear();
    for (const timer of this.quotaRefreshTimers.values()) {
      clearTimeout(timer);
    }
    this.quotaRefreshTimers.clear();
  }

  async rebuild(): Promise<void> {
    const endpoints = this.store.listEndpoints();
    for (const timer of this.pollTimers.values()) {
      clearInterval(timer);
    }
    this.pollTimers.clear();
    for (const timer of this.quotaRefreshTimers.values()) {
      clearTimeout(timer);
    }
    this.quotaRefreshTimers.clear();

    for (const endpoint of endpoints) {
      if (!endpoint.enabled || !endpoint.dynamicEnabled) {
        continue;
      }
      const intervalMs = endpoint.pollingIntervalSec * 1000;
      await this.refreshEndpoint(endpoint.id, "startup");
      const timer = setInterval(() => {
        void this.refreshEndpoint(endpoint.id, "poll");
      }, intervalMs);
      this.pollTimers.set(endpoint.id, timer);
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
      await this.syncOne(endpoint, _reason);
    } finally {
      this.inFlight.delete(endpointId);
    }
  }

  private async syncOne(endpoint: EndpointRecord, reason: RefreshReason): Promise<void> {
    try {
      const apiKey = this.decryptSecret(endpoint.apiKeyEncrypted);
      const previousByModelId = new Map(
        this.store
          .listModels({ endpointId: endpoint.id })
          .map((item) => [item.modelId, item]),
      );
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

      const synced = await this.store.replaceDynamicModels(
        endpoint.id,
        upstreamModels.map((model) => ({
          modelId: model.modelId,
          displayName: model.displayName,
          provider: model.provider,
          enabled: (() => {
            const previous = previousByModelId.get(model.modelId);
            const statusOverride = previous?.meta?.status_override;
            if (statusOverride === "enabled") {
              return true;
            }
            if (statusOverride === "disabled") {
              return false;
            }
            const providerKey = (model.provider || "").trim().toLowerCase();
            const modelQuota = quotaSnapshot?.byModelId?.[model.modelId];
            const providerQuota = providerKey ? quotaSnapshot?.byProvider?.[providerKey] : undefined;
            const quota = modelQuota ?? providerQuota;

            if (/iflow/i.test(providerKey)) {
              return true;
            }
            if (quota?.unlimited) {
              return true;
            }
            const hasQuotaSignal = typeof quota?.remainingFraction === "number" || Boolean(quota?.resetAt);
            const quotaExhausted = hasQuotaSignal
              && typeof quota?.remainingFraction === "number"
              && quota.remainingFraction <= 0;
            return !quotaExhausted;
          })(),
          meta: (() => {
            const previous = previousByModelId.get(model.modelId);
            const meta: Record<string, unknown> = { ...model.raw };
            const modelQuota = quotaSnapshot?.byModelId?.[model.modelId];
            const providerKey = (model.provider || "").trim().toLowerCase();
            const providerQuota = providerKey ? quotaSnapshot?.byProvider?.[providerKey] : undefined;
            const quota = modelQuota ?? providerQuota;
            const hasQuotaSignal = typeof quota?.remainingFraction === "number" || Boolean(quota?.resetAt);
            const quotaExhausted = hasQuotaSignal
              && typeof quota?.remainingFraction === "number"
              && quota.remainingFraction <= 0;

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
              meta.quota_limited = false;
              meta.quota_exhausted = false;
            } else if (hasQuotaSignal) {
              meta.quota_limited = true;
              meta.quota_exhausted = quotaExhausted;
            }

            if (/iflow/i.test(providerKey)) {
              meta.quota_unlimited = true;
              meta.quota_limited = false;
              meta.quota_exhausted = false;
              meta.quota_display = "不限量";
            }
            const statusOverride = previous?.meta?.status_override;
            if (statusOverride === "enabled" || statusOverride === "disabled") {
              meta.status_override = statusOverride;
            }

            return meta;
          })(),
        })),
      );
      this.scheduleQuotaRefresh(endpoint.id, synced);
      if (this.onModelsSynced) {
        try {
          await this.onModelsSynced({
            endpointId: endpoint.id,
            models: synced,
            reason,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[poller] onModelsSynced callback failed: ${message}`);
        }
      }
      await this.store.setEndpointSyncStatus(endpoint.id, "ok");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown sync error";
      await this.store.setEndpointSyncStatus(endpoint.id, "error", message);
    }
  }

  private scheduleQuotaRefresh(endpointId: string, models: Array<{ enabled: boolean; meta?: Record<string, unknown> }>): void {
    const existing = this.quotaRefreshTimers.get(endpointId);
    if (existing) {
      clearTimeout(existing);
      this.quotaRefreshTimers.delete(endpointId);
    }

    const now = Date.now();
    let nextAtMs: number | undefined;
    for (const model of models) {
      const meta = model.meta ?? {};
      const quotaLimited = meta.quota_limited === true;
      const quotaExhausted = meta.quota_exhausted === true || model.enabled === false;
      if (!quotaLimited || !quotaExhausted) {
        continue;
      }
      const resetAtRaw = typeof meta.quota_reset_at === "string" ? meta.quota_reset_at : "";
      if (!resetAtRaw) {
        continue;
      }
      const parsed = Date.parse(resetAtRaw);
      if (!Number.isFinite(parsed)) {
        continue;
      }
      const candidate = parsed + 60_000;
      if (!nextAtMs || candidate < nextAtMs) {
        nextAtMs = candidate;
      }
    }

    if (!nextAtMs) {
      return;
    }

    const delayMs = Math.max(1_000, nextAtMs - now);
    const timer = setTimeout(() => {
      this.quotaRefreshTimers.delete(endpointId);
      void this.refreshEndpoint(endpointId, "quota_reset_timer");
    }, delayMs);
    this.quotaRefreshTimers.set(endpointId, timer);
  }
}
