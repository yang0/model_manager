export type ModelSource = "dynamic" | "manual";
export type EndpointProtocol = "anthropic" | "openai_responses";

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

export interface StorageState {
  version: 1;
  endpoints: EndpointRecord[];
  models: ModelRecord[];
  settings: AppSettings;
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
