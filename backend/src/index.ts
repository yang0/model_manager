import path from "node:path";
import fs from "node:fs";
import fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import type {
  ApiResult,
  ApplyClaudeInput,
  EndpointRecord,
  EndpointView,
  ModelSource,
  SmartRoutingVariablePolicy,
} from "@model-manager/shared";
import { DEFAULT_BACKEND_PORT, STORAGE_PATH } from "./constants.js";
import { applyClaudeSettings, detectDefaultClaudeSettingsPath, readClaudeSettings } from "./claude.js";
import { discoverCliproxyConfig, readCliproxyConfig, readCliproxyConfigFromContent } from "./cliproxy-config.js";
import { decryptSecretWithDpapi, encryptSecretWithDpapi } from "./dpapi.js";
import { maskSecret, normalizeBaseUrl } from "./utils.js";
import { DataStore } from "./storage.js";
import { EndpointPoller } from "./poller.js";

const CLIPROXY_LOCAL_NAME = "CLIProxy Local";
const CLIPROXY_FALLBACK_BASE_URL = "http://127.0.0.1:8317";
const CLAUDE_MODEL_KEYS = [
  "model",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];
const HIGH_SCORE_PATTERNS = [
  /opus/,
  /gpt-5/,
  /o1|o3/,
  /gemini-3(\.1)?-pro/,
  /gemini-2\.5-pro/,
  /thinking/,
  /qwen3-max/,
  /deepseek-r1/,
  /glm-4\.6/,
];
const MID_SCORE_PATTERNS = [
  /sonnet/,
  /gpt-4(\.1)?/,
  /codex/,
  /gemini-3-flash/,
  /gemini-2\.5-flash/,
  /qwen3-coder-plus/,
  /qwen3-235b/,
  /deepseek-v3(\.1|\.2)?/,
  /kimi-k2/,
  /glm-4/,
];
const LOW_SCORE_PATTERNS = [
  /haiku/,
  /flash-lite/,
  /mini|nano/,
  /qwen3-32b/,
  /qwen/,
  /deepseek-v3/,
  /kimi/,
  /llama/,
];
const LIMITED_PROVIDER_PATTERNS = [/antigravity/];
const GENEROUS_PROVIDER_PATTERNS = [/iflow/, /qwen/, /kimi/, /domestic/, /local/];
const GENEROUS_MODEL_PATTERNS = [/codex/, /gpt-5\.[23]/, /qwen/, /deepseek/, /glm/, /kimi/];
const META_LIMITED_PATTERNS = [/quota/, /credit/, /balance/, /remaining/, /limit/, /usage/];
const META_UNLIMITED_PATTERNS = [/unlimited/, /no[-_\s]?limit/, /unmetered/];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function toFlatText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => toFlatText(item)).join(" ");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function detectPerformanceTier(modelId: string): "high" | "medium" | "light" {
  const text = modelId.toLowerCase();
  if (HIGH_SCORE_PATTERNS.some((pattern) => pattern.test(text))) {
    return "high";
  }
  if (MID_SCORE_PATTERNS.some((pattern) => pattern.test(text))) {
    return "medium";
  }
  if (LOW_SCORE_PATTERNS.some((pattern) => pattern.test(text))) {
    return "light";
  }
  return "medium";
}

function estimatePerformanceScore(modelId: string, provider: string | undefined, scoringModelId?: string): number {
  const lowerModel = modelId.toLowerCase();
  const lowerProvider = (provider || "").toLowerCase();
  const lowerScoring = (scoringModelId || "").toLowerCase();
  const tier = detectPerformanceTier(modelId);
  let score = tier === "high" ? 90 : tier === "medium" ? 74 : 58;

  if (/thinking|reasoner|r1/.test(lowerModel)) {
    score += 4;
  }
  if (/max|opus|pro/.test(lowerModel)) {
    score += 3;
  }
  if (/flash-lite|mini|nano/.test(lowerModel)) {
    score -= 8;
  }
  if (/preview/.test(lowerModel)) {
    score -= 3;
  }
  if (/openai|anthropic|google/.test(lowerProvider)) {
    score += 1;
  }
  if (lowerScoring && lowerModel === lowerScoring) {
    score += 2;
  }
  return Math.max(35, Math.min(99, score));
}

function inferQuotaLimit(
  modelId: string,
  provider: string | undefined,
  meta: Record<string, unknown> | undefined,
): { hasQuotaLimit: boolean; quotaReason: string } {
  const lowerModel = modelId.toLowerCase();
  const lowerProvider = (provider || "").toLowerCase();
  const lowerMeta = toFlatText(meta).toLowerCase();

  if (META_UNLIMITED_PATTERNS.some((pattern) => pattern.test(lowerMeta))) {
    return { hasQuotaLimit: false, quotaReason: "meta indicates unlimited/no-limit quota" };
  }
  if (META_LIMITED_PATTERNS.some((pattern) => pattern.test(lowerMeta))) {
    return { hasQuotaLimit: true, quotaReason: "meta contains quota/credit/limit signal" };
  }
  if (LIMITED_PROVIDER_PATTERNS.some((pattern) => pattern.test(lowerProvider))) {
    return { hasQuotaLimit: true, quotaReason: "provider likely has stricter premium quota pool" };
  }
  if (GENEROUS_PROVIDER_PATTERNS.some((pattern) => pattern.test(lowerProvider))
    || GENEROUS_MODEL_PATTERNS.some((pattern) => pattern.test(lowerModel))) {
    return { hasQuotaLimit: false, quotaReason: "provider/model usually treated as generous or stable pool" };
  }
  if (/claude|gemini/.test(lowerModel)) {
    return { hasQuotaLimit: true, quotaReason: "high-tier model family usually has usage cap" };
  }
  return { hasQuotaLimit: true, quotaReason: "unknown provider, conservative assumption: limited" };
}

function toObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function extractTextFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of value) {
    const obj = toObject(item);
    const text = asString(obj.text || obj.content || obj.value);
    if (text) {
      parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return toObject(parsed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
        return toObject(parsed);
      } catch {
        return null;
      }
    }
    return null;
  }
}

type ParsedScoreItem = {
  score: number;
  tier: "high" | "medium" | "light";
  quotaLimited: boolean;
  quotaReason: string;
  reason?: string;
};

function parseAiScorePayload(rawText: string, allowedModelIds: Set<string>): Map<string, ParsedScoreItem> | null {
  const root = extractJsonObject(rawText);
  if (!root) {
    return null;
  }
  const scores = Array.isArray(root.scores) ? root.scores : [];
  const result = new Map<string, ParsedScoreItem>();
  for (const item of scores) {
    const obj = toObject(item);
    const modelId = asString(obj.modelId ?? obj.model_id ?? obj.model).trim();
    if (!modelId || !allowedModelIds.has(modelId)) {
      continue;
    }
    const rawScore = obj.score;
    let scoreNum = Number.NaN;
    if (typeof rawScore === "number") {
      scoreNum = rawScore;
    } else if (typeof rawScore === "string") {
      scoreNum = Number(rawScore.trim());
    }
    if (!Number.isFinite(scoreNum)) {
      continue;
    }
    const score = Math.max(0, Math.min(100, Math.round(scoreNum)));
    const rawTier = asString(obj.tier).toLowerCase();
    const tier = rawTier === "high" || rawTier === "medium" || rawTier === "light"
      ? rawTier
      : detectPerformanceTier(modelId);
    const quotaLimited = typeof obj.quotaLimited === "boolean"
      ? obj.quotaLimited
      : typeof obj.quota_limited === "boolean"
      ? obj.quota_limited
      : true;
    const quotaReason = asString(obj.quotaReason ?? obj.quota_reason).trim() || "ai_scoring";
    const reason = asString(obj.reason).trim() || undefined;
    result.set(modelId, {
      score,
      tier,
      quotaLimited,
      quotaReason,
      reason,
    });
  }
  return result.size ? result : null;
}

async function requestAiScoreByChat(
  baseUrl: string,
  apiKey: string,
  scoringModelId: string,
  systemPrompt: string,
  userPrompt: string,
  allowedModelIds: Set<string>,
): Promise<Map<string, ParsedScoreItem> | null> {
  const requestBody = {
    model: scoringModelId,
    temperature: 0.1,
    max_tokens: 2200,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  };
  const url = `${normalizeBaseUrl(baseUrl)}/v1/chat/completions`;
  console.log("[models/score][chat] request url:", url);
  console.log("[models/score][chat] prompt payload:\n", JSON.stringify(requestBody, null, 2));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const raw = await response.text();
    console.log("[models/score][chat] response status:", response.status);
    console.log("[models/score][chat] response raw:\n", raw);
    if (!response.ok) {
      return null;
    }
    let parsedJson: unknown;
    try {
      parsedJson = raw ? JSON.parse(raw) : {};
    } catch {
      return null;
    }
    const payload = toObject(parsedJson);
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const first = toObject(choices[0]);
    const message = toObject(first.message);
    const content = extractTextFromUnknown(message.content);
    if (!content) {
      return null;
    }
    return parseAiScorePayload(content, allowedModelIds);
  } catch (error) {
    console.error("[models/score][chat] request failed:", error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestAiScoreByResponses(
  baseUrl: string,
  apiKey: string,
  scoringModelId: string,
  systemPrompt: string,
  userPrompt: string,
  allowedModelIds: Set<string>,
): Promise<Map<string, ParsedScoreItem> | null> {
  const requestBody = {
    model: scoringModelId,
    input: [
      { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
      { role: "user", content: [{ type: "input_text", text: userPrompt }] },
    ],
    max_output_tokens: 2200,
  };
  const url = `${normalizeBaseUrl(baseUrl)}/v1/responses`;
  console.log("[models/score][responses] request url:", url);
  console.log("[models/score][responses] prompt payload:\n", JSON.stringify(requestBody, null, 2));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const raw = await response.text();
    console.log("[models/score][responses] response status:", response.status);
    console.log("[models/score][responses] response raw:\n", raw);
    if (!response.ok) {
      return null;
    }
    let parsedJson: unknown;
    try {
      parsedJson = raw ? JSON.parse(raw) : {};
    } catch {
      return null;
    }
    const payload = toObject(parsedJson);
    const outputText = asString(payload.output_text);
    if (outputText) {
      return parseAiScorePayload(outputText, allowedModelIds);
    }
    const output = Array.isArray(payload.output) ? payload.output : [];
    for (const item of output) {
      const obj = toObject(item);
      const contentList = Array.isArray(obj.content) ? obj.content : [];
      for (const content of contentList) {
        const contentObj = toObject(content);
        const text = asString(contentObj.text);
        if (!text) {
          continue;
        }
        const parsed = parseAiScorePayload(text, allowedModelIds);
        if (parsed) {
          return parsed;
        }
      }
    }
    return null;
  } catch (error) {
    console.error("[models/score][responses] request failed:", error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function toEndpointView(endpoint: EndpointRecord): EndpointView {
  let apiKeyMasked = "";
  let hasApiKey = false;

  try {
    const plain = decryptSecretWithDpapi(endpoint.apiKeyEncrypted);
    hasApiKey = plain.length > 0;
    apiKeyMasked = maskSecret(plain);
  } catch {
    hasApiKey = Boolean(endpoint.apiKeyEncrypted);
    apiKeyMasked = "****";
  }

  return {
    id: endpoint.id,
    name: endpoint.name,
    baseUrl: endpoint.baseUrl,
    protocol: "anthropic",
    enabled: endpoint.enabled,
    dynamicEnabled: endpoint.dynamicEnabled,
    pollingIntervalSec: endpoint.pollingIntervalSec,
    lastSyncAt: endpoint.lastSyncAt,
    lastSyncStatus: endpoint.lastSyncStatus,
    lastSyncError: endpoint.lastSyncError,
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
    apiKeyMasked,
    hasApiKey,
  };
}

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

function fail(message: string): ApiResult<never> {
  return { ok: false, error: message };
}

type FallbackChainView = {
  modelKey: string;
  currentModelId?: string;
  priorityList: string[];
};

function normalizeModelIdList(modelIds: string[] | undefined, allowedModelIds: Set<string>): string[] {
  const dedup = new Set<string>();
  const normalized: string[] = [];
  for (const value of modelIds ?? []) {
    const trimmed = value.trim();
    if (!trimmed || dedup.has(trimmed) || !allowedModelIds.has(trimmed)) {
      continue;
    }
    dedup.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

async function ensureCliproxyOnlyEndpoint(store: DataStore): Promise<EndpointRecord> {
  const discovered = await discoverCliproxyConfig();

  if (discovered) {
    const encrypted = encryptSecretWithDpapi(discovered.apiKey);
    return store.ensureSingleDynamicEndpoint(
      {
        name: CLIPROXY_LOCAL_NAME,
        baseUrl: discovered.baseUrl,
        protocol: "anthropic",
        pollingIntervalSec: store.getSettings().defaultPollingIntervalSec,
      },
      encrypted,
    );
  }

  const previous = store.listEndpoints();
  const candidate = previous.find((item) => item.name === CLIPROXY_LOCAL_NAME) ?? previous[0];
  const encrypted = candidate?.apiKeyEncrypted ?? encryptSecretWithDpapi("");
  const baseUrl = candidate?.baseUrl || CLIPROXY_FALLBACK_BASE_URL;
  const pollingIntervalSec = candidate?.pollingIntervalSec ?? store.getSettings().defaultPollingIntervalSec;

  return store.ensureSingleDynamicEndpoint(
    {
      name: CLIPROXY_LOCAL_NAME,
      baseUrl,
      protocol: "anthropic",
      pollingIntervalSec,
    },
    encrypted,
  );
}

const defaultClaudePath = await detectDefaultClaudeSettingsPath();
const store = new DataStore(STORAGE_PATH, defaultClaudePath);
await store.init();
await ensureCliproxyOnlyEndpoint(store);

const poller = new EndpointPoller(store, decryptSecretWithDpapi);
await poller.start();

const app = fastify({
  logger: false,
});

await app.register(cors, {
  origin: true,
});

app.get("/api/health", async () => ok({ status: "ok" }));

app.get("/api/endpoints", async () => {
  const endpoints = store.listEndpoints().map(toEndpointView);
  return ok(endpoints);
});

app.post("/api/endpoints/import-cliproxy", async (request, reply) => {
  try {
    const body = (request.body ?? {}) as { configPath?: string; configContent?: string; sourceName?: string };
    const config = isNonEmptyString(body.configContent)
      ? readCliproxyConfigFromContent(body.configContent, body.sourceName || "uploaded-config")
      : isNonEmptyString(body.configPath)
      ? await readCliproxyConfig(body.configPath)
      : await discoverCliproxyConfig();
    if (!config) {
      reply.code(404);
      return fail("No CLIProxy config found. Provide a configPath.");
    }

    const encrypted = encryptSecretWithDpapi(config.apiKey);
    const endpoint = await store.ensureSingleDynamicEndpoint(
      {
        name: CLIPROXY_LOCAL_NAME,
        baseUrl: config.baseUrl,
        protocol: "anthropic",
        pollingIntervalSec: store.getSettings().defaultPollingIntervalSec,
      },
      encrypted,
    );
    await poller.rebuild();
    return ok({
      endpoint: toEndpointView(endpoint),
      importedFrom: config.configPath,
      action: "updated" as const,
    });
  } catch (error) {
    reply.code(400);
    return fail(error instanceof Error ? error.message : "Failed to import CLIProxy config.");
  }
});

app.get("/api/endpoints/cliproxy-config", async () => {
  const discovered = await discoverCliproxyConfig();
  if (!discovered) {
    return ok({
      found: false,
      configPath: "",
      baseUrl: "",
    });
  }
  return ok({
    found: true,
    configPath: discovered.configPath,
    baseUrl: discovered.baseUrl,
  });
});

app.post("/api/endpoints/:id/refresh", async (request, reply) => {
  try {
    const params = request.params as { id?: string };
    if (!isNonEmptyString(params.id)) {
      reply.code(400);
      return fail("Missing endpoint id.");
    }
    const endpoint = store.listEndpoints()[0];
    if (!endpoint || endpoint.id !== params.id) {
      reply.code(404);
      return fail("Endpoint not found.");
    }
    await poller.refreshEndpoint(endpoint.id, "manual");
    const refreshed = store.getEndpointById(endpoint.id);
    if (!refreshed) {
      reply.code(404);
      return fail("Endpoint not found.");
    }
    return ok(toEndpointView(refreshed));
  } catch (error) {
    reply.code(500);
    return fail(error instanceof Error ? error.message : "Failed to refresh endpoint.");
  }
});

app.get("/api/models", async (request) => {
  const endpoint = store.listEndpoints()[0];
  if (!endpoint) {
    return ok([]);
  }
  const query = request.query as { source?: ModelSource };
  const models = store
    .listModels({
      endpointId: endpoint.id,
      source: query.source === "dynamic" || query.source === "manual" ? query.source : undefined,
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return ok(models);
});

app.post("/api/models/score", async (request, reply) => {
  try {
    console.log("[models/score] received request.");
    const endpoint = store.listEndpoints()[0];
    if (!endpoint) {
      console.warn("[models/score] CLIProxy endpoint not found.");
      reply.code(404);
      return fail("CLIProxy endpoint not found.");
    }
    const body = (request.body ?? {}) as { scoringModelId?: string };
    const scoringModelIdInput = isNonEmptyString(body.scoringModelId) ? body.scoringModelId.trim() : "";
    const models = store
      .listModels({ endpointId: endpoint.id })
      .sort((a, b) => a.modelId.localeCompare(b.modelId));
    console.log(`[models/score] scoringModelId=${scoringModelIdInput || "auto"} models=${models.length}`);
    if (!models.length) {
      console.log("[models/score] no models to score.");
      return ok({
        updatedCount: 0,
        changedCount: 0,
        source: "none",
        scoringModelId: scoringModelIdInput,
        models: [],
      });
    }
    if (scoringModelIdInput && !models.some((item) => item.modelId === scoringModelIdInput)) {
      console.warn(`[models/score] invalid scoringModelId: ${scoringModelIdInput}`);
      reply.code(400);
      return fail("scoringModelId not found in current model list.");
    }

    const scoringModelId = scoringModelIdInput || models[0].modelId;
    const apiKey = decryptSecretWithDpapi(endpoint.apiKeyEncrypted);
    if (!apiKey) {
      reply.code(400);
      return fail("Endpoint API key is empty.");
    }

    const scoringPayload = {
      objective: "Score model quality for Claude Code coding tasks.",
      targetVariables: [
        "model",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
      ],
      modelIds: models.map((model) => model.modelId),
      outputSchema: {
        scores: [
          {
            modelId: "string",
            score: "number(0-100)",
            tier: "high|medium|light",
            reason: "string(optional)",
          },
        ],
      },
    };
    const systemPrompt = "You are an expert LLM evaluator for coding tasks. Return strict JSON only.";
    const userPrompt = [
      "Score each model for Claude Code coding usage.",
      "Use only provided modelId values.",
      "Return exactly one score item per model.",
      "Score range: 0-100, higher means better coding quality + reliability for complex code tasks.",
      "Tier must be one of high|medium|light.",
      "Output JSON only. No markdown. No code fences.",
      `Judge model id: ${scoringModelId}`,
      "Scoring payload:",
      JSON.stringify(scoringPayload),
    ].join("\n");
    console.log("[models/score] scoring prompt (system):\n", systemPrompt);
    console.log("[models/score] scoring prompt (user):\n", userPrompt);

    const allowedModelIds = new Set(models.map((item) => item.modelId));
    let parsedScores = await requestAiScoreByChat(
      endpoint.baseUrl,
      apiKey,
      scoringModelId,
      systemPrompt,
      userPrompt,
      allowedModelIds,
    );
    let source: "ai_chat" | "ai_responses" = "ai_chat";
    if (!parsedScores) {
      parsedScores = await requestAiScoreByResponses(
        endpoint.baseUrl,
        apiKey,
        scoringModelId,
        systemPrompt,
        userPrompt,
        allowedModelIds,
      );
      source = "ai_responses";
    }
    if (!parsedScores) {
      reply.code(502);
      return fail("AI scoring failed: upstream did not return parseable JSON scores.");
    }
    console.log(`[models/score] parsed AI scores=${parsedScores.size}`);

    const now = new Date().toISOString();
    let changedCount = 0;
    const patches = models.map((model) => {
      const fallbackScore = estimatePerformanceScore(model.modelId, model.provider, scoringModelId);
      const fallbackTier = detectPerformanceTier(model.modelId);
      const fallbackQuota = inferQuotaLimit(model.modelId, model.provider, model.meta);
      const ai = parsedScores.get(model.modelId);
      const performanceScore = ai?.score ?? fallbackScore;
      const performanceTier = ai?.tier ?? fallbackTier;
      const quotaLimited = ai?.quotaLimited ?? fallbackQuota.hasQuotaLimit;
      const quotaReason = ai?.quotaReason ?? fallbackQuota.quotaReason;

      const prevScore = typeof model.meta?.performance_score === "number"
        ? model.meta.performance_score
        : Number.NaN;
      const prevTier = typeof model.meta?.performance_tier === "string" ? model.meta.performance_tier : "";
      if (!Number.isFinite(prevScore) || prevScore !== performanceScore || prevTier !== performanceTier) {
        changedCount += 1;
      }

      return {
        id: model.id,
        metaPatch: {
          performance_score: performanceScore,
          performance_tier: performanceTier,
          score_source: source,
          score_model_id: scoringModelId,
          scored_at: now,
          quota_limited: quotaLimited,
          quota_reason: quotaReason,
          score_reason: ai?.reason || null,
        },
      };
    });
    await store.patchModelMetaBatch(patches);

    const updatedModels = store
      .listModels({ endpointId: endpoint.id })
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    console.log(`[models/score] completed updatedCount=${patches.length} changedCount=${changedCount} source=${source}`);
    return ok({
      updatedCount: patches.length,
      changedCount,
      source,
      scoringModelId,
      models: updatedModels,
    });
  } catch (error) {
    console.error("[models/score] failed:", error);
    reply.code(500);
    return fail(error instanceof Error ? error.message : "Failed to score models.");
  }
});

app.get("/api/settings", async () => {
  return ok(store.getSettings());
});

app.put("/api/settings", async (request, reply) => {
  try {
    const body = (request.body ?? {}) as {
      claudeSettingsPath?: string;
      autoRefresh?: boolean;
      defaultPollingIntervalSec?: number;
    };
    const updated = await store.updateSettings(body);
    return ok(updated);
  } catch (error) {
    reply.code(400);
    return fail(error instanceof Error ? error.message : "Failed to update settings.");
  }
});

app.get("/api/fallback-chains", async (request, reply) => {
  try {
    const endpoint = store.listEndpoints()[0];
    if (!endpoint) {
      return ok([] as FallbackChainView[]);
    }

    const models = store.listModels({ endpointId: endpoint.id });
    const availableModelIds = new Set(models.map((item) => item.modelId));
    const settingsPath = store.getSettings().claudeSettingsPath;
    const current = await readClaudeSettings(settingsPath);
    const config = store.getSmartRouting();
    const modelKeys = Array.from(new Set([
      ...CLAUDE_MODEL_KEYS,
      ...Object.keys(current.env.modelValues),
      ...Object.keys(config.variables),
    ])).sort((a, b) => a.localeCompare(b));

    const rows: FallbackChainView[] = modelKeys.map((modelKey) => {
      const configured = current.env.modelValues[modelKey];
      const configuredModelId = isNonEmptyString(configured) && availableModelIds.has(configured)
        ? configured
        : undefined;
      const existing = config.variables[modelKey];
      const manualList = normalizeModelIdList(existing?.priorityList, availableModelIds);
      const priorityList = manualList.length
        ? manualList
        : configuredModelId
        ? [configuredModelId]
        : [];
      return {
        modelKey,
        currentModelId: priorityList[0] ?? configuredModelId,
        priorityList,
      };
    });

    return ok(rows);
  } catch (error) {
    reply.code(500);
    return fail(error instanceof Error ? error.message : "Failed to read fallback chains.");
  }
});

app.put("/api/fallback-chains/:modelKey", async (request, reply) => {
  try {
    const params = request.params as { modelKey?: string };
    if (!isNonEmptyString(params.modelKey)) {
      reply.code(400);
      return fail("modelKey is required.");
    }
    const modelKey = params.modelKey.trim();

    const endpoint = store.listEndpoints()[0];
    if (!endpoint) {
      reply.code(404);
      return fail("CLIProxy endpoint not found.");
    }
    const models = store.listModels({ endpointId: endpoint.id });
    const availableModelIds = new Set(models.map((item) => item.modelId));

    const body = (request.body ?? {}) as { priorityList?: string[] };
    const inputList = Array.isArray(body.priorityList) ? body.priorityList : [];
    const priorityList = normalizeModelIdList(inputList, availableModelIds);
    if (!priorityList.length) {
      reply.code(400);
      return fail("priorityList must include at least one valid model.");
    }

    const targetModelId = priorityList[0];
    const targetModel = models.find((item) => item.modelId === targetModelId);
    if (!targetModel) {
      reply.code(400);
      return fail("First model in priorityList is not available.");
    }
    const apiKey = decryptSecretWithDpapi(endpoint.apiKeyEncrypted);
    const settingsPath = store.getSettings().claudeSettingsPath;
    await applyClaudeSettings({
      settingsPath,
      baseUrl: endpoint.baseUrl,
      apiKey,
      modelId: targetModelId,
      modelKey,
    });

    const config = store.getSmartRouting();
    const existing = config.variables[modelKey];
    const nextPolicy: SmartRoutingVariablePolicy = {
      modelKey,
      priorityList,
      currentModelId: targetModelId,
      lastSwitchAt: new Date().toISOString(),
      lastReason: "manual_fallback_update",
      lockTop: true,
    };
    config.enabled = false;
    config.autoApplyToClaude = false;
    config.variables[modelKey] = nextPolicy;
    await store.setSmartRouting(config);

    return ok({
      modelKey,
      currentModelId: nextPolicy.currentModelId,
      priorityList: nextPolicy.priorityList,
    } satisfies FallbackChainView);
  } catch (error) {
    reply.code(400);
    return fail(error instanceof Error ? error.message : "Failed to update fallback chain.");
  }
});

app.get("/api/claude/detect-settings", async () => {
  const configured = store.getSettings().claudeSettingsPath;
  const detected = await detectDefaultClaudeSettingsPath();
  return ok({
    detectedPath: path.resolve(detected),
    configuredPath: path.resolve(configured),
  });
});

app.get("/api/claude/current", async () => {
  const settingsPath = store.getSettings().claudeSettingsPath;
  const current = await readClaudeSettings(settingsPath);
  const modelKeys = Array.from(new Set([
    ...CLAUDE_MODEL_KEYS,
    ...Object.keys(current.env.modelValues),
  ]));
  return ok({
    settingsPath: current.settingsPath,
    exists: current.exists,
    env: {
      ANTHROPIC_BASE_URL: current.env.ANTHROPIC_BASE_URL,
      hasAuthToken: Boolean(current.env.ANTHROPIC_AUTH_TOKEN),
      ANTHROPIC_AUTH_TOKEN_MASKED: current.env.ANTHROPIC_AUTH_TOKEN
        ? maskSecret(current.env.ANTHROPIC_AUTH_TOKEN)
        : "",
      modelValues: current.env.modelValues,
      modelKeys,
    },
  });
});

app.post("/api/claude/apply", async (request, reply) => {
  try {
    const body = request.body as Partial<ApplyClaudeInput> | undefined;
    if (!body || !isNonEmptyString(body.modelRecordId)) {
      reply.code(400);
      return fail("modelRecordId is required.");
    }

    const endpoint = store.listEndpoints()[0];
    if (!endpoint) {
      reply.code(404);
      return fail("CLIProxy endpoint not found.");
    }

    const model = store.getModelById(body.modelRecordId);
    if (!model || model.endpointId !== endpoint.id) {
      reply.code(404);
      return fail("Model not found under CLIProxy endpoint.");
    }

    const secret = decryptSecretWithDpapi(endpoint.apiKeyEncrypted);
    const settingsPath = isNonEmptyString(body.claudeSettingsPath)
      ? body.claudeSettingsPath
      : store.getSettings().claudeSettingsPath;
    const modelKey = isNonEmptyString(body.modelKey) ? body.modelKey.trim() : "ANTHROPIC_MODEL";

    const result = await applyClaudeSettings({
      settingsPath,
      baseUrl: endpoint.baseUrl,
      apiKey: secret,
      modelId: model.modelId,
      modelKey,
    });

    return ok({
      ...result,
      endpointId: endpoint.id,
      endpointName: endpoint.name,
      modelRecordId: model.id,
      modelId: model.modelId,
      modelSource: model.source,
      modelKey,
      applyMode: "direct_anthropic",
      resolvedBaseUrl: endpoint.baseUrl,
    });
  } catch (error) {
    reply.code(500);
    return fail(error instanceof Error ? error.message : "Failed to apply Claude settings.");
  }
});

const frontendDistCandidates = [
  path.resolve(process.cwd(), "frontend", "dist"),
  path.resolve(process.cwd(), "..", "frontend", "dist"),
];
const frontendDistPath = frontendDistCandidates.find((candidate) =>
  fs.existsSync(path.join(candidate, "index.html"))
);
if (frontendDistPath) {
  await app.register(fastifyStatic, {
    root: frontendDistPath,
    prefix: "/",
    allowedPath: (_pathName, _root, request) => {
      return !request.url.startsWith("/api/");
    },
  });

  app.get("/", async (_request, reply) => {
    return reply.sendFile("index.html");
  });
}

app.setErrorHandler((error, _request, reply) => {
  console.error("[api] unhandled error:", error);
  const message = error instanceof Error ? error.message : "Internal server error";
  const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number"
    ? (error as { statusCode: number }).statusCode
    : 500;
  reply.code(statusCode).send(fail(message));
});

await app.listen({
  host: "127.0.0.1",
  port: DEFAULT_BACKEND_PORT,
});

console.log(`model-manager backend listening on http://127.0.0.1:${DEFAULT_BACKEND_PORT}`);
