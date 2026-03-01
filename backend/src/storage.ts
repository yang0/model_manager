import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AppSettings,
  CreateEndpointInput,
  EndpointProtocol,
  EndpointRecord,
  ModelRecord,
  ModelSource,
  StorageState,
  UpdateEndpointInput,
  UpsertManualModelInput,
} from "@model-manager/shared";
import { DEFAULT_POLLING_INTERVAL_SEC } from "./constants.js";
import { modelRecordId, normalizeBaseUrl, normalizePollingInterval, toIsoNow } from "./utils.js";

interface DynamicModelInput {
  modelId: string;
  displayName: string;
  provider?: string;
  meta?: Record<string, unknown>;
}

interface UpdateSettingsInput {
  claudeSettingsPath?: string;
  autoRefresh?: boolean;
  defaultPollingIntervalSec?: number;
}

function cloneState(state: StorageState): StorageState {
  return JSON.parse(JSON.stringify(state)) as StorageState;
}

function defaultState(defaultClaudeSettingsPath: string): StorageState {
  return {
    version: 1,
    endpoints: [],
    models: [],
    settings: {
      claudeSettingsPath: defaultClaudeSettingsPath,
      autoRefresh: true,
      defaultPollingIntervalSec: DEFAULT_POLLING_INTERVAL_SEC,
    },
  };
}

function normalizeSettings(input: Partial<AppSettings> | undefined, defaultClaudeSettingsPath: string): AppSettings {
  return {
    claudeSettingsPath: (typeof input?.claudeSettingsPath === "string" && input.claudeSettingsPath.trim())
      ? input.claudeSettingsPath.trim()
      : defaultClaudeSettingsPath,
    autoRefresh: typeof input?.autoRefresh === "boolean" ? input.autoRefresh : true,
    defaultPollingIntervalSec: normalizePollingInterval(input?.defaultPollingIntervalSec),
  };
}

function normalizeModelSource(source: unknown): ModelSource {
  return source === "manual" ? "manual" : "dynamic";
}

function normalizeEndpointProtocol(protocol: unknown): EndpointProtocol {
  return protocol === "openai_responses" ? "openai_responses" : "anthropic";
}

export class DataStore {
  private state: StorageState;

  constructor(
    private readonly storagePath: string,
    private readonly defaultClaudeSettingsPath: string,
  ) {
    this.state = defaultState(defaultClaudeSettingsPath);
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.storagePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StorageState>;
      this.state = this.normalizeState(parsed);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }
      this.state = defaultState(this.defaultClaudeSettingsPath);
      await this.persist();
    }
  }

  private normalizeState(input: Partial<StorageState>): StorageState {
    const now = toIsoNow();
    const endpointList = Array.isArray(input.endpoints) ? input.endpoints : [];
    const modelList = Array.isArray(input.models) ? input.models : [];

    const endpoints: EndpointRecord[] = [];
    for (const item of endpointList) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const endpoint = item as Partial<EndpointRecord>;
      if (!endpoint.id || !endpoint.baseUrl || !endpoint.name) {
        continue;
      }
      endpoints.push({
        id: endpoint.id,
        name: endpoint.name,
        baseUrl: normalizeBaseUrl(endpoint.baseUrl),
        protocol: normalizeEndpointProtocol(endpoint.protocol),
        apiKeyEncrypted: endpoint.apiKeyEncrypted ?? "",
        enabled: endpoint.enabled ?? true,
        dynamicEnabled: endpoint.dynamicEnabled ?? true,
        pollingIntervalSec: normalizePollingInterval(endpoint.pollingIntervalSec),
        lastSyncAt: endpoint.lastSyncAt,
        lastSyncStatus: endpoint.lastSyncStatus ?? "idle",
        lastSyncError: endpoint.lastSyncError,
        createdAt: endpoint.createdAt ?? now,
        updatedAt: endpoint.updatedAt ?? now,
      });
    }

    const endpointSet = new Set(endpoints.map((x) => x.id));
    const models: ModelRecord[] = [];
    for (const item of modelList) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const model = item as Partial<ModelRecord>;
      if (!model.endpointId || !model.modelId || !endpointSet.has(model.endpointId)) {
        continue;
      }
      const source = normalizeModelSource(model.source);
      models.push({
        id: model.id ?? modelRecordId(model.endpointId, source, model.modelId),
        endpointId: model.endpointId,
        modelId: model.modelId,
        displayName: model.displayName ?? model.modelId,
        provider: model.provider,
        source,
        enabled: model.enabled ?? true,
        createdAt: model.createdAt ?? now,
        updatedAt: model.updatedAt ?? now,
        meta: model.meta,
      });
    }

    return {
      version: 1,
      endpoints,
      models,
      settings: normalizeSettings(input.settings, this.defaultClaudeSettingsPath),
    };
  }

  private async persist(): Promise<void> {
    const tmpPath = `${this.storagePath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, this.storagePath);
  }

  getState(): StorageState {
    return cloneState(this.state);
  }

  listEndpoints(): EndpointRecord[] {
    return this.state.endpoints.map((item) => ({ ...item }));
  }

  getEndpointById(id: string): EndpointRecord | undefined {
    const item = this.state.endpoints.find((endpoint) => endpoint.id === id);
    return item ? { ...item } : undefined;
  }

  listModels(input?: { endpointId?: string; source?: ModelSource }): ModelRecord[] {
    return this.state.models
      .filter((item) => {
        if (input?.endpointId && item.endpointId !== input.endpointId) {
          return false;
        }
        if (input?.source && item.source !== input.source) {
          return false;
        }
        return true;
      })
      .map((item) => ({ ...item }));
  }

  getModelById(modelId: string): ModelRecord | undefined {
    const item = this.state.models.find((model) => model.id === modelId);
    return item ? { ...item } : undefined;
  }

  getEndpointModel(endpointId: string, modelId: string): ModelRecord | undefined {
    const item = this.state.models.find((model) => model.endpointId === endpointId && model.modelId === modelId);
    return item ? { ...item } : undefined;
  }

  async createEndpoint(input: CreateEndpointInput, apiKeyEncrypted: string): Promise<EndpointRecord> {
    const now = toIsoNow();
    const endpoint: EndpointRecord = {
      id: randomUUID(),
      name: input.name.trim(),
      baseUrl: normalizeBaseUrl(input.baseUrl),
      protocol: normalizeEndpointProtocol(input.protocol),
      apiKeyEncrypted,
      enabled: input.enabled ?? true,
      dynamicEnabled: input.dynamicEnabled ?? true,
      pollingIntervalSec: normalizePollingInterval(input.pollingIntervalSec),
      lastSyncStatus: "idle",
      createdAt: now,
      updatedAt: now,
    };
    this.state.endpoints.push(endpoint);
    await this.persist();
    return { ...endpoint };
  }

  async updateEndpoint(id: string, input: UpdateEndpointInput, nextEncryptedApiKey?: string): Promise<EndpointRecord> {
    const index = this.state.endpoints.findIndex((endpoint) => endpoint.id === id);
    if (index < 0) {
      throw new Error("Endpoint not found");
    }
    const current = this.state.endpoints[index];
    const updated: EndpointRecord = {
      ...current,
      name: typeof input.name === "string" ? input.name.trim() : current.name,
      baseUrl: typeof input.baseUrl === "string" ? normalizeBaseUrl(input.baseUrl) : current.baseUrl,
      protocol: normalizeEndpointProtocol(input.protocol ?? current.protocol),
      enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
      dynamicEnabled: typeof input.dynamicEnabled === "boolean" ? input.dynamicEnabled : current.dynamicEnabled,
      pollingIntervalSec: typeof input.pollingIntervalSec === "number"
        ? normalizePollingInterval(input.pollingIntervalSec)
        : current.pollingIntervalSec,
      apiKeyEncrypted: nextEncryptedApiKey ?? current.apiKeyEncrypted,
      updatedAt: toIsoNow(),
    };
    this.state.endpoints[index] = updated;
    await this.persist();
    return { ...updated };
  }

  async deleteEndpoint(id: string): Promise<void> {
    this.state.endpoints = this.state.endpoints.filter((endpoint) => endpoint.id !== id);
    this.state.models = this.state.models.filter((model) => model.endpointId !== id);
    await this.persist();
  }

  async setEndpointSyncStatus(id: string, status: "ok" | "error", error?: string): Promise<void> {
    const endpoint = this.state.endpoints.find((item) => item.id === id);
    if (!endpoint) {
      return;
    }
    endpoint.lastSyncStatus = status;
    endpoint.lastSyncAt = toIsoNow();
    endpoint.lastSyncError = error;
    endpoint.updatedAt = toIsoNow();
    await this.persist();
  }

  async replaceDynamicModels(endpointId: string, models: DynamicModelInput[]): Promise<ModelRecord[]> {
    const now = toIsoNow();
    const previous = this.state.models.filter(
      (item) => item.endpointId === endpointId && item.source === "dynamic",
    );
    const previousMap = new Map(previous.map((item) => [item.modelId, item]));
    const nextDynamic = models.map((item) => {
      const existed = previousMap.get(item.modelId);
      return {
        id: modelRecordId(endpointId, "dynamic", item.modelId),
        endpointId,
        modelId: item.modelId,
        displayName: item.displayName || item.modelId,
        provider: item.provider,
        source: "dynamic" as const,
        enabled: existed?.enabled ?? true,
        createdAt: existed?.createdAt ?? now,
        updatedAt: now,
        meta: item.meta,
      } satisfies ModelRecord;
    });

    this.state.models = this.state.models.filter(
      (item) => !(item.endpointId === endpointId && item.source === "dynamic"),
    );
    this.state.models.push(...nextDynamic);
    await this.persist();
    return nextDynamic.map((item) => ({ ...item }));
  }

  async createManualModel(input: UpsertManualModelInput): Promise<ModelRecord> {
    const endpoint = this.state.endpoints.find((item) => item.id === input.endpointId);
    if (!endpoint) {
      throw new Error("Endpoint not found");
    }

    const existing = this.state.models.find(
      (item) => item.endpointId === input.endpointId && item.modelId === input.modelId && item.source === "manual",
    );
    if (existing) {
      throw new Error("A manual model with the same modelId already exists under this endpoint.");
    }

    const now = toIsoNow();
    const model: ModelRecord = {
      id: randomUUID(),
      endpointId: input.endpointId,
      modelId: input.modelId.trim(),
      displayName: input.displayName?.trim() || input.modelId.trim(),
      provider: input.provider?.trim() || undefined,
      source: "manual",
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      meta: {},
    };
    this.state.models.push(model);
    await this.persist();
    return { ...model };
  }

  async updateManualModel(modelId: string, input: Partial<UpsertManualModelInput>): Promise<ModelRecord> {
    const index = this.state.models.findIndex((item) => item.id === modelId && item.source === "manual");
    if (index < 0) {
      throw new Error("Manual model not found");
    }

    const current = this.state.models[index];
    const nextModelId = typeof input.modelId === "string" ? input.modelId.trim() : current.modelId;
    const nextEndpointId = typeof input.endpointId === "string" ? input.endpointId : current.endpointId;

    const duplicate = this.state.models.find(
      (item) =>
        item.id !== current.id &&
        item.source === "manual" &&
        item.endpointId === nextEndpointId &&
        item.modelId === nextModelId,
    );
    if (duplicate) {
      throw new Error("Another manual model with the same modelId exists under this endpoint.");
    }

    const updated: ModelRecord = {
      ...current,
      endpointId: nextEndpointId,
      modelId: nextModelId,
      displayName: typeof input.displayName === "string" ? input.displayName.trim() : current.displayName,
      provider: typeof input.provider === "string" ? input.provider.trim() || undefined : current.provider,
      enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
      updatedAt: toIsoNow(),
    };
    this.state.models[index] = updated;
    await this.persist();
    return { ...updated };
  }

  async deleteManualModel(modelId: string): Promise<void> {
    this.state.models = this.state.models.filter((item) => !(item.id === modelId && item.source === "manual"));
    await this.persist();
  }

  getSettings(): AppSettings {
    return { ...this.state.settings };
  }

  async updateSettings(input: UpdateSettingsInput): Promise<AppSettings> {
    const next: AppSettings = {
      claudeSettingsPath: typeof input.claudeSettingsPath === "string"
        ? input.claudeSettingsPath
        : this.state.settings.claudeSettingsPath,
      autoRefresh: typeof input.autoRefresh === "boolean" ? input.autoRefresh : this.state.settings.autoRefresh,
      defaultPollingIntervalSec: typeof input.defaultPollingIntervalSec === "number"
        ? normalizePollingInterval(input.defaultPollingIntervalSec)
        : this.state.settings.defaultPollingIntervalSec,
    };
    this.state.settings = next;
    await this.persist();
    return { ...next };
  }
}
