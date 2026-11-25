/**
 * Context handling policy: PASS-THROUGH ONLY.
 *
 * The proxy no longer manages, trims, prunes, collapses or compacts context.
 * Whatever the client sends is forwarded upstream. The only transformations
 * applied are protocol correctness fixes (see `sanitizeAndNormalizeMessages`),
 * because DeepAI's endpoint rejects or misinterprets certain payload shapes.
 *
 * Instead of guessing when the context is too large, the proxy detects when the
 * CLIENT already compacted the transcript (OpenCode, Claude Code and similar
 * harnesses inject a summary message into the history). Once that is detected
 * the proxy knows the client took over history reduction and simply steps back.
 */

export const CONTEXT_MODE = "passthrough";

export function normalizeContextSettings(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    mode: CONTEXT_MODE,
    // Detects when the client compacted the transcript. Detection is purely
    // observational and never modifies the payload.
    detectCompaction: source.detectCompaction !== false,
  };
}

export function estimateTextTokens(text) {
  if (!text) return 0;
  const str = typeof text === "string" ? text : JSON.stringify(text);
  if (!str) return 0;
  // Conservative ~3.5 chars per token to account for code, JSON, and Portuguese accents
  return Math.ceil(str.length / 3.5);
}

function estimateReasoningTokens(msg) {
  if (!msg || typeof msg !== "object") return 0;
  let tokens = 0;
  if (typeof msg.reasoning === "string" && msg.reasoning.length > 0) {
    tokens += estimateTextTokens(msg.reasoning);
  }
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length > 0) {
    tokens += estimateTextTokens(msg.reasoning_content);
  }
  if (typeof msg.reasoning_text === "string" && msg.reasoning_text.length > 0) {
    tokens += estimateTextTokens(msg.reasoning_text);
  }
  if (Array.isArray(msg.reasoning_details) && msg.reasoning_details.length > 0) {
    for (const detail of msg.reasoning_details) {
      if (!detail || typeof detail !== "object") continue;
      if (typeof detail.data === "string") tokens += estimateTextTokens(detail.data);
      else if (typeof detail.text === "string") tokens += estimateTextTokens(detail.text);
      else if (typeof detail.summary === "string") tokens += estimateTextTokens(detail.summary);
      else tokens += estimateTextTokens(detail);
    }
  }
  return tokens;
}

export function estimateMessageTokens(msg) {
  if (!msg || typeof msg !== "object") return 4;
  let tokens = 4; // per-message framing overhead
  if (msg.role) tokens += 1;
  if (msg.name) tokens += estimateTextTokens(msg.name) + 1;

  if (typeof msg.content === "string") {
    tokens += estimateTextTokens(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && typeof part.text === "string") {
        tokens += estimateTextTokens(part.text);
      } else if (part.type === "image_url" || part.type === "input_image") {
        tokens += 1024;
      } else {
        tokens += estimateTextTokens(part);
      }
    }
  } else if (msg.content != null) {
    tokens += estimateTextTokens(msg.content);
  }

  if (Array.isArray(msg.tool_calls)) {
    tokens += estimateTextTokens(msg.tool_calls);
  }
  if (msg.tool_call_id) {
    tokens += 4;
  }

  tokens += estimateReasoningTokens(msg);
  return tokens;
}

export function estimateRequestTokens(messages, tools) {
  let total = 3; // assistant reply priming
  if (Array.isArray(messages)) {
    for (const m of messages) {
      total += estimateMessageTokens(m);
    }
  }
  if (Array.isArray(tools) && tools.length > 0) {
    total += estimateTextTokens(tools);
  }
  return total;
}

export function resolveModelContextLimits(modelInfo) {
  const contextWindow = Number(modelInfo?.contextWindow) || 128000;
  const maxOutputTokens = Number(modelInfo?.maxTokens) || 16384;
  return {
    contextWindow,
    maxOutputTokens,
    // Informational only: the proxy never enforces this budget.
    inputBudget: Math.max(0, contextWindow - maxOutputTokens),
  };
}

export function isTextOnlyPartArray(content) {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
  );
}

export function extractMessageText(msg) {
  if (!msg || typeof msg !== "object") return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p) => p && typeof p === "object" && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

/* ------------------------------------------------------------------------- */
/* Client compaction detector                                                */
/* ------------------------------------------------------------------------- */

/**
 * Wrappers harnesses use to inject the post-compaction summary as a single
 * message. OpenCode wraps the whole thing in <conversation-checkpoint>.
 */
const CHECKPOINT_TAGS = [
  "conversation-checkpoint",
  "conversation-summary",
  "conversation_summary",
  "summary-checkpoint",
  "context-checkpoint",
  "compacted-context",
];

/** Headings written by OpenCode's compaction summary builder. */
const SUMMARY_HEADINGS = [
  "## Objective",
  "## Requirements",
  "## Decisions",
  "## Work State",
  "## Next Move",
  "## Relevant Files",
  "## Important Context",
  "## Additional Context",
  "## Active",
  "## Completed",
  "## Blocked",
  "## Progress",
  "## Current State",
  "## Pending Tasks",
];

/**
 * Markers OpenCode writes inside <recent-context> when rendering the tail of
 * the pre-compaction transcript.
 */
const TRANSCRIPT_MARKERS = [
  "[User]:",
  "[Assistant]:",
  "[Assistant tool call]:",
  "[Tool result]:",
  "[Tool error]:",
  "[Shell]:",
  "[Skill activated:",
  "[Attached ",
  "[Synthetic context]:",
  "[... older exchanges omitted]",
  "[truncated]",
];

/** Phrases other harnesses (Claude Code, Codex, Cline, Aider...) inject. */
const LEGACY_SUMMARY_PATTERNS = [
  /this session is being continued from a previous conversation/i,
  /conversation (?:so far )?(?:has been|was) (?:summari[sz]ed|compacted|truncated)/i,
  /summary of (?:the )?(?:previous|prior|earlier) (?:conversation|session|context)/i,
  /the conversation (?:so far|up to this point) (?:has been|was)/i,
  /previous conversation (?:summary|was summari[sz]ed)/i,
  /context (?:has been|was) compacted/i,
  /(?:here is|below is) a summary of (?:our|the) (?:conversation|session)/i,
];

const MARKER_RENDER_HINT = /<recent-context>|<summary>|\bconversation checkpoint\b/i;

function countMatches(text, needles) {
  const found = [];
  for (const needle of needles) {
    if (text.includes(needle)) found.push(needle);
  }
  return found;
}

function detectInText(text) {
  if (!text || typeof text !== "string") return null;

  const lowerTags = CHECKPOINT_TAGS.filter((tag) => text.toLowerCase().includes(`<${tag}`));
  const headings = countMatches(text, SUMMARY_HEADINGS);
  const markers = countMatches(text, TRANSCRIPT_MARKERS);
  const legacy = LEGACY_SUMMARY_PATTERNS.some((re) => re.test(text));
  const hasRenderHint = MARKER_RENDER_HINT.test(text);

  let score = 0;
  const reasons = [];

  if (lowerTags.length > 0) {
    score += 5;
    reasons.push(`tag:${lowerTags[0]}`);
  }
  if (headings.length >= 2) {
    score += 3;
    reasons.push(`headings:${headings.length}`);
  } else if (headings.length === 1 && hasRenderHint) {
    score += 1;
    reasons.push("heading:1");
  }
  if (markers.length >= 3) {
    score += 2;
    reasons.push(`markers:${markers.length}`);
  } else if (markers.length > 0 && hasRenderHint) {
    score += 1;
    reasons.push(`markers:${markers.length}`);
  }
  if (legacy) {
    score += 3;
    reasons.push("legacy-phrase");
  }
  if (text.length > 4000 && (headings.length >= 1 || markers.length >= 1)) {
    score += 1;
    reasons.push("large-summary");
  }

  if (score < 3) return null;

  let kind = null;
  if (lowerTags.length > 0) kind = "opencode-checkpoint";
  else if (headings.length >= 2) kind = "summary-checkpoint";
  else if (legacy) kind = "generic-summary";

  if (!kind) return null;

  return {
    kind,
    score,
    tags: lowerTags,
    headings,
    markers,
    legacy,
    reasons,
  };
}

/**
 * Detects whether the CLIENT already compacted the transcript.
 *
 * Returns `{ compacted, kind, index, ... }` where `index` is the position of
 * the summary message in the incoming array. Detection never modifies the
 * payload; it only tells the proxy (and the dashboard) that the client owns
 * history reduction from this point on.
 */
export function detectClientCompaction(messages, { scanLimit = 6 } = {}) {
  const empty = {
    compacted: false,
    kind: null,
    index: null,
    summaryTokens: 0,
    recentTokens: 0,
    markers: [],
    headings: [],
    score: 0,
    confidence: null,
    messagesBefore: 0,
    messagesTotal: Array.isArray(messages) ? messages.length : 0,
  };
  if (!Array.isArray(messages) || messages.length === 0) return empty;

  let best = null;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "user" && msg.role !== "system") continue;

    const text = extractMessageText(msg);
    if (!text || text.length < 120) continue;

    const hit = detectInText(text);
    if (!hit) continue;

    // A tagged checkpoint is unambiguous wherever it appears. Untagged
    // summaries must appear near the start of the transcript, otherwise it is
    // almost certainly the user talking about compaction.
    const hasTag = hit.tags.length > 0;
    if (!hasTag && i > scanLimit) continue;

    if (!best || hit.score > best.hit.score) {
      best = { hit, index: i, text };
    }
  }

  if (!best) return empty;

  const { hit, index, text } = best;
  const summaryMatch = /<summary>([\s\S]*?)<\/summary>/i.exec(text);
  const recentMatch = /<recent-context>([\s\S]*?)<\/recent-context>/i.exec(text);
  const summaryText = summaryMatch ? summaryMatch[1] : text;
  const recentText = recentMatch ? recentMatch[1] : "";

  const confidence = hit.score >= 8 ? "high" : hit.score >= 5 ? "medium" : "low";

  return {
    compacted: true,
    kind: hit.kind,
    index,
    summaryTokens: estimateTextTokens(summaryText),
    recentTokens: estimateTextTokens(recentText),
    markers: hit.markers,
    headings: hit.headings,
    tags: hit.tags,
    legacy: hit.legacy,
    score: hit.score,
    confidence,
    reasons: hit.reasons,
    messagesBefore: index,
    messagesTotal: messages.length,
  };
}

/* ------------------------------------------------------------------------- */
/* Protocol sanitization (not context pruning)                               */
/* ------------------------------------------------------------------------- */

function stripReplayReasoningFields(msg) {
  if (!msg || typeof msg !== "object") return { msg, stripped: false };
  const hasReasoning =
    msg.reasoning !== undefined ||
    msg.reasoning_content !== undefined ||
    msg.reasoning_text !== undefined ||
    msg.reasoning_details !== undefined ||
    msg.providerMetadata !== undefined ||
    msg.provider_metadata !== undefined;
  if (!hasReasoning) return { msg, stripped: false };
  const next = { ...msg };
  delete next.reasoning;
  delete next.reasoning_content;
  delete next.reasoning_text;
  delete next.reasoning_details;
  delete next.providerMetadata;
  delete next.provider_metadata;
  return { msg: next, stripped: true };
}

/**
 * Normalizes a transcript for DeepAI's OpenAI-compatible completions endpoint.
 * This is protocol correctness only — it never removes user or assistant
 * content in order to save tokens:
 *
 * 1. Converts role "developer" -> "system".
 * 2. Flattens text-only content part arrays into plain strings for
 *    system/user/assistant/tool (preserving multimodal user arrays).
 * 3. Strips replayed reasoning/reasoning_details (e.g. stealth-v1 encrypted
 *    gwst1... blobs) which DeepAI's native client never sends back.
 * 4. Collapses mid-conversation system notifications into the leading system
 *    message (DeepAI treats mid-conversation system messages as turn breaks).
 * 5. Skips empty/aborted assistant messages (no text content and no tool_calls).
 * 6. Repairs orphaned tool_calls (inserting synthetic "No result provided"
 *    tool outputs) and drops orphaned role:"tool" messages without a matching
 *    preceding assistant tool_call.
 */
export function sanitizeAndNormalizeMessages(messages, { stripReasoning = true } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      messages: Array.isArray(messages) ? [] : messages,
      strippedReasoningCount: 0,
      repairedToolCount: 0,
      foldedSystemCount: 0,
    };
  }

  let strippedReasoningCount = 0;
  let repairedToolCount = 0;
  let foldedSystemCount = 0;

  // Step 1: Per-message role, content, and reasoning normalization
  const normalized = [];
  for (const rawMsg of messages) {
    if (!rawMsg || typeof rawMsg !== "object") continue;
    let msg = { ...rawMsg };

    if (msg.role === "developer") {
      msg.role = "system";
    }

    if (stripReasoning) {
      const stripped = stripReplayReasoningFields(msg);
      msg = stripped.msg;
      if (stripped.stripped) strippedReasoningCount += 1;
    }

    if (isTextOnlyPartArray(msg.content)) {
      msg.content = msg.content.length === 1 ? msg.content[0].text : msg.content.map((p) => p.text).join("\n");
    } else if ((msg.role === "system" || msg.role === "assistant" || msg.role === "tool") && Array.isArray(msg.content)) {
      msg.content = extractMessageText(msg);
    } else if (msg.role === "tool" && msg.content == null) {
      msg.content = "";
    } else if (msg.role === "tool" && typeof msg.content !== "string") {
      msg.content = JSON.stringify(msg.content);
    }

    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      const validToolCalls = [];
      for (let idx = 0; idx < msg.tool_calls.length; idx++) {
        const tc = msg.tool_calls[idx];
        if (!tc || typeof tc !== "object") continue;
        const id = typeof tc.id === "string" && tc.id.trim() ? tc.id.trim() : `call_auto_${idx}`;
        const fnName = tc.function?.name || tc.name || "tool";
        const rawArgs = tc.function?.arguments ?? tc.arguments ?? "{}";
        const strArgs = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs);
        validToolCalls.push({
          ...tc,
          id,
          type: tc.type || "function",
          function: {
            ...(tc.function || {}),
            name: fnName,
            arguments: strArgs,
          },
        });
      }
      if (validToolCalls.length > 0) {
        msg.tool_calls = validToolCalls;
      } else {
        delete msg.tool_calls;
      }
    }

    normalized.push(msg);
  }

  // Step 2: Separate leading system messages and fold any mid-conversation system messages
  // into the leading system message (matching pi-ai collapseSystemMessages).
  const leadingSystemTexts = [];
  const midSystemTexts = [];
  const trailingSystemTexts = [];
  const rawNonSystem = [];
  let sawNonSystem = false;

  // Check if the original normalized list ends with one or more mid-conversation system messages
  let lastNonSystemIdx = -1;
  for (let i = normalized.length - 1; i >= 0; i--) {
    if (normalized[i].role !== "system") {
      lastNonSystemIdx = i;
      break;
    }
  }

  for (let i = 0; i < normalized.length; i++) {
    const m = normalized[i];
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content.trim() : extractMessageText(m).trim();
      if (!sawNonSystem) {
        if (text) leadingSystemTexts.push(text);
        else if (leadingSystemTexts.length === 0) leadingSystemTexts.push("");
      } else {
        foldedSystemCount += 1;
        if (text) {
          midSystemTexts.push(text);
          if (i > lastNonSystemIdx) {
            trailingSystemTexts.push(text);
          }
        }
      }
    } else {
      sawNonSystem = true;
      rawNonSystem.push(m);
    }
  }

  const systemMessages = [];
  if (leadingSystemTexts.length > 0 || midSystemTexts.length > 0) {
    const combinedSystem = [...leadingSystemTexts, ...midSystemTexts]
      .filter((t, idx, arr) => t !== "" || arr.length === 1)
      .join("\n\n");
    systemMessages.push({
      role: "system",
      content: combinedSystem,
    });
  }

  // Step 3: Repair tool_calls / tool result pairing and drop empty assistant or orphaned tool messages
  const repairedNonSystem = [];
  let i = 0;
  while (i < rawNonSystem.length) {
    const msg = rawNonSystem[i];

    if (msg.role === "tool") {
      // Orphaned tool result without a preceding assistant tool_calls batch
      repairedToolCount += 1;
      i++;
      continue;
    }

    if (msg.role === "assistant") {
      const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
      const hasContent =
        typeof msg.content === "string"
          ? msg.content.trim().length > 0
          : Array.isArray(msg.content) && msg.content.length > 0;

      // Skip empty/aborted assistant messages when there are other messages in the conversation
      if (!hasToolCalls && !hasContent && rawNonSystem.length > 1) {
        i++;
        continue;
      }

      if (hasToolCalls) {
        repairedNonSystem.push(msg);
        const expectedIds = msg.tool_calls.map((tc) => tc.id);
        const expectedSet = new Set(expectedIds);
        const collectedToolsById = new Map();
        const unmatchedTools = [];

        let j = i + 1;
        while (j < rawNonSystem.length && rawNonSystem[j].role === "tool") {
          const toolMsg = rawNonSystem[j];
          const tcId = toolMsg.tool_call_id;
          if (tcId && expectedSet.has(tcId) && !collectedToolsById.has(tcId)) {
            collectedToolsById.set(tcId, toolMsg);
          } else if (!tcId) {
            unmatchedTools.push(toolMsg);
          } else {
            // Duplicate or orphaned tool_call_id inside batch
            repairedToolCount += 1;
          }
          j++;
        }

        for (const tcId of expectedIds) {
          if (collectedToolsById.has(tcId)) {
            repairedNonSystem.push(collectedToolsById.get(tcId));
          } else if (unmatchedTools.length > 0) {
            const positional = { ...unmatchedTools.shift(), tool_call_id: tcId };
            repairedNonSystem.push(positional);
            repairedToolCount += 1;
          } else {
            repairedNonSystem.push({
              role: "tool",
              tool_call_id: tcId,
              content: "No result provided",
            });
            repairedToolCount += 1;
          }
        }

        i = j;
        continue;
      }

      repairedNonSystem.push(msg);
      i++;
      continue;
    }

    repairedNonSystem.push(msg);
    i++;
  }

  // If the request originally ended with a mid-conversation system message and after folding
  // the last message is a completed assistant turn (no pending tool results), append a user
  // continuation cue so the model does not see an assistant-terminated transcript.
  if (trailingSystemTexts.length > 0 && repairedNonSystem.length > 0) {
    const lastMsg = repairedNonSystem[repairedNonSystem.length - 1];
    if (lastMsg.role === "assistant" && (!Array.isArray(lastMsg.tool_calls) || lastMsg.tool_calls.length === 0)) {
      repairedNonSystem.push({
        role: "user",
        content: `[Notificação do sistema: ${trailingSystemTexts.join(" ")}]`,
      });
    }
  }

  return {
    messages: [...systemMessages, ...repairedNonSystem],
    strippedReasoningCount,
    repairedToolCount,
    foldedSystemCount,
  };
}

/* ------------------------------------------------------------------------- */
/* Entry point                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Pass-through context handling.
 *
 * The payload is forwarded exactly as received, except for protocol
 * sanitization. Nothing is trimmed, dropped, truncated, summarized or clamped.
 * The only extra work is observing whether the client already compacted, so
 * the proxy (and the dashboard) can report it and stop looking at history.
 */
export function manageContext({ body, modelInfo, contextSettings } = {}) {
  const settings = normalizeContextSettings(contextSettings);
  const limits = resolveModelContextLimits(modelInfo);
  const rawMessages = Array.isArray(body?.messages) ? body.messages : null;
  const tools = Array.isArray(body?.tools) ? body.tools : null;

  if (!rawMessages) {
    return {
      body,
      meta: {
        mode: settings.mode,
        contextWindow: limits.contextWindow,
        inputBudget: limits.inputBudget,
        originalInputTokens: 0,
        estimatedInputTokens: 0,
        trimmed: false,
        droppedMessages: 0,
        truncatedMessages: 0,
        clampedMaxTokens: false,
        utilizationPct: 0,
        strippedReasoningCount: 0,
        foldedSystemCount: 0,
        repairedToolCount: 0,
        compaction: detectClientCompaction([], {}),
      },
    };
  }

  const originalInputTokens = estimateRequestTokens(rawMessages, tools);
  const compaction = settings.detectCompaction
    ? detectClientCompaction(rawMessages)
    : { ...detectClientCompaction([]), messagesTotal: rawMessages.length };

  const sanitized = sanitizeAndNormalizeMessages(rawMessages, { stripReasoning: true });
  const messages = sanitized.messages;
  const estimatedInputTokens = estimateRequestTokens(messages, tools);

  const utilizationPct = Math.min(
    999,
    Math.round((estimatedInputTokens / Math.max(1, limits.contextWindow)) * 100),
  );

  return {
    body: Array.isArray(body?.messages) ? { ...body, messages } : body,
    meta: {
      mode: settings.mode,
      contextWindow: limits.contextWindow,
      inputBudget: limits.inputBudget,
      originalInputTokens,
      estimatedInputTokens,
      // Nothing is ever removed to fit a budget.
      trimmed: false,
      droppedMessages: 0,
      truncatedMessages: 0,
      clampedMaxTokens: false,
      utilizationPct,
      strippedReasoningCount: sanitized.strippedReasoningCount,
      foldedSystemCount: sanitized.foldedSystemCount,
      repairedToolCount: sanitized.repairedToolCount,
      compaction,
    },
  };
}
