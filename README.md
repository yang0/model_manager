# model_manager

用于管理 CLIProxyAPI 反代模型和手动模型，并一键写入 Claude Code 配置。

## 文档

- 中文一期文档：`docs/PHASE1_ZH.md`
- English phase-1 doc: `docs/PHASE1_EN.md`

## 功能

- 动态拉取模型：按 Endpoint 轮询 `{baseUrl}/v1/models`（默认 30 秒）
- 手动维护模型：一个 `baseUrl + api_key` Endpoint 下可维护多个模型
- 模型共存策略：同名模型允许共存，按 `endpoint + model` 区分
- Claude 一键配置：写入 `env.ANTHROPIC_BASE_URL`、`env.ANTHROPIC_AUTH_TOKEN`、`env.ANTHROPIC_MODEL`
- 内置协议转换：`OpenAI /v1/responses` Endpoint 可通过本服务内置网关转成 Anthropic `/v1/messages`
- 本地加密：API Key 使用 Windows DPAPI 加密后存储

## 技术栈

- Frontend: React + TypeScript + Vite
- Backend: Node.js + TypeScript + Fastify
- Storage: `%APPDATA%/model-manager/storage.json`

## 目录结构

- `frontend/` WebUI
- `backend/` 本地 API 服务
- `shared/` 前后端共享类型

## 开发启动

```bash
npm install
npm run dev
```

开发模式端口：

- Frontend: `http://127.0.0.1:5173`
- Backend: `http://127.0.0.1:3199`
- Vite 已内置代理：`/api`、`/v1` -> `http://127.0.0.1:3199`

## 单服务启动（推荐）

```bash
npm run build
npm run start -w backend
```

单服务地址：

- WebUI: `http://127.0.0.1:3199`
- API: `http://127.0.0.1:3199/api/*`
- Anthropic 兼容网关: `http://127.0.0.1:3199/v1/*`

可选环境变量：

- `MODEL_MANAGER_PORT`: 修改后端端口（默认 `3199`）
- `MODEL_MANAGER_GATEWAY_BASE_URL`: 覆盖写入 Claude Code 的网关地址（默认 `http://127.0.0.1:${MODEL_MANAGER_PORT}`）
- `VITE_API_BASE_URL`: 覆盖前端 API 地址（默认同源）

## 生产构建

```bash
npm run build
```

输出目录：

- `backend/dist`
- `frontend/dist`
- `shared/dist`

## 已实现接口（后端）

- `GET /api/health`
- `GET /api/endpoints`
- `POST /api/endpoints`
- `PUT /api/endpoints/:id`
- `DELETE /api/endpoints/:id`
- `POST /api/endpoints/:id/refresh`
- `GET /api/models`
- `POST /api/models/manual`
- `PUT /api/models/manual/:id`
- `DELETE /api/models/manual/:id`
- `GET /api/settings`
- `PUT /api/settings`
- `GET /api/claude/detect-settings`
- `POST /api/claude/apply`
