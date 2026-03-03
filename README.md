# model_manager

用于管理 CLIProxy 反代模型，并作为 Claude Code 与 CLIProxy 之间的本地中间代理。

当前推荐链路：
`Claude Code -> model_manager (http://127.0.0.1:3199) -> CLIProxy`

## 文档

- 中文一期文档：`docs/PHASE1_ZH.md`
- English phase-1 doc: `docs/PHASE1_EN.md`
- 通用代理模型（proxy_model）使用说明：`docs/PROXY_MODEL_ZH.md`

## 核心功能（当前实现）

- 单一模型源：仅保留 `CLIProxy Local`
- 动态模型同步：轮询 `{baseUrl}/v1/models`（默认 30 秒）
- 额度信息整合（CLIProxy 管理接口）：
  - antigravity：模型级剩余额度与重置时间
  - gemini-cli：bucket 聚合后模型额度
  - iflow：标记为不限量
- 本地代理网关（`/v1/*`）：
  - `GET /v1/models`
  - `POST /v1/messages`
  - `POST /v1/messages/count_tokens`
  - `POST /v1/chat/completions`
- Fallback Chain 运行时自动切换：
  - 请求失败后按 chain 尝试可用模型
  - 成功切换后自动回写 Claude 配置与当前模型
- 通用代理模型 `proxy_model`（Anthropic 调用模式不变）：
  - 客户端可固定 `model=proxy_model` 调用 `/v1/messages`
  - `proxy_model` 使用独立 fallback chain（WebUI 独立菜单）
  - `proxy_model` 的切换仅更新内部路由状态，不回写 Claude 的 `model/env.*MODEL*`
  - 请求含 `thinking/thingking/reasoning` 参数时会智能判断模型能力：支持则透传，不支持则自动剔除
  - 若初次判断支持但上游返回不支持错误，会对同一模型自动“去 thinking 重试”一次
  - 流式 `POST /v1/messages`（`stream: true`）会输出 Anthropic SSE 事件序列，兼容 OpenClaw
- 模型状态管理：
  - 自动：有限额且额度耗尽时禁用，额度恢复后重新启用
  - 手动：支持在模型列表中点击启用/禁用（带状态覆盖）
  - 状态变化会触发 Claude 变量模型重算与回写
- 配置写入：
  - `ANTHROPIC_BASE_URL` 固定写为本地代理地址（默认 `http://127.0.0.1:3199`）
  - `ANTHROPIC_AUTH_TOKEN` 写入 CLIProxy API Key
  - 写入 `model` / `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_*` / `CLAUDE_CODE_SUBAGENT_MODEL`
- 密钥安全：API Key 使用 Windows DPAPI 加密存储

## 技术栈

- Frontend: React + TypeScript + Vite
- Backend: Node.js + TypeScript + Fastify
- Storage: `%APPDATA%/model-manager/storage.json`

## 目录结构

- `frontend/` WebUI
- `backend/` 本地 API + 本地代理网关
- `shared/` 前后端共享类型

## 开发启动

```bash
npm install
npm run dev
```

- Frontend: `http://127.0.0.1:5173`
- Backend: `http://127.0.0.1:3199`
- Vite 代理：`/api`、`/v1` -> `http://127.0.0.1:3199`

## 单服务启动（推荐）

```bash
npm run build
npm run start -w backend
```

- WebUI: `http://127.0.0.1:3199`
- API: `http://127.0.0.1:3199/api/*`
- Proxy: `http://127.0.0.1:3199/v1/*`

## 可选环境变量

- `MODEL_MANAGER_PORT`: 后端端口（默认 `3199`）
- `VITE_API_BASE_URL`: 前端 API 地址（默认同源）
- `CLIPROXY_MANAGEMENT_KEY`: CLIProxy 管理密钥（用于额度同步）

额度同步密钥优先级：
1. `smartRouting.signals.management.secretKeyEncrypted`
2. `CLIPROXY_MANAGEMENT_KEY`

## 生产构建

```bash
npm run build
```

输出目录：
- `backend/dist`
- `frontend/dist`
- `shared/dist`

## 后端接口（当前）

- `GET /api/health`
- `GET /api/endpoints`
- `POST /api/endpoints/import-cliproxy`
- `GET /api/endpoints/cliproxy-config`
- `POST /api/endpoints/:id/refresh`
- `GET /api/models`
- `GET /api/models/quickstart`
- `PUT /api/models/:id/enabled`
- `POST /api/models/score`
- `GET /api/fallback-chains`
- `PUT /api/fallback-chains/:modelKey`
- `GET /api/settings`
- `PUT /api/settings`
- `GET /api/claude/detect-settings`
- `GET /api/claude/current`
- `POST /api/claude/apply`
- `GET /v1/models`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `POST /v1/chat/completions`
