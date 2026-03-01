interface FetchModelsInput {
  baseUrl: string;
  apiKey: string;
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
