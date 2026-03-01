# model_manager Phase 1 Documentation (English)

## 1. Phase Goal

Phase 1 delivers a local model manager and Claude Code config tool with:

- Endpoint management (CLIProxy + manual endpoints)
- Dynamic model sync plus manual model coexistence
- Claude Code config visualization and auto-apply
- Built-in OpenAI Responses -> Anthropic protocol conversion
- Single-service runtime (same port for WebUI + API + gateway)

## 2. Delivered Scope

### 2.1 Frontend (React + TypeScript + Vite)

- Split layout dashboard
  - Left menu: `Home`, `CLIProxy Local`, dynamic endpoint list, add button
  - Right area: home config, endpoint model list, endpoint config
- Home page for Claude Code configuration
  - Shows settings path, base URL, masked token, all model keys/values
  - Cascading model selectors with auto-save behavior
- Latest cascading rules
  - Only `model` row can change endpoint
  - Other rows follow the `model` endpoint
  - If a same `modelId` exists in the new endpoint, keep that mapping
  - Otherwise fallback to the `model` row model to avoid invalid config
- CLIProxy Local page
  - Config file display / import / refresh only
  - No endpoint editing and no manual model creation on this page

### 2.2 Backend (Node.js + TypeScript + Fastify)

- Business APIs (`/api/*`)
  - endpoint CRUD, refresh, plaintext api key read
  - model listing and manual model CRUD
  - settings read/write
  - Claude settings detect/apply
- Dynamic model sync
  - Polls `{baseUrl}/v1/models` by default
  - Persists models and endpoint sync status
- Secret handling
  - Endpoint API keys are stored encrypted with Windows DPAPI
- Built-in protocol gateway (`/v1/*`)
  - `POST /v1/messages`
  - `POST /v1/messages/count_tokens`
  - `GET /v1/models`
  - Converts OpenAI Responses upstream outputs into Anthropic-compatible outputs

### 2.3 Single-Port Runtime

In production mode, one backend port serves:

- WebUI static files
- `/api/*` management APIs
- `/v1/*` gateway APIs

Default port: `3199`

## 3. Protocol and Model Support

- Endpoint protocols:
  - `anthropic`
  - `openai_responses`
- For `openai_responses` apply flow:
  - `ANTHROPIC_BASE_URL` -> local gateway (default `http://127.0.0.1:3199`)
  - `ANTHROPIC_AUTH_TOKEN` -> `mm_ep_<endpointId>`
  - Gateway resolves endpoint by token and forwards to upstream Responses API

## 4. Key Compatibility Fixes Completed

- Fixed HTML response issue under `5173` dev mode for `/api` and `/v1`
  - Added Vite dev proxy to backend
- Fixed OpenAI-compatible upstream issues
  - Stop forwarding `metadata` (causes 5xx on some gateways)
  - Added upstream retry for transient network/socket failures
- Fixed home auto-refresh overriding in-progress user selections
  - Local selection is preserved until apply
- Fixed UI-linking vs config-file mismatch
  - Primary model change now applies linked model rows to Claude settings

## 5. Repository Structure

- `frontend/`: WebUI
- `backend/`: local API service + built-in protocol gateway
- `shared/`: shared types
- `docs/`: phase documentation

## 6. Run Instructions

### Development mode

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

## 7. Phase Limits and Next Suggestions

- Current implementation prioritizes common Claude Code request flows
- Phase 2 suggestions:
  - endpoint-level advanced retry policy
  - model capability tags (tool use / vision / long context)
  - richer templates for Claude model-key strategy

