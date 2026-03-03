import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import "./App.css";
import {
  getClaudeCurrent,
  getCliproxyConfigInfo,
  getEndpoints,
  getFallbackChains,
  getModels,
  importCliproxyConfig,
  refreshEndpoint,
  scoreModels,
  updateModelEnabled,
  updateFallbackChain,
} from "./api";
import type {
  ClaudeCurrentState,
  EndpointView,
  FallbackChainView,
  ModelRecord,
} from "./types";

type MessageState = {
  type: "success" | "error";
  text: string;
} | null;

type MenuKey = "home" | "proxy_model" | "cliproxy";

const CLIPROXY_LOCAL_NAME = "CLIProxy Local";
const PROXY_MODEL_KEY = "proxy_model";
const DEFAULT_MODEL_KEYS = [
  "model",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  PROXY_MODEL_KEY,
];
const QUOTA_PRIMARY_KEYS = [
  "quota_display",
  "quota_text",
  "quota",
  "remaining_quota",
  "available_quota",
  "quota_remaining",
  "credit",
  "credits",
  "balance",
  "remaining",
  "remain",
  "limit",
  "token_limit",
  "daily_limit",
  "monthly_limit",
];
const QUOTA_KEYWORDS = ["quota", "credit", "balance", "remaining", "remain", "limit", "available", "left"];
const QUOTA_RESET_KEYS = [
  "quota_reset_at",
  "next_quota_update_at",
  "next_refresh_at",
  "reset_time",
  "resetTime",
  "reset_at",
  "resetAt",
];
const DRAFT_CHAIN_DRAG_TYPE = "application/x-model-manager-draft-model-id";

function toQuotaText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    const text = value.trim();
    return text ? text : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => toQuotaText(item))
      .filter((item): item is string => Boolean(item));
    return parts.length ? parts.join(", ") : null;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => {
        const text = toQuotaText(item);
        return text ? `${key}:${text}` : null;
      })
      .filter((item): item is string => Boolean(item));
    return entries.length ? entries.join(" | ") : null;
  }
  return null;
}

function quotaFromModelMeta(meta?: Record<string, unknown>): string {
  if (!meta) {
    return "-";
  }

  if (meta.quota_unlimited === true) {
    return "不限量";
  }

  if (typeof meta.quota_remaining_fraction === "number" && Number.isFinite(meta.quota_remaining_fraction)) {
    const fraction = Math.max(0, Math.min(1, meta.quota_remaining_fraction));
    const percent = fraction * 100;
    if (percent >= 99.95) {
      return "100%";
    }
    return percent >= 10 ? `${percent.toFixed(0)}%` : `${percent.toFixed(1)}%`;
  }

  for (const key of QUOTA_PRIMARY_KEYS) {
    const value = meta[key];
    if (typeof value === "boolean") {
      continue;
    }
    const text = toQuotaText(value);
    if (text) {
      return text;
    }
  }

  for (const [key, value] of Object.entries(meta)) {
    const lowered = key.toLowerCase();
    if (!QUOTA_KEYWORDS.some((token) => lowered.includes(token))) {
      continue;
    }
    if (typeof value === "boolean") {
      continue;
    }
    if (/(quota_limited|quota_reason|limit_reached|limited|enabled)$/.test(lowered)) {
      continue;
    }
    const text = toQuotaText(value);
    if (text) {
      return text;
    }
  }

  return "-";
}

function quotaResetTimeFromModelMeta(meta?: Record<string, unknown>): string {
  if (!meta) {
    return "-";
  }
  for (const key of QUOTA_RESET_KEYS) {
    const value = meta[key];
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      continue;
    }
    return date.toLocaleString(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  return "-";
}

function modelScoreValueFromMeta(meta?: Record<string, unknown>): number | null {
  if (!meta) {
    return null;
  }
  const candidates = [
    meta.performance_score,
    meta.performanceScore,
    meta.score,
    meta.model_score,
  ];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.round(value);
    }
    if (typeof value === "string" && value.trim()) {
      const asNum = Number(value);
      if (Number.isFinite(asNum)) {
        return Math.round(asNum);
      }
    }
  }
  return null;
}

function modelScoreFromMeta(meta?: Record<string, unknown>): string {
  const value = modelScoreValueFromMeta(meta);
  return value === null ? "-" : String(value);
}

function toBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    if (normalized === "true" || normalized === "1" || normalized === "yes") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no") {
      return false;
    }
  }
  return null;
}

function getModelStatusView(model: ModelRecord): {
  title: string;
  detail: string;
  tone: "enabled" | "disabled";
  source: "manual" | "auto";
} {
  const meta = model.meta ?? {};
  const overrideRaw = typeof meta.status_override === "string" ? meta.status_override.trim().toLowerCase() : "";
  const source: "manual" | "auto" = overrideRaw === "enabled" || overrideRaw === "disabled" ? "manual" : "auto";
  const quotaLimited = toBooleanLike(meta.quota_limited) === true;
  const quotaExhausted = toBooleanLike(meta.quota_exhausted) === true;
  const quotaUnlimited = toBooleanLike(meta.quota_unlimited) === true;

  if (model.enabled) {
    if (source === "manual") {
      return {
        title: "已启用",
        detail: "手动启用",
        tone: "enabled",
        source,
      };
    }
    if (quotaUnlimited) {
      return {
        title: "已启用",
        detail: "自动启用 · 不限量",
        tone: "enabled",
        source,
      };
    }
    if (quotaLimited) {
      return {
        title: "已启用",
        detail: "自动启用 · 额度可用",
        tone: "enabled",
        source,
      };
    }
    return {
      title: "已启用",
      detail: "自动启用",
      tone: "enabled",
      source,
    };
  }

  if (source === "manual") {
    return {
      title: "已禁用",
      detail: "手动禁用",
      tone: "disabled",
      source,
    };
  }
  if (quotaLimited && quotaExhausted) {
    return {
      title: "已禁用",
      detail: "自动禁用 · 额度耗尽",
      tone: "disabled",
      source,
    };
  }
  return {
    title: "已禁用",
    detail: "自动禁用",
    tone: "disabled",
    source,
  };
}

function formatTime(value?: string): string {
  if (!value) {
    return "N/A";
  }
  return new Date(value).toLocaleString();
}

function resolveCliproxyEndpoint(endpoints: EndpointView[]): EndpointView | null {
  return endpoints.find((item) => item.name.trim().toLowerCase() === CLIPROXY_LOCAL_NAME.toLowerCase())
    ?? endpoints[0]
    ?? null;
}

function chainMapFromRows(rows: FallbackChainView[]): Record<string, string[]> {
  return Object.fromEntries(rows.map((row) => [row.modelKey, row.priorityList]));
}

function chainCurrentMapFromRows(rows: FallbackChainView[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of rows) {
    if (typeof row.currentModelId === "string" && row.currentModelId.trim()) {
      result[row.modelKey] = row.currentModelId.trim();
    }
  }
  return result;
}

function normalizeVariableKeys(current: ClaudeCurrentState | null, fallbackMap: Record<string, string[]>): string[] {
  const base = current?.env.modelKeys?.length
    ? current.env.modelKeys
    : DEFAULT_MODEL_KEYS;
  const set = new Set<string>([...base, ...Object.keys(fallbackMap)]);
  const extras = Array.from(set).filter((key) => !base.includes(key)).sort((a, b) => a.localeCompare(b));
  return [...base, ...extras];
}

function App() {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<MessageState>(null);
  const [activeMenu, setActiveMenu] = useState<MenuKey>("home");

  const [endpoint, setEndpoint] = useState<EndpointView | null>(null);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [claudeCurrent, setClaudeCurrent] = useState<ClaudeCurrentState | null>(null);
  const [fallbackChains, setFallbackChains] = useState<Record<string, string[]>>({});
  const [fallbackCurrentByKey, setFallbackCurrentByKey] = useState<Record<string, string>>({});

  const [cliproxyConfigInfo, setCliproxyConfigInfo] = useState({
    found: false,
    configPath: "",
    baseUrl: "",
  });
  const [scoringModelIdInput, setScoringModelIdInput] = useState("");
  const [selectedCliproxyConfigName, setSelectedCliproxyConfigName] = useState("");
  const [selectedCliproxyConfigContent, setSelectedCliproxyConfigContent] = useState("");
  const [isScoringModels, setIsScoringModels] = useState(false);
  const [scoreSortOrder, setScoreSortOrder] = useState<"none" | "desc" | "asc">("none");

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsModelKey, setSettingsModelKey] = useState("");
  const [draftChain, setDraftChain] = useState<string[]>([]);
  const [draggingModelId, setDraggingModelId] = useState<string | null>(null);
  const selectAllDraftRef = useRef<HTMLInputElement | null>(null);
  const [settingsSort, setSettingsSort] = useState<{
    field: "score" | "provider" | "name";
    direction: "asc" | "desc";
  }>({
    field: "score",
    direction: "desc",
  });

  const setSuccess = (text: string) => setMessage({ type: "success", text });
  const setError = (error: unknown) =>
    setMessage({ type: "error", text: error instanceof Error ? error.message : "Unexpected error." });

  const modelIds = useMemo(() => models.map((item) => item.modelId).sort((a, b) => a.localeCompare(b)), [models]);
  const modelIdSet = useMemo(() => new Set(modelIds), [modelIds]);
  const modelMap = useMemo(() => new Map(models.map((item) => [item.modelId, item])), [models]);
  const selectedAvailableModelCount = useMemo(
    () => draftChain.filter((item) => modelIdSet.has(item)).length,
    [draftChain, modelIdSet],
  );
  const allDraftModelsSelected = modelIds.length > 0 && selectedAvailableModelCount === modelIds.length;
  const partiallyDraftModelsSelected = selectedAvailableModelCount > 0 && !allDraftModelsSelected;
  const settingsSortedModels = useMemo(() => {
    const next = models.slice();
    if (settingsSort.field === "provider") {
      next.sort((a, b) => {
        const providerA = (a.provider || "").toLowerCase();
        const providerB = (b.provider || "").toLowerCase();
        const providerCmp = providerA.localeCompare(providerB);
        if (providerCmp !== 0) {
          return settingsSort.direction === "asc" ? providerCmp : -providerCmp;
        }
        const nameCmp = a.modelId.localeCompare(b.modelId);
        return settingsSort.direction === "asc" ? nameCmp : -nameCmp;
      });
      return next;
    }
    if (settingsSort.field === "name") {
      next.sort((a, b) => {
        const nameCmp = a.modelId.localeCompare(b.modelId);
        return settingsSort.direction === "asc" ? nameCmp : -nameCmp;
      });
      return next;
    }
    next.sort((a, b) => {
      const scoreA = modelScoreValueFromMeta(a.meta);
      const scoreB = modelScoreValueFromMeta(b.meta);
      if (scoreA === null && scoreB === null) {
        return a.modelId.localeCompare(b.modelId);
      }
      if (scoreA === null) {
        return 1;
      }
      if (scoreB === null) {
        return -1;
      }
      const diff = settingsSort.direction === "asc" ? scoreA - scoreB : scoreB - scoreA;
      if (diff !== 0) {
        return diff;
      }
      return a.modelId.localeCompare(b.modelId);
    });
    return next;
  }, [models, settingsSort.direction, settingsSort.field]);
  const settingsDisplayedModels = useMemo(() => {
    const selected = draftChain
      .map((modelId) => modelMap.get(modelId))
      .filter((item): item is ModelRecord => Boolean(item));
    const selectedIdSet = new Set(selected.map((item) => item.modelId));
    const unselected = settingsSortedModels.filter((item) => !selectedIdSet.has(item.modelId));
    return [...selected, ...unselected];
  }, [draftChain, modelMap, settingsSortedModels]);

  const loadData = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
    }
    try {
      const [nextEndpoints, nextAllModels, nextCurrent, nextCliproxyInfo, nextFallbackRows] = await Promise.all([
        getEndpoints(),
        getModels(),
        getClaudeCurrent(),
        getCliproxyConfigInfo(),
        getFallbackChains(),
      ]);
      const nextEndpoint = resolveCliproxyEndpoint(nextEndpoints);
      const nextModels = nextEndpoint
        ? nextAllModels
          .filter((item) => item.endpointId === nextEndpoint.id)
          .sort((a, b) => a.displayName.localeCompare(b.displayName))
        : [];

      const nextFallbackMap = chainMapFromRows(nextFallbackRows);
      const nextFallbackCurrentMap = chainCurrentMapFromRows(nextFallbackRows);
      const available = new Set(nextModels.map((item) => item.modelId));
      const keys = normalizeVariableKeys(nextCurrent, nextFallbackMap);

      for (const key of keys) {
        const existing = (nextFallbackMap[key] ?? []).filter((item) => available.has(item));
        if (existing.length) {
          nextFallbackMap[key] = existing;
          continue;
        }
        const configured = nextCurrent?.env.modelValues?.[key];
        if (configured && available.has(configured)) {
          nextFallbackMap[key] = [configured];
        }
      }
      for (const [key, modelId] of Object.entries(nextFallbackCurrentMap)) {
        if (!available.has(modelId)) {
          delete nextFallbackCurrentMap[key];
        }
      }
      for (const key of keys) {
        if (nextFallbackCurrentMap[key]) {
          continue;
        }
        const configured = nextCurrent?.env.modelValues?.[key];
        if (configured && available.has(configured)) {
          nextFallbackCurrentMap[key] = configured;
          continue;
        }
        const chainTop = nextFallbackMap[key]?.[0];
        if (chainTop) {
          nextFallbackCurrentMap[key] = chainTop;
        }
      }

      setEndpoint(nextEndpoint);
      setModels(nextModels);
      setScoringModelIdInput((prev) => {
        if (prev && nextModels.some((item) => item.modelId === prev)) {
          return prev;
        }
        return nextModels[0]?.modelId || "";
      });
      setClaudeCurrent(nextCurrent);
      setCliproxyConfigInfo(nextCliproxyInfo);
      setFallbackChains(nextFallbackMap);
      setFallbackCurrentByKey(nextFallbackCurrentMap);
    } catch (error) {
      setError(error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadData(true);
    }, 12_000);
    return () => window.clearInterval(timer);
  }, [loadData]);

  useEffect(() => {
    if (selectAllDraftRef.current) {
      selectAllDraftRef.current.indeterminate = partiallyDraftModelsSelected;
    }
  }, [partiallyDraftModelsSelected]);

  const variableKeys = useMemo(() => normalizeVariableKeys(claudeCurrent, fallbackChains), [claudeCurrent, fallbackChains]);
  const claudeVariableKeys = useMemo(
    () => variableKeys.filter((key) => key !== PROXY_MODEL_KEY),
    [variableKeys],
  );
  const proxyModelChain = fallbackChains[PROXY_MODEL_KEY] ?? [];
  const proxyModelCurrent = fallbackCurrentByKey[PROXY_MODEL_KEY] || proxyModelChain[0] || "未设置";
  const proxyClientBaseUrl = claudeCurrent?.env.ANTHROPIC_BASE_URL?.trim() || "http://127.0.0.1:3199";
  const proxyClientApiKey = claudeCurrent?.env.ANTHROPIC_AUTH_TOKEN || "";
  const proxyClientInvokeApi = "/v1/messages";
  const proxyClientCurlExample = useMemo(() => {
    const apiKey = proxyClientApiKey || "<your-api-key>";
    return [
      `curl -X POST "${proxyClientBaseUrl}${proxyClientInvokeApi}" \\`,
      "  -H \"content-type: application/json\" \\",
      "  -H \"anthropic-version: 2023-06-01\" \\",
      `  -H "x-api-key: ${apiKey}" \\`,
      "  -d '{",
      `    \"model\": \"${PROXY_MODEL_KEY}\",`,
      "    \"max_tokens\": 256,",
      "    \"messages\": [{\"role\": \"user\", \"content\": \"Hello\"}]",
      "  }'",
    ].join("\n");
  }, [proxyClientApiKey, proxyClientBaseUrl, proxyClientInvokeApi]);

  const currentModelEntries = useMemo(() => {
    const keys = claudeCurrent?.env.modelKeys ?? [];
    const values = claudeCurrent?.env.modelValues ?? {};
    return keys.map((key) => ({
      key,
      value: values[key] || "未配置",
    }));
  }, [claudeCurrent]);

  const homeConfigLines = useMemo(() => {
    const lines: Array<{ key: string; value: string }> = [
      {
        key: "配置文件",
        value: claudeCurrent?.settingsPath || "N/A",
      },
      {
        key: "当前 Base URL",
        value: claudeCurrent?.env.ANTHROPIC_BASE_URL || "未配置",
      },
      {
        key: "当前 Token",
        value: claudeCurrent?.env.ANTHROPIC_AUTH_TOKEN || "未配置",
      },
    ];
    for (const item of currentModelEntries) {
      lines.push({
        key: item.key,
        value: item.value,
      });
    }
    return lines;
  }, [claudeCurrent, currentModelEntries]);

  const displayedModels = useMemo(() => {
    const next = models.slice();
    if (scoreSortOrder === "none") {
      return next;
    }
    next.sort((a, b) => {
      const scoreA = modelScoreValueFromMeta(a.meta);
      const scoreB = modelScoreValueFromMeta(b.meta);
      if (scoreA === null && scoreB === null) {
        return a.displayName.localeCompare(b.displayName);
      }
      if (scoreA === null) {
        return 1;
      }
      if (scoreB === null) {
        return -1;
      }
      const diff = scoreSortOrder === "desc" ? scoreB - scoreA : scoreA - scoreB;
      if (diff !== 0) {
        return diff;
      }
      return a.displayName.localeCompare(b.displayName);
    });
    return next;
  }, [models, scoreSortOrder]);

  const scoreSortIcon = scoreSortOrder === "desc" ? "↓" : scoreSortOrder === "asc" ? "↑" : "↕";

  const closeSettingsModal = () => {
    setSettingsOpen(false);
    setSettingsModelKey("");
    setDraftChain([]);
    setDraggingModelId(null);
    setSettingsSort({ field: "score", direction: "desc" });
  };

  const persistChain = useCallback(async (modelKey: string, nextChain: string[], successText: string) => {
    const normalized = nextChain.filter((item, index) => item && modelIdSet.has(item) && nextChain.indexOf(item) === index);
    if (!normalized.length) {
      throw new Error("fallback chain 至少保留一个模型。");
    }
    const updated = await updateFallbackChain(modelKey, normalized);
    setFallbackChains((prev) => ({
      ...prev,
      [updated.modelKey]: updated.priorityList,
    }));
    setFallbackCurrentByKey((prev) => ({
      ...prev,
      [updated.modelKey]: updated.currentModelId || updated.priorityList[0] || "",
    }));
    await loadData(true);
    setSuccess(successText);
  }, [loadData, modelIdSet]);

  const handleToggleScoreSort = () => {
    setScoreSortOrder((prev) => {
      if (prev === "none") {
        return "desc";
      }
      if (prev === "desc") {
        return "asc";
      }
      return "none";
    });
  };

  const handleChooseCliproxyConfigFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      setSelectedCliproxyConfigName("");
      setSelectedCliproxyConfigContent("");
      return;
    }
    try {
      const content = await file.text();
      setSelectedCliproxyConfigName(file.name);
      setSelectedCliproxyConfigContent(content);
    } catch (error) {
      setError(error);
    }
  };

  const handleImportSelectedCliproxyConfig = async () => {
    if (!selectedCliproxyConfigContent.trim()) {
      setError(new Error("请先选择 cliproxy 配置文件。"));
      return;
    }
    setSubmitting(true);
    try {
      await importCliproxyConfig({
        configContent: selectedCliproxyConfigContent,
        sourceName: selectedCliproxyConfigName || "selected-cliproxy-config",
      });
      await loadData(true);
      setSuccess(`已导入配置文件: ${selectedCliproxyConfigName || "selected-cliproxy-config"}`);
    } catch (error) {
      setError(error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRefreshCliproxy = async () => {
    if (!endpoint) {
      return;
    }
    setSubmitting(true);
    try {
      await refreshEndpoint(endpoint.id);
      const info = await getCliproxyConfigInfo();
      setCliproxyConfigInfo(info);
      await loadData(true);
      setSuccess("CLIProxy 模型和配置状态已刷新。");
    } catch (error) {
      setError(error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleScoreAllModels = async () => {
    if (!models.length) {
      return;
    }
    setIsScoringModels(true);
    setSubmitting(true);
    try {
      const result = await scoreModels({
        scoringModelId: scoringModelIdInput || undefined,
      });
      setModels(
        result.models
          .slice()
          .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      );
      const changedText = typeof result.changedCount === "number"
        ? `，变化 ${result.changedCount} 个`
        : "";
      const sourceText = result.source ? `（${result.source}）` : "";
      setSuccess(`模型评分完成${sourceText}，共处理 ${result.updatedCount} 个模型${changedText}。`);
    } catch (error) {
      setError(error);
    } finally {
      setIsScoringModels(false);
      setSubmitting(false);
    }
  };

  const handleToggleModelEnabled = async (model: ModelRecord) => {
    setSubmitting(true);
    try {
      const updated = await updateModelEnabled(model.id, !model.enabled);
      setModels((prev) =>
        prev
          .map((item) => (item.id === updated.id ? updated : item))
          .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      );
      await loadData(true);
      setSuccess(`模型 ${updated.modelId} 已${updated.enabled ? "启用" : "禁用"}，并同步了 fallback 配置。`);
    } catch (error) {
      setError(error);
    } finally {
      setSubmitting(false);
    }
  };

  const openSettingsModal = (modelKey: string) => {
    const chain = (fallbackChains[modelKey] ?? []).filter((item) => modelIdSet.has(item));
    setSettingsModelKey(modelKey);
    setDraftChain(chain);
    setSettingsSort({ field: "score", direction: "desc" });
    setSettingsOpen(true);
  };

  const settingsHeaderIcon = (field: "score" | "provider" | "name"): string => {
    if (settingsSort.field !== field) {
      return "↕";
    }
    return settingsSort.direction === "asc" ? "↑" : "↓";
  };

  const handleSettingsHeaderSort = (field: "score" | "provider" | "name") => {
    setSettingsSort((prev) => {
      if (prev.field === field) {
        return {
          field,
          direction: prev.direction === "asc" ? "desc" : "asc",
        };
      }
      return {
        field,
        direction: field === "score" ? "desc" : "asc",
      };
    });
  };

  const toggleDraftModel = (modelId: string, checked: boolean) => {
    setDraftChain((prev) => {
      const exists = prev.includes(modelId);
      if (checked) {
        if (exists) {
          return prev;
        }
        return [...prev, modelId];
      }
      if (!exists) {
        return prev;
      }
      return prev.filter((item) => item !== modelId);
    });
  };

  const handleToggleAllDraftModels = (checked: boolean) => {
    setDraftChain((prev) => {
      if (!checked) {
        return [];
      }
      const validPrev = prev.filter((item, index) => modelIdSet.has(item) && prev.indexOf(item) === index);
      const picked = new Set(validPrev);
      const missing = modelIds.filter((item) => !picked.has(item));
      return [...validPrev, ...missing];
    });
  };

  const reorderDraftChain = (sourceModelId: string, targetModelId: string) => {
    setDraftChain((prev) => {
      const sourceIndex = prev.indexOf(sourceModelId);
      const targetIndex = prev.indexOf(targetModelId);
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
        return prev;
      }
      const next = prev.slice();
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  };

  const handleDraftRowDragStart = (event: DragEvent<HTMLTableRowElement>, modelId: string) => {
    if (submitting || !draftChain.includes(modelId)) {
      return;
    }
    setDraggingModelId(modelId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAFT_CHAIN_DRAG_TYPE, modelId);
  };

  const handleDraftRowDragOver = (event: DragEvent<HTMLTableRowElement>, targetModelId: string) => {
    const sourceModelId = event.dataTransfer.getData(DRAFT_CHAIN_DRAG_TYPE) || draggingModelId;
    if (!sourceModelId || sourceModelId === targetModelId) {
      return;
    }
    if (!draftChain.includes(sourceModelId) || !draftChain.includes(targetModelId)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const handleDraftRowDrop = (event: DragEvent<HTMLTableRowElement>, targetModelId: string) => {
    event.preventDefault();
    const sourceModelId = event.dataTransfer.getData(DRAFT_CHAIN_DRAG_TYPE) || draggingModelId;
    if (!sourceModelId || sourceModelId === targetModelId) {
      setDraggingModelId(null);
      return;
    }
    reorderDraftChain(sourceModelId, targetModelId);
    setDraggingModelId(null);
  };

  const handleDraftRowDragEnd = () => {
    setDraggingModelId(null);
  };

  const handleSaveDraftChain = async () => {
    if (!settingsModelKey) {
      return;
    }
    if (!draftChain.length) {
      setError(new Error("请至少选择一个模型。"));
      return;
    }
    setSubmitting(true);
    try {
      await persistChain(settingsModelKey, draftChain, `已保存 ${settingsModelKey} 的 fallback chain，并自动更新 Claude 配置。`);
      closeSettingsModal();
    } catch (error) {
      setError(error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemoveFallbackModel = async (modelKey: string, modelId: string) => {
    const chain = fallbackChains[modelKey] ?? [];
    if (!chain.includes(modelId)) {
      return;
    }
    if (chain.length <= 1) {
      setError(new Error("fallback chain 至少保留一个模型。"));
      return;
    }
    setSubmitting(true);
    try {
      const next = chain.filter((item) => item !== modelId);
      await persistChain(modelKey, next, `已更新 ${modelKey} 的 fallback chain，并自动更新 Claude 配置。`);
    } catch (error) {
      setError(error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSetFallbackCurrentModel = async (modelKey: string, modelId: string) => {
    const chain = fallbackChains[modelKey] ?? [];
    if (!chain.includes(modelId)) {
      return;
    }

    const target = modelMap.get(modelId);
    if (!target || !target.enabled) {
      return;
    }

    const next = [modelId, ...chain.filter((item) => item !== modelId)];
    const current = fallbackCurrentByKey[modelKey] || chain[0] || "";
    if (next[0] === current && chain.length === next.length && chain.every((item, index) => item === next[index])) {
      return;
    }

    setSubmitting(true);
    try {
      await persistChain(modelKey, next, `已将 ${modelKey} 当前模型切换为 ${modelId}，并自动更新 Claude 配置。`);
    } catch (error) {
      setError(error);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="app-shell">
        <aside className="sidebar">
          <h1>Model Manager</h1>
        </aside>
        <main className="main-pane">
          <p className="loading">Loading...</p>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1>Model Manager</h1>
        <nav className="menu">
          <button
            className={activeMenu === "home" ? "menu-item active" : "menu-item"}
            onClick={() => setActiveMenu("home")}
            type="button"
          >
            首页
          </button>
          <button
            className={activeMenu === "proxy_model" ? "menu-item active" : "menu-item"}
            onClick={() => setActiveMenu("proxy_model")}
            type="button"
          >
            通用代理模型
          </button>
          <button
            className={activeMenu === "cliproxy" ? "menu-item active" : "menu-item"}
            onClick={() => setActiveMenu("cliproxy")}
            type="button"
          >
            CLIProxy Local
          </button>
        </nav>
      </aside>

      <main className="main-pane">
        {message && (
          <div className={`notice ${message.type}`}>
            {message.text}
          </div>
        )}

        {!endpoint && (
          <section className="content-card">
            <h2>CLIProxy Local</h2>
            <p className="muted">当前未检测到可用的 CLIProxy endpoint，请在 CLIProxy Local 页面导入配置。</p>
          </section>
        )}

        {activeMenu === "home" && (
          <section className="content-card">
            <h2>Claude Code 当前配置</h2>
            <div className="mechanism-note">
              <div className="mechanism-title">Fallback Chain 切换机制</div>
              <ul>
                <li>每个变量都有独立 chain，首项是当前优先模型。</li>
                <li>请求失败时会按 chain 顺序跳到下一个可用且 `enabled` 的模型。</li>
                <li>切换成功后会自动回写 Claude 配置，后续请求默认使用新模型。</li>
                <li>仅当模型“有额度限制且额度耗尽”才会被置为 `disabled`，其余模型保持 `enabled`。</li>
                <li>额度刷新时间到达后 +1 分钟会自动刷新状态，系统重启时也会先拉取一次额度并重置状态。</li>
              </ul>
            </div>
            <div className="config-lines">
              {homeConfigLines.map((line) => (
                <div className="config-line" key={line.key}>
                  <div className="config-key">{line.key}</div>
                  <div className="config-value">{line.value}</div>
                </div>
              ))}
            </div>

            {claudeVariableKeys.map((modelKey) => {
              const chain = fallbackChains[modelKey] ?? [];
              const current = fallbackCurrentByKey[modelKey] || chain[0] || "未设置";
              return (
                <div className="home-row-block" key={modelKey}>
                  <div className="config-row">
                    <label>{modelKey}</label>
                    <div className="variable-head">
                      <span className="variable-current">当前: {current}</span>
                      <button
                        disabled={submitting || !models.length}
                        onClick={() => {
                          openSettingsModal(modelKey);
                        }}
                        type="button"
                      >
                        设置
                      </button>
                    </div>
                  </div>

                  <div className="fallback-line">
                    <div className="config-key">Fallback Chain</div>
                    <div className="fallback-chip-list">
                      {chain.length ? chain.map((modelId) => {
                        const model = modelMap.get(modelId);
                        const disabled = model?.enabled === false;
                        return (
                          <span
                            className={[
                              "fallback-chip",
                              disabled ? "is-disabled" : "is-enabled",
                              current === modelId ? "is-current" : "",
                            ]
                              .filter(Boolean)
                              .join(" ")}
                            key={`${modelKey}:${modelId}`}
                          >
                            <button
                              className="fallback-chip-select"
                              disabled={submitting || disabled}
                              onClick={() => {
                                void handleSetFallbackCurrentModel(modelKey, modelId);
                              }}
                              title={disabled ? "模型已禁用，无法设为当前模型" : "点击设为当前模型"}
                              type="button"
                            >
                              <span>{modelId}</span>
                              {current === modelId ? <em className="current-check" title="当前模型">✓</em> : null}
                            </button>
                            <button
                              disabled={submitting || chain.length <= 1}
                              onClick={() => {
                                void handleRemoveFallbackModel(modelKey, modelId);
                              }}
                              title="移除"
                              type="button"
                            >
                              ×
                            </button>
                          </span>
                        );
                      }) : <span className="muted">未设置</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </section>
        )}

        {activeMenu === "proxy_model" && (
          <section className="content-card">
            <h2>通用代理模型（proxy_model）</h2>
            <div className="mechanism-note">
              <div className="mechanism-title">使用说明</div>
              <ul>
                <li>调用方式保持 Anthropic 模式不变，仍走 `POST /v1/messages`。</li>
                <li>客户端把 `model` 固定传 `proxy_model`，服务端按这里的 fallback chain 自动切换。</li>
                <li>该链独立于 Claude 各变量链，不会回写 Claude 的 `model`/`env.*MODEL*` 字段。</li>
              </ul>
            </div>
            <div className="config-lines">
              <div className="config-line">
                <div className="config-key">Base URL</div>
                <div className="config-value">{proxyClientBaseUrl}</div>
              </div>
              <div className="config-line">
                <div className="config-key">API Key</div>
                <div className="config-value">{proxyClientApiKey || "未配置"}</div>
              </div>
              <div className="config-line">
                <div className="config-key">Model</div>
                <div className="config-value">{PROXY_MODEL_KEY}</div>
              </div>
              <div className="config-line">
                <div className="config-key">Invoke API</div>
                <div className="config-value">{proxyClientInvokeApi}</div>
              </div>
            </div>
            <pre className="code-block">{proxyClientCurlExample}</pre>
            <p className="muted">如果你的 SDK 必填 API Key，这里使用上面的值；本地代理模式下不会用它向上游鉴权。</p>

            <div className="home-row-block" key={PROXY_MODEL_KEY}>
              <div className="config-row">
                <label>{PROXY_MODEL_KEY}</label>
                <div className="variable-head">
                  <span className="variable-current">当前: {proxyModelCurrent}</span>
                  <button
                    disabled={submitting || !models.length}
                    onClick={() => {
                      openSettingsModal(PROXY_MODEL_KEY);
                    }}
                    type="button"
                  >
                    设置
                  </button>
                </div>
              </div>

              <div className="fallback-line">
                <div className="config-key">Fallback Chain</div>
                <div className="fallback-chip-list">
                  {proxyModelChain.length ? proxyModelChain.map((modelId) => {
                    const model = modelMap.get(modelId);
                    const disabled = model?.enabled === false;
                    return (
                      <span
                        className={[
                          "fallback-chip",
                          disabled ? "is-disabled" : "is-enabled",
                          proxyModelCurrent === modelId ? "is-current" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        key={`${PROXY_MODEL_KEY}:${modelId}`}
                      >
                        <button
                          className="fallback-chip-select"
                          disabled={submitting || disabled}
                          onClick={() => {
                            void handleSetFallbackCurrentModel(PROXY_MODEL_KEY, modelId);
                          }}
                          title={disabled ? "模型已禁用，无法设为当前模型" : "点击设为当前模型"}
                          type="button"
                        >
                          <span>{modelId}</span>
                          {proxyModelCurrent === modelId ? <em className="current-check" title="当前模型">✓</em> : null}
                        </button>
                        <button
                          disabled={submitting || proxyModelChain.length <= 1}
                          onClick={() => {
                            void handleRemoveFallbackModel(PROXY_MODEL_KEY, modelId);
                          }}
                          title="移除"
                          type="button"
                        >
                          ×
                        </button>
                      </span>
                    );
                  }) : <span className="muted">未设置</span>}
                </div>
              </div>
            </div>
          </section>
        )}

        {activeMenu === "cliproxy" && (
          <>
            <section className="content-card">
              <div className="content-head">
                <h2>CLIProxy 配置文件</h2>
                <button
                  className="icon-btn"
                  disabled={submitting || !endpoint}
                  onClick={() => {
                    void handleRefreshCliproxy();
                  }}
                  title="刷新模型与配置状态"
                  type="button"
                >
                  ↻
                </button>
              </div>
              <div className="config-lines">
                <div className="config-line">
                  <div className="config-key">当前 Endpoint</div>
                  <div className="config-value">{endpoint?.name || CLIPROXY_LOCAL_NAME}</div>
                </div>
                <div className="config-line">
                  <div className="config-key">当前 Base URL</div>
                  <div className="config-value">{endpoint?.baseUrl || "未配置"}</div>
                </div>
                <div className="config-line">
                  <div className="config-key">自动发现配置</div>
                  <div className="config-value">{cliproxyConfigInfo.found ? cliproxyConfigInfo.configPath : "未发现"}</div>
                </div>
                <div className="config-line">
                  <div className="config-key">发现的 Base URL</div>
                  <div className="config-value">{cliproxyConfigInfo.baseUrl || "未解析"}</div>
                </div>
              </div>
              <div className="inline-form">
                <input
                  accept=".yaml,.yml"
                  onChange={(event) => {
                    void handleChooseCliproxyConfigFile(event);
                  }}
                  type="file"
                />
                <button
                  disabled={submitting || !selectedCliproxyConfigContent}
                  onClick={() => {
                    void handleImportSelectedCliproxyConfig();
                  }}
                  type="button"
                >
                  导入所选配置
                </button>
              </div>
              <p className="muted">
                已选择文件: {selectedCliproxyConfigName || "未选择"}
              </p>
            </section>

            <section className="content-card">
              <div className="content-head">
                <h3>CLIProxy 模型列表</h3>
                <div className="toolbar">
                  <select
                    disabled={submitting || !models.length}
                    onChange={(event) => {
                      setScoringModelIdInput(event.target.value);
                    }}
                    value={scoringModelIdInput}
                  >
                    {models.map((model) => (
                      <option key={model.id} value={model.modelId}>
                        {model.modelId}
                      </option>
                    ))}
                  </select>
                  <button
                    disabled={submitting || !models.length}
                    onClick={() => {
                      void handleScoreAllModels();
                    }}
                    type="button"
                  >
                    {isScoringModels ? "评分中..." : "模型评分"}
                  </button>
                </div>
              </div>
              <div className="status-legend">
                状态说明：主标签表示是否可用，副标签表示状态来源和原因（手动 / 自动、额度情况）。点击可切换启用状态。
              </div>
              <p className="muted">最后同步时间: {formatTime(endpoint?.lastSyncAt)}</p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Model ID</th>
                      <th>显示名</th>
                      <th>Provider</th>
                      <th>额度</th>
                      <th>下次更新</th>
                      <th>
                        <button
                          className="th-sort-btn"
                          onClick={handleToggleScoreSort}
                          title="按评分排序"
                          type="button"
                        >
                          评分 {scoreSortIcon}
                        </button>
                      </th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedModels.map((model) => (
                      <tr className={model.enabled ? "model-row-enabled" : "model-row-disabled"} key={model.id}>
                        {(() => {
                          const statusView = getModelStatusView(model);
                          return (
                            <>
                        <td>{model.modelId}</td>
                        <td>{model.displayName}</td>
                        <td>{model.provider || "-"}</td>
                        <td>{quotaFromModelMeta(model.meta)}</td>
                        <td>{quotaResetTimeFromModelMeta(model.meta)}</td>
                        <td>{modelScoreFromMeta(model.meta)}</td>
                        <td>
                          <button
                            className={[
                              "status-toggle-btn",
                              `is-${statusView.tone}`,
                              `source-${statusView.source}`,
                            ].join(" ")}
                            disabled={submitting}
                            onClick={() => {
                              void handleToggleModelEnabled(model);
                            }}
                            title={`${statusView.title}（${statusView.detail}），点击${model.enabled ? "禁用" : "启用"}模型`}
                            type="button"
                          >
                            <span className="status-main">
                              <span className="status-icon" aria-hidden="true">{statusView.tone === "enabled" ? "✓" : "×"}</span>
                              <span>{statusView.title}</span>
                            </span>
                            <span className="status-sub">{statusView.detail}</span>
                          </button>
                        </td>
                            </>
                          );
                        })()}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>

      {settingsOpen && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!submitting) {
              closeSettingsModal();
            }
          }}
        >
          <div
            className="modal-card model-settings-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <h3>设置模型链</h3>
            <p className="muted mono">变量: {settingsModelKey}</p>
            <p className="muted">可多选；已选模型会自动置顶，可拖动已选行调整顺序。链路首项会自动写回 Claude 当前模型。</p>

            <div className="table-wrap model-settings-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>
                      <input
                        aria-label="全选模型"
                        checked={allDraftModelsSelected}
                        disabled={submitting || !modelIds.length}
                        onChange={(event) => {
                          handleToggleAllDraftModels(event.target.checked);
                        }}
                        ref={selectAllDraftRef}
                        title="全选 / 取消全选"
                        type="checkbox"
                      />
                    </th>
                    <th>
                      <button
                        className="th-sort-btn"
                        onClick={() => {
                          handleSettingsHeaderSort("name");
                        }}
                        title="按模型名称排序"
                        type="button"
                      >
                        Model ID {settingsHeaderIcon("name")}
                      </button>
                    </th>
                    <th>
                      <button
                        className="th-sort-btn"
                        onClick={() => {
                          handleSettingsHeaderSort("provider");
                        }}
                        title="按 Provider 排序"
                        type="button"
                      >
                        Provider {settingsHeaderIcon("provider")}
                      </button>
                    </th>
                    <th>
                      <button
                        className="th-sort-btn"
                        onClick={() => {
                          handleSettingsHeaderSort("score");
                        }}
                        title="按评分排序"
                        type="button"
                      >
                        评分 {settingsHeaderIcon("score")}
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {settingsDisplayedModels.map((model) => {
                    const modelId = model.modelId;
                    const selected = draftChain.includes(modelId);
                    const rowClassName = [
                      selected ? "settings-row-selected settings-row-draggable" : "",
                      draggingModelId === modelId ? "settings-row-dragging" : "",
                      model.enabled ? "" : "settings-row-disabled",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    return (
                      <tr
                        className={rowClassName || undefined}
                        draggable={selected && !submitting}
                        key={modelId}
                        onDragEnd={handleDraftRowDragEnd}
                        onDragOver={(event) => {
                          handleDraftRowDragOver(event, modelId);
                        }}
                        onDragStart={(event) => {
                          handleDraftRowDragStart(event, modelId);
                        }}
                        onDrop={(event) => {
                          handleDraftRowDrop(event, modelId);
                        }}
                      >
                        <td>
                          <input
                            checked={selected}
                            disabled={submitting}
                            onChange={(event) => {
                              toggleDraftModel(modelId, event.target.checked);
                            }}
                            type="checkbox"
                          />
                        </td>
                        <td>{selected ? `↕ ${modelId}` : modelId}</td>
                        <td>{model.provider || "-"}</td>
                        <td>{modelScoreFromMeta(model.meta)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="modal-actions">
              <button
                className="ghost-btn"
                disabled={submitting}
                onClick={closeSettingsModal}
                type="button"
              >
                取消
              </button>
              <button
                disabled={submitting || !draftChain.length}
                onClick={() => {
                  void handleSaveDraftChain();
                }}
                type="button"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
