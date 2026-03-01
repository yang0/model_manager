import type {
  ApiResult,
  AppSettings,
  ClaudeCurrentState,
  EndpointView,
  FallbackChainView,
  ModelRecord,
} from "./types";

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").trim();

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers ?? {});
  if (options?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers,
  });

  const raw = await response.text();
  let payload: ApiResult<T> | null = null;
  try {
    payload = raw ? (JSON.parse(raw) as ApiResult<T>) : null;
  } catch {
    payload = null;
  }

  if (!response.ok || !payload?.ok || payload.data === undefined) {
    const fallback = raw ? `${response.status} ${response.statusText}: ${raw}` : `Request failed with status ${response.status}`;
    throw new Error(payload?.error || fallback);
  }
  return payload.data;
}

export async function getEndpoints(): Promise<EndpointView[]> {
  return request<EndpointView[]>("/api/endpoints");
}

export async function refreshEndpoint(id: string): Promise<EndpointView> {
  return request<EndpointView>(`/api/endpoints/${id}/refresh`, {
    method: "POST",
  });
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

export async function getModels(): Promise<ModelRecord[]> {
  return request<ModelRecord[]>("/api/models");
}

export async function scoreModels(payload?: { scoringModelId?: string }): Promise<{
  updatedCount: number;
  changedCount?: number;
  source?: string;
  scoringModelId: string;
  models: ModelRecord[];
}> {
  return request("/api/models/score", {
    method: "POST",
    body: JSON.stringify({
      scoringModelId: payload?.scoringModelId ?? "",
    }),
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
  applyMode?: "direct_anthropic";
  resolvedBaseUrl?: string;
}> {
  return request("/api/claude/apply", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function getFallbackChains(): Promise<FallbackChainView[]> {
  return request<FallbackChainView[]>("/api/fallback-chains");
}

export async function updateFallbackChain(modelKey: string, priorityList: string[]): Promise<FallbackChainView> {
  return request<FallbackChainView>(`/api/fallback-chains/${encodeURIComponent(modelKey)}`, {
    method: "PUT",
    body: JSON.stringify({ priorityList }),
  });
}
