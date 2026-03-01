interface FetchModelsInput {
  baseUrl: string;
  apiKey: string;
}

interface FetchQuotaSnapshotInput {
  baseUrl: string;
  managementKey: string;
}

interface ManagementAuthFile {
  authIndex: string;
  provider: string;
  disabled: boolean;
  account?: string;
}

interface QuotaInfo {
  quotaDisplay: string;
  resetAt?: string;
  remainingFraction?: number;
  unlimited?: boolean;
  source: string;
}

export interface CliproxyQuotaSnapshot {
  byModelId: Record<string, QuotaInfo>;
  byProvider: Record<string, QuotaInfo>;
}

export interface UpstreamModel {
  modelId: string;
  displayName: string;
  provider?: string;
  raw: Record<string, unknown>;
}

function toObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeFraction(value: unknown): number | null {
  const num = asNumber(value);
  if (num === null) {
    return null;
  }
  if (num <= 1) {
    return Math.max(0, Math.min(1, num));
  }
  if (num <= 100) {
    return Math.max(0, Math.min(1, num / 100));
  }
  return null;
}

function formatFractionText(fraction: number): string {
  const percent = fraction * 100;
  if (percent <= 0) {
    return "0%";
  }
  if (percent >= 99.95) {
    return "100%";
  }
  if (percent >= 10) {
    return `${percent.toFixed(0)}%`;
  }
  return `${percent.toFixed(1)}%`;
}

function minFraction(current: number | undefined, next: number | undefined): number | undefined {
  if (typeof next !== "number") {
    return current;
  }
  if (typeof current !== "number") {
    return next;
  }
  return Math.min(current, next);
}

function earlierTime(current?: string, next?: string): string | undefined {
  if (!next) {
    return current;
  }
  if (!current) {
    return next;
  }
  const currentMs = Date.parse(current);
  const nextMs = Date.parse(next);
  if (!Number.isFinite(currentMs)) {
    return next;
  }
  if (!Number.isFinite(nextMs)) {
    return current;
  }
  return nextMs < currentMs ? next : current;
}

function normalizeProvider(value: unknown): string {
  return asString(value).trim().toLowerCase();
}

function normalizeAuthFiles(payload: unknown): ManagementAuthFile[] {
  const root = toObject(payload);
  const files = Array.isArray(root.files) ? root.files : [];
  const result: ManagementAuthFile[] = [];

  for (const item of files) {
    const obj = toObject(item);
    const authIndex = asString(obj.auth_index ?? obj.authIndex).trim();
    const provider = normalizeProvider(obj.type ?? obj.provider);
    if (!authIndex || !provider) {
      continue;
    }
    const disabled = obj.disabled === true || asString(obj.disabled).trim().toLowerCase() === "true";
    const account = asString(obj.account).trim() || undefined;
    result.push({
      authIndex,
      provider,
      disabled,
      account,
    });
  }

  return result;
}

function extractProjectIdFromAccount(account?: string): string | null {
  if (!account) {
    return null;
  }
  const matches = Array.from(account.matchAll(/\(([^()]+)\)/g));
  if (!matches.length) {
    return null;
  }
  const candidate = matches[matches.length - 1]?.[1]?.trim();
  return candidate || null;
}

function normalizeGeminiModelId(modelId: string): string {
  return modelId.endsWith("_vertex")
    ? modelId.slice(0, -"_vertex".length)
    : modelId;
}

async function fetchManagementJson(baseUrl: string, managementKey: string, path: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${managementKey}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Management GET ${path} failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function callManagementApiCall(input: {
  baseUrl: string;
  managementKey: string;
  authIndex: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: string;
}): Promise<{ statusCode: number; body: unknown }> {
  const response = await fetch(`${input.baseUrl}/v0/management/api-call`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.managementKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      auth_index: input.authIndex,
      method: input.method,
      url: input.url,
      header: input.headers ?? {},
      data: input.data ?? "",
    }),
  });
  if (!response.ok) {
    throw new Error(`Management POST /api-call failed: ${response.status} ${response.statusText}`);
  }

  const payload = toObject(await response.json());
  const statusCodeRaw = payload.status_code ?? payload.statusCode;
  const statusCode = typeof statusCodeRaw === "number"
    ? statusCodeRaw
    : Number(asString(statusCodeRaw).trim());

  const bodyRaw = payload.body;
  if (typeof bodyRaw === "string") {
    try {
      return { statusCode, body: JSON.parse(bodyRaw) };
    } catch {
      return { statusCode, body: bodyRaw };
    }
  }
  return { statusCode, body: bodyRaw };
}

async function loadAntigravityQuota(
  baseUrl: string,
  managementKey: string,
  authIndex: string,
): Promise<Record<string, QuotaInfo>> {
  const result: Record<string, QuotaInfo> = {};
  const response = await callManagementApiCall({
    baseUrl,
    managementKey,
    authIndex,
    method: "POST",
    url: "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    headers: {
      Authorization: "Bearer $TOKEN$",
      "Content-Type": "application/json",
      "User-Agent": "antigravity/1.11.5 windows/amd64",
    },
    data: JSON.stringify({ project: "bamboo-precept-lgxtn" }),
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    return result;
  }

  const body = toObject(response.body);
  const models = toObject(body.models);
  for (const [modelId, value] of Object.entries(models)) {
    const model = toObject(value);
    const quotaInfo = toObject(model.quotaInfo ?? model.quota_info);
    const fraction = normalizeFraction(
      quotaInfo.remainingFraction ?? quotaInfo.remaining_fraction ?? quotaInfo.remaining,
    );
    const resetAt = asString(quotaInfo.resetTime ?? quotaInfo.reset_time).trim() || undefined;
    if (fraction === null && !resetAt) {
      continue;
    }
    result[modelId] = {
      quotaDisplay: typeof fraction === "number" ? formatFractionText(fraction) : "-",
      remainingFraction: fraction === null ? undefined : fraction,
      resetAt,
      source: "antigravity",
    };
  }
  return result;
}

async function loadGeminiCliQuota(
  baseUrl: string,
  managementKey: string,
  authIndex: string,
  projectId: string,
): Promise<Record<string, QuotaInfo>> {
  const response = await callManagementApiCall({
    baseUrl,
    managementKey,
    authIndex,
    method: "POST",
    url: "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    headers: {
      Authorization: "Bearer $TOKEN$",
      "Content-Type": "application/json",
    },
    data: JSON.stringify({ project: projectId }),
  });

  const result: Record<string, QuotaInfo> = {};
  if (response.statusCode < 200 || response.statusCode >= 300) {
    return result;
  }

  const body = toObject(response.body);
  const buckets = Array.isArray(body.buckets) ? body.buckets : [];
  for (const item of buckets) {
    const bucket = toObject(item);
    const rawModelId = asString(bucket.modelId ?? bucket.model_id).trim();
    if (!rawModelId) {
      continue;
    }
    const modelId = normalizeGeminiModelId(rawModelId);
    const fraction = normalizeFraction(bucket.remainingFraction ?? bucket.remaining_fraction);
    const resetAt = asString(bucket.resetTime ?? bucket.reset_time).trim() || undefined;
    if (fraction === null && !resetAt) {
      continue;
    }

    const prev = result[modelId];
    const nextFraction = minFraction(prev?.remainingFraction, fraction === null ? undefined : fraction);
    const nextResetAt = earlierTime(prev?.resetAt, resetAt);
    result[modelId] = {
      quotaDisplay: typeof nextFraction === "number" ? formatFractionText(nextFraction) : "-",
      remainingFraction: nextFraction,
      resetAt: nextResetAt,
      source: "gemini-cli",
    };
  }

  return result;
}

function mergeQuotaInfoMap(target: Record<string, QuotaInfo>, incoming: Record<string, QuotaInfo>): void {
  for (const [modelId, item] of Object.entries(incoming)) {
    const prev = target[modelId];
    if (!prev) {
      target[modelId] = { ...item };
      continue;
    }
    const remainingFraction = minFraction(prev.remainingFraction, item.remainingFraction);
    const resetAt = earlierTime(prev.resetAt, item.resetAt);
    target[modelId] = {
      quotaDisplay: typeof remainingFraction === "number" ? formatFractionText(remainingFraction) : prev.quotaDisplay || item.quotaDisplay,
      remainingFraction,
      resetAt,
      unlimited: prev.unlimited || item.unlimited,
      source: prev.source || item.source,
    };
  }
}

function parseModelItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  const asObj = toObject(payload);
  if (Array.isArray(asObj.data)) {
    return asObj.data;
  }
  if (Array.isArray(asObj.models)) {
    return asObj.models;
  }
  return [];
}

export async function fetchCliproxyModels(input: FetchModelsInput): Promise<UpstreamModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(`${input.baseUrl}/v1/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Upstream returned ${response.status} ${response.statusText}`);
    }

    const payload: unknown = await response.json();
    const items = parseModelItems(payload);

    const result: UpstreamModel[] = [];
    for (const item of items) {
      const obj = toObject(item);
      const modelIdValue = obj.id ?? obj.model ?? obj.name;
      const modelId = typeof modelIdValue === "string" ? modelIdValue : "";
      if (!modelId) {
        continue;
      }
      result.push({
        modelId,
        displayName: typeof obj.name === "string" ? obj.name : modelId,
        provider: typeof obj.owned_by === "string" ? obj.owned_by : undefined,
        raw: obj,
      });
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchCliproxyQuotaSnapshot(input: FetchQuotaSnapshotInput): Promise<CliproxyQuotaSnapshot> {
  const byModelId: Record<string, QuotaInfo> = {};
  const byProvider: Record<string, QuotaInfo> = {};

  const rawAuthFiles = await fetchManagementJson(input.baseUrl, input.managementKey, "/v0/management/auth-files");
  const authFiles = normalizeAuthFiles(rawAuthFiles).filter((item) => !item.disabled);

  for (const authFile of authFiles) {
    if (authFile.provider === "iflow") {
      byProvider.iflow = {
        quotaDisplay: "不限量",
        unlimited: true,
        source: "iflow",
      };
      continue;
    }

    if (authFile.provider === "antigravity") {
      const quotaMap = await loadAntigravityQuota(input.baseUrl, input.managementKey, authFile.authIndex);
      mergeQuotaInfoMap(byModelId, quotaMap);
      continue;
    }

    if (authFile.provider === "gemini-cli") {
      const projectId = extractProjectIdFromAccount(authFile.account);
      if (!projectId) {
        continue;
      }
      const quotaMap = await loadGeminiCliQuota(input.baseUrl, input.managementKey, authFile.authIndex, projectId);
      mergeQuotaInfoMap(byModelId, quotaMap);
      continue;
    }
  }

  return { byModelId, byProvider };
}
