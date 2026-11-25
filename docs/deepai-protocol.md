# DeepAI Code Protocol Specification

Extracted from DeepAI Code Desktop (`app.asar` / `server.asar` / `apps/server/dist/binCli-C6U4jU1g.mjs`, `@earendil-works/pi-ai`, and `.deepai-code/userdata/deepai/pi/deepai/models.json`).

---

## 1. Upstream Origins & Base URLs

- **API Origin (`DEEPAI_API_ORIGIN`):** `https://api.deepai.org`
- **DeepAI Code Base (`DEEPAI_MODEL_BASE`):** `https://api.deepai.org/deepai_code`

---

## 2. Desktop Auth / Login Flow (RFC 8252 Loopback + PKCE)

DeepAI Code Desktop uses a local ephemeral loopback HTTP server on `127.0.0.1` with PKCE (`S256`) and a CSRF `state` token.

### 2.1. Authorization / Login URL

```
GET https://api.deepai.org/deepai_code/desktop_auth/
```

**Query Parameters:**
| Parameter | Description |
| :--- | :--- |
| `state` | 64-char hex random string (`crypto.randomBytes(32).toString("hex")`) |
| `port` | Ephemeral local TCP port bound on `127.0.0.1` |
| `code_challenge` | Base64url-encoded SHA-256 hash of `code_verifier` |
| `code_challenge_method` | `S256` |

*(Note: `redirect_uri` is not sent as a query param; the server redirects back to `http://127.0.0.1:<port>/auth-callback` using `port`.)*

### 2.2. Local Loopback Callback

```
GET http://127.0.0.1:<port>/auth-callback?code=<auth_code>&state=<state>
```

- Validates `req.method === "GET"`, `code` is non-empty and `<= 4096` chars, and `state` matches via timing-safe comparison.
- On success, responds with `303 See Other` redirecting to a local confirmation page.

### 2.3. Authorization Code Exchange

```
POST https://api.deepai.org/deepai_code/desktop_auth/exchange/
Content-Type: application/json
```

**Request Body:**
```json
{
  "code": "<auth_code>",
  "code_verifier": "<base64url_32_bytes>"
}
```

**Response JSON (`200 OK`):**
```json
{
  "api_key": "<string, required, non-empty>",
  "username": "<string, optional, defaults to ''>",
  "is_pro": true,
  "connect_token": "dc_<43 base64url chars, optional>",
  "connect_expires_at": "<ISO-8601 timestamp, optional>",
  "connect_unavailable": "session_limit"
}
```

- `api_key` is a long-lived API key (no refresh endpoint exists for `api_key`).
- `is_pro` is boolean (`d.is_pro === true`).
- `connect_token` (if present) must match `/^dc_[A-Za-z0-9_-]{43}$/` and is used for `/connect/*` remote-server endpoints with `Authorization: Bearer <connect_token>`.

### 2.4. Account, Quota, Check-In & Model Catalog Endpoints

All `/deepai_code/*` and `/get_usage_summary` requests include the standard DeepAI headers (see Section 3.2).

| Endpoint | Method | Purpose & Response |
| :--- | :--- | :--- |
| `https://api.deepai.org/deepai_code/theos` | `GET` | Allowance / Theos balance & check-in nonce. Returns `{ enabled, balance, granted, refresh_at, lane_version, check_in: { nonce, seconds } }`. |
| `https://api.deepai.org/get_usage_summary` | `GET` | Entitlement check. Returns `{ is_authenticated: boolean, is_pro: boolean, error?: ... }`. |
| `https://api.deepai.org/deepai_code/models` | `GET` | Live model catalog JSON (`{ models: [...] }`). |
| `https://api.deepai.org/speech_to_text` | `POST` | Audio dictation (`multipart/form-data` with `voiceRecording`, header `api-key: <api_key>`). |
| `https://api.deepai.org/chat_attachments/upload` | `POST` | Upload history attachment (`multipart/form-data` with `file`, headers `api-key` + lane headers). |
| `https://api.deepai.org/chat_attachments/get?uuid=<uuid>` | `GET` | Fetch attachment metadata & `download_url` (header `api-key`). |

#### Check-In & Beacon Mechanism (`/theos`)
Before proxying inference requests (`/chat/completions` or `/responses`), the desktop client ensures a valid check-in from `/theos` (cached for `check_in.seconds / 2`).
- `GET /deepai_code/theos` sends:
  - `X-DeepAI-Code-Check-In: <previous_32_hex_nonce>` (when available)
  - `X-DeepAI-Code-Beacon: v=<app_version>;up=<uptime_sec>;pi=<0|1>;focus=<0|1>`

---

## 3. Chat Completions / Inference Upstream API

### 3.1. Endpoints

- **Chat Completions (26 of 27 models):**
  `POST https://api.deepai.org/deepai_code/chat/completions`
- **OpenAI Responses API (`gpt-6-astra` only, `api: "openai-responses"`):**
  `POST https://api.deepai.org/deepai_code/responses`

### 3.2. Required & Optional Request Headers

| Header | Value / Format | Notes |
| :--- | :--- | :--- |
| `Content-Type` | `application/json` | Required |
| `api-key` | `<api_key>` | Required (`Api-Key` / `api-key`; NOT `Authorization: Bearer`) |
| `X-DeepAI-Code-Theos` | `"7"` | Required lane version (`DEEPAI_LANE_HEADERS`) |
| `X-DeepAI-Code-Instance` | `<32-char hex>` | Random per-process instance ID (`randomBytes(16).toString("hex")`) |
| `X-DeepAI-Code-Machine` | `<64-char hex>` | SHA-256 hex digest of machine UUID (Windows: `Win32_ComputerSystemProduct.UUID` or `HKLM\...\Cryptography\MachineGuid`; macOS: `IOPlatformUUID`; Linux: `/etc/machine-id`). Required for metered calls (`machine_required` if omitted). |
| `X-Session-Affinity` | `<session_id>` | Optional; forwarded if matching `/^[A-Za-z0-9._:-]{1,256}$/` |

- **No `Origin` header** is sent upstream.
- **`User-Agent`:** Not required/forwarded on `/chat/completions` or `/responses` (only `/gravity-display-proxy` sets `User-Agent: DeepAI-Code`).

### 3.3. Request Payload Format

Standard OpenAI Chat Completions JSON payload (with `compat.supportsDeveloperRole: false`):

```json
{
  "model": "glm-5.3-flash",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "stream": true,
  "stream_options": { "include_usage": true },
  "max_completion_tokens": 131072,
  "temperature": 0.7,
  "reasoning_effort": "medium",
  "tools": [ ... ]
}
```

- **Model ID:** Strip any `deepai/` prefix before sending upstream (e.g., `deepai/glm-5.3-flash` -> `glm-5.3-flash`).
- **Thinking / Reasoning Effort (`thinkingLevelMap`):**
  - `off` maps to `"none"` for all reasoning models.
  - `minimal`, `low`, `medium`, `high` pass through directly.
  - `deepai-cyber` and `muse-ember` additionally support `max` (`"max"`).
  - `muse-ember` additionally supports `xhigh` (`"xhigh"`).
- **`gpt-6-astra`:** Uses `api: "openai-responses"` format at `POST /deepai_code/responses`.

### 3.4. Streaming SSE Format & Error Handling

- **Streaming Response:** Standard OpenAI-compatible Server-Sent Events (`Content-Type: text/event-stream`), emitting `data: <json>\n\n` chunks (including `choices[].delta.content`, `choices[].delta.reasoning` / `reasoning_content` / `reasoning_text`, `choices[].delta.tool_calls`, and final `usage` chunk) terminated by `data: [DONE]\n\n`. Upstream may also send SSE keepalive comments.
- **Watchdog Timeouts (client-side):** `330s` idle byte timeout, `930s` total request timeout.
- **Capacity Busy (`409`):** If upstream returns HTTP `409` with `{"error": {"code": "session_busy"}}`, read `Retry-After` header (clamped `1–30s`, default `2s`) and retry.
- **Known Refusal / Error Codes:**
  - `auth_required`
  - `check_in_refused`
  - `machine_required`
  - `social_login_required`
  - `email_unverified`
  - `machine_bound`
  - `network_bound`
  - `theos_exhausted`
  - `pro_required`
  - `rate_limit_exceeded`

---

## 4. Complete Models List (27 Models)

All models have `subProvider: "deepai"` and `reasoning: true`.
- **Free (`premier: false`, `theosPerRequest: "0"`):** 11 models
- **Paid / Pro (`premier: true`, `theosPerRequest > 0`):** 16 models
- Note: `gpt-oss-120b` is explicitly filtered out by the client (`decodeDeepAIModels`).

### 4.1. Summary Table

| Model ID | Display Name | Tier | Theos / Req | Input | Context Window | Max Tokens | API | Extra Thinking Levels |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `glm-5.3-flash` | GLM 5.3 Flash | **Free** | `0` | text, image | 320,000 | 131,072 | `openai-completions` | `off`->`none` |
| `deepseek-v4.1-flash` | DeepSeek V4.1 Flash 1017 | **Free** | `0` | text, image | 320,000 | 131,072 | `openai-completions` | `off`->`none` |
| `mimo-2.6-flash` | MiMo 2.6 Flash | **Free** | `0` | text, image | 320,000 | 131,072 | `openai-completions` | `off`->`none` |
| `qwen-3.8-flash` | Qwen 3.8 Flash | **Free** | `0` | text, image | 320,000 | 128,000 | `openai-completions` | `off`->`none` |
| `minimax-m3.1-flash` | MiniMax M3.1 Flash | **Free** | `0` | text, image | 320,000 | 131,072 | `openai-completions` | `off`->`none` |
| `muse-ember` | Muse Ember | **Free** | `0` | text, image | 320,000 | 131,072 | `openai-completions` | `off`->`none`, `xhigh`, `max` |
| `solar-mini-4` | Solar Mini 4 | **Free** | `0` | text | 320,000 | 131,072 | `openai-completions` | `off`->`none` |
| `gpt-6-luna` | GPT-6 Luna | **Free** | `0` | text, image | 320,000 | 128,000 | `openai-completions` | `off`->`none` |
| `mimo-2.6-pro` | MiMo 2.6 Pro | **Free** | `0` | text, image | 320,000 | 131,072 | `openai-completions` | `off`->`none` |
| `glyph-cluster` | Glyph Cluster | **Free** | `0` | text | 256,000 | 131,072 | `openai-completions` | `off`->`none` |
| `deepai-cyber` | DeepAI Cyber | **Free** | `0` | text | 320,000 | 131,072 | `openai-completions` | `off`->`none`, `max` |
| `minimax-m3` | MiniMax M3 | **Paid/Pro** | `2` | text | 320,000 | 131,000 | `openai-completions` | `off`->`none` |
| `glm-5.3` | GLM 5.3 | **Paid/Pro** | `3` | text | 320,000 | 131,072 | `openai-completions` | `off`->`none` |
| `kimi-k3` | Kimi K3 | **Paid/Pro** | `3` | text, image | 320,000 | 131,072 | `openai-completions` | `off`->`none` |
| `kimi-k3.1-pro` | Kimi K3.1 Pro | **Paid/Pro** | `3` | text, image | 320,000 | 131,072 | `openai-completions` | `off`->`none` |
| `gpt-6.1-terra` | GPT-6.1 Terra | **Paid/Pro** | `5` | text, image | 320,000 | 128,000 | `openai-completions` | `off`->`none` |
| `muse-spark-1.3` | Muse Spark 1.3 | **Paid/Pro** | `6` | text, image | 320,000 | 131,072 | `openai-completions` | `off`->`none` |
| `gemini-4-hydrogen` | Gemini 4 Hydrogen | **Paid/Pro** | `8` | text, image | 320,000 | 131,072 | `openai-completions` | `off`->`none` |
| `gpt-6.1-sol` | GPT-6.1 Sol | **Paid/Pro** | `10` | text, image | 320,000 | 128,000 | `openai-completions` | `off`->`none` |
| `gemini-4-argon` | Gemini 4 Argon | **Paid/Pro** | `10` | text, image | 320,000 | 131,072 | `openai-completions` | `off`->`none` |
| `gemini-4-carbon` | Gemini 4 Carbon | **Paid/Pro** | `10` | text, image | 320,000 | 131,072 | `openai-completions` | `off`->`none` |
| `claude-sonnet-5-5` | Claude Sonnet 5.5 | **Paid/Pro** | `10` | text, image | 320,000 | 64,000 | `openai-completions` | `off`->`none` |
| `claude-opus-5-5` | Claude Opus 5.5 | **Paid/Pro** | `15` | text, image | 320,000 | 64,000 | `openai-completions` | `off`->`none` |
| `muse-wonder` | Muse Wonder | **Paid/Pro** | `15` | text, image | 320,000 | 131,072 | `openai-completions` | `off`->`none` |
| `qwen-3.8-max-prime` | Qwen 3.8 Max Prime | **Paid/Pro** | `15` | text, image | 320,000 | 131,072 | `openai-completions` | `off`->`none` |
| `claude-fable-5-2` | Claude Fable 5.2 | **Paid/Pro** | `20` | text, image | 320,000 | 64,000 | `openai-completions` | `off`->`none` |
| `gpt-6-astra` | GPT-6 Astra | **Paid/Pro** | `50` | text, image | 320,000 | 128,000 | `openai-responses` | `off`->`none` |

### 4.2. Raw Models JSON

```json
[
  {
    "id": "glm-5.3-flash",
    "name": "GLM 5.3 Flash",
    "reasoning": true,
    "input": ["text", "image"],
    "contextWindow": 320000,
    "maxTokens": 131072,
    "premier": false,
    "theosPerRequest": "0",
    "thinkingLevelMap": { "off": "none" }
  },
  {
    "id": "deepseek-v4.1-flash",
    "name": "DeepSeek V4.1 Flash 1017",
    "reasoning": true,
    "input": ["text", "image"],
    "contextWindow": 320000,
    "maxTokens": 131072,
    "premier": false,
    "theosPerRequest": "0",
    "thinkingLevelMap": { "off": "none" }
  },
  {
    "id": "mimo-2.6-flash",
    "name": "MiMo 2.6 Flash",
    "reasoning": true,
    "input": ["text", "image"],
    "contextWindow": 320000,
    "maxTokens": 131072,
    "premier": false,
    "theosPerRequest": "0",
    "thinkingLevelMap": { "off": "none" }
  },
  {
    "id": "qwen-3.8-flash",
    "name": "Qwen 3.8 Flash",
    "reasoning": true,
    "input": ["text", "image"],
    "contextWindow": 320000,
    "maxTokens": 128000,
    "premier": false,
    "theosPerRequest": "0",
    "thinkingLevelMap": { "off": "none" }
  },
  {
    "id": "minimax-m3.1-flash",
    "name": "MiniMax M3.1 Flash",
    "reasoning": true,
    "input": ["text", "image"],
    "contextWindow": 320000,
    "maxTokens": 131072,
    "premier": false,
    "theosPerRequest": "0",
    "thinkingLevelMap": { "off": "none" }
  },
  {
    "id": "muse-ember",
    "name": "Muse Ember",
    "reasoning": true,
    "input": ["text", "image"],
    "contextWindow": 320000,
    "maxTokens": 131072,
    "premier": false,
    "theosPerRequest": "0",
    "thinkingLevelMap": { "off": "none", "max": "max", "xhigh": "xhigh" }
  },
  {
    "id": "solar-mini-4",
    "name": "Solar Mini 4",
    "reasoning": true,
    "input": ["text"],
    "contextWindow": 320000,
    "maxTokens": 131072,
    "premier": false,
    "theosPerRequest": "0",
    "thinkingLevelMap": { "off": "none" }
  },
  {
    "id": "gpt-6-luna",
    "name": "GPT-6 Luna",
    "reasoning": true,
    "input": ["text", "image"],
    "contextWindow": 320000,
    "maxTokens": 128000,
    "premier": false,
    "theosPerRequest": "0",
    "thinkingLevelMap": { "off": "none" }
  },
  {
    "id": "mimo-2.6-pro",
    "name": "MiMo 2.6 Pro",
    "reasoning": true,
    "input": ["text", "image"],
    "contextWindow": 320000,
    "maxTokens": 131072,
    "premier": false,
    "theosPerRequest": "0",
    "thinkingLevelMap": { "off": "none" }
  },
  {
    "id": "glyph-cluster",
    "name": "Glyph Cluster",
    "reasoning": true,
    "input": ["text"],
    "contextWindow": 256000,
    "maxTokens": 131072,
    "premier": false,
    "theosPerRequest": "0",
    "thinkingLevelMap": { "off": "none" }
  },
  {
    "id": "deepai-cyber",
    "name": "DeepAI Cyber",
    "reasoning": true,
    "input": ["text"],
    "contextWindow": 320000,
    "maxTokens": 131072,
    "premier": false,
    "theosPerRequest": "0",
    "thinkingLevelMap": { "off": "none", "max": "max" }
  },
  {
    "id": "minimax-m3",
    "name": "MiniMax M3",
    "reasoning": true,
    "input": ["text"],
    "contextWindow": 320000,
    "maxTokens": 131000,
    "premier": true,
    "theosPerRequest": "2",
    "thinkingLevelMap": { "off": "none" }
  },
  {
    "id": "gpt-6.1-sol",
    "name": "GPT-6.1 Sol",
    "reasoning": true,
    "input": ["text", "image"],
    "contextWindow": 320000,
    "maxTokens": 128000,
    "premier": true,
    "theosPerRequest": "10",
    "thinkingLevelMap": { "off": "none" }
  },
  {
    "id": "gemini-4-argon",
    "name": "Gemini 4 Argon",
    "reasoning": true,
    "input": ["text", "image"],
    "contextWindow": 320000,
    "maxTokens": 131072,
    "premier": true,
    "theosPerRequest": "10",
    "thinkingLevelMap": { "off": "none" }
  },
  {
    "id": "glm-5.3",
    "name": "GLM 5.3",
    "reasoning": true,
    "input": ["text"],
    "contextWindow": 320000,
    "maxTokens": 131072,
    "premier": true,
    "theosPerRequest": "3",
    "thinkingLevelMap": { "off": "none" }
  },
  {
    "id": "kimi-k3",
    "name": "Kimi K3",
    "reasoning": true,
    "input": ["text", "image"],
    "contextWindow": 320000,
    "maxTokens": 131072,
    "premier": true,
    "theosPerRequest": "3",
    "thinkingLevelMap": { "off": "none" }
  },
  {
    "id": "kimi-k3.1-pro",
    "name": "Kimi K3.1 Pro",
    "reasoning": true,
    "input": ["text", "image"],
    "contextWindow": 320000,
    "maxTokens": 131072,
    "premier": true,
    "theosPerRequest": "3",
    "thinkingLevelMap": { "off": "none" }
  },
  {
    "id": "gpt-6.1-terra",
    "name": "GPT-6.1 Terra",
    "reasoning": true,
    "input": ["text", "image"],
    "contextWindow": 320000,
    "maxTokens": 128000,
    "premier": true,
    "theosPerRequest": "5",
    "thinkingLevelMap": { "off": "none" }
  },
  {
    "id": "muse-spark-1.3",
    "name": "Muse Spark 1.3",
    "reasoning": true,
    "input": ["text", "image"],
    "contextWindow": 320000,
    "maxTokens": 131072,
    "premier": true,
    "theosPerRequest": "6",
    "thinkingLevelMap": { "off": "none" }
  },
  {
    "id": "gemini-4-hydrogen",
    "name": "Gemini 4 Hydrogen",
    "reasoning": true,
    "input": ["text", "image"],
    "contextWindow": 320000,
    "maxTokens": 131072,
    "premier": true,
    "theosPerRequest": "8",
    "thinkingLevelMap": { "off": "none" }
  },
  {
    "id": "gemini-4-carbon",
    "name": "Gemini 4 Carbon",
    "reasoning": true,
    "input": ["text", "image"],
    "contextWindow": 320000,
    "maxTokens": 131072,
    "premier": true,
    "theosPerRequest": "10",
    "thinkingLevelMap": { "off": "none" }
  },
  {
    "id": "claude-sonnet-5-5",
    "name": "Claude Sonnet 5.5",
    "reasoning": true,
    "input": ["text", "image"],
    "contextWindow": 320000,
    "maxTokens": 64000,
    "premier": true,
    "theosPerRequest": "10",
    "thinkingLevelMap": { "off": "none" }
  },
  {
    "id": "claude-opus-5-5",
    "name": "Claude Opus 5.5",
    "reasoning": true,
    "input": ["text", "image"],
    "contextWindow": 320000,
    "maxTokens": 64000,
    "premier": true,
    "theosPerRequest": "15",
    "thinkingLevelMap": { "off": "none" }
  },
  {
    "id": "muse-wonder",
    "name": "Muse Wonder",
    "reasoning": true,
    "input": ["text", "image"],
    "contextWindow": 320000,
    "maxTokens": 131072,
    "premier": true,
    "theosPerRequest": "15",
    "thinkingLevelMap": { "off": "none" }
  },
  {
    "id": "qwen-3.8-max-prime",
    "name": "Qwen 3.8 Max Prime",
    "reasoning": true,
    "input": ["text", "image"],
    "contextWindow": 320000,
    "maxTokens": 131072,
    "premier": true,
    "theosPerRequest": "15",
    "thinkingLevelMap": { "off": "none" }
  },
  {
    "id": "claude-fable-5-2",
    "name": "Claude Fable 5.2",
    "reasoning": true,
    "input": ["text", "image"],
    "contextWindow": 320000,
    "maxTokens": 64000,
    "premier": true,
    "theosPerRequest": "20",
    "thinkingLevelMap": { "off": "none" }
  },
  {
    "id": "gpt-6-astra",
    "name": "GPT-6 Astra",
    "reasoning": true,
    "input": ["text", "image"],
    "contextWindow": 320000,
    "maxTokens": 128000,
    "premier": true,
    "api": "openai-responses",
    "theosPerRequest": "50",
    "thinkingLevelMap": { "off": "none" }
  }
]
```
