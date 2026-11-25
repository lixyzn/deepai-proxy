import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { buildDeepAIHeaders, DEEPAI_MODEL_BASE } from "./deepai.mjs";
import { getModelById, normalizeModelId } from "./models.mjs";
import {
  extractMessageText,
  manageContext,
} from "./context.mjs";

const SESSION_AFFINITY_RE = /^[A-Za-z0-9._:-]{1,256}$/;
const STREAM_IDLE_TIMEOUT_MS = 330_000;
const STREAM_TOTAL_TIMEOUT_MS = 930_000;
const MAX_TRACKED_SESSIONS = 256;

function openAiError(res, status, message, { type = "api_error", code = null, param = null } = {}) {
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      // ignore
    }
    return;
  }
  const payload = JSON.stringify({
    error: {
      message,
      type,
      param,
      code,
    },
  });
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function hashShort(input) {
  return crypto.createHash("sha256").update(String(input || "")).digest("hex").slice(0, 24);
}

function buildMessageFingerprints(msgs) {
  const fingerprints = [];
  if (!Array.isArray(msgs)) return fingerprints;
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    const role = m.role === "developer" ? "system" : m.role || "unknown";
    if (role === "system") continue;
    if (role === "tool" && typeof m.tool_call_id === "string" && m.tool_call_id.trim()) {
      fingerprints.push(`tc:${m.tool_call_id.trim()}`);
      continue;
    }
    if (role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      for (const tc of m.tool_calls) {
        if (typeof tc?.id === "string" && tc.id.trim()) {
          fingerprints.push(`tc:${tc.id.trim()}`);
        }
      }
    }
    const text = extractMessageText(m).trim();
    if (text.length >= 8) {
      fingerprints.push(`msg:${role}:${hashShort(text.slice(0, 512))}`);
    }
  }
  return fingerprints;
}

export function createSessionAffinityResolver() {
  // Map<affinityId, { systemHash: string, fingerprints: Set<string>, updatedAt: number }>
  const sessions = new Map();

  function rememberSession(affinity, systemHash, fingerprints) {
    if (!affinity || fingerprints.length === 0) return;
    const existing = sessions.get(affinity);
    const fpSet = existing ? existing.fingerprints : new Set();
    for (const fp of fingerprints) {
      fpSet.add(fp);
      if (fpSet.size > 200) {
        const oldest = fpSet.values().next().value;
        fpSet.delete(oldest);
      }
    }
    sessions.delete(affinity);
    sessions.set(affinity, {
      systemHash,
      fingerprints: fpSet,
      updatedAt: Date.now(),
    });
    if (sessions.size > MAX_TRACKED_SESSIONS) {
      const oldestKey = sessions.keys().next().value;
      sessions.delete(oldestKey);
    }
  }

  return function resolveSessionAffinity(req, body) {
    const candidates = [
      req?.headers?.["x-session-affinity"],
      body?.prompt_cache_key,
      req?.headers?.["x-session-id"],
      req?.headers?.["session-id"],
      req?.headers?.["session_id"],
      req?.headers?.["x-conversation-id"],
      req?.headers?.["conversation-id"],
      req?.headers?.["x-thread-id"],
      req?.headers?.["thread-id"],
      req?.headers?.["x-client-session-id"],
      req?.headers?.["x-client-request-id"],
      body?.session_id,
      body?.conversation_id,
      body?.thread_id,
      body?.sessionId,
      body?.conversationId,
      body?.threadId,
      body?.metadata?.session_id,
      body?.metadata?.conversation_id,
      body?.metadata?.thread_id,
      body?.user,
    ];
    for (const raw of candidates) {
      const val = typeof raw === "string" ? raw.trim() : "";
      if (val && SESSION_AFFINITY_RE.test(val)) {
        return val;
      }
    }

    const msgs = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : [];
    const firstSystem = msgs.find((m) => m?.role === "system" || m?.role === "developer");
    const firstUser = msgs.find((m) => m?.role === "user");
    const systemText = extractMessageText(firstSystem).slice(0, 1024);
    const systemHash = hashShort(systemText);
    const fingerprints = buildMessageFingerprints(msgs);

    // Compute deterministic seed independent of modelId so model switching preserves session affinity
    const seed = `${systemText}|${extractMessageText(firstUser).slice(0, 1024)}|${extractMessageText(msgs[0]).slice(0, 256)}`;
    const deterministicAffinity = `dp-${hashShort(seed)}`;

    // If deterministicAffinity is already tracked, update its fingerprints and return it
    if (sessions.has(deterministicAffinity)) {
      rememberSession(deterministicAffinity, systemHash, fingerprints);
      return deterministicAffinity;
    }

    // Check if this transcript overlaps with an existing tracked session (e.g. after client prefix compaction)
    if (fingerprints.length > 0) {
      let bestAffinity = null;
      let bestOverlap = 0;
      for (const [affinity, entry] of sessions.entries()) {
        if (entry.systemHash !== systemHash) continue;
        let overlap = 0;
        for (const fp of fingerprints) {
          if (entry.fingerprints.has(fp)) overlap += 1;
        }
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestAffinity = affinity;
        }
      }
      if (bestAffinity && bestOverlap >= 1) {
        rememberSession(bestAffinity, systemHash, fingerprints);
        return bestAffinity;
      }
    }

    rememberSession(deterministicAffinity, systemHash, fingerprints);
    return deterministicAffinity;
  };
}

function buildUpstreamPayload(body, modelId, modelInfo, isStream, sessionAffinity) {
  const payload = { ...body, model: modelId, stream: isStream };

  if (payload.reasoning_effort === "off") {
    payload.reasoning_effort = modelInfo?.capabilities?.thinkingLevelMap?.off || "none";
  }

  if (
    payload.max_completion_tokens !== undefined &&
    payload.max_tokens === undefined &&
    modelInfo?.api !== "openai-responses"
  ) {
    payload.max_tokens = payload.max_completion_tokens;
    delete payload.max_completion_tokens;
  }

  if (isStream) {
    payload.stream_options = {
      ...(typeof payload.stream_options === "object" && payload.stream_options ? payload.stream_options : {}),
      include_usage: true,
    };
  }

  if (modelInfo?.api === "openai-responses" && !payload.input && Array.isArray(payload.messages)) {
    payload.input = payload.messages;
    delete payload.messages;
    delete payload.stream_options;
  } else if (sessionAffinity && SESSION_AFFINITY_RE.test(sessionAffinity)) {
    const existingKey = typeof payload.prompt_cache_key === "string" ? payload.prompt_cache_key.trim() : "";
    if (!existingKey || !SESSION_AFFINITY_RE.test(existingKey)) {
      payload.prompt_cache_key = sessionAffinity;
    }
  }

  return payload;
}

function extractUsageDetails(rawUsage) {
  const promptTokens = Number(rawUsage?.prompt_tokens ?? rawUsage?.input_tokens) || 0;
  const completionTokens = Number(rawUsage?.completion_tokens ?? rawUsage?.output_tokens) || 0;
  const cachedTokens =
    Number(
      rawUsage?.prompt_tokens_details?.cached_tokens ??
        rawUsage?.prompt_cache_hit_tokens ??
        rawUsage?.cached_tokens,
    ) || 0;
  const cacheWriteTokens = Number(rawUsage?.prompt_tokens_details?.cache_write_tokens) || 0;
  const totalTokens = Number(rawUsage?.total_tokens) || promptTokens + completionTokens;
  return {
    promptTokens,
    completionTokens,
    cachedTokens,
    cacheWriteTokens,
    totalTokens,
  };
}

function normalizeUsageForClient(rawUsage, estimatedInputTokens = 0) {
  const { promptTokens, completionTokens, cachedTokens, cacheWriteTokens } = extractUsageDetails(rawUsage);
  const est = Math.max(0, Math.round(Number(estimatedInputTokens) || 0));
  const isUnderReported =
    est > 0 && (promptTokens === 0 || (promptTokens < est * 0.65 && est - promptTokens >= 1024));
  const effectivePromptTokens = isUnderReported
    ? Math.max(promptTokens, est, cachedTokens + cacheWriteTokens)
    : Math.max(promptTokens, cachedTokens + cacheWriteTokens);
  const effectiveTotalTokens = effectivePromptTokens + completionTokens;

  const normalized = {
    ...(rawUsage && typeof rawUsage === "object" ? rawUsage : {}),
    prompt_tokens: effectivePromptTokens,
    completion_tokens: completionTokens,
    total_tokens: effectiveTotalTokens,
  };
  if (cachedTokens > 0 || cacheWriteTokens > 0 || rawUsage?.prompt_tokens_details) {
    normalized.prompt_tokens_details = {
      ...(rawUsage?.prompt_tokens_details && typeof rawUsage.prompt_tokens_details === "object"
        ? rawUsage.prompt_tokens_details
        : {}),
      cached_tokens: cachedTokens,
    };
  }
  return normalized;
}

function parseRetryAfterMs(headers) {
  const raw = headers?.get?.("retry-after") ?? headers?.["retry-after"];
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec > 0) {
    return Math.min(30_000, Math.max(1_000, Math.round(sec * 1000)));
  }
  return 2_000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processSseBuffer(buffer, state, estimatedInputTokens, writeOut) {
  const lines = buffer.split("\n");
  const remainder = lines.pop() ?? "";
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      writeOut(`${rawLine}\n`);
      continue;
    }
    const dataStr = trimmed.slice(5).trim();
    if (dataStr === "[DONE]") {
      state.sawDone = true;
      writeOut(`${rawLine}\n`);
      continue;
    }
    try {
      const parsed = JSON.parse(dataStr);
      if (parsed?.usage) {
        state.sawUsage = true;
        const normalizedUsage = normalizeUsageForClient(parsed.usage, estimatedInputTokens);
        const extracted = extractUsageDetails(normalizedUsage);
        state.promptTokens = extracted.promptTokens;
        state.completionTokens = extracted.completionTokens;
        state.totalTokens = extracted.totalTokens;
        state.cachedTokens = extracted.cachedTokens;
        writeOut(`data: ${JSON.stringify({ ...parsed, usage: normalizedUsage })}\n`);
        continue;
      }
    } catch {
      // ignore non-JSON SSE chunks and forward raw line
    }
    writeOut(`${rawLine}\n`);
  }
  return remainder;
}

export function createChatCompletionsHandler({
  accountStore,
  configStore,
  metricsStore,
  logger = console,
  upstreamBaseUrl = null,
  fetchImpl = fetch,
} = {}) {
  const checkInCache = new Map();
  const resolveSessionAffinity = createSessionAffinityResolver();

  async function ensureCheckIn(account, baseUrl) {
    const cached = checkInCache.get(account.id);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.nonce;
    }
    try {
      const extraHeaders = {};
      if (cached?.nonce) {
        extraHeaders["X-DeepAI-Code-Check-In"] = cached.nonce;
      }
      extraHeaders["X-DeepAI-Code-Beacon"] = `v=1.0.0;up=${Math.floor(process.uptime())};pi=1;focus=1`;
      const headers = buildDeepAIHeaders(account, extraHeaders);
      const res = await fetchImpl(`${baseUrl}/theos`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        const nonce = data?.check_in?.nonce || null;
        const seconds = Number(data?.check_in?.seconds) || 60;
        if (nonce) {
          checkInCache.set(account.id, {
            nonce,
            expiresAt: now + Math.max(5_000, (seconds / 2) * 1000),
          });
        }
        return nonce;
      }
    } catch {
      // Check-in is best-effort; do not block inference if unavailable
    }
    return cached?.nonce || null;
  }

  return async function handleChatCompletions(req, res, body) {
    const startTime = performance.now();
    const requestId = crypto.randomUUID();

    // 1. Validate proxy API key if enabled
    const authResult = await configStore.validateRequest(req);
    if (!authResult.ok) {
      return openAiError(
        res,
        401,
        authResult.reason === "missing_api_key"
          ? "Missing API key. Provide Authorization: Bearer <key> or x-api-key header."
          : "Invalid proxy API key.",
        { type: "invalid_request_error", code: authResult.reason || "invalid_api_key" },
      );
    }

    const config = await configStore.get();
    const rawModel = body?.model || config.defaultModel || "glm-5.3-flash";
    const modelId = normalizeModelId(rawModel);
    const modelInfo = getModelById(modelId);
    const isStream = Boolean(body?.stream);
    const baseUrl = (upstreamBaseUrl || process.env.DEEPAI_MODEL_BASE || DEEPAI_MODEL_BASE).replace(/\/+$/, "");
    const endpoint =
      modelInfo?.api === "openai-responses" ? `${baseUrl}/responses` : `${baseUrl}/chat/completions`;

    if (!body || typeof body !== "object" || (!Array.isArray(body.messages) && !body.input)) {
      return openAiError(res, 400, "Invalid request body: 'messages' array is required.", {
        type: "invalid_request_error",
        code: "invalid_request",
        param: "messages",
      });
    }

    const strategy = config.rotationStrategy || "round-robin";
    const allowFailover = strategy === "round-robin" || strategy === "failover";
    const excludeIds = [];

    // Resolve session affinity from the transcript as the client sent it, so the
    // tracker keeps matching across client-side compaction.
    const sessionAffinity = resolveSessionAffinity(req, body);

    const ctxResult = manageContext({
      body,
      modelInfo,
      contextSettings: config.contextManagement,
    });

    const ctxMeta = ctxResult.meta;
    const compaction = ctxMeta.compaction || {};
    const contextHeaders = {
      "X-DeepAI-Context-Limit": String(ctxMeta.contextWindow || 0),
      "X-DeepAI-Context-Used-Est": String(ctxMeta.estimatedInputTokens || 0),
      // Pass-through policy: the proxy never trims. These stay for compatibility.
      "X-DeepAI-Context-Trimmed": "false",
      "X-DeepAI-Context-Dropped-Messages": "0",
      "X-DeepAI-Context-Truncated-Messages": "0",
      "X-DeepAI-Client-Compacted": String(Boolean(compaction.compacted)),
      "X-DeepAI-Session-Affinity": sessionAffinity,
    };
    const contextTelemetry = {
      estimatedInputTokens: ctxMeta.estimatedInputTokens || 0,
      contextLimit: ctxMeta.contextWindow || 0,
      contextTrimmed: false,
      droppedMessages: 0,
      contextUtilizationPct: ctxMeta.utilizationPct || 0,
      clientCompacted: Boolean(compaction.compacted),
      compactionKind: compaction.kind || null,
    };

    if (compaction.compacted) {
      logger.log?.(
        `[context] cliente já compactou (${compaction.kind}, ${compaction.confidence}): ` +
          `${compaction.messagesTotal} msgs, resumo ~${compaction.summaryTokens} tok. Repassando sem poda.`,
      );
    }

    const upstreamPayload = buildUpstreamPayload(ctxResult.body, modelId, modelInfo, isStream, sessionAffinity);

    let lastStatus = 503;
    let lastErrorMessage = "Nenhuma conta DeepAI habilitada disponível.";
    let lastAccount = null;

    while (true) {
      const account = await accountStore.selectAccountForRequest(strategy, { excludeIds });
      if (!account) {
        const latencyMs = Math.round(performance.now() - startTime);
        await metricsStore?.record({
          id: requestId,
          model: modelId,
          accountId: lastAccount?.id || null,
          accountLabel: lastAccount?.label || "Nenhuma conta",
          latencyMs,
          status: lastStatus,
          ok: false,
          stream: isStream,
          error: lastErrorMessage,
        });
        return openAiError(res, lastStatus, lastErrorMessage, {
          type: lastStatus === 401 ? "authentication_error" : "api_error",
          code: lastStatus === 503 ? "no_accounts_available" : "upstream_error",
        });
      }

      lastAccount = account;
      const checkInNonce = await ensureCheckIn(account, baseUrl);
      const extraHeaders = {
        "Content-Type": "application/json",
      };
      if (checkInNonce) {
        extraHeaders["X-DeepAI-Code-Check-In"] = checkInNonce;
      }
      if (sessionAffinity && SESSION_AFFINITY_RE.test(sessionAffinity)) {
        extraHeaders["X-Session-Affinity"] = sessionAffinity;
      }

      const headers = buildDeepAIHeaders(account, extraHeaders);
      let upstreamRes = null;
      let busyRetried = false;

      while (true) {
        try {
          upstreamRes = await fetchImpl(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(upstreamPayload),
            signal: AbortSignal.timeout(STREAM_TOTAL_TIMEOUT_MS),
          });
        } catch (err) {
          const msg = err?.message || "Erro de conexão com DeepAI upstream";
          lastStatus = 502;
          lastErrorMessage = msg;
          await accountStore.recordUsage(account.id, {
            ok: false,
            status: 502,
            error: msg,
            cooldownMs: 10_000,
          });
          upstreamRes = null;
          break;
        }

        if (upstreamRes.status === 409 && !busyRetried) {
          const errText = await upstreamRes.text().catch(() => "");
          let errJson = null;
          try {
            errJson = errText ? JSON.parse(errText) : null;
          } catch {
            errJson = null;
          }
          if (errJson?.error?.code === "session_busy") {
            busyRetried = true;
            await sleep(parseRetryAfterMs(upstreamRes.headers));
            continue;
          }
          lastStatus = 409;
          lastErrorMessage = errJson?.error?.message || errText || "Session busy (409)";
          upstreamRes = null;
          break;
        }

        break;
      }

      if (!upstreamRes) {
        if (!allowFailover) {
          const latencyMs = Math.round(performance.now() - startTime);
          await metricsStore?.record({
            id: requestId,
            model: modelId,
            accountId: account.id,
            accountLabel: account.label || account.username || account.id,
            latencyMs,
            status: lastStatus,
            ok: false,
            stream: isStream,
            error: lastErrorMessage,
          });
          return openAiError(res, lastStatus, lastErrorMessage, { code: "upstream_error" });
        }
        excludeIds.push(account.id);
        continue;
      }

      if (!upstreamRes.ok) {
        const errText = await upstreamRes.text().catch(() => "");
        let errJson = null;
        try {
          errJson = errText ? JSON.parse(errText) : null;
        } catch {
          errJson = null;
        }
        const errMsg =
          errJson?.error?.message ||
          errJson?.message ||
          errJson?.detail ||
          errJson?.error ||
          errText ||
          `DeepAI upstream error HTTP ${upstreamRes.status}`;

        const shouldRetryNext =
          allowFailover && (upstreamRes.status === 401 || upstreamRes.status === 403 || upstreamRes.status === 429 || upstreamRes.status >= 500);

        const cooldownMs =
          upstreamRes.status === 429
            ? 30_000
            : upstreamRes.status === 401 || upstreamRes.status === 403
              ? 60_000
              : upstreamRes.status >= 500
                ? 10_000
                : 0;

        await accountStore.recordUsage(account.id, {
          ok: false,
          status: upstreamRes.status,
          error: String(errMsg).slice(0, 300),
          cooldownMs,
        });

        lastStatus = upstreamRes.status;
        lastErrorMessage = String(errMsg);

        if (shouldRetryNext) {
          excludeIds.push(account.id);
          continue;
        }

        const latencyMs = Math.round(performance.now() - startTime);
        await metricsStore?.record({
          id: requestId,
          model: modelId,
          accountId: account.id,
          accountLabel: account.label || account.username || account.id,
          latencyMs,
          status: upstreamRes.status,
          ok: false,
          stream: isStream,
          error: lastErrorMessage,
        });

        if (errJson && errJson.error) {
          const payload = JSON.stringify(errJson);
          res.writeHead(upstreamRes.status, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(payload),
            "Cache-Control": "no-store",
          });
          res.end(payload);
          return;
        }
        return openAiError(res, upstreamRes.status, lastErrorMessage, { code: "upstream_error" });
      }

      // ---- Success: Stream ----
      if (isStream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          ...contextHeaders,
        });

        const sseState = {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          cachedTokens: 0,
          sawUsage: false,
          sawDone: false,
        };
        let lineBuffer = "";
        let streamError = null;
        const writeOut = (text) => {
          res.write(text);
        };

        try {
          if (upstreamRes.body) {
            const reader = upstreamRes.body.getReader();
            const decoder = new TextDecoder();
            let idleTimer = null;
            const resetIdle = () => {
              if (idleTimer) clearTimeout(idleTimer);
              idleTimer = setTimeout(() => {
                reader.cancel(new Error("Stream idle timeout")).catch(() => {});
              }, STREAM_IDLE_TIMEOUT_MS);
            };
            resetIdle();

            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              resetIdle();
              if (value && value.byteLength > 0) {
                const chunkText = decoder.decode(value, { stream: true });
                lineBuffer = processSseBuffer(
                  lineBuffer + chunkText,
                  sseState,
                  ctxMeta.estimatedInputTokens,
                  writeOut,
                );
              }
            }
            if (idleTimer) clearTimeout(idleTimer);
            const tail = decoder.decode();
            if (tail) {
              lineBuffer = processSseBuffer(
                lineBuffer + tail,
                sseState,
                ctxMeta.estimatedInputTokens,
                writeOut,
              );
            }
            if (lineBuffer.trim()) {
              processSseBuffer(
                `${lineBuffer}\n`,
                sseState,
                ctxMeta.estimatedInputTokens,
                writeOut,
              );
            } else if (lineBuffer) {
              writeOut(lineBuffer);
            }
          }

          if (!sseState.sawUsage && body?.stream_options?.include_usage && ctxMeta.estimatedInputTokens > 0) {
            const fallbackUsage = normalizeUsageForClient({}, ctxMeta.estimatedInputTokens);
            sseState.promptTokens = fallbackUsage.prompt_tokens;
            sseState.completionTokens = fallbackUsage.completionTokens;
            sseState.totalTokens = fallbackUsage.total_tokens;
            const usageChunk = {
              id: `chatcmpl-${requestId}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [],
              usage: fallbackUsage,
            };
            res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
          }

          if (!sseState.sawDone) {
            res.write("data: [DONE]\n\n");
          }
          res.end();
        } catch (err) {
          streamError = err?.message || "Stream interrupted";
          logger.error?.("[proxy] stream error:", err);
          try {
            res.end();
          } catch {
            // ignore
          }
        }

        const latencyMs = Math.round(performance.now() - startTime);
        const ok = !streamError;
        await accountStore.recordUsage(account.id, {
          ok,
          status: ok ? 200 : 502,
          error: streamError,
        });
        await metricsStore?.record({
          id: requestId,
          model: modelId,
          accountId: account.id,
          accountLabel: account.label || account.username || account.id,
          latencyMs,
          status: ok ? 200 : 502,
          ok,
          stream: true,
          promptTokens: sseState.promptTokens,
          completionTokens: sseState.completionTokens,
          totalTokens: sseState.totalTokens,
          cachedTokens: sseState.cachedTokens,
          error: streamError,
          ...contextTelemetry,
        });
        return;
      }

      // ---- Success: Non-streaming JSON ----
      const rawText = await upstreamRes.text();
      let data = null;
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch {
        data = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: rawText },
              finish_reason: "stop",
            },
          ],
        };
      }

      const normalizedUsage = normalizeUsageForClient(data?.usage, ctxMeta.estimatedInputTokens);
      if (data && typeof data === "object" && (data.usage || ctxMeta.estimatedInputTokens > 0)) {
        data.usage = normalizedUsage;
      }
      const { promptTokens, completionTokens, totalTokens, cachedTokens } = extractUsageDetails(normalizedUsage);
      const latencyMs = Math.round(performance.now() - startTime);

      await accountStore.recordUsage(account.id, { ok: true, status: 200 });
      await metricsStore?.record({
        id: requestId,
        model: modelId,
        accountId: account.id,
        accountLabel: account.label || account.username || account.id,
        latencyMs,
        status: 200,
        ok: true,
        stream: false,
        promptTokens,
        completionTokens,
        totalTokens,
        cachedTokens,
        ...contextTelemetry,
      });

      const payload = JSON.stringify(data);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
        "Cache-Control": "no-store",
        ...contextHeaders,
      });
      res.end(payload);
      return;
    }
  };
}
