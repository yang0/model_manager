# model_manager 第一阶段文档（中文）

更新时间：2026-03-01

## 1. 阶段目标与结果

第一阶段目标是交付一个本地可运行的 Claude Code 模型管理系统，支持：

- 统一管理 CLIProxy 提供的模型
- 为 Claude Code 配置多变量 fallback chain
- 在运行时失败时自动切换模型
- 将切换结果自动回写 Claude 配置

当前目标已完成，系统已进入稳定可用状态。

## 2. 当前系统架构

推荐调用链路：

`Claude Code -> model_manager -> CLIProxy`

其中：

- model_manager 作为中间代理，监听本地 `http://127.0.0.1:3199`
- Claude Code 的 `ANTHROPIC_BASE_URL` 写入 model_manager 地址
- model_manager 再转发到 CLIProxy 上游

## 3. 核心能力

### 3.1 模型同步与额度整合

- 单 endpoint：`CLIProxy Local`
- 定时拉取模型列表（默认 30 秒）
- 通过 CLIProxy 管理接口整合 OAuth 额度
  - antigravity：模型级额度与重置时间
  - gemini-cli：按 bucket 聚合额度
  - iflow：固定不限量

### 3.2 运行时 fallback 切换

- 请求入口：`/v1/messages`、`/v1/messages/count_tokens`
- 当请求失败时，根据 fallback chain 顺序尝试下一个可用模型
- 响应头返回实际命中模型和 fallback 次数
  - `x-mm-proxy-model`
  - `x-mm-proxy-fallback-count`

### 3.3 Claude 配置自动回写

- fallback 成功后自动同步 Claude 对应模型变量
- 状态变化（模型启用/禁用）时自动重算各变量当前模型并回写配置
- 写入项包括：
  - `env.ANTHROPIC_BASE_URL`（固定本地代理地址）
  - `env.ANTHROPIC_AUTH_TOKEN`
  - `model`
  - `ANTHROPIC_MODEL`
  - `ANTHROPIC_DEFAULT_OPUS_MODEL`
  - `ANTHROPIC_DEFAULT_SONNET_MODEL`
  - `ANTHROPIC_DEFAULT_HAIKU_MODEL`
  - `CLAUDE_CODE_SUBAGENT_MODEL`

### 3.4 模型状态管理

- 自动策略：
  - 仅“有限额且额度耗尽”的模型会被自动禁用
  - 到达额度刷新时间后 +1 分钟自动刷新并恢复可用状态
  - 系统重启后会先拉取额度并重置状态
- 手动策略：
  - WebUI 模型列表支持手动启用/禁用
  - 手动操作会触发配置重算与回写

## 4. 前端交付

- 技术栈：React + TypeScript + Vite
- 页面：
  - 首页：Claude 当前配置 + 各变量 fallback chain 管理
  - CLIProxy Local：配置导入、刷新、模型列表、评分、状态操作
- 模型列表状态列：
  - 显示“启用/禁用”状态与原因
  - 支持点击切换

## 5. 后端交付

- 技术栈：Node.js + TypeScript + Fastify
- 主要接口：
  - `GET /api/health`
  - `GET /api/endpoints`
  - `POST /api/endpoints/import-cliproxy`
  - `GET /api/endpoints/cliproxy-config`
  - `POST /api/endpoints/:id/refresh`
  - `GET /api/models`
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

## 6. 运行方式

### 开发模式

```bash
npm install
npm run dev
```

- Frontend: `http://127.0.0.1:5173`
- Backend: `http://127.0.0.1:3199`

### 单服务模式（推荐）

```bash
npm run build
npm run start -w backend
```

- 统一入口：`http://127.0.0.1:3199`

## 7. 已知边界

- fallback 依赖上游错误码/错误信息判断是否继续降级
- 对特殊上游的非标准错误格式，仍建议结合日志排查并按需扩展规则
