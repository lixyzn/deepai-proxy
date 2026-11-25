# DeepAI Code Desktop — Context, Usage & Session Protocol Findings

Reverse-engineered from `C:\Users\User\Downloads\deepai-code-extraction`:
- `AppData-Local-Programs-deepai-code-desktop\resources\server.asar`
  - `/apps/server/dist/binCli-C6U4jU1g.mjs` (`src/deepai/api.ts`, `src/deepai/localTransport.ts`, `src/deepai/modelTransportPolicy.ts`, embedded `pi-deepai-extension.ts`)
  - `/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js`
  - `/node_modules/@earendil-works/pi-ai/dist/utils/overflow.js`
  - `/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`
  - `/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js`
- `.deepai-code\caches\deepai.json` & `.deepai-code\caches\pi-deepai-extension.ts`
- `.deepai-code\userdata\deepai\pi\deepai\sessions\**\*.jsonl` (real desktop session transcripts)
- `C:\Users\User\Downloads\deepai-proxy-novo\data\metrics.json`

---

## 1. Context Window Limits & Server vs. Client Responsibility

### Model Catalog Limits (`.deepai-code/caches/deepai.json`)
- `decodeDeepAIModels()` in `binCli-C6U4jU1g.mjs` (`src/deepai/api.ts`) decodes `/deepai_code/models` directly without overriding `contextWindow` (only renaming `deepseek-v4.1-flash` to `"DeepSeek V4.1 Flash 1017"`).
- `BUNDLED_DEEPAI_MODELS` fallback defines `glm-5.3-flash` with `contextWindow: 1048576, maxTokens: 131072`.
- In `.deepai-code/caches/deepai.json`, **26 of 27 models** (including `deepseek-v4.1-flash`, `glm-5.3-flash`, `mimo-2.6-flash`, `qwen-3.8-flash`, `minimax-m3.1-flash`, `muse-ember`, `solar-mini-4`, `gpt-6-luna`, `mimo-2.6-pro`, `deepai-cyber`, and all 16 Pro models) report `contextWindow: 320000`. Only `glyph-cluster` reports `contextWindow: 256000`.
- All 27 models use `api: "openai-completions"` (none set `api: "openai-responses"`).

### Real Server Limit & Behavior
- **320k works on healthy routes, but is NOT guaranteed on all backend shards/sessions:**
  - In `2026-11-20T14-21-13-043Z_01a1f955-33d2-749e-a99f-0d976a422c98.jsonl`, `deepseek-v4.1-flash` reached **`input=245,484` / `cacheRead=295,680` / `totalTokens=297,068`** before client-side compaction triggered.
  - However, in two sessions on 2026-11-21 (`2026-11-21T15-20-45-617Z_01a1feb2-1330-75de-8c1e-9c5aa8dd27d3.jsonl` and `2026-11-21T23-26-22-914Z_01a2006e-acc1-722b-87c9-7841bd07bb2f.jsonl`), `api.deepai.org/deepai_code/chat/completions` returned HTTP `400`:
    ```json
    {"message":"This conversation exceeds the context window. Compact it to continue.","type":"context_length_exceeded","code":"context_length_exceeded"}
    ```
    when Pi's estimated `tokensBefore` was **`186,764`**, **`192,808`**, and **`142,289`**. (This error string does not exist in `server.asar` or `deepai-proxy-novo`; it comes directly from `api.deepai.org`).
- **No server-side compaction:** DeepAI's server does **not** compact conversations for the client. When a request exceeds the active backend's limit, it rejects with HTTP `400 context_length_exceeded`.

---

## 2. `usage` / `prompt_tokens` / `cached_tokens` Parsing & Why `metrics.json` Showed `47992` -> `10349` -> `17200`

### How `pi-ai` Parses `usage` (`@earendil-works/pi-ai/dist/api/openai-completions.js`)
In `parseChunkUsage(rawUsage, model)`:
```js
const promptTokens = rawUsage.prompt_tokens || 0;
const cacheReadTokens =
  rawUsage.prompt_tokens_details?.cached_tokens ??
  rawUsage.prompt_cache_hit_tokens ??
  rawUsage.cached_tokens ??
  0;
const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;
const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
const outputTokens = rawUsage.completion_tokens || 0;
// totalTokens = input + outputTokens + cacheReadTokens + cacheWriteTokens
```

### How `deepai-proxy-novo` Currently Parses `usage` (`src/proxy.mjs`)
In `parseSseUsage()` (lines 99–105) and non-streaming handling (lines 529–531), `deepai-proxy-novo` only reads `usage.prompt_tokens ?? usage.input_tokens`, `usage.completion_tokens ?? usage.output_tokens`, and `usage.total_tokens`. It **does not** extract `prompt_tokens_details?.cached_tokens`, `prompt_cache_hit_tokens`, or `cached_tokens`.

### Why `api.deepai.org` Returned `promptTokens: 47992` then `10349` then `17200` on `193k–200k` Est Requests
Comparing `C:\Users\User\Downloads\deepai-proxy-novo\data\metrics.json` (2026-11-22) with the raw Pi session logs (2026-11-21) proves this is **upstream `api.deepai.org` behavior**, not a `pi-ai` or proxy parsing bug:
- In `2026-11-21T15-20-45...` (lines 238–328):
  - Even with `in + cacheRead` combined, `api.deepai.org` reported `totalTokens=33,000` (`in=791, cacheRead=31,744`), then **dropped to `8,535` (`in=2,058, cacheRead=6,336`)** immediately after a new user message (line 242), grew incrementally with tool results to `40,633`, dropped to `31,364`, dropped again to `7,231` on the next user message (line 316), and then **returned `400 context_length_exceeded`** at `tokensBefore=186,764`.
- In `metrics.json` (2026-11-22):
  - `17:58:02`: `estimatedInputTokens=193,306` -> `promptTokens=47,992`
  - `17:58:32`: `estimatedInputTokens=194,087` -> `promptTokens=10,349` (reset to base prompt + turn delta)
  - `17:58:46`: `estimatedInputTokens=200,375` (`+6,288` est) -> `promptTokens=17,200` (`+6,851`)
- **Consequence:** Because `api.deepai.org` under-reports `usage.prompt_tokens` (`~7k–48k`) on these sessions while still counting the full conversation against its context limit, any client that trusts `usage.prompt_tokens` for context-window budgeting (like `pi-coding-agent`'s `estimateContextTokens()`) thinks the context is only 3%–15% full and **never triggers proactive compaction** before hitting `400 context_length_exceeded`.

---

## 3. Session Affinity, Caching & Request Transformations

1. **Provider Compat (`deepAIPiModels()` in `binCli-C6U4jU1g.mjs`):**
   - `compat: { supportsDeveloperRole: false, sendSessionAffinityHeaders: true }`
2. **Client Headers (`openai-completions.js` `createClient()`):**
   - When `sessionId` and `compat.sendSessionAffinityHeaders` are set (`sessionAffinityFormat === "openai"` default), `pi-ai` sends:
     - `session_id: sessionId`
     - `x-client-request-id: sessionId`
     - `x-session-affinity: sessionId`
3. **Local Transport Forwarding (`startDeepAIModelTransport()` in `binCli-C6U4jU1g.mjs`):**
   - Validates `incoming.headers["x-session-affinity"]` against `/^[A-Za-z0-9._:-]{1,256}$/` and forwards **`X-Session-Affinity`** upstream to `https://api.deepai.org/deepai_code/chat/completions`.
   - Reads `payload.prompt_cache_key` (`/^[A-Za-z0-9._:-]{1,256}$/`) for per-thread capacity tracking.
   - Attaches `X-DeepAI-Code-Theos: "7"`, `X-DeepAI-Code-Instance`, `X-DeepAI-Code-Machine`, `api-key`, and `X-DeepAI-Code-Check-In` (on `/theos` check-in).
4. **Payload Hook (`before_provider_request` in `pi-deepai-extension.ts`):**
   - **Flattens text-only `user` content arrays:** If `message.role === "user"` and `message.content` is an array of `{ type: "text", text: string }` (2 keys), it joins them into a plain `string` (*"Some text endpoints route every array through their multimodal processor"*).
   - **Injects `prompt_cache_key`:** Sets `payload.prompt_cache_key = env("T3_DEEPAI_THREAD_ID")` (*"Stable, opaque chat identity preserves the production routing/cache contract"*).
   - **`previous_response_id`:** Not used for DeepAI (`openai-completions` only; `previous_response_id` is only in `openai-responses` / `openai-codex-responses`).

---

## 4. How DeepAI Code Desktop Performs Compaction

All compaction is **client-side** in `@earendil-works/pi-coding-agent`:
- **Defaults (`DEFAULT_COMPACTION_SETTINGS` in `compaction.js`):** `enabled: true`, `reserveTokens: 16384`, `keepRecentTokens: 20000`.
- **Triggers (`AgentSession._checkCompaction()` in `agent-session.js`):**
  1. **Overflow with retry:** `stopReason === "error"` and `isContextOverflow(assistantMessage)` (`pi-ai/dist/utils/overflow.js` matches `/context[_ ]length[_ ]exceeded/i`, `/exceeds (?:the )?(?:model'?s )?maximum context length/i`, etc.), or `isRecoverableLength(...)`. Inserts a `context_edit` omission (`_omitRecoveryAttempt`), runs `_runAutoCompaction("overflow", true)`, and retries once.
  2. **Silent overflow without retry:** `stopReason === "stop"` and `usage.input + usage.cacheRead > contextWindow`.
  3. **Threshold without retry:** `shouldCompact(contextTokens, contextWindow, settings)` -> `contextTokens > contextWindow - reserveTokens` (`303,616` for a `320k` model).
- **Token Estimation (`estimateContextTokens()` / `estimateProjectedContextTokens()`):**
  - Uses `lastAssistant.usage` (`totalTokens || input + output + cacheRead + cacheWrite`) + `Math.ceil(chars / 4)` (`4800` chars/image) for trailing messages.
  - Falls back to full `chars / 4` estimation if a `context_edit` or `compaction` occurred after the last valid assistant usage.
- **Cut Point & Summarization (`prepareCompaction()` / `compact()`):**
  - Walks backwards accumulating `estimateTokens` until `keepRecentTokens` (`20000`) to pick `firstKeptEntryId` (and optional `turnPrefixMessages` on split turns).
  - Calls `completeSummarization()` (`cacheRetention: "none"`) wrapped in `deepaiRecoverTruncatedSummary()` (retries with an explicit word limit if `stopReason === "length"`).
  - Appends a `compaction` JSONL entry with `summary`, `firstKeptEntryId`, `tokensBefore`, and `details: { readFiles, modifiedFiles }`.

---

## 5. Implemented Policy in `deepai-proxy` (current)

1. **Session affinity synthesis (`src/proxy.mjs`):** derives a stable `X-Session-Affinity` + `prompt_cache_key` from `body.prompt_cache_key`, session headers, `body.user`, or a SHA-256 prefix of the transcript, excluding `modelId` so model switches keep the same affinity. Recent message/tool_call fingerprints in an LRU table keep affinity across client-side compaction.
2. **Text-only `user` array flattening + protocol normalization (`sanitizeAndNormalizeMessages`):** flattens `{type:"text"}` arrays, converts `developer` -> `system`, folds mid-conversation `system` notifications into index `0`, skips empty/aborted assistant messages, repairs orphaned tool pairs, and strips replayed `reasoning_details` (`gwst1...` blobs). This is protocol correctness, **not** context pruning.
3. **No context management at all (`src/context.mjs`):** the transcript is forwarded exactly as the client sent it. There is no sliding window, no budget-based pruning, no progressive tool compaction, no `max_tokens` clamping, and no proxy-generated `400 context_length_exceeded`. If upstream rejects the request, that error is surfaced verbatim — the client decides what to do.
4. **Client compaction detector (`detectClientCompaction`):** observes whether the client already compacted. Detection never mutates the payload; it is reported via `X-DeepAI-Client-Compacted`, logged, and stored in metrics (`clientCompacted`, `compactionKind`).
5. **`cached_tokens` capture:** `prompt_tokens_details.cached_tokens ?? prompt_cache_hit_tokens ?? cached_tokens` is recorded in `metrics.json` alongside `promptTokens` and `estimatedInputTokens`.

---

## 6. Client-Side Compaction Detection

The proxy does not decide when to reduce history. Modern harnesses do it themselves and leave a durable artifact in the transcript; detecting that artifact is enough to know the client already compacted.

### OpenCode
After compaction, history begins with a single `user` message:

```
<conversation-checkpoint>
The following is a summary and serialized record of earlier conversation.

<summary>
## Objective
## Requirements
## Decisions
## Work State
### Completed / ### Active / ### Blocked
## Next Move
</summary>

<recent-context>
[User]: ...
[Assistant tool call]: ...
[Tool result]: ...
</recent-context>
</conversation-checkpoint>
```

Signals used: the wrapper tags, the `## ` heading signature, transcript markers (`[User]:`, `[Assistant]:`, `[Assistant tool call]:`, `[Tool result]:`, `[Shell]:`, `[... older exchanges omitted]`, `[truncated]`), and summary size. Legacy catch-all heading `## Additional Context` is also recognized. Native compaction yields `native.messages` and no summary text.

### Other harnesses
Claude Code and similar tools inject a leading user message such as "This session is being continued from a previous conversation…" plus summary headings. The detector scores wrapper tags, heading count, marker density, legacy phrases, and summary length.

### Scoring
A transcript is considered compacted at score >= 3: a checkpoint tag alone (5), or two summary headings (3), or a legacy phrase (3). Untagged summaries must appear in the first `scanLimit` (6) messages, so a user merely *talking* about compaction late in a thread is never flagged. Output shape:

```js
{ compacted, kind, index, summaryTokens, recentTokens, markers, headings, score, confidence, messagesBefore, messagesTotal }
```

`kind` is `opencode-checkpoint`, `summary-checkpoint`, or `generic-summary`.

### Why detection instead of trimming
When the client compacts, everything before the checkpoint is already gone. Re-trimming would either destroy the surviving tail or fight the client. Detection is the signal to stop looking at history — not to prune.
