import type { EndpointRecord } from "@model-manager/shared";
import type { FastifyReply } from "fastify";
import { LOCAL_GATEWAY_TOKEN_PREFIX } from "./constants.js";
import type { DataStore } from "./storage.js";
import { normalizeBaseUrl } from "./utils.js";

type DecryptFn = (ciphertext: string) => string;

interface GatewayResolvedEndpoint {
  endpoint: EndpointRecord;
  apiKey: string;
}

interface UpstreamRequestFailure {
  statusCode: number;
  message: string;
}

interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
}

export interface AnthropicGatewayMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

function toObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeJsonString(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseBearerToken(authHeader: string | undefined): string {
  if (!authHeader) {
    return "";
  }
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match?.[1]?.trim() ?? "";
}

function toResponseRole(role: string): "user" | "assistant" | "system" {
  if (role === "assistant") {
    return "assistant";
  }
  if (role === "system") {
    return "system";
  }
  return "user";
}

function buildTextFromAnthropicContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  const blocks = toArray(content);
  const fragments: string[] = [];
  for (const block of blocks) {
    const blockObj = toObject(block);
    const type = toString(blockObj.type);
    if (typeof block === "string") {
      fragments.push(block);
      continue;
    }
    if (type === "text" && typeof blockObj.text === "string") {
      fragments.push(blockObj.text);
      continue;
    }
    if ((type === "thinking" || type === "redacted_thinking") && typeof blockObj.text === "string") {
      fragments.push(blockObj.text);
      continue;
    }
    if (type === "tool_result") {
      const nested = buildTextFromAnthropicContent(blockObj.content);
      if (nested) {
        fragments.push(nested);
      }
      continue;
    }
    if (typeof blockObj.text === "string") {
      fragments.push(blockObj.text);
      continue;
    }
    const raw = safeJsonString(block);
    if (raw !== "{}") {
      fragments.push(raw);
    }
  }
  return fragments.join("\n");
}

function toInputImageBlock(blockObj: Record<string, unknown>): Record<string, unknown> | null {
  const source = toObject(blockObj.source);
  const sourceType = toString(source.type);

  if (sourceType === "base64") {
    const data = toString(source.data);
    if (!data) {
      return null;
    }
    const mediaType = toString(source.media_type) ?? "image/png";
    return {
      type: "input_image",
      image_url: `data:${mediaType};base64,${data}`,
    };
  }

  if (sourceType === "url") {
    const url = toString(source.url);
    if (!url) {
      return null;
    }
    return {
      type: "input_image",
      image_url: url,
    };
  }

  const imageUrl = toString(blockObj.image_url);
  if (!imageUrl) {
    return null;
  }
  return {
    type: "input_image",
    image_url: imageUrl,
  };
}

function pushResponseMessage(
  inputItems: Array<Record<string, unknown>>,
  role: "user" | "assistant" | "system",
  textParts: string[],
  imageBlocks: Array<Record<string, unknown>>,
): void {
  const text = textParts.join("\n").trim();
  if (role === "assistant") {
    if (text) {
      inputItems.push({
        role: "assistant",
        content: text,
      });
    }
    return;
  }

  const contentBlocks: Array<Record<string, unknown>> = [];
  if (text) {
    contentBlocks.push({
      type: "input_text",
      text,
    });
  }
  if (imageBlocks.length > 0) {
    contentBlocks.push(...imageBlocks);
  }
  if (contentBlocks.length === 0) {
    return;
  }

  inputItems.push({
    role,
    content: contentBlocks,
  });
}

function convertAnthropicTools(toolsRaw: unknown): Array<Record<string, unknown>> {
  const tools = toArray(toolsRaw);
  const converted: Array<Record<string, unknown>> = [];
  for (const item of tools) {
    const obj = toObject(item);
    const name = toString(obj.name);
    if (!name) {
      continue;
    }
    const parameters = toObject(obj.input_schema);
    const tool: Record<string, unknown> = {
      type: "function",
      name,
      parameters: Object.keys(parameters).length > 0 ? parameters : { type: "object", properties: {} },
    };
    const description = toString(obj.description);
    if (description) {
      tool.description = description;
    }
    converted.push(tool);
  }
  return converted;
}

function convertAnthropicToolChoice(toolChoiceRaw: unknown): unknown {
  if (typeof toolChoiceRaw === "string") {
    if (toolChoiceRaw === "any") {
      return "required";
    }
    return toolChoiceRaw;
  }

  const obj = toObject(toolChoiceRaw);
  const type = toString(obj.type);
  if (!type) {
    return undefined;
  }
  if (type === "auto" || type === "none") {
    return type;
  }
  if (type === "any") {
    return "required";
  }
  if (type === "tool") {
    const name = toString(obj.name);
    return name
      ? {
          type: "function",
          name,
        }
      : "required";
  }
  return undefined;
}

export function buildGatewayAuthToken(endpointId: string): string {
  return `${LOCAL_GATEWAY_TOKEN_PREFIX}${endpointId}`;
}

export function resolveGatewayEndpointFromAuthHeader(
  authHeader: string | undefined,
  store: DataStore,
  decryptSecret: DecryptFn,
): GatewayResolvedEndpoint | null {
  const token = parseBearerToken(authHeader);
  if (!token.startsWith(LOCAL_GATEWAY_TOKEN_PREFIX)) {
    return null;
  }
  const endpointId = token.slice(LOCAL_GATEWAY_TOKEN_PREFIX.length).trim();
  if (!endpointId) {
    return null;
  }
  const endpoint = store.getEndpointById(endpointId);
  if (!endpoint || !endpoint.enabled || endpoint.protocol !== "openai_responses") {
    return null;
  }

  try {
    const apiKey = decryptSecret(endpoint.apiKeyEncrypted);
    if (!apiKey) {
      return null;
    }
    return { endpoint, apiKey };
  } catch {
    return null;
  }
}

export function buildOpenAiResponsesPayloadFromAnthropic(bodyRaw: unknown): Record<string, unknown> {
  const body = toObject(bodyRaw);
  const inputItems: Array<Record<string, unknown>> = [];

  const systemText = buildTextFromAnthropicContent(body.system);
  if (systemText.trim()) {
    inputItems.push({
      role: "system",
      content: [{ type: "input_text", text: systemText.trim() }],
    });
  }

  for (const item of toArray(body.messages)) {
    const messageObj = toObject(item);
    const role = toResponseRole(toString(messageObj.role) ?? "user");
    const content = messageObj.content;

    if (typeof content === "string") {
      pushResponseMessage(inputItems, role, [content], []);
      continue;
    }

    const blocks = toArray(content);
    if (blocks.length === 0) {
      const fallbackText = buildTextFromAnthropicContent(content);
      if (fallbackText.trim()) {
        pushResponseMessage(inputItems, role, [fallbackText], []);
      }
      continue;
    }

    let textParts: string[] = [];
    let imageBlocks: Array<Record<string, unknown>> = [];
    const flush = () => {
      pushResponseMessage(inputItems, role, textParts, imageBlocks);
      textParts = [];
      imageBlocks = [];
    };

    for (const block of blocks) {
      const blockObj = toObject(block);
      const type = toString(blockObj.type);

      if (type === "text" && typeof blockObj.text === "string") {
        textParts.push(blockObj.text);
        continue;
      }

      if ((type === "thinking" || type === "redacted_thinking") && typeof blockObj.text === "string") {
        textParts.push(blockObj.text);
        continue;
      }

      if (type === "image") {
        const imageBlock = toInputImageBlock(blockObj);
        if (imageBlock) {
          imageBlocks.push(imageBlock);
        }
        continue;
      }

      if (type === "tool_use") {
        flush();
        if (role !== "assistant") {
          continue;
        }
        const callId = toString(blockObj.id) ?? `tool_call_${Date.now()}`;
        const name = toString(blockObj.name) ?? "tool";
        inputItems.push({
          type: "function_call",
          call_id: callId,
          name,
          arguments: safeJsonString(blockObj.input ?? {}),
        });
        continue;
      }

      if (type === "tool_result") {
        flush();
        const callId = toString(blockObj.tool_use_id) ?? toString(blockObj.id) ?? `tool_result_${Date.now()}`;
        const output = buildTextFromAnthropicContent(blockObj.content) || safeJsonString(blockObj.content);
        inputItems.push({
          type: "function_call_output",
          call_id: callId,
          output,
        });
        continue;
      }

      const fallbackText = buildTextFromAnthropicContent(block);
      if (fallbackText.trim()) {
        textParts.push(fallbackText);
      }
    }

    flush();
  }

  const payload: Record<string, unknown> = {
    model: toString(body.model) ?? "",
    input: inputItems,
    stream: false,
  };

  const maxTokens = toNumber(body.max_tokens);
  if (typeof maxTokens === "number") {
    payload.max_output_tokens = maxTokens;
  }

  const temperature = toNumber(body.temperature);
  if (typeof temperature === "number") {
    payload.temperature = temperature;
  }

  const topP = toNumber(body.top_p);
  if (typeof topP === "number") {
    payload.top_p = topP;
  }

  const stopSequences = toArray(body.stop_sequences).filter((item): item is string => typeof item === "string");
  if (stopSequences.length > 0) {
    payload.stop = stopSequences;
  }

  const tools = convertAnthropicTools(body.tools);
  if (tools.length > 0) {
    payload.tools = tools;
  }

  const toolChoice = convertAnthropicToolChoice(body.tool_choice);
  if (toolChoice !== undefined) {
    payload.tool_choice = toolChoice;
  }

  // Some OpenAI-compatible gateways (including certain proxy stacks) return 5xx
  // when metadata is present, even if it is valid JSON. Skip metadata forwarding
  // to maximize compatibility with Claude Code requests.

  return payload;
}

function parseOpenAiFailure(responseStatus: number, payload: unknown, fallbackText: string): UpstreamRequestFailure {
  const obj = toObject(payload);
  const errorObj = toObject(obj.error);
  const message = toString(errorObj.message) ?? toString(obj.message) ?? fallbackText;
  return {
    statusCode: responseStatus,
    message: message || `Upstream returned status ${responseStatus}`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

function isLikelyTransientNetworkError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("fetch failed") ||
    lower.includes("socket") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("timeout") ||
    lower.includes("tls") ||
    lower.includes("network")
  );
}

export async function requestOpenAiResponses(
  endpoint: EndpointRecord,
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const retryConfig: RetryConfig = {
    maxAttempts: 3,
    initialDelayMs: 800,
  };
  const requestBody = JSON.stringify(payload);

  let lastError: UpstreamRequestFailure | null = null;
  for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300_000);
    try {
      const response = await fetch(`${normalizeBaseUrl(endpoint.baseUrl)}/v1/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: requestBody,
        signal: controller.signal,
      });

      const responseText = await response.text();
      let responsePayload: unknown = {};
      try {
        responsePayload = responseText ? JSON.parse(responseText) : {};
      } catch {
        responsePayload = { message: responseText };
      }

      if (!response.ok) {
        const failure = parseOpenAiFailure(response.status, responsePayload, responseText);
        lastError = failure;
        if (attempt < retryConfig.maxAttempts && isRetryableStatus(failure.statusCode)) {
          await sleep(retryConfig.initialDelayMs * attempt);
          continue;
        }
        throw failure;
      }

      return responsePayload;
    } catch (error) {
      const maybeFailure = error as Partial<UpstreamRequestFailure> & Error;
      let failure: UpstreamRequestFailure;

      if (typeof maybeFailure.statusCode === "number" && typeof maybeFailure.message === "string") {
        failure = {
          statusCode: maybeFailure.statusCode,
          message: maybeFailure.message,
        };
      } else if (maybeFailure.name === "AbortError") {
        failure = {
          statusCode: 504,
          message: "Upstream request timed out.",
        };
      } else {
        failure = {
          statusCode: 502,
          message: maybeFailure.message || "Failed to reach upstream OpenAI endpoint.",
        };
      }

      lastError = failure;
      if (
        attempt < retryConfig.maxAttempts
        && (isRetryableStatus(failure.statusCode) || isLikelyTransientNetworkError(failure.message))
      ) {
        await sleep(retryConfig.initialDelayMs * attempt);
        continue;
      }

      throw failure;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw (
    lastError ?? {
      statusCode: 502,
      message: "Failed to reach upstream OpenAI endpoint.",
    }
  );
}

export async function requestOpenAiModels(endpoint: EndpointRecord, apiKey: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${normalizeBaseUrl(endpoint.baseUrl)}/v1/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: unknown = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { message: text };
    }
    if (!response.ok) {
      throw parseOpenAiFailure(response.status, payload, text);
    }
    return payload;
  } catch (error) {
    const maybeFailure = error as Partial<UpstreamRequestFailure> & Error;
    if (typeof maybeFailure.statusCode === "number" && typeof maybeFailure.message === "string") {
      throw maybeFailure;
    }
    if (maybeFailure.name === "AbortError") {
      throw {
        statusCode: 504,
        message: "Upstream model request timed out.",
      } satisfies UpstreamRequestFailure;
    }
    throw {
      statusCode: 502,
      message: maybeFailure.message || "Failed to fetch upstream models.",
    } satisfies UpstreamRequestFailure;
  } finally {
    clearTimeout(timeout);
  }
}

export function convertOpenAiResponseToAnthropic(
  upstreamRaw: unknown,
  fallbackModel: string,
): AnthropicGatewayMessage {
  const upstream = toObject(upstreamRaw);
  const output = toArray(upstream.output);
  const content: AnthropicGatewayMessage["content"] = [];
  let hasToolUse = false;

  for (const item of output) {
    const itemObj = toObject(item);
    const type = toString(itemObj.type);

    if (type === "message") {
      const messageContent = toArray(itemObj.content);
      for (const part of messageContent) {
        const partObj = toObject(part);
        const partType = toString(partObj.type);
        if ((partType === "output_text" || partType === "text") && typeof partObj.text === "string") {
          content.push({
            type: "text",
            text: partObj.text,
          });
        }
      }
      continue;
    }

    if (type === "function_call") {
      hasToolUse = true;
      const name = toString(itemObj.name) ?? "tool";
      const id = toString(itemObj.call_id) ?? toString(itemObj.id) ?? `tool_${content.length + 1}`;
      content.push({
        type: "tool_use",
        id,
        name,
        input: parseJsonObject(itemObj.arguments),
      });
    }
  }

  const outputText = toString(upstream.output_text);
  if (content.length === 0 && outputText) {
    content.push({
      type: "text",
      text: outputText,
    });
  }

  const usage = toObject(upstream.usage);
  const inputTokens = toNumber(usage.input_tokens) ?? 0;
  const outputTokens = toNumber(usage.output_tokens) ?? 0;

  let stopReason: AnthropicGatewayMessage["stop_reason"] = hasToolUse ? "tool_use" : "end_turn";
  const incompleteDetails = toObject(upstream.incomplete_details);
  if (toString(incompleteDetails.reason) === "max_output_tokens") {
    stopReason = "max_tokens";
  }

  return {
    id: toString(upstream.id) ?? `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: toString(upstream.model) ?? fallbackModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  };
}

function chunkText(text: string, size: number): string[] {
  if (!text) {
    return [];
  }
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

function writeSse(rawReply: FastifyReply["raw"], event: string, payload: unknown): void {
  rawReply.write(`event: ${event}\n`);
  rawReply.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function sendAnthropicStream(reply: FastifyReply, message: AnthropicGatewayMessage): void {
  reply.hijack();
  const raw = reply.raw;
  raw.statusCode = 200;
  raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  raw.setHeader("Cache-Control", "no-cache, no-transform");
  raw.setHeader("Connection", "keep-alive");
  raw.setHeader("X-Accel-Buffering", "no");

  writeSse(raw, "message_start", {
    type: "message_start",
    message: {
      id: message.id,
      type: "message",
      role: "assistant",
      model: message.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: message.usage.input_tokens,
        output_tokens: 0,
      },
    },
  });

  for (let index = 0; index < message.content.length; index += 1) {
    const block = message.content[index];
    if (block.type === "text") {
      writeSse(raw, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "text",
          text: "",
        },
      });
      for (const chunk of chunkText(block.text, 160)) {
        writeSse(raw, "content_block_delta", {
          type: "content_block_delta",
          index,
          delta: {
            type: "text_delta",
            text: chunk,
          },
        });
      }
      writeSse(raw, "content_block_stop", {
        type: "content_block_stop",
        index,
      });
      continue;
    }

    writeSse(raw, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: {},
      },
    });
    writeSse(raw, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: safeJsonString(block.input),
      },
    });
    writeSse(raw, "content_block_stop", {
      type: "content_block_stop",
      index,
    });
  }

  writeSse(raw, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: message.stop_reason,
      stop_sequence: message.stop_sequence,
    },
    usage: {
      output_tokens: message.usage.output_tokens,
    },
  });

  writeSse(raw, "message_stop", {
    type: "message_stop",
  });
  raw.end();
}

export function estimateInputTokensFromAnthropic(bodyRaw: unknown): number {
  const body = toObject(bodyRaw);
  const parts: string[] = [];
  const systemText = buildTextFromAnthropicContent(body.system);
  if (systemText) {
    parts.push(systemText);
  }

  for (const item of toArray(body.messages)) {
    const messageObj = toObject(item);
    const text = buildTextFromAnthropicContent(messageObj.content);
    if (text) {
      parts.push(text);
    }
  }

  for (const tool of toArray(body.tools)) {
    const raw = safeJsonString(tool);
    if (raw && raw !== "{}") {
      parts.push(raw);
    }
  }

  const merged = parts.join("\n");
  const estimated = Math.ceil(merged.length / 4);
  return Math.max(estimated, 1);
}

export function toUpstreamFailure(error: unknown): UpstreamRequestFailure {
  const err = error as Partial<UpstreamRequestFailure> & Error;
  if (typeof err.statusCode === "number" && typeof err.message === "string") {
    return {
      statusCode: err.statusCode,
      message: err.message,
    };
  }
  return {
    statusCode: 502,
    message: err.message || "Gateway request failed.",
  };
}
