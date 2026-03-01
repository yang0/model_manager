import path from "node:path";
import fs from "node:fs";
import fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import type {
  ApiResult,
  ApplyClaudeInput,
  CreateEndpointInput,
  EndpointProtocol,
  EndpointRecord,
  EndpointView,
  ModelSource,
  UpdateEndpointInput,
  UpsertManualModelInput,
} from "@model-manager/shared";
import {
  DEFAULT_BACKEND_PORT,
  LOCAL_GATEWAY_BASE_URL,
  STORAGE_PATH,
} from "./constants.js";
import { applyClaudeSettings, detectDefaultClaudeSettingsPath, readClaudeSettings } from "./claude.js";
import { discoverCliproxyConfig, readCliproxyConfig, readCliproxyConfigFromContent } from "./cliproxy-config.js";
import { decryptSecretWithDpapi, encryptSecretWithDpapi } from "./dpapi.js";
import {
  buildGatewayAuthToken,
  buildOpenAiResponsesPayloadFromAnthropic,
  convertOpenAiResponseToAnthropic,
  estimateInputTokensFromAnthropic,
  requestOpenAiModels,
  requestOpenAiResponses,
  resolveGatewayEndpointFromAuthHeader,
  sendAnthropicStream,
  toUpstreamFailure,
} from "./gateway.js";
import { maskSecret } from "./utils.js";
import { DataStore } from "./storage.js";
import { EndpointPoller } from "./poller.js";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeEndpointProtocol(protocol: unknown): EndpointProtocol {
  return protocol === "openai_responses" ? "openai_responses" : "anthropic";
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
    protocol: endpoint.protocol,
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

function anthropicFail(message: string, type = "api_error"): Record<string, unknown> {
  return {
    type: "error",
    error: {
      type,
      message,
    },
  };
}

const defaultClaudePath = await detectDefaultClaudeSettingsPath();
const store = new DataStore(STORAGE_PATH, defaultClaudePath);
await store.init();
const poller = new EndpointPoller(store, decryptSecretWithDpapi);

if (store.listEndpoints().length === 0) {
  const discovered = await discoverCliproxyConfig();
  if (discovered) {
    const encrypted = encryptSecretWithDpapi(discovered.apiKey);
    await store.createEndpoint(
      {
        name: discovered.endpointName,
        baseUrl: discovered.baseUrl,
        apiKey: discovered.apiKey,
        protocol: "anthropic",
        enabled: true,
        dynamicEnabled: true,
        pollingIntervalSec: store.getSettings().defaultPollingIntervalSec,
      },
      encrypted,
    );
  }
}

await poller.start();

const app = fastify({
  logger: false,
});

await app.register(cors, {
  origin: true,
});

app.get("/v1/models", async (request, reply) => {
  const resolved = resolveGatewayEndpointFromAuthHeader(
    request.headers.authorization,
    store,
    decryptSecretWithDpapi,
  );
  if (!resolved) {
    reply.code(401);
    return anthropicFail("Invalid or expired gateway token.", "authentication_error");
  }

  try {
    return await requestOpenAiModels(resolved.endpoint, resolved.apiKey);
  } catch (error) {
    const failure = toUpstreamFailure(error);
    console.error(
      `[gateway:/v1/models] endpoint=${resolved.endpoint.name} baseUrl=${resolved.endpoint.baseUrl} status=${failure.statusCode} error=${failure.message}`,
    );
    reply.code(failure.statusCode);
    return anthropicFail(failure.message);
  }
});

app.post("/v1/messages/count_tokens", async (request, reply) => {
  const resolved = resolveGatewayEndpointFromAuthHeader(
    request.headers.authorization,
    store,
    decryptSecretWithDpapi,
  );
  if (!resolved) {
    reply.code(401);
    return anthropicFail("Invalid or expired gateway token.", "authentication_error");
  }

  const inputTokens = estimateInputTokensFromAnthropic(request.body ?? {});
  return {
    input_tokens: inputTokens,
  };
});

app.post("/v1/messages", async (request, reply) => {
  const resolved = resolveGatewayEndpointFromAuthHeader(
    request.headers.authorization,
    store,
    decryptSecretWithDpapi,
  );
  if (!resolved) {
    reply.code(401);
    return anthropicFail("Invalid or expired gateway token.", "authentication_error");
  }

  const body = (request.body ?? {}) as Record<string, unknown>;
  const wantsStream = body.stream === true;
  const payload = buildOpenAiResponsesPayloadFromAnthropic(body);
  const fallbackModel = isNonEmptyString(body.model) ? body.model : "";
  const messageCount = Array.isArray(body.messages) ? body.messages.length : 0;
  const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;

  try {
    const upstream = await requestOpenAiResponses(resolved.endpoint, resolved.apiKey, payload);
    const anthropicMessage = convertOpenAiResponseToAnthropic(upstream, fallbackModel);

    if (wantsStream) {
      sendAnthropicStream(reply, anthropicMessage);
      return reply;
    }

    return anthropicMessage;
  } catch (error) {
    const failure = toUpstreamFailure(error);
    try {
      const debugPath = path.resolve(process.cwd(), "gateway-last-failure.json");
      const snapshot = {
        at: new Date().toISOString(),
        endpointId: resolved.endpoint.id,
        endpointName: resolved.endpoint.name,
        endpointBaseUrl: resolved.endpoint.baseUrl,
        failure,
        anthBodySummary: {
          model: fallbackModel,
          stream: wantsStream,
          messageCount,
          toolCount,
          toolNames: Array.isArray(body.tools)
            ? body.tools
              .map((item) => (item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string")
                ? (item as { name: string }).name
                : "")
              .filter(Boolean)
            : [],
        },
        openaiPayload: payload,
      };
      fs.writeFileSync(debugPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    } catch {
      // Ignore debug snapshot failures.
    }
    console.error(
      `[gateway:/v1/messages] endpoint=${resolved.endpoint.name} baseUrl=${resolved.endpoint.baseUrl} status=${failure.statusCode} model=${fallbackModel || "N/A"} stream=${String(wantsStream)} messages=${messageCount} tools=${toolCount} error=${failure.message}`,
    );
    reply.code(failure.statusCode);
    return anthropicFail(failure.message);
  }
});

app.get("/api/health", async () => ok({ status: "ok" }));

app.get("/api/endpoints", async () => {
  const endpoints = store.listEndpoints().map(toEndpointView);
  return ok(endpoints);
});

app.post("/api/endpoints", async (request, reply) => {
  try {
    const body = request.body as Partial<CreateEndpointInput> | undefined;
    if (!body || !isNonEmptyString(body.name) || !isNonEmptyString(body.baseUrl) || !isNonEmptyString(body.apiKey)) {
      reply.code(400);
      return fail("name, baseUrl and apiKey are required.");
    }

    const encrypted = encryptSecretWithDpapi(body.apiKey);
    const endpoint = await store.createEndpoint(
      {
        name: body.name,
        baseUrl: body.baseUrl,
        apiKey: body.apiKey,
        protocol: normalizeEndpointProtocol(body.protocol),
        enabled: body.enabled,
        dynamicEnabled: body.dynamicEnabled,
        pollingIntervalSec: body.pollingIntervalSec ?? store.getSettings().defaultPollingIntervalSec,
      },
      encrypted,
    );

    await poller.rebuild();
    return ok(toEndpointView(endpoint));
  } catch (error) {
    reply.code(500);
    return fail(error instanceof Error ? error.message : "Failed to create endpoint.");
  }
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

    const existing = store.listEndpoints().find((item) => item.baseUrl === config.baseUrl);
    const encrypted = encryptSecretWithDpapi(config.apiKey);

    if (existing) {
      const updated = await store.updateEndpoint(existing.id, {
        name: existing.name || config.endpointName,
        protocol: "anthropic",
        enabled: true,
        dynamicEnabled: true,
      }, encrypted);
      await poller.rebuild();
      return ok({
        endpoint: toEndpointView(updated),
        importedFrom: config.configPath,
        action: "updated",
      });
    }

    const created = await store.createEndpoint(
      {
        name: config.endpointName,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        protocol: "anthropic",
        enabled: true,
        dynamicEnabled: true,
        pollingIntervalSec: store.getSettings().defaultPollingIntervalSec,
      },
      encrypted,
    );
    await poller.rebuild();
    return ok({
      endpoint: toEndpointView(created),
      importedFrom: config.configPath,
      action: "created",
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

app.put("/api/endpoints/:id", async (request, reply) => {
  try {
    const params = request.params as { id?: string };
    if (!isNonEmptyString(params.id)) {
      reply.code(400);
      return fail("Missing endpoint id.");
    }

    const body = (request.body ?? {}) as Partial<UpdateEndpointInput>;
    const encrypted = isNonEmptyString(body.apiKey) ? encryptSecretWithDpapi(body.apiKey) : undefined;
    const endpoint = await store.updateEndpoint(params.id, body, encrypted);
    await poller.rebuild();
    return ok(toEndpointView(endpoint));
  } catch (error) {
    reply.code(400);
    return fail(error instanceof Error ? error.message : "Failed to update endpoint.");
  }
});

app.get("/api/endpoints/:id/api-key", async (request, reply) => {
  try {
    const params = request.params as { id?: string };
    if (!isNonEmptyString(params.id)) {
      reply.code(400);
      return fail("Missing endpoint id.");
    }
    const endpoint = store.getEndpointById(params.id);
    if (!endpoint) {
      reply.code(404);
      return fail("Endpoint not found.");
    }
    const apiKey = decryptSecretWithDpapi(endpoint.apiKeyEncrypted);
    return ok({ apiKey });
  } catch (error) {
    reply.code(500);
    return fail(error instanceof Error ? error.message : "Failed to read endpoint api key.");
  }
});

app.delete("/api/endpoints/:id", async (request, reply) => {
  try {
    const params = request.params as { id?: string };
    if (!isNonEmptyString(params.id)) {
      reply.code(400);
      return fail("Missing endpoint id.");
    }
    await store.deleteEndpoint(params.id);
    await poller.rebuild();
    return ok({ deleted: true });
  } catch (error) {
    reply.code(500);
    return fail(error instanceof Error ? error.message : "Failed to delete endpoint.");
  }
});

app.post("/api/endpoints/:id/refresh", async (request, reply) => {
  try {
    const params = request.params as { id?: string };
    if (!isNonEmptyString(params.id)) {
      reply.code(400);
      return fail("Missing endpoint id.");
    }
    await poller.refreshEndpoint(params.id, "manual");
    const endpoint = store.getEndpointById(params.id);
    if (!endpoint) {
      reply.code(404);
      return fail("Endpoint not found.");
    }
    return ok(toEndpointView(endpoint));
  } catch (error) {
    reply.code(500);
    return fail(error instanceof Error ? error.message : "Failed to refresh endpoint.");
  }
});

app.get("/api/models", async (request) => {
  const query = request.query as { endpointId?: string; source?: ModelSource };
  const models = store
    .listModels({
      endpointId: isNonEmptyString(query.endpointId) ? query.endpointId : undefined,
      source: query.source === "dynamic" || query.source === "manual" ? query.source : undefined,
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return ok(models);
});

app.post("/api/models/manual", async (request, reply) => {
  try {
    const body = request.body as Partial<UpsertManualModelInput> | undefined;
    if (!body || !isNonEmptyString(body.endpointId) || !isNonEmptyString(body.modelId)) {
      reply.code(400);
      return fail("endpointId and modelId are required.");
    }
    const model = await store.createManualModel({
      endpointId: body.endpointId,
      modelId: body.modelId,
      displayName: body.displayName,
      provider: body.provider,
      enabled: body.enabled,
    });
    return ok(model);
  } catch (error) {
    reply.code(400);
    return fail(error instanceof Error ? error.message : "Failed to create manual model.");
  }
});

app.put("/api/models/manual/:id", async (request, reply) => {
  try {
    const params = request.params as { id?: string };
    if (!isNonEmptyString(params.id)) {
      reply.code(400);
      return fail("Missing model id.");
    }
    const body = (request.body ?? {}) as Partial<UpsertManualModelInput>;
    const model = await store.updateManualModel(params.id, body);
    return ok(model);
  } catch (error) {
    reply.code(400);
    return fail(error instanceof Error ? error.message : "Failed to update manual model.");
  }
});

app.delete("/api/models/manual/:id", async (request, reply) => {
  try {
    const params = request.params as { id?: string };
    if (!isNonEmptyString(params.id)) {
      reply.code(400);
      return fail("Missing model id.");
    }
    await store.deleteManualModel(params.id);
    return ok({ deleted: true });
  } catch (error) {
    reply.code(500);
    return fail(error instanceof Error ? error.message : "Failed to delete manual model.");
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
  const defaultModelKeys = [
    "model",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
  ];
  const modelKeys = Array.from(new Set([
    ...defaultModelKeys,
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
    if (!body || !isNonEmptyString(body.endpointId) || !isNonEmptyString(body.modelRecordId)) {
      reply.code(400);
      return fail("endpointId and modelRecordId are required.");
    }

    const endpoint = store.getEndpointById(body.endpointId);
    if (!endpoint) {
      reply.code(404);
      return fail("Endpoint not found.");
    }

    const model = store.getModelById(body.modelRecordId);
    if (!model || model.endpointId !== endpoint.id) {
      reply.code(404);
      return fail("Model not found under selected endpoint.");
    }

    const secret = decryptSecretWithDpapi(endpoint.apiKeyEncrypted);
    const applyMode = endpoint.protocol === "openai_responses" ? "via_local_gateway" : "direct_anthropic";
    const resolvedBaseUrl = applyMode === "via_local_gateway"
      ? LOCAL_GATEWAY_BASE_URL
      : endpoint.baseUrl;
    const resolvedApiKey = applyMode === "via_local_gateway"
      ? buildGatewayAuthToken(endpoint.id)
      : secret;
    const settingsPath = isNonEmptyString(body.claudeSettingsPath)
      ? body.claudeSettingsPath
      : store.getSettings().claudeSettingsPath;
    const modelKey = isNonEmptyString(body.modelKey) ? body.modelKey.trim() : "ANTHROPIC_MODEL";

    const result = await applyClaudeSettings({
      settingsPath,
      baseUrl: resolvedBaseUrl,
      apiKey: resolvedApiKey,
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
      applyMode,
      resolvedBaseUrl,
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
      return !(request.url.startsWith("/api/") || request.url.startsWith("/v1/"));
    },
  });

  app.get("/", async (_request, reply) => {
    return reply.sendFile("index.html");
  });
}

app.setErrorHandler((error, _request, reply) => {
  const message = error instanceof Error ? error.message : "Internal server error";
  reply.code(500).send(fail(message));
});

await app.listen({
  host: "127.0.0.1",
  port: DEFAULT_BACKEND_PORT,
});

console.log(`model-manager backend listening on http://127.0.0.1:${DEFAULT_BACKEND_PORT}`);
