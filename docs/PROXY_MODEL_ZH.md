# 通用代理模型（`proxy_model`）使用说明

本文档说明如何在不改变 Anthropic 调用方式的前提下，使用 model_manager 的通用模型入口 `proxy_model`。

## 1. 目标

- 客户端继续按 Anthropic 协议调用 `POST /v1/messages`
- 客户端请求里固定 `model=proxy_model`
- model_manager 在服务端按 `proxy_model` 的 fallback chain 自动选择真实模型

## 2. WebUI 配置

1. 打开左侧菜单 `通用代理模型`
2. 在 `proxy_model` 区域点击 `设置`
3. 选择并排序 fallback chain（首项为当前优先模型）
4. 保存后立即生效

说明：
- 该 chain 与首页 Claude 变量 chain 独立
- `proxy_model` 切换不会回写 `~/.claude/settings.json` 中的 `model` 或 `env.*MODEL*`

## 3. 客户端调用参数

- Base URL：`http://127.0.0.1:3199`（或你的 model_manager 地址）
- API 路径：`/v1/messages`
- Model：`proxy_model`
- Header：
  - `content-type: application/json`
  - `anthropic-version: 2023-06-01`
  - `x-api-key: <your-api-key>`（本地代理场景可传任意非空值；最终上游鉴权由服务端完成）

## 4. 调用示例

```bash
curl -X POST "http://127.0.0.1:3199/v1/messages" \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "x-api-key: demo-key" \
  -d '{
    "model": "proxy_model",
    "max_tokens": 256,
    "messages": [{"role":"user","content":"Hello"}]
  }'
```

## 5. 观察实际命中模型

响应头包含：

- `x-mm-proxy-model`：本次实际命中的真实模型
- `x-mm-proxy-fallback-count`：fallback 次数（`0` 表示首项命中）
- `x-mm-proxy-thinking`：thinking 参数处理状态
  - `kept`：透传给上游
  - `dropped`：已自动剔除
  - `none`：请求中未携带 thinking 参数

可用于灰度验证和故障排查。

## 6. Thinking 参数智能处理

当请求包含以下任一字段时，会触发智能判断：

- `thinking`
- `thingking`（兼容拼写）
- `reasoning`
- `reasoning_effort` / `reasoningEffort`
- `reasoning_budget_tokens` / `reasoningBudgetTokens`

处理策略：

1. 优先读取模型 `meta` 里的显式能力标记（如 `supports_thinking`、`supports_reasoning` 等）
2. 若无显式标记，再根据模型名启发式判断
3. 判断支持则透传 thinking 参数；不支持则自动剔除
4. 若判断支持后仍收到上游“不支持 thinking/reasoning”错误，会对同一模型自动去参重试一次

这样可以在保证兼容性的同时，尽量保留支持推理的模型能力。

## 7. 流式兼容（OpenClaw）

`POST /v1/messages` 且 `stream: true` 时，返回 `text/event-stream`，并输出 Anthropic 风格事件序列（非空）：

1. `message_start`
2. `content_block_start`
3. `content_block_delta`（一个或多个文本增量）
4. `content_block_stop`
5. `message_delta`（含 `usage`）
6. `message_stop`

附加诊断头：

- `x-mm-proxy-stream-adapter: anthropic_messages`
- `x-mm-proxy-sse-frames: <事件帧数量>`

## 8. 附：Chat Completions 接口

除 Anthropic Messages 外，代理也支持：

- `POST /v1/chat/completions`

该路径同样使用 fallback chain 选模，且可与 `proxy_model` 配合使用。
