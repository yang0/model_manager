# model_manager 第一阶段文档（中文）

> 说明（2026-03-01 更新）：当前代码已进入“简化模式”，仅保留 CLIProxy Local 单 endpoint。本文档记录第一阶段完整交付背景。

## 0. 2026-03-01 增量更新（简化模式）

- CLIProxy 模型列表新增额度展示能力：
  - `额度`：优先显示 `quota_display` / `quota_remaining_fraction`
  - `下次更新`：显示额度恢复/重置时间（如 `quota_reset_at`）
- OAuth 额度来源：
  - 通过 CLIProxy 管理端接口拉取 `auth-files`，再使用 `api-call` 调额度接口
  - antigravity：`fetchAvailableModels`
  - gemini-cli：`retrieveUserQuota`
- 特殊规则：
  - `iflow` provider 统一按“不限量”显示
  - 前端过滤布尔型额度元信息（如 `quota_limited`），避免出现无意义的 `true/false`
- 密钥来源优先级：
  1. 已保存的 management secret（`smartRouting.signals.management.secretKeyEncrypted`）
  2. 环境变量 `CLIPROXY_MANAGEMENT_KEY`

## 1. 阶段目标

第一阶段目标是完成一个可本地运行的模型管理与 Claude Code 配置工具，覆盖：

- Endpoint 管理（CLIProxy / 手动新增）
- 动态模型拉取与手动模型共存
- Claude Code 配置可视化与自动写入
- OpenAI Responses -> Anthropic 协议转换（内置网关）
- 单服务运行（同端口提供 WebUI + API + 网关）

## 2. 当前交付范围

### 2.1 前端（React + TypeScript + Vite）

- 左右布局管理台
  - 左侧菜单：`首页`、`CLIProxy Local`、动态 endpoint 列表、添加按钮
  - 右侧内容：首页配置、endpoint 模型列表、endpoint 配置
- 首页支持 Claude Code 模型配置
  - 显示当前配置文件、Base URL、Token 掩码、全部模型键值
  - 二级联动选择模型并自动保存
- 联动规则（最新）
  - 仅 `model` 行可切换 endpoint
  - 其他模型行 endpoint 跟随 `model`
  - 若其他模型在新 endpoint 中存在同名模型，保留同名映射
  - 若不存在，回退为 `model` 当前模型，避免写入不存在模型
- CLIProxy Local 页面
  - 仅保留配置文件展示/选择导入/刷新
  - 不提供 endpoint 编辑与手动模型新增

### 2.2 后端（Node.js + TypeScript + Fastify）

- 业务 API（`/api/*`）
  - endpoints CRUD、刷新、读取明文 api key
  - models 查询、手动模型 CRUD
  - settings 读写
  - Claude 配置检测与应用
- 动态拉取
  - 默认轮询 `{baseUrl}/v1/models`
  - 写回本地存储并标记同步状态
- 密钥安全
  - Windows DPAPI 加密存储 endpoint api key
- 内置协议网关（`/v1/*`）
  - `POST /v1/messages`
  - `POST /v1/messages/count_tokens`
  - `GET /v1/models`
  - 支持 OpenAI Responses 上游转 Anthropic 兼容输出

### 2.3 单端口运行

- 生产模式下，后端同端口提供：
  - WebUI 静态页面
  - `/api/*` 管理接口
  - `/v1/*` 网关接口
- 默认端口：`3199`

## 3. 协议与模型支持

- endpoint 协议类型：
  - `anthropic`
  - `openai_responses`
- 对 `openai_responses` 的 Claude 应用逻辑：
  - `ANTHROPIC_BASE_URL` 指向本地网关（默认 `http://127.0.0.1:3199`）
  - `ANTHROPIC_AUTH_TOKEN` 写入 `mm_ep_<endpointId>`
  - 网关用 token 反查 endpoint 并转发到上游 OpenAI Responses

## 4. 已完成的重要兼容修复

- 修复前端 `5173` 下 `/api`、`/v1` 返回 HTML 导致 JSON 解析报错的问题
  - 已在 Vite dev server 增加代理
- 修复 OpenAI 上游兼容问题
  - 去除 `metadata` 转发（某些网关会因此 5xx）
  - 增加上游请求重试，缓解短时网络/连接抖动
- 修复首页自动刷新覆盖用户选择的问题
  - 用户本地未提交选择优先保留
- 修复联动显示与配置文件不一致问题
  - 主模型变更时会批量写回相关模型键

## 5. 目录说明

- `frontend/`：WebUI
- `backend/`：本地服务 + 内置协议转换网关
- `shared/`：前后端共享类型
- `docs/`：阶段文档

## 6. 启动方式

### 开发模式

```bash
npm install
npm run dev
```

- Frontend: `http://127.0.0.1:5173`
- Backend: `http://127.0.0.1:3199`

### 单服务（推荐）

```bash
npm run build
npm run start -w backend
```

- 统一入口：`http://127.0.0.1:3199`

## 7. 阶段性限制与后续建议

- 当前优先支持 Claude Code 常见调用路径，后续可继续补齐更多边缘字段转换
- 可在二阶段新增：
  - endpoint 级高级重试策略配置
  - 模型能力标注（工具调用/图像/长上下文）
  - 更细粒度的 Claude 模型键策略模板
