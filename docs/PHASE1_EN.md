# model_manager Phase 1 Documentation (English)

Updated: 2026-03-01

## 1. Phase Goal and Outcome

Phase 1 aimed to deliver a production-usable local model manager for Claude Code that can:

- manage CLIProxy models in one place
- configure per-variable fallback chains
- switch models at runtime on request failures
- write the switched model back into Claude settings automatically

This goal is completed.

## 2. Current Architecture

Recommended request path:

`Claude Code -> model_manager -> CLIProxy`

Notes:

- model_manager runs as the local proxy at `http://127.0.0.1:3199`
- Claude settings use model_manager as `ANTHROPIC_BASE_URL`
- model_manager forwards to CLIProxy upstream

## 3. Core Capabilities

### 3.1 Model Sync and Quota Integration

- Single endpoint mode: `CLIProxy Local`
- Periodic model sync (default every 30s)
- OAuth quota integration via CLIProxy management APIs:
  - antigravity: per-model quota and reset time
  - gemini-cli: quota aggregated from buckets to model level
  - iflow: always treated as unlimited

### 3.2 Runtime Fallback Switching

- Request proxy endpoints: `/v1/messages`, `/v1/messages/count_tokens`
- On failure, model_manager tries the next available model in the fallback chain
- Response headers expose routing result:
  - `x-mm-proxy-model`
  - `x-mm-proxy-fallback-count`

### 3.3 Automatic Claude Config Write-Back

- Successful fallback switches are written back to Claude model variables
- Model status changes (enable/disable) trigger model recalculation and config write-back
- Updated keys include:
  - `env.ANTHROPIC_BASE_URL` (fixed to local proxy)
  - `env.ANTHROPIC_AUTH_TOKEN`
  - `model`
  - `ANTHROPIC_MODEL`
  - `ANTHROPIC_DEFAULT_OPUS_MODEL`
  - `ANTHROPIC_DEFAULT_SONNET_MODEL`
  - `ANTHROPIC_DEFAULT_HAIKU_MODEL`
  - `CLAUDE_CODE_SUBAGENT_MODEL`

### 3.4 Model Status Management

- Automatic behavior:
  - only quota-limited models with exhausted quota are auto-disabled
  - quota refresh is retried at `reset_time + 1 minute`
  - on restart, quota is fetched and statuses are recalculated
- Manual behavior:
  - WebUI allows one-click enable/disable per model
  - manual status changes also trigger fallback/config reconciliation

## 4. Frontend Delivery

- Stack: React + TypeScript + Vite
- Pages:
  - Home: Claude current config + fallback chains per variable
  - CLIProxy Local: config import, refresh, model list, scoring, status operations
- Status column in model list:
  - clearly shows enabled/disabled and reason
  - clickable to toggle state

## 5. Backend Delivery

- Stack: Node.js + TypeScript + Fastify
- Main endpoints:
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

## 6. Run Instructions

### Development

```bash
npm install
npm run dev
```

- Frontend: `http://127.0.0.1:5173`
- Backend: `http://127.0.0.1:3199`

### Single-service mode (recommended)

```bash
npm run build
npm run start -w backend
```

- Unified entry: `http://127.0.0.1:3199`

## 7. Known Boundary

- fallback continuation depends on upstream status codes and error text patterns
- for non-standard upstream error formats, inspect logs and extend fallback detection rules if needed
