export type ModelSource = "dynamic" | "manual";
export type EndpointProtocol = "anthropic" | "openai_responses";
export type SmartRoutingGenerationMode = "startup_and_model_change" | "initial_only" | "always_before_switch";
export type SmartRoutingSignalMode = "management" | "inference" | "hybrid";
export type SmartRoutingHealthState = "healthy" | "degraded" | "unknown";
export type SmartRoutingHealthSource = "management" | "inference" | "mixed" | "none";
export type SmartRoutingGenerationSource = "ai" | "heuristic";
export type SmartRoutingGenerationProcessStatus = "idle" | "running" | "succeeded" | "failed";

export interface EndpointRecord {
  id: string;
  name: string;
  baseUrl: string;
  protocol: EndpointProtocol;
  apiKeyEncrypted: string;
  enabled: boolean;
  dynamicEnabled: boolean;
  pollingIntervalSec: number;
  lastSyncAt?: string;
  lastSyncStatus: "idle" | "ok" | "error";
  lastSyncError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ModelRecord {
  id: string;
  endpointId: string;
  modelId: string;
  displayName: string;
  provider?: string;
  source: ModelSource;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  meta?: Record<string, unknown>;
}

export interface AppSettings {
  claudeSettingsPath: string;
  autoRefresh: boolean;
  defaultPollingIntervalSec: number;
}

export interface SmartRoutingGenerationConfig {
  mode: SmartRoutingGenerationMode;
  generatorModelId?: string;
  systemPromptTemplate?: string;
  userPromptTemplate?: string;
}

export interface SmartRoutingManagementSignalConfig {
  baseUrl: string;
  pollSec: number;
  secretKeyEncrypted?: string;
}

export interface SmartRoutingInferenceSignalConfig {
  windowMin: number;
  quotaErrorThreshold: number;
}

export interface SmartRoutingSignalsConfig {
  mode: SmartRoutingSignalMode;
  management: SmartRoutingManagementSignalConfig;
  inference: SmartRoutingInferenceSignalConfig;
}

export interface SmartRoutingVariablePolicy {
  modelKey: string;
  priorityList: string[];
  currentModelId?: string;
  lastSwitchAt?: string;
  lastReason?: string;
  lockTop?: boolean;
}

export interface SmartRoutingModelHealth {
  state: SmartRoutingHealthState;
  source: SmartRoutingHealthSource;
  reason?: string;
  updatedAt: string;
}

export interface SmartRoutingRuntimeState {
  healthByModelId: Record<string, SmartRoutingModelHealth>;
  lastGenerationAt?: string;
  lastGenerationSource?: SmartRoutingGenerationSource;
  lastGenerationChangedKeys?: number;
  lastGenerationMessage?: string;
  generationProcess?: {
    status: SmartRoutingGenerationProcessStatus;
    stage?: string;
    startedAt?: string;
    updatedAt?: string;
    finishedAt?: string;
    logs: string[];
  };
  lastEvaluationAt?: string;
  lastModelSignature?: string;
  lastError?: string;
}

export interface SmartRoutingConfig {
  enabled: boolean;
  autoApplyToClaude: boolean;
  generation: SmartRoutingGenerationConfig;
  signals: SmartRoutingSignalsConfig;
  variables: Record<string, SmartRoutingVariablePolicy>;
  runtime: SmartRoutingRuntimeState;
}

export interface StorageState {
  version: 2;
  endpoints: EndpointRecord[];
  models: ModelRecord[];
  settings: AppSettings;
  smartRouting: SmartRoutingConfig;
}

export interface EndpointView {
  id: string;
  name: string;
  baseUrl: string;
  protocol: EndpointProtocol;
  enabled: boolean;
  dynamicEnabled: boolean;
  pollingIntervalSec: number;
  lastSyncAt?: string;
  lastSyncStatus: "idle" | "ok" | "error";
  lastSyncError?: string;
  createdAt: string;
  updatedAt: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
}

export interface CreateEndpointInput {
  name: string;
  baseUrl: string;
  apiKey: string;
  protocol?: EndpointProtocol;
  enabled?: boolean;
  dynamicEnabled?: boolean;
  pollingIntervalSec?: number;
}

export interface UpdateEndpointInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  protocol?: EndpointProtocol;
  enabled?: boolean;
  dynamicEnabled?: boolean;
  pollingIntervalSec?: number;
}

export interface UpsertManualModelInput {
  endpointId: string;
  modelId: string;
  displayName?: string;
  provider?: string;
  enabled?: boolean;
}

export interface ApplyClaudeInput {
  endpointId: string;
  modelRecordId: string;
  modelKey?: string;
  claudeSettingsPath?: string;
}

export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface SmartRoutingView {
  enabled: boolean;
  autoApplyToClaude: boolean;
  generation: SmartRoutingGenerationConfig;
  signals: {
    mode: SmartRoutingSignalMode;
    management: {
      baseUrl: string;
      pollSec: number;
      hasSecretKey: boolean;
      secretKey?: string;
    };
    inference: SmartRoutingInferenceSignalConfig;
  };
  variables: Record<string, SmartRoutingVariablePolicy>;
  runtime: SmartRoutingRuntimeState;
}

export interface UpdateSmartRoutingInput {
  enabled?: boolean;
  autoApplyToClaude?: boolean;
  generation?: Partial<SmartRoutingGenerationConfig>;
  signals?: {
    mode?: SmartRoutingSignalMode;
    management?: {
      baseUrl?: string;
      pollSec?: number;
      secretKey?: string;
      clearSecretKey?: boolean;
    };
    inference?: Partial<SmartRoutingInferenceSignalConfig>;
  };
  variables?: Record<string, SmartRoutingVariablePolicy>;
}
