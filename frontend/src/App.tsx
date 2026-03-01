import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import "./App.css";
import {
  applyClaudeConfig,
  createEndpoint,
  createManualModel,
  deleteManualModel,
  getClaudeCurrent,
  getCliproxyConfigInfo,
  getEndpointApiKey,
  getEndpoints,
  getModels,
  importCliproxyConfig,
  refreshEndpoint,
  updateEndpoint,
} from "./api";
import type { ClaudeCurrentState, EndpointProtocol, EndpointView, ModelRecord } from "./types";

type MessageState = {
  type: "success" | "error";
  text: string;
} | null;

type MenuKey = "home" | `endpoint:${string}`;
type HomeModelRow = {
  modelKey: string;
  endpointId: string;
  modelRecordId: string;
};
const CURRENT_CONFIG_ENDPOINT_ID = "__current_config_endpoint__";
const CLIPROXY_LOCAL_NAME = "CLIProxy Local";

const defaultEndpointForm = {
  name: "",
  baseUrl: "http://127.0.0.1:8317",
  apiKey: "",
  protocol: "anthropic" as EndpointProtocol,
};

function formatTime(value?: string): string {
  if (!value) {
    return "N/A";
  }
  return new Date(value).toLocaleString();
}

function menuToEndpointId(menu: MenuKey): string | null {
  return menu.startsWith("endpoint:") ? menu.slice("endpoint:".length) : null;
}

function isCliproxyLocalEndpoint(endpoint?: Pick<EndpointView, "name"> | null): boolean {
  return endpoint?.name?.trim().toLowerCase() === CLIPROXY_LOCAL_NAME.toLowerCase();
}

function isOpenAiResponsesEndpoint(endpoint?: Pick<EndpointView, "protocol"> | null): boolean {
  return endpoint?.protocol === "openai_responses";
}

function normalizeClaudeBaseUrl(baseUrl?: string): string {
  const input = (baseUrl ?? "").trim();
  if (!input) {
    return "";
  }
  return input.replace(/\/+$/, "");
}

function inferCurrentEndpointName(baseUrl?: string): string {
  if (!baseUrl) {
    return "当前配置 Endpoint";
  }
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host.includes("kimi")) {
      return "Kimi (当前配置)";
    }
    return `当前配置 (${host})`;
  } catch {
    if (baseUrl.includes("kimi")) {
      return "Kimi (当前配置)";
    }
    return "当前配置 Endpoint";
  }
}

function App() {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<MessageState>(null);
  const [activeMenu, setActiveMenu] = useState<MenuKey>("home");

  const [endpoints, setEndpoints] = useState<EndpointView[]>([]);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [claudeCurrent, setClaudeCurrent] = useState<ClaudeCurrentState | null>(null);

  const [homeModelRows, setHomeModelRows] = useState<HomeModelRow[]>([]);
  const [homeRowsDirty, setHomeRowsDirty] = useState(false);
  const [showAddEndpointModal, setShowAddEndpointModal] = useState(false);
  const [newEndpoint, setNewEndpoint] = useState(defaultEndpointForm);
  const [manualModelForm, setManualModelForm] = useState({
    modelId: "",
    displayName: "",
    provider: "",
  });
  const [endpointConfigForm, setEndpointConfigForm] = useState({
    baseUrl: "",
    apiKey: "",
    protocol: "anthropic" as EndpointProtocol,
  });
  const [cliproxyConfigInfo, setCliproxyConfigInfo] = useState({
    found: false,
    configPath: "",
    baseUrl: "",
  });
  const [selectedCliproxyConfigName, setSelectedCliproxyConfigName] = useState("");
  const [selectedCliproxyConfigContent, setSelectedCliproxyConfigContent] = useState("");

  const setSuccess = (text: string) => setMessage({ type: "success", text });
  const setError = (error: unknown) =>
    setMessage({ type: "error", text: error instanceof Error ? error.message : "Unexpected error." });

  const applyRowsToClaude = useCallback(async (rows: HomeModelRow[]): Promise<number> => {
    let applied = 0;
    for (const row of rows) {
      if (!row.modelRecordId) {
        continue;
      }
      const model = models.find((item) => item.id === row.modelRecordId);
      if (!model) {
        continue;
      }
      await applyClaudeConfig({
        endpointId: model.endpointId,
        modelRecordId: model.id,
        modelKey: row.modelKey,
      });
      applied += 1;
    }
    return applied;
  }, [models]);

  const alignRowsToPrimaryEndpoint = useCallback((rows: HomeModelRow[], nextModels: ModelRecord[]): HomeModelRow[] => {
    if (rows.length === 0) {
      return rows;
    }
    const primaryIndexRaw = rows.findIndex((item) => item.modelKey === "model");
    const primaryIndex = primaryIndexRaw >= 0 ? primaryIndexRaw : 0;
    const primary = rows[primaryIndex];
    const primaryEndpointId = primary.endpointId;

    const modelById = new Map(nextModels.map((item) => [item.id, item]));
    const primaryModelsByModelId = new Map(
      nextModels
        .filter((item) => item.endpointId === primaryEndpointId)
        .map((item) => [item.modelId, item.id]),
    );

    const primaryModelValid = nextModels.some(
      (item) => item.id === primary.modelRecordId && item.endpointId === primaryEndpointId,
    );
    const normalizedPrimary = primaryModelValid
      ? primary
      : {
          ...primary,
          modelRecordId: "",
        };

    const primaryModelRecordId = normalizedPrimary.modelRecordId;

    return rows.map((row, index) => {
      if (index === primaryIndex || row.modelKey === "model") {
        return index === primaryIndex ? normalizedPrimary : row;
      }
      let mappedModelRecordId = row.modelRecordId;
      if (mappedModelRecordId) {
        const selectedModel = modelById.get(mappedModelRecordId);
        if (selectedModel) {
          const sameModelInPrimary = primaryModelsByModelId.get(selectedModel.modelId);
          if (sameModelInPrimary) {
            mappedModelRecordId = sameModelInPrimary;
          }
        }
      }
      const modelValid = nextModels.some(
        (item) => item.id === mappedModelRecordId && item.endpointId === primaryEndpointId,
      );
      return {
        ...row,
        endpointId: primaryEndpointId,
        modelRecordId: modelValid ? mappedModelRecordId : primaryModelRecordId,
      };
    });
  }, []);

  const buildHomeModelRows = useCallback(
    (nextEndpoints: EndpointView[], nextModels: ModelRecord[], current: ClaudeCurrentState | null): HomeModelRow[] => {
      const modelKeys = current?.env.modelKeys?.length
        ? current.env.modelKeys
        : [
            "model",
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "CLAUDE_CODE_SUBAGENT_MODEL",
          ];
      const modelValues = current?.env.modelValues ?? {};
      const currentClaudeBaseUrl = normalizeClaudeBaseUrl(current?.env.ANTHROPIC_BASE_URL);
      const defaultEndpointId = nextEndpoints.find(
        (item) => normalizeClaudeBaseUrl(item.baseUrl) === currentClaudeBaseUrl,
      )?.id ?? nextEndpoints[0]?.id ?? "";

      return modelKeys.map((modelKey) => {
        const configuredModelId = modelValues[modelKey];
        let endpointId = defaultEndpointId;
        let modelRecordId = "";

        if (configuredModelId) {
          const exact = nextModels.find(
            (item) => item.endpointId === endpointId && item.modelId === configuredModelId,
          );
          if (exact) {
            modelRecordId = exact.id;
          } else {
            const fallbackByModelId = nextModels.find((item) => item.modelId === configuredModelId);
            if (fallbackByModelId) {
              endpointId = fallbackByModelId.endpointId;
              modelRecordId = fallbackByModelId.id;
            }
          }
        }

        return {
          modelKey,
          endpointId,
          modelRecordId,
        };
      });
    },
    [],
  );

  const loadData = useCallback(
    async (silent = false) => {
      if (!silent) {
        setLoading(true);
      }
      try {
        const [nextEndpoints, nextModels, nextClaudeCurrent, nextCliproxyConfigInfo] = await Promise.all([
          getEndpoints(),
          getModels(),
          getClaudeCurrent(),
          getCliproxyConfigInfo(),
        ]);
        setEndpoints(nextEndpoints);
        setModels(nextModels);
        setClaudeCurrent(nextClaudeCurrent);
        setCliproxyConfigInfo(nextCliproxyConfigInfo);

        setActiveMenu((prev) => {
          const endpointId = menuToEndpointId(prev);
          if (!endpointId) {
            return prev;
          }
          if (endpointId === CURRENT_CONFIG_ENDPOINT_ID && nextClaudeCurrent?.env.ANTHROPIC_BASE_URL) {
            return prev;
          }
          if (nextEndpoints.some((item) => item.id === endpointId)) {
            return prev;
          }
          return "home";
        });

        const computedRows = buildHomeModelRows(nextEndpoints, nextModels, nextClaudeCurrent);
        setHomeModelRows((prevRows) => {
          const normalizeRows = (rows: HomeModelRow[]) => alignRowsToPrimaryEndpoint(rows, nextModels);
          if (!homeRowsDirty) {
            return normalizeRows(computedRows);
          }

          const endpointSet = new Set(nextEndpoints.map((item) => item.id));
          const modelSet = new Set(nextModels.map((item) => item.id));
          const prevByKey = new Map(prevRows.map((item) => [item.modelKey, item]));

          const merged = computedRows.map((row) => {
            const prev = prevByKey.get(row.modelKey);
            if (!prev) {
              return row;
            }
            if (!endpointSet.has(prev.endpointId)) {
              return row;
            }
            if (!prev.modelRecordId) {
              return {
                ...row,
                endpointId: prev.endpointId,
                modelRecordId: "",
              };
            }
            if (!modelSet.has(prev.modelRecordId)) {
              return row;
            }
            return prev;
          });
          return normalizeRows(merged);
        });
      } catch (error) {
        setError(error);
      } finally {
        setLoading(false);
      }
    },
    [alignRowsToPrimaryEndpoint, buildHomeModelRows, homeRowsDirty],
  );

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadData(true);
    }, 12_000);
    return () => window.clearInterval(timer);
  }, [loadData]);

  const virtualCurrentEndpoint = useMemo(() => {
    if (!claudeCurrent?.env.ANTHROPIC_BASE_URL || !claudeCurrent.env.hasAuthToken) {
      return null;
    }
    const currentClaudeBaseUrl = normalizeClaudeBaseUrl(claudeCurrent.env.ANTHROPIC_BASE_URL);
    const exists = endpoints.some((item) => normalizeClaudeBaseUrl(item.baseUrl) === currentClaudeBaseUrl);
    if (exists) {
      return null;
    }
    const now = new Date().toISOString();
    const baseUrl = claudeCurrent.env.ANTHROPIC_BASE_URL;
    return {
      id: CURRENT_CONFIG_ENDPOINT_ID,
      name: inferCurrentEndpointName(baseUrl),
      baseUrl,
      protocol: "anthropic",
      enabled: true,
      dynamicEnabled: false,
      pollingIntervalSec: 30,
      lastSyncStatus: "idle" as const,
      lastSyncAt: undefined,
      lastSyncError: undefined,
      createdAt: now,
      updatedAt: now,
      apiKeyMasked: claudeCurrent.env.ANTHROPIC_AUTH_TOKEN_MASKED || "",
      hasApiKey: claudeCurrent.env.hasAuthToken,
    } satisfies EndpointView;
  }, [claudeCurrent, endpoints]);

  const menuEndpoints = useMemo(
    () => (virtualCurrentEndpoint ? [virtualCurrentEndpoint, ...endpoints] : endpoints),
    [endpoints, virtualCurrentEndpoint],
  );

  const endpointMap = useMemo(
    () => new Map(menuEndpoints.map((endpoint) => [endpoint.id, endpoint])),
    [menuEndpoints],
  );

  const selectedEndpointIdFromMenu = useMemo(() => menuToEndpointId(activeMenu), [activeMenu]);
  const selectedEndpoint = useMemo(
    () => (selectedEndpointIdFromMenu ? endpointMap.get(selectedEndpointIdFromMenu) ?? null : null),
    [endpointMap, selectedEndpointIdFromMenu],
  );
  const isCliproxyLocalPage = useMemo(() => isCliproxyLocalEndpoint(selectedEndpoint), [selectedEndpoint]);
  const isOpenAiResponsesPage = useMemo(() => isOpenAiResponsesEndpoint(selectedEndpoint), [selectedEndpoint]);
  const canManageEndpointConfig = Boolean(
    selectedEndpointIdFromMenu
      && selectedEndpointIdFromMenu !== CURRENT_CONFIG_ENDPOINT_ID
      && !isCliproxyLocalPage,
  );
  const canManageManualModels = canManageEndpointConfig;
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
        value: claudeCurrent?.env.ANTHROPIC_AUTH_TOKEN_MASKED || "未配置",
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

  const endpointModels = useMemo(() => {
    if (!selectedEndpointIdFromMenu) {
      return [];
    }
    return models
      .filter((model) => model.endpointId === selectedEndpointIdFromMenu)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [models, selectedEndpointIdFromMenu]);
  const localGatewayGuideText = useMemo(() => {
    if (!isOpenAiResponsesPage) {
      return "";
    }
    return [
      "OpenAI Responses 协议已由当前服务内置转换，不需要额外启动 ccNexus。",
      "在首页选择该 endpoint 的模型后，会自动写入 Claude Code：",
      "ANTHROPIC_BASE_URL=http://127.0.0.1:3199",
      "ANTHROPIC_AUTH_TOKEN=mm_ep_<endpoint-id>",
      "ANTHROPIC_MODEL=<你选择的模型>",
    ].join("\n");
  }, [isOpenAiResponsesPage]);

  const handleHomeRowEndpointChange = (rowIndex: number, endpointId: string) => {
    setHomeRowsDirty(true);
    setHomeModelRows((prev) => {
      if (!prev[rowIndex]) {
        return prev;
      }
      const currentPrimary = prev[rowIndex];
      let nextPrimaryModelRecordId = "";
      if (currentPrimary.modelRecordId) {
        const currentPrimaryModel = models.find((item) => item.id === currentPrimary.modelRecordId);
        if (currentPrimaryModel) {
          const mapped = models.find(
            (item) => item.endpointId === endpointId && item.modelId === currentPrimaryModel.modelId,
          );
          nextPrimaryModelRecordId = mapped?.id ?? "";
        }
      }

      const draft = prev.map((row, idx) => (idx === rowIndex
        ? {
            ...row,
            endpointId,
            modelRecordId: nextPrimaryModelRecordId,
          }
        : row));
      return alignRowsToPrimaryEndpoint(draft, models);
    });
  };

  const handleHomeRowModelChange = async (rowIndex: number, modelRecordId: string) => {
    const row = homeModelRows[rowIndex];
    if (!row) {
      return;
    }
    const primaryRow = homeModelRows.find((item) => item.modelKey === "model") ?? homeModelRows[0];
    const primaryEndpointId = primaryRow?.endpointId ?? "";
    const model = models.find((item) => item.id === modelRecordId);
    if (!model) {
      return;
    }
    if (row.modelKey !== "model" && primaryEndpointId && model.endpointId !== primaryEndpointId) {
      return;
    }
    const draftRows = homeModelRows.map((item, idx) => (idx === rowIndex
      ? {
          ...item,
          endpointId: model.endpointId,
          modelRecordId,
        }
      : item));
    const nextRows = alignRowsToPrimaryEndpoint(draftRows, models);
    setHomeModelRows(nextRows);
    setSubmitting(true);
    try {
      if (row.modelKey === "model") {
        const applied = await applyRowsToClaude(nextRows);
        setSuccess(`已自动保存 ${applied} 项模型配置`);
      } else {
        await applyClaudeConfig({
          endpointId: model.endpointId,
          modelRecordId,
          modelKey: row.modelKey,
        });
        setSuccess(`已自动保存 ${row.modelKey} = ${model.modelId}`);
      }
      setHomeRowsDirty(false);
      await loadData(true);
    } catch (error) {
      setError(error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRefreshByMenu = async () => {
    setSubmitting(true);
    try {
      const endpointId = menuToEndpointId(activeMenu);
      if (endpointId) {
        if (endpointId === CURRENT_CONFIG_ENDPOINT_ID) {
          await loadData(true);
          setSuccess("当前配置 Endpoint 已更新。");
          return;
        }
        await refreshEndpoint(endpointId);
        await loadData(true);
        setSuccess("Endpoint 模型已刷新。");
      }
    } catch (error) {
      setError(error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateEndpoint = async (event: FormEvent) => {
    event.preventDefault();
    if (!newEndpoint.name || !newEndpoint.baseUrl || !newEndpoint.apiKey) {
      setError(new Error("请填写 endpoint name / baseUrl / apiKey"));
      return;
    }
    setSubmitting(true);
    try {
      const created = await createEndpoint({
        name: newEndpoint.name,
        baseUrl: newEndpoint.baseUrl,
        apiKey: newEndpoint.apiKey,
        protocol: newEndpoint.protocol,
        dynamicEnabled: true,
        enabled: true,
      });
      setNewEndpoint(defaultEndpointForm);
      setShowAddEndpointModal(false);
      await loadData(true);
      setActiveMenu(`endpoint:${created.id}`);
      setSuccess(`已添加 endpoint: ${created.name}`);
    } catch (error) {
      setError(error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateManualModel = async (event: FormEvent) => {
    event.preventDefault();
    const endpointId = selectedEndpointIdFromMenu;
    if (!endpointId) {
      return;
    }
    if (endpointId === CURRENT_CONFIG_ENDPOINT_ID) {
      setError(new Error("当前配置 Endpoint 不支持直接新增手动模型。"));
      return;
    }
    if (!manualModelForm.modelId) {
      setError(new Error("请填写 model id"));
      return;
    }
    setSubmitting(true);
    try {
      await createManualModel({
        endpointId,
        modelId: manualModelForm.modelId,
        displayName: manualModelForm.displayName || undefined,
        provider: manualModelForm.provider || undefined,
      });
      setManualModelForm({
        modelId: "",
        displayName: "",
        provider: "",
      });
      await loadData(true);
      setSuccess("手动模型已添加。");
    } catch (error) {
      setError(error);
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (!selectedEndpointIdFromMenu || selectedEndpointIdFromMenu === CURRENT_CONFIG_ENDPOINT_ID) {
      return;
    }
    const endpoint = endpointMap.get(selectedEndpointIdFromMenu);
    if (!endpoint || isCliproxyLocalEndpoint(endpoint)) {
      return;
    }
    let cancelled = false;
    setEndpointConfigForm({
      baseUrl: endpoint.baseUrl,
      apiKey: "",
      protocol: endpoint.protocol,
    });
    void (async () => {
      try {
        const apiKey = await getEndpointApiKey(selectedEndpointIdFromMenu);
        if (cancelled) {
          return;
        }
        setEndpointConfigForm({
          baseUrl: endpoint.baseUrl,
          apiKey,
          protocol: endpoint.protocol,
        });
      } catch {
        // Keep empty when secret read fails.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpointMap, selectedEndpointIdFromMenu]);

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

  const handleRefreshCliproxyConfigInfo = async () => {
    setSubmitting(true);
    try {
      const info = await getCliproxyConfigInfo();
      setCliproxyConfigInfo(info);
      setSuccess("已刷新 cliproxy 配置文件状态。");
    } catch (error) {
      setError(error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdateEndpointConfig = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedEndpointIdFromMenu || selectedEndpointIdFromMenu === CURRENT_CONFIG_ENDPOINT_ID) {
      return;
    }
    if (!endpointConfigForm.baseUrl) {
      setError(new Error("base url 不能为空"));
      return;
    }
    setSubmitting(true);
    try {
      const updated = await updateEndpoint(selectedEndpointIdFromMenu, {
        baseUrl: endpointConfigForm.baseUrl,
        apiKey: endpointConfigForm.apiKey || undefined,
        protocol: endpointConfigForm.protocol,
      });
      setEndpoints((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setEndpointConfigForm((prev) => ({
        ...prev,
        protocol: updated.protocol,
        apiKey: "",
      }));
      await loadData(true);
      setSuccess(`Endpoint 已更新，当前协议: ${updated.protocol}`);
    } catch (error) {
      setError(error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteManualModel = async (modelId: string) => {
    setSubmitting(true);
    try {
      await deleteManualModel(modelId);
      await loadData(true);
      setSuccess("手动模型已删除。");
    } catch (error) {
      setError(error);
    } finally {
      setSubmitting(false);
    }
  };

  const renderModelList = (title: string, rows: ModelRecord[]) => {
    return (
      <div className="content-card">
        <div className="content-head">
          <h2>{title}</h2>
          <button
            className="icon-btn"
            disabled={submitting}
            onClick={() => void handleRefreshByMenu()}
            title="刷新模型列表"
            type="button"
          >
            ↻
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Model ID</th>
                <th>显示名</th>
                <th>Provider</th>
                <th>来源</th>
                <th>状态</th>
                {canManageManualModels && <th></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((model) => (
                <tr key={model.id}>
                  <td>{model.modelId}</td>
                  <td>{model.displayName}</td>
                  <td>{model.provider || "-"}</td>
                  <td>{model.source}</td>
                  <td>{model.enabled ? "enabled" : "disabled"}</td>
                  {canManageManualModels && (
                    <td>
                      {model.source === "manual" ? (
                        <button
                          className="danger ghost"
                          disabled={submitting}
                          onClick={() => void handleDeleteManualModel(model.id)}
                          type="button"
                        >
                          删除
                        </button>
                      ) : null}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
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
          {menuEndpoints.map((endpoint) => (
            <button
              className={activeMenu === `endpoint:${endpoint.id}` ? "menu-item active" : "menu-item"}
              key={endpoint.id}
              onClick={() => setActiveMenu(`endpoint:${endpoint.id}`)}
              type="button"
            >
              {endpoint.name}
            </button>
          ))}
          <button
            className="menu-item add-item"
            onClick={() => setShowAddEndpointModal(true)}
            type="button"
          >
            + 添加 Endpoint
          </button>
        </nav>
      </aside>

      <main className="main-pane">
        {message && (
          <div className={`notice ${message.type}`}>
            {message.text}
          </div>
        )}

        {activeMenu === "home" && (
          <section className="content-card">
            <h2>Claude Code 当前配置</h2>
            <div className="config-lines">
              {homeConfigLines.map((line) => (
                <div className="config-line" key={line.key}>
                  <div className="config-key">{line.key}</div>
                  <div className="config-value">{line.value}</div>
                </div>
              ))}
              </div>

            {homeModelRows.map((row, rowIndex) => {
              const primaryRow = homeModelRows.find((item) => item.modelKey === "model") ?? homeModelRows[0];
              const primaryEndpointId = primaryRow?.endpointId ?? "";
              const isPrimaryRow = row.modelKey === "model";
              const effectiveEndpointId = isPrimaryRow ? row.endpointId : primaryEndpointId;
              const effectiveEndpoint = endpoints.find((item) => item.id === effectiveEndpointId);
              const rowOptions = models
                .filter((item) => item.endpointId === effectiveEndpointId)
                .sort((a, b) => a.displayName.localeCompare(b.displayName));
              return (
                <div className="config-row" key={row.modelKey}>
                  <label>{row.modelKey}</label>
                  {isPrimaryRow ? (
                    <select
                      disabled={submitting}
                      value={effectiveEndpointId}
                      onChange={(event) => {
                        void handleHomeRowEndpointChange(rowIndex, event.target.value);
                      }}
                    >
                      <option value="">选择 Endpoint</option>
                      {endpoints.map((endpoint) => (
                        <option key={endpoint.id} value={endpoint.id}>
                          {endpoint.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <select
                      disabled
                      value={effectiveEndpointId}
                    >
                      <option value={effectiveEndpointId}>
                        {effectiveEndpoint?.name || "跟随 model 的 endpoint"}
                      </option>
                    </select>
                  )}
                  <select
                    disabled={submitting || !effectiveEndpointId}
                    value={row.modelRecordId}
                    onChange={(event) => {
                      void handleHomeRowModelChange(rowIndex, event.target.value);
                    }}
                  >
                    <option value="">选择模型</option>
                    {rowOptions.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.modelId}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </section>
        )}

        {selectedEndpointIdFromMenu && (
          <>
            {canManageEndpointConfig && (
              <section className="content-card">
                <h3>Endpoint 配置</h3>
                <p className="muted">Endpoint: {selectedEndpoint?.name || selectedEndpointIdFromMenu}</p>
                <form className="inline-form" onSubmit={handleUpdateEndpointConfig}>
                  <select
                    value={endpointConfigForm.protocol}
                    onChange={(event) =>
                      setEndpointConfigForm((prev) => ({
                        ...prev,
                        protocol: event.target.value as EndpointProtocol,
                      }))}
                  >
                    <option value="anthropic">Anthropic /v1/messages</option>
                    <option value="openai_responses">OpenAI /v1/responses（内置转换）</option>
                  </select>
                  <input
                    value={endpointConfigForm.baseUrl}
                    placeholder="base url"
                    onChange={(event) => setEndpointConfigForm((prev) => ({ ...prev, baseUrl: event.target.value }))}
                  />
                  <input
                    type="text"
                    value={endpointConfigForm.apiKey}
                    placeholder="new api key (可选，不填则不改)"
                    onChange={(event) => setEndpointConfigForm((prev) => ({ ...prev, apiKey: event.target.value }))}
                  />
                  <button disabled={submitting} type="submit">保存 Endpoint 配置</button>
                </form>
              </section>
            )}
            {isOpenAiResponsesPage && (
              <section className="content-card">
                <div className="content-head">
                  <h3>Claude Code 接入（内置协议转换）</h3>
                </div>
                <p className="muted">
                  当前 endpoint 协议是 OpenAI Responses。Claude Code 会通过当前服务内置网关接入。
                </p>
                <pre className="code-block">{localGatewayGuideText}</pre>
              </section>
            )}
            {isCliproxyLocalPage && (
              <section className="content-card">
                <div className="content-head">
                  <h3>CLIProxy 配置文件</h3>
                  <button
                    className="icon-btn"
                    disabled={submitting}
                    onClick={() => void handleRefreshCliproxyConfigInfo()}
                    title="刷新配置文件状态"
                    type="button"
                  >
                    ↻
                  </button>
                </div>
                <div className="config-lines">
                  <div className="config-line">
                    <div className="config-key">自动发现配置</div>
                    <div className="config-value">{cliproxyConfigInfo.found ? cliproxyConfigInfo.configPath : "未发现"}</div>
                  </div>
                  <div className="config-line">
                    <div className="config-key">配置 Base URL</div>
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
                    onClick={() => void handleImportSelectedCliproxyConfig()}
                    type="button"
                  >
                    导入所选配置
                  </button>
                </div>
                <p className="muted">
                  已选择文件: {selectedCliproxyConfigName || "未选择"}
                </p>
              </section>
            )}
            {renderModelList(
              `${endpointMap.get(selectedEndpointIdFromMenu)?.name || "Endpoint"} 模型列表`,
              endpointModels,
            )}
            {canManageManualModels && (
              <section className="content-card">
                <h3>手动添加模型</h3>
                <form className="inline-form" onSubmit={handleCreateManualModel}>
                  <input
                    value={manualModelForm.modelId}
                    placeholder="model id"
                    onChange={(event) => setManualModelForm((prev) => ({ ...prev, modelId: event.target.value }))}
                  />
                  <input
                    value={manualModelForm.displayName}
                    placeholder="display name"
                    onChange={(event) =>
                      setManualModelForm((prev) => ({ ...prev, displayName: event.target.value }))
                    }
                  />
                  <input
                    value={manualModelForm.provider}
                    placeholder="provider"
                    onChange={(event) => setManualModelForm((prev) => ({ ...prev, provider: event.target.value }))}
                  />
                  <button disabled={submitting} type="submit">添加</button>
                </form>
                <p className="muted">
                  最后同步时间: {formatTime(endpointMap.get(selectedEndpointIdFromMenu)?.lastSyncAt)}
                </p>
              </section>
            )}
          </>
        )}
      </main>
      {showAddEndpointModal && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!submitting) {
              setShowAddEndpointModal(false);
            }
          }}
        >
          <div
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
          >
            <h3>添加 Endpoint</h3>
            <form className="modal-form" onSubmit={handleCreateEndpoint}>
              <select
                value={newEndpoint.protocol}
                onChange={(event) =>
                  setNewEndpoint((prev) => ({ ...prev, protocol: event.target.value as EndpointProtocol }))}
              >
                <option value="anthropic">Anthropic /v1/messages</option>
                <option value="openai_responses">OpenAI /v1/responses（内置转换）</option>
              </select>
              <input
                value={newEndpoint.name}
                placeholder="endpoint name"
                onChange={(event) => setNewEndpoint((prev) => ({ ...prev, name: event.target.value }))}
              />
              <input
                value={newEndpoint.baseUrl}
                placeholder="base url"
                onChange={(event) => setNewEndpoint((prev) => ({ ...prev, baseUrl: event.target.value }))}
              />
              <input
                type="text"
                value={newEndpoint.apiKey}
                placeholder="api key"
                onChange={(event) => setNewEndpoint((prev) => ({ ...prev, apiKey: event.target.value }))}
              />
              <div className="modal-actions">
                <button
                  className="ghost-btn"
                  disabled={submitting}
                  onClick={() => setShowAddEndpointModal(false)}
                  type="button"
                >
                  取消
                </button>
                <button disabled={submitting} type="submit">添加</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
