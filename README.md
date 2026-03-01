# model_manager

用于管理 CLIProxyAPI 反代模型，并一键写入 Claude Code 配置。

## 文档

- 中文一期文档：`docs/PHASE1_ZH.md`
- English phase-1 doc: `docs/PHASE1_EN.md`
- 简化版说明（仅 CLIProxy）：本 README

## 功能（简化版）

- 仅保留 `CLIProxy Local` 单一模型源
- 动态拉取模型：轮询 `{baseUrl}/v1/models`（默认 30 秒）
- OAuth 额度整合：通过 CLIProxy 管理接口拉取额度与下次恢复时间
  - antigravity：按模型显示 `remainingFraction` 与 `resetTime`
  - gemini-cli：按模型聚合 bucket 后显示额度/恢复时间
  - iflow：固定显示 `不限量`
- Claude 一键配置：写入 `env.ANTHROPIC_BASE_URL`、`env.ANTHROPIC_AUTH_TOKEN`、各模型键
- 本地加密：API Key 使用 Windows DPAPI 加密后存储
- 启动时会清理历史多 endpoint / 手动模型数据，仅保留 CLIProxy 数据

## 技术栈

- Frontend: React + TypeScript + Vite
- Backend: Node.js + TypeScript + Fastify
- Storage: `%APPDATA%/model-manager/storage.json`

## 目录结构

- `frontend/` WebUI
- `backend/` 本地 API 服务（仅 CLIProxy）
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

可选环境变量：

- `MODEL_MANAGER_PORT`: 修改后端端口（默认 `3199`）
- `VITE_API_BASE_URL`: 覆盖前端 API 地址（默认同源）
- `CLIPROXY_MANAGEMENT_KEY`: CLIProxy 管理密钥（用于拉 OAuth 额度；未配置则跳过额度同步）

> 额度同步密钥优先级：
> 1) `smartRouting.signals.management.secretKeyEncrypted`（已存储的管理密钥）
> 2) 环境变量 `CLIPROXY_MANAGEMENT_KEY`

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
- `POST /api/endpoints/import-cliproxy`
- `GET /api/endpoints/cliproxy-config`
- `POST /api/endpoints/:id/refresh`
- `GET /api/models`
- `POST /api/models/score`
- `GET /api/fallback-chains`
- `PUT /api/fallback-chains/:modelKey`
- `GET /api/settings`
- `PUT /api/settings`
- `GET /api/claude/detect-settings`
- `GET /api/claude/current`
- `POST /api/claude/apply`
