import type { EndpointRecord } from "@model-manager/shared";
import { fetchCliproxyModels } from "./cliproxy.js";
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

      await this.store.replaceDynamicModels(
        endpoint.id,
        upstreamModels.map((model) => ({
          modelId: model.modelId,
          displayName: model.displayName,
          provider: model.provider,
          meta: model.raw,
        })),
      );
      await this.store.setEndpointSyncStatus(endpoint.id, "ok");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown sync error";
      await this.store.setEndpointSyncStatus(endpoint.id, "error", message);
    }
  }
}
