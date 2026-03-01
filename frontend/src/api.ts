import type { ApiResult, AppSettings, ClaudeCurrentState, EndpointProtocol, EndpointView, ModelRecord } from "./types";

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").trim();

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });

  const payload = (await response.json()) as ApiResult<T>;
  if (!response.ok || !payload.ok || payload.data === undefined) {
    throw new Error(payload.error || `Request failed with status ${response.status}`);
  }
  return payload.data;
}

export interface CreateEndpointPayload {
  name: string;
  baseUrl: string;
  apiKey: string;
  protocol?: EndpointProtocol;
  enabled?: boolean;
  dynamicEnabled?: boolean;
  pollingIntervalSec?: number;
}

export interface UpdateEndpointPayload {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  protocol?: EndpointProtocol;
  enabled?: boolean;
  dynamicEnabled?: boolean;
  pollingIntervalSec?: number;
}

export interface CreateManualModelPayload {
  endpointId: string;
  modelId: string;
  displayName?: string;
  provider?: string;
}

export async function getEndpoints(): Promise<EndpointView[]> {
  return request<EndpointView[]>("/api/endpoints");
}

export async function createEndpoint(payload: CreateEndpointPayload): Promise<EndpointView> {
  return request<EndpointView>("/api/endpoints", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateEndpoint(id: string, payload: UpdateEndpointPayload): Promise<EndpointView> {
  return request<EndpointView>(`/api/endpoints/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function deleteEndpoint(id: string): Promise<void> {
  await request<{ deleted: boolean }>(`/api/endpoints/${id}`, {
    method: "DELETE",
  });
}

export async function refreshEndpoint(id: string): Promise<EndpointView> {
  return request<EndpointView>(`/api/endpoints/${id}/refresh`, {
    method: "POST",
  });
}

export async function getEndpointApiKey(id: string): Promise<string> {
  const result = await request<{ apiKey: string }>(`/api/endpoints/${id}/api-key`);
  return result.apiKey;
}

export async function importCliproxyConfig(payload?: {
  configPath?: string;
  configContent?: string;
  sourceName?: string;
}): Promise<{
  endpoint: EndpointView;
  importedFrom: string;
  action: "created" | "updated";
}> {
  return request("/api/endpoints/import-cliproxy", {
    method: "POST",
    body: JSON.stringify(payload ?? {}),
  });
}

export async function getCliproxyConfigInfo(): Promise<{
  found: boolean;
  configPath: string;
  baseUrl: string;
}> {
  return request("/api/endpoints/cliproxy-config");
}

export async function getModels(endpointId?: string): Promise<ModelRecord[]> {
  const query = endpointId ? `?endpointId=${encodeURIComponent(endpointId)}` : "";
  return request<ModelRecord[]>(`/api/models${query}`);
}

export async function createManualModel(payload: CreateManualModelPayload): Promise<ModelRecord> {
  return request<ModelRecord>("/api/models/manual", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function deleteManualModel(modelId: string): Promise<void> {
  await request<{ deleted: boolean }>(`/api/models/manual/${modelId}`, {
    method: "DELETE",
  });
}

export async function getSettings(): Promise<AppSettings> {
  return request<AppSettings>("/api/settings");
}

export async function updateSettings(payload: Partial<AppSettings>): Promise<AppSettings> {
  return request<AppSettings>("/api/settings", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function detectClaudeSettings(): Promise<{ detectedPath: string; configuredPath: string }> {
  return request<{ detectedPath: string; configuredPath: string }>("/api/claude/detect-settings");
}

export async function getClaudeCurrent(): Promise<ClaudeCurrentState> {
  return request<ClaudeCurrentState>("/api/claude/current");
}

export async function applyClaudeConfig(payload: {
  endpointId: string;
  modelRecordId: string;
  modelKey?: string;
  claudeSettingsPath?: string;
}): Promise<{
  settingsPath: string;
  backupPath?: string;
  updatedKeys: string[];
  endpointId: string;
  endpointName: string;
  modelRecordId: string;
  modelId: string;
  modelSource: string;
  modelKey: string;
  applyMode?: "direct_anthropic" | "via_local_gateway";
  resolvedBaseUrl?: string;
}> {
  return request("/api/claude/apply", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
