export type ModelSource = "dynamic" | "manual";
export type EndpointProtocol = "anthropic" | "openai_responses";

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
}

export interface AppSettings {
  claudeSettingsPath: string;
  autoRefresh: boolean;
  defaultPollingIntervalSec: number;
}

export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface ClaudeCurrentState {
  settingsPath: string;
  exists: boolean;
  env: {
    ANTHROPIC_BASE_URL?: string;
    hasAuthToken: boolean;
    ANTHROPIC_AUTH_TOKEN_MASKED: string;
    modelValues: Record<string, string>;
    modelKeys: string[];
  };
}
