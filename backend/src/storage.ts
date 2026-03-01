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
  SmartRoutingConfig,
  SmartRoutingGenerationConfig,
  SmartRoutingInferenceSignalConfig,
  SmartRoutingManagementSignalConfig,
  SmartRoutingModelHealth,
  SmartRoutingRuntimeState,
  SmartRoutingSignalMode,
  SmartRoutingSignalsConfig,
  SmartRoutingVariablePolicy,
  StorageState,
  UpdateEndpointInput,
  UpsertManualModelInput,
} from "@model-manager/shared";
import {
  DEFAULT_POLLING_INTERVAL_SEC,
  DEFAULT_SMART_ROUTING_INFERENCE_QUOTA_ERROR_THRESHOLD,
  DEFAULT_SMART_ROUTING_INFERENCE_WINDOW_MIN,
  DEFAULT_SMART_ROUTING_MANAGEMENT_BASE_URL,
  DEFAULT_SMART_ROUTING_MANAGEMENT_POLL_SEC,
} from "./constants.js";
import { modelRecordId, normalizeBaseUrl, normalizePollingInterval, toIsoNow } from "./utils.js";

interface DynamicModelInput {
  modelId: string;
  displayName: string;
  provider?: string;
  enabled?: boolean;
  meta?: Record<string, unknown>;
}

interface UpdateSettingsInput {
  claudeSettingsPath?: string;
  autoRefresh?: boolean;
  defaultPollingIntervalSec?: number;
}

const PERSISTED_DYNAMIC_META_KEYS = [
  "performance_score",
  "performance_tier",
  "score_source",
  "score_model_id",
  "scored_at",
  "quota_limited",
  "quota_reason",
  "status_override",
] as const;

function pickPersistedDynamicMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!meta) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const key of PERSISTED_DYNAMIC_META_KEYS) {
    if (key in meta) {
      result[key] = meta[key];
    }
  }
  return result;
}

function cloneState(state: StorageState): StorageState {
  return JSON.parse(JSON.stringify(state)) as StorageState;
}

function defaultState(defaultClaudeSettingsPath: string): StorageState {
  return {
    version: 2,
    endpoints: [],
    models: [],
    settings: {
      claudeSettingsPath: defaultClaudeSettingsPath,
      autoRefresh: true,
      defaultPollingIntervalSec: DEFAULT_POLLING_INTERVAL_SEC,
    },
    smartRouting: defaultSmartRoutingConfig(),
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

function normalizeSmartRoutingPollSec(input?: number): number {
  if (typeof input !== "number" || Number.isNaN(input)) {
    return DEFAULT_SMART_ROUTING_MANAGEMENT_POLL_SEC;
  }
  if (input < 5) {
    return 5;
  }
  if (input > 300) {
    return 300;
  }
  return Math.floor(input);
}

function normalizeSmartRoutingWindowMin(input?: number): number {
  if (typeof input !== "number" || Number.isNaN(input)) {
    return DEFAULT_SMART_ROUTING_INFERENCE_WINDOW_MIN;
  }
  if (input < 1) {
    return 1;
  }
  if (input > 120) {
    return 120;
  }
  return Math.floor(input);
}

function normalizeSmartRoutingThreshold(input?: number): number {
  if (typeof input !== "number" || Number.isNaN(input)) {
    return DEFAULT_SMART_ROUTING_INFERENCE_QUOTA_ERROR_THRESHOLD;
  }
  if (input < 1) {
    return 1;
  }
  if (input > 20) {
    return 20;
  }
  return Math.floor(input);
}

function normalizeSignalMode(input: unknown): SmartRoutingSignalMode {
  if (input === "management" || input === "inference" || input === "hybrid") {
    return input;
  }
  return "hybrid";
}

function normalizeGenerationConfig(input: Partial<SmartRoutingGenerationConfig> | undefined): SmartRoutingGenerationConfig {
  const defaultSystemPromptTemplate = "You are an expert model routing planner. Return strict JSON only.";
  const defaultUserPromptTemplate = [
    "Build independent model fallback priority list for each variable.",
    "Each model includes: hasQuotaLimit(boolean), quotaLimitReason(string), performanceScore(0-100), performanceTier(high/medium/light).",
    "Prefer higher performanceScore first, but ensure fallback path remains robust.",
    "If high-tier limited models are exhausted, degrade to lower-tier models; keep at least one hasQuotaLimit=false model in tail fallback.",
    "Output JSON: {\"variables\": {\"<key>\": [\"model1\",\"model2\"]}}",
    "Routing payload:",
    "{{payload_json}}",
  ].join("\n");

  return {
    mode: input?.mode === "initial_only" || input?.mode === "always_before_switch" || input?.mode === "startup_and_model_change"
      ? input.mode
      : "startup_and_model_change",
    generatorModelId: typeof input?.generatorModelId === "string" && input.generatorModelId.trim()
      ? input.generatorModelId.trim()
      : undefined,
    systemPromptTemplate: typeof input?.systemPromptTemplate === "string" && input.systemPromptTemplate.trim()
      ? input.systemPromptTemplate.trim()
      : defaultSystemPromptTemplate,
    userPromptTemplate: typeof input?.userPromptTemplate === "string" && input.userPromptTemplate.trim()
      ? input.userPromptTemplate.trim()
      : defaultUserPromptTemplate,
  };
}

function normalizeManagementConfig(
  input: Partial<SmartRoutingManagementSignalConfig> | undefined,
): SmartRoutingManagementSignalConfig {
  return {
    baseUrl: normalizeBaseUrl(input?.baseUrl || DEFAULT_SMART_ROUTING_MANAGEMENT_BASE_URL),
    pollSec: normalizeSmartRoutingPollSec(input?.pollSec),
    secretKeyEncrypted: typeof input?.secretKeyEncrypted === "string" ? input.secretKeyEncrypted : undefined,
  };
}

function normalizeInferenceConfig(
  input: Partial<SmartRoutingInferenceSignalConfig> | undefined,
): SmartRoutingInferenceSignalConfig {
  return {
    windowMin: normalizeSmartRoutingWindowMin(input?.windowMin),
    quotaErrorThreshold: normalizeSmartRoutingThreshold(input?.quotaErrorThreshold),
  };
}

function normalizeSignalsConfig(input: Partial<SmartRoutingSignalsConfig> | undefined): SmartRoutingSignalsConfig {
  return {
    mode: normalizeSignalMode(input?.mode),
    management: normalizeManagementConfig(input?.management),
    inference: normalizeInferenceConfig(input?.inference),
  };
}

function normalizeVariablePolicy(input: unknown, keyHint: string): SmartRoutingVariablePolicy | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const record = input as Partial<SmartRoutingVariablePolicy>;
  const modelKey = typeof record.modelKey === "string" && record.modelKey.trim()
    ? record.modelKey.trim()
    : keyHint;
  if (!modelKey) {
    return null;
  }
  const dedup = new Set<string>();
  const priorityList = Array.isArray(record.priorityList)
    ? record.priorityList
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => {
        if (!item || dedup.has(item)) {
          return false;
        }
        dedup.add(item);
        return true;
      })
    : [];
  return {
    modelKey,
    priorityList,
    currentModelId: typeof record.currentModelId === "string" && record.currentModelId.trim()
      ? record.currentModelId.trim()
      : undefined,
    lastSwitchAt: typeof record.lastSwitchAt === "string" ? record.lastSwitchAt : undefined,
    lastReason: typeof record.lastReason === "string" ? record.lastReason : undefined,
    lockTop: typeof record.lockTop === "boolean" ? record.lockTop : false,
  };
}

function normalizeRuntimeState(input: Partial<SmartRoutingRuntimeState> | undefined): SmartRoutingRuntimeState {
  const healthByModelId: Record<string, SmartRoutingModelHealth> = {};
  if (input?.healthByModelId && typeof input.healthByModelId === "object") {
    for (const [modelId, value] of Object.entries(input.healthByModelId)) {
      if (!value || typeof value !== "object") {
        continue;
      }
      const item = value as Partial<SmartRoutingModelHealth>;
      const state = item.state === "healthy" || item.state === "degraded" || item.state === "unknown"
        ? item.state
        : "unknown";
      const source = item.source === "management" || item.source === "inference" || item.source === "mixed" || item.source === "none"
        ? item.source
        : "none";
      healthByModelId[modelId] = {
        state,
        source,
        reason: typeof item.reason === "string" ? item.reason : undefined,
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : toIsoNow(),
      };
    }
  }
  return {
    healthByModelId,
    lastGenerationAt: typeof input?.lastGenerationAt === "string" ? input.lastGenerationAt : undefined,
    lastGenerationSource: input?.lastGenerationSource === "ai" || input?.lastGenerationSource === "heuristic"
      ? input.lastGenerationSource
      : undefined,
    lastGenerationChangedKeys: typeof input?.lastGenerationChangedKeys === "number"
      && Number.isFinite(input.lastGenerationChangedKeys)
      && input.lastGenerationChangedKeys >= 0
      ? Math.floor(input.lastGenerationChangedKeys)
      : undefined,
    lastGenerationMessage: typeof input?.lastGenerationMessage === "string"
      ? input.lastGenerationMessage
      : undefined,
    generationProcess: input?.generationProcess && typeof input.generationProcess === "object"
      ? {
        status: input.generationProcess.status === "running"
          || input.generationProcess.status === "succeeded"
          || input.generationProcess.status === "failed"
          || input.generationProcess.status === "idle"
          ? input.generationProcess.status
          : "idle",
        stage: typeof input.generationProcess.stage === "string" ? input.generationProcess.stage : undefined,
        startedAt: typeof input.generationProcess.startedAt === "string" ? input.generationProcess.startedAt : undefined,
        updatedAt: typeof input.generationProcess.updatedAt === "string" ? input.generationProcess.updatedAt : undefined,
        finishedAt: typeof input.generationProcess.finishedAt === "string" ? input.generationProcess.finishedAt : undefined,
        logs: Array.isArray(input.generationProcess.logs)
          ? input.generationProcess.logs
            .filter((item): item is string => typeof item === "string")
            .slice(-80)
          : [],
      }
      : {
        status: "idle",
        logs: [],
      },
    lastEvaluationAt: typeof input?.lastEvaluationAt === "string" ? input.lastEvaluationAt : undefined,
    lastModelSignature: typeof input?.lastModelSignature === "string" ? input.lastModelSignature : undefined,
    lastError: typeof input?.lastError === "string" ? input.lastError : undefined,
  };
}

function defaultSmartRoutingConfig(): SmartRoutingConfig {
  return {
    enabled: true,
    autoApplyToClaude: true,
    generation: {
      mode: "startup_and_model_change",
    },
    signals: {
      mode: "hybrid",
      management: {
        baseUrl: DEFAULT_SMART_ROUTING_MANAGEMENT_BASE_URL,
        pollSec: DEFAULT_SMART_ROUTING_MANAGEMENT_POLL_SEC,
      },
      inference: {
        windowMin: DEFAULT_SMART_ROUTING_INFERENCE_WINDOW_MIN,
        quotaErrorThreshold: DEFAULT_SMART_ROUTING_INFERENCE_QUOTA_ERROR_THRESHOLD,
      },
    },
    variables: {},
    runtime: {
      healthByModelId: {},
    },
  };
}

function normalizeSmartRouting(input: Partial<SmartRoutingConfig> | undefined): SmartRoutingConfig {
  const defaults = defaultSmartRoutingConfig();
  const variables: Record<string, SmartRoutingVariablePolicy> = {};
  if (input?.variables && typeof input.variables === "object") {
    for (const [key, value] of Object.entries(input.variables)) {
      const normalized = normalizeVariablePolicy(value, key);
      if (normalized) {
        variables[normalized.modelKey] = normalized;
      }
    }
  }

  return {
    enabled: typeof input?.enabled === "boolean" ? input.enabled : defaults.enabled,
    autoApplyToClaude: typeof input?.autoApplyToClaude === "boolean"
      ? input.autoApplyToClaude
      : defaults.autoApplyToClaude,
    generation: normalizeGenerationConfig(input?.generation),
    signals: normalizeSignalsConfig(input?.signals),
    variables,
    runtime: normalizeRuntimeState(input?.runtime),
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
      version: 2,
      endpoints,
      models,
      settings: normalizeSettings(input.settings, this.defaultClaudeSettingsPath),
      smartRouting: normalizeSmartRouting(input.smartRouting),
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

  async patchModelMetaBatch(patches: Array<{ id: string; metaPatch: Record<string, unknown> }>): Promise<ModelRecord[]> {
    if (!patches.length) {
      return [];
    }
    const now = toIsoNow();
    const patchMap = new Map<string, Record<string, unknown>>();
    for (const patch of patches) {
      if (!patch?.id || !patch.metaPatch || typeof patch.metaPatch !== "object") {
        continue;
      }
      patchMap.set(patch.id, patch.metaPatch);
    }
    if (!patchMap.size) {
      return [];
    }

    const updated: ModelRecord[] = [];
    for (const item of this.state.models) {
      const patch = patchMap.get(item.id);
      if (!patch) {
        continue;
      }
      item.meta = {
        ...(item.meta ?? {}),
        ...patch,
      };
      item.updatedAt = now;
      updated.push({ ...item });
    }
    if (updated.length) {
      await this.persist();
    }
    return updated;
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
      const preservedMeta = pickPersistedDynamicMeta(existed?.meta);
      return {
        id: modelRecordId(endpointId, "dynamic", item.modelId),
        endpointId,
        modelId: item.modelId,
        displayName: item.displayName || item.modelId,
        provider: item.provider,
        source: "dynamic" as const,
        enabled: typeof item.enabled === "boolean" ? item.enabled : (existed?.enabled ?? true),
        createdAt: existed?.createdAt ?? now,
        updatedAt: now,
        meta: {
          ...(item.meta ?? {}),
          ...preservedMeta,
        },
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

  async setModelEnabled(
    modelId: string,
    enabled: boolean,
    input?: {
      statusOverride?: "enabled" | "disabled" | null;
    },
  ): Promise<ModelRecord> {
    const index = this.state.models.findIndex((item) => item.id === modelId);
    if (index < 0) {
      throw new Error("Model not found");
    }
    const current = this.state.models[index];
    const nextMeta: Record<string, unknown> = { ...(current.meta ?? {}) };
    if (current.source === "dynamic") {
      if (input?.statusOverride === "enabled" || input?.statusOverride === "disabled") {
        nextMeta.status_override = input.statusOverride;
      } else if (Object.prototype.hasOwnProperty.call(nextMeta, "status_override")) {
        delete nextMeta.status_override;
      }
    }

    const updated: ModelRecord = {
      ...current,
      enabled,
      meta: nextMeta,
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

  async ensureSingleDynamicEndpoint(input: {
    name: string;
    baseUrl: string;
    protocol?: EndpointProtocol;
    pollingIntervalSec?: number;
  }, apiKeyEncrypted: string): Promise<EndpointRecord> {
    const now = toIsoNow();
    const normalizedBaseUrl = normalizeBaseUrl(input.baseUrl);
    const normalizedProtocol = normalizeEndpointProtocol(input.protocol);
    const pollingIntervalSec = normalizePollingInterval(input.pollingIntervalSec);

    const matched = this.state.endpoints.find(
      (item) => item.name === input.name || normalizeBaseUrl(item.baseUrl) === normalizedBaseUrl,
    );

    const endpoint: EndpointRecord = {
      id: matched?.id ?? randomUUID(),
      name: input.name.trim(),
      baseUrl: normalizedBaseUrl,
      protocol: normalizedProtocol,
      apiKeyEncrypted,
      enabled: true,
      dynamicEnabled: true,
      pollingIntervalSec,
      lastSyncAt: matched?.lastSyncAt,
      lastSyncStatus: matched?.lastSyncStatus ?? "idle",
      lastSyncError: matched?.lastSyncError,
      createdAt: matched?.createdAt ?? now,
      updatedAt: now,
    };

    this.state.endpoints = [endpoint];
    this.state.models = this.state.models.filter(
      (item) => item.endpointId === endpoint.id && item.source === "dynamic",
    );
    await this.persist();
    return { ...endpoint };
  }

  getSettings(): AppSettings {
    return { ...this.state.settings };
  }

  getSmartRouting(): SmartRoutingConfig {
    return JSON.parse(JSON.stringify(this.state.smartRouting)) as SmartRoutingConfig;
  }

  async setSmartRouting(input: SmartRoutingConfig): Promise<SmartRoutingConfig> {
    this.state.smartRouting = normalizeSmartRouting(input);
    await this.persist();
    return this.getSmartRouting();
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
