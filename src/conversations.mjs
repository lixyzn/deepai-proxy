import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, decryptSecret, encryptSecret } from "./store.mjs";

/**
 * Ledger de conversas do proxy.
 *
 * O cliente OpenAI não é obrigado a mandar `prompt_cache_key`, thread id ou
 * qualquer identificador de conversa. Então o proxy mantém a identidade aqui:
 * o histórico normalizado é usado para reconhecer a continuação, inclusive
 * depois de compactação/truncamento, troca de modelo ou failover de conta.
 *
 * O conteúdo fica criptografado em repouso com a mesma chave das contas
 * (`data/secret.key`). O banco expõe apenas metadados.
 */

const VERSION = 1;
const MAX_SESSIONS = 120;
const MAX_MESSAGES = 800;
const MAX_SESSION_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_HINTS = 8;
const KEY_RE = /^[A-Za-z0-9._:-]{1,256}$/;
const MESSAGE_SIG = 32;

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function hashText(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function canonicalMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return message;
  }
  const next = { ...message };
  // Campos que o cliente pode incluir/omitir sem mudar o turno da conversa.
  for (const key of [
    "reasoning_content",
    "reasoning",
    "refusal",
    "annotations",
    "logprobs",
    "provider",
  ]) {
    delete next[key];
  }
  if (Array.isArray(next.tool_calls)) {
    next.tool_calls = next.tool_calls.map((call) => {
      if (!call || typeof call !== "object") return call;
      const copy = { ...call };
      if (copy.function && typeof copy.function === "object") {
        copy.function = { ...copy.function };
        if (typeof copy.function.arguments === "string") {
          try {
            copy.function.arguments = stableStringify(
              JSON.parse(copy.function.arguments),
            );
          } catch {
            // argumentos podem estar incompletos em streaming; preserva o texto.
          }
        }
      }
      return copy;
    });
  }
  return next;
}

export function messageSignature(message) {
  return `m_${hashText(stableStringify(canonicalMessage(message))).slice(
    0,
    MESSAGE_SIG,
  )}`;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part) =>
        part &&
        typeof part === "object" &&
        typeof part.text === "string" &&
        (part.type === "text" ||
          part.type === "input_text" ||
          part.type === "output_text"),
    )
    .map((part) => part.text)
    .join("\n");
}

function firstUserHash(messages) {
  for (const message of messages) {
    if (message?.role === "user") {
      const text = textOf(message.content).trim();
      if (text) return hashText(text);
    }
  }
  for (const message of messages) {
    if (message?.role === "system" || message?.role === "developer") {
      const text = textOf(message.content).trim();
      if (text) return hashText(text);
    }
  }
  return null;
}

function lastUserHash(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      const text = textOf(message.content).trim();
      if (text) return hashText(text);
    }
  }
  return null;
}

function clientKey(headers, address) {
  const auth = String(
    headers?.authorization ??
      headers?.["x-api-key"] ??
      headers?.["x-deepai-proxy-token"] ??
      "",
  );
  const seed = auth
    ? `auth\0${auth}`
    : `peer\0${address ?? "loopback"}\0${headers?.["user-agent"] ?? ""}`;
  return hashText(seed).slice(0, 32);
}

function providedKey(body, headers) {
  const bodyKeys = [
    "prompt_cache_key",
    "conversation_id",
    "conversationId",
    "thread_id",
    "threadId",
    "session_id",
    "sessionId",
  ];
  for (const key of bodyKeys) {
    if (typeof body?.[key] === "string" && KEY_RE.test(body[key])) {
      return body[key];
    }
  }
  const headerKeys = [
    "x-conversation-id",
    "x-thread-id",
    "x-session-id",
    "x-client-session-id",
    "x-session-affinity",
  ];
  for (const key of headerKeys) {
    const raw = headers?.[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string" && KEY_RE.test(value)) return value;
  }
  return null;
}

function hintId(client, key) {
  return hashText(`hint\0${client}\0${key}`).slice(0, 32);
}

function extractHistory(body, endpoint) {
  if (endpoint === "responses") {
    if (Array.isArray(body?.input)) {
      return body.input.filter(
        (item) => item && typeof item === "object" && !Array.isArray(item),
      );
    }
    if (typeof body?.input === "string" && body.input.trim()) {
      return [{ role: "user", content: body.input }];
    }
    return null;
  }
  if (!Array.isArray(body?.messages)) return null;
  return body.messages.filter(
    (message) =>
      message && typeof message === "object" && !Array.isArray(message),
  );
}

function longestOverlap(stored, incoming, { preferTail = false } = {}) {
  const positions = new Map();
  for (let index = 0; index < stored.length; index += 1) {
    const list = positions.get(stored[index]) ?? [];
    if (list.length < 12) list.push(index);
    positions.set(stored[index], list);
  }

  let best = { length: 0, storedStart: 0, incomingStart: 0 };
  for (let incomingIndex = 0; incomingIndex < incoming.length; incomingIndex += 1) {
    const matches = positions.get(incoming[incomingIndex]);
    if (!matches) continue;
    for (const storedIndex of matches) {
      let length = 0;
      while (
        storedIndex + length < stored.length &&
        incomingIndex + length < incoming.length &&
        stored[storedIndex + length] === incoming[incomingIndex + length]
      ) {
        length += 1;
      }
      const better =
        length > best.length ||
        (preferTail &&
          length === best.length &&
          length > 0 &&
          (incomingIndex > best.incomingStart ||
            (incomingIndex === best.incomingStart &&
              storedIndex > best.storedStart)));
      if (better) {
        best = {
          length,
          storedStart: storedIndex,
          incomingStart: incomingIndex,
        };
      }
    }
  }
  return best;
}

function isSystem(message) {
  return message?.role === "system" || message?.role === "developer";
}

function estimateTokens(messages) {
  let total = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const content = msg.content;
    if (typeof content === "string") {
      total += Math.ceil(content.length / 4);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === "object" && typeof part.text === "string") {
          total += Math.ceil(part.text.length / 4);
        }
      }
    }
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const args = tc?.function?.arguments;
        if (typeof args === "string") total += Math.ceil(args.length / 4);
      }
    }
  }
  return total;
}

function trimMessages(messages) {
  let list = messages.slice(-MAX_MESSAGES).map((message) => ({ ...message }));
  if (isSystem(messages[0]) && !isSystem(list[0])) {
    list.unshift({ ...messages[0] });
  }
  let bytes = Buffer.byteLength(JSON.stringify(list), "utf8");
  while (bytes > MAX_SESSION_BYTES && list.length > 2) {
    const index = isSystem(list[0]) ? 1 : 0;
    list.splice(index, 1);
    bytes = Buffer.byteLength(JSON.stringify(list), "utf8");
  }
  return list;
}

/**
 * Compatação com histerese: quando passa do orçamento (high watermark),
 * corta do início do corpo até um alvo menor (low watermark) e mantém esse
 * piso estável até bater o orçamento de novo. Isso evita o "cliff" 40k->20k->10k
 * e preserva prefixo mais estável para KV cache upstream.
 *
 * `keepRecentTokens` é tratado como alvo mínimo após compatação; o alvo real
 * é max(keepRecentTokens, budget*ratio), limitado ao budget.
 */
export function compactMessages(
  messages,
  {
    contextWindow = 128000,
    reserveTokens = 16384,
    keepRecentTokens = 20000,
    maxTokens,
    lowWatermarkRatio = 0.62,
  } = {},
) {
  if (!Array.isArray(messages) || messages.length <= 2) return messages;

  const budget = Math.max(1024, maxTokens ? maxTokens : contextWindow - reserveTokens);
  const totalTokens = estimateTokens(messages);
  if (totalTokens <= budget) return messages;

  const first = messages[0];
  const leadingSystem = isSystem(first) ? [first] : [];
  const body = isSystem(first) ? messages.slice(1) : messages.slice();
  if (body.length === 0) return messages;

  const systemTokens = estimateTokens(leadingSystem);
  const ratio = Number.isFinite(lowWatermarkRatio)
    ? Math.min(0.9, Math.max(0.4, lowWatermarkRatio))
    : 0.62;
  const target = Math.max(
    1024,
    Math.min(budget - 1024, Math.max(keepRecentTokens, Math.floor(budget * ratio))),
  );
  const recentBudget = Math.max(512, target - systemTokens);

  const recent = [];
  let recentTokens = 0;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    const message = body[index];
    const tokens = estimateTokens([message]);
    if (recentTokens + tokens > recentBudget && recent.length > 0) break;
    recent.unshift(message);
    recentTokens += tokens;
  }

  // Não corta no meio de uma sequência de ferramentas.
  let cutIndex = body.length - recent.length;
  while (cutIndex > 0 && recent[0]?.role === "tool") {
    cutIndex -= 1;
    recent.unshift(body[cutIndex]);
    recentTokens += estimateTokens([body[cutIndex]]);
  }
  // Se o corte deixou um assistant com tool_calls sem nenhum resultado, recua.
  while (cutIndex > 0) {
    const firstRecent = recent[0];
    if (
      firstRecent?.role === "assistant" &&
      Array.isArray(firstRecent.tool_calls) &&
      firstRecent.tool_calls.length > 0 &&
      !recent.slice(1).some((m) => m.role === "tool")
    ) {
      cutIndex -= 1;
      recent.unshift(body[cutIndex]);
      recentTokens += estimateTokens([body[cutIndex]]);
      continue;
    }
    break;
  }

  const result = [...leadingSystem, ...recent];

  // Remove órfãos óbvios de tool no começo da janela.
  while (
    result.length > leadingSystem.length + 1 &&
    result[leadingSystem.length]?.role === "tool"
  ) {
    result.splice(leadingSystem.length, 1);
  }
  // Remove assistant+tool_calls sem qualquer resultado correspondente no começo.
  while (result.length > leadingSystem.length) {
    const firstBody = result[leadingSystem.length];
    if (
      firstBody?.role === "assistant" &&
      Array.isArray(firstBody.tool_calls) &&
      firstBody.tool_calls.length > 0 &&
      !result.slice(leadingSystem.length + 1).some((m) => m.role === "tool")
    ) {
      result.splice(leadingSystem.length, 1);
      continue;
    }
    break;
  }

  return result;
}

function safeDecrypt(record) {
  if (typeof record.messagesEnc !== "string") return [];
  try {
    const parsed = JSON.parse(decryptSecret(record.messagesEnc));
    return Array.isArray(parsed)
      ? parsed.filter(
          (message) =>
            message && typeof message === "object" && !Array.isArray(message),
        )
      : [];
  } catch {
    return [];
  }
}

function publicSession(session) {
  return {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    model: session.model ?? null,
    endpoint: session.endpoint,
    messages: session.messages.length,
    tokensEstimate: session.tokensEstimate,
    bytes: session.bytes,
    restored: session.restored,
    hints: session.hints.length,
  };
}

export class ConversationStore {
  constructor(file = path.join(DATA_DIR, "conversations.json")) {
    this.file = file;
    this.sessions = [];
    this.byHint = new Map();
    this.stats = { created: 0, matched: 0, restored: 0, clearedAt: null };
    this.updatedAt = null;
    this.pendingSave = null;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const rows = Array.isArray(raw?.sessions) ? raw.sessions : [];
      this.sessions = [];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        if (typeof row.id !== "string" || !KEY_RE.test(row.id)) continue;
        const messages = safeDecrypt(row);
        if (messages.length === 0) continue;
        const session = {
          id: row.id,
          createdAt:
            typeof row.createdAt === "string"
              ? row.createdAt
              : new Date().toISOString(),
          updatedAt:
            typeof row.updatedAt === "string"
              ? row.updatedAt
              : new Date().toISOString(),
          clientKey: typeof row.clientKey === "string" ? row.clientKey : "",
          endpoint:
            row.endpoint === "responses" ? "responses" : "chat/completions",
          model: typeof row.model === "string" ? row.model : null,
          messages,
          signatures: messages.map(messageSignature),
          firstUserHash:
            typeof row.firstUserHash === "string" ? row.firstUserHash : null,
          lastUserHash:
            typeof row.lastUserHash === "string" ? row.lastUserHash : null,
          hints: Array.isArray(row.hints)
            ? row.hints.filter((hint) => typeof hint === "string").slice(0, MAX_HINTS)
            : [],
          encrypted: typeof row.messagesEnc === "string" ? row.messagesEnc : null,
          restored: Number.isFinite(Number(row.restored))
            ? Number(row.restored)
            : 0,
          bytes: Buffer.byteLength(JSON.stringify(messages), "utf8"),
          tokensEstimate: Math.ceil(
            Buffer.byteLength(JSON.stringify(messages), "utf8") / 4,
          ),
        };
        this.sessions.push(session);
        for (const hint of session.hints) this.byHint.set(hint, session.id);
      }
      if (raw?.stats && typeof raw.stats === "object") {
        this.stats = { ...this.stats, ...raw.stats };
      }
      this.updatedAt =
        typeof raw?.updatedAt === "string" ? raw.updatedAt : null;
    } catch {
      // primeiro uso ou arquivo ilegível: começa vazio.
    }
  }

  find(client, endpoint, messages) {
    const incoming = messages.map(messageSignature);
    let best = null;

    for (const session of this.sessions) {
      if (session.clientKey !== client || session.endpoint !== endpoint) continue;
      const overlap = longestOverlap(session.signatures, incoming);
      if (overlap.length === 0) continue;

      let confidence = overlap.length;
      if (overlap.storedStart === 0 && overlap.incomingStart === 0) {
        confidence += 2;
      }
      if (overlap.length === session.signatures.length) confidence += 1;
      if (
        session.signatures.length === 1 &&
        overlap.length === 1 &&
        Date.now() - Date.parse(session.updatedAt) < 30 * 60 * 1000
      ) {
        confidence += 1;
      }

      if (!best || confidence > best.confidence) {
        best = { session, overlap, confidence };
      }
    }

    if (!best) return null;
    const oneTurn =
      best.session.signatures.length === 1 && best.overlap.length === 1;
    const anchor = best.session.messages[best.overlap.storedStart];
    const suffixMatch =
      !isSystem(anchor) &&
      best.overlap.incomingStart === 0 &&
      best.overlap.length >= 1 &&
      messages.length >= 2;
    if (best.overlap.length < 2 && !oneTurn && !suffixMatch) return null;
    return best;
  }

  restore(session, incoming, { trusted = false, hintMatched = false } = {}) {
    const stored = session.messages;
    if (stored.length === 0) return { messages: incoming, restored: 0 };
    if (incoming.length === 0) return { messages: stored, restored: stored.length };

    const storedSigs = session.signatures;
    const incomingSigs = incoming.map(messageSignature);
    const overlap = longestOverlap(storedSigs, incomingSigs, { preferTail: true });
    const storedSigsSet = new Set(storedSigs);

    // Semantic compaction: client replaced old history with a shorter
    // summary/rewritten form while keeping recent tail overlap. Accept the
    // compacted incoming as the new truth instead of merging with the full
    // stored body, which would duplicate context and undo compaction.
    const novelBeforeOverlap =
      overlap.length > 0 &&
      overlap.incomingStart > 0 &&
      incoming.slice(0, overlap.incomingStart).some((m, i) => !isSystem(m) && !storedSigsSet.has(incomingSigs[i]));
    const compactionTrusted = hintMatched || (trusted && overlap.length >= 2);
    const isCompaction =
      compactionTrusted && incoming.length < stored.length && novelBeforeOverlap;

    if (overlap.length === 0) {
      if (trusted && stored.length > 0) {
        const incomingBody = incoming.filter((m) => !isSystem(m));
        const storedTail = new Set(storedSigs.slice(-24));
        const novel = incomingBody.filter((m) => !storedTail.has(messageSignature(m)));
        if (novel.length > 0) {
          const prefix = isSystem(incoming[0]) ? [incoming[0]] : (isSystem(stored[0]) ? [stored[0]] : []);
          const base = stored.filter((m) => !isSystem(m));
          return { messages: trimMessages([...prefix, ...base, ...novel]), restored: base.length };
        }
        return { messages: stored, restored: 0 };
      }
      return { messages: incoming, restored: 0 };
    }

    if (isCompaction) {
      return { messages: trimMessages(incoming), restored: 0, compacted: true };
    }

    const currentHasSystem = isSystem(incoming[0]);
    const leadingOnlySystem =
      overlap.incomingStart > 0 &&
      incoming.slice(0, overlap.incomingStart).every(isSystem);

    if ((overlap.incomingStart === 0 || leadingOnlySystem) && overlap.storedStart > 0) {
      let missing = session.messages.slice(0, overlap.storedStart);
      if (currentHasSystem) missing = missing.filter((message) => !isSystem(message));
      const prefix = currentHasSystem ? [incoming[0]] : [];
      const rest = currentHasSystem ? incoming.slice(1) : incoming.slice();
      return { messages: trimMessages([...prefix, ...missing, ...rest]), restored: missing.length };
    }

    if (overlap.incomingStart === 0 && overlap.storedStart === 0 && incoming.length < session.messages.length) {
      const prefix = currentHasSystem ? [incoming[0]] : (isSystem(stored[0]) ? [stored[0]] : []);
      const storedBody = session.messages.filter((message) => !isSystem(message));
      const incomingTail = incoming.slice(overlap.length);
      const novelTail = incomingTail.filter((m) => !storedSigsSet.has(messageSignature(m)));
      return { messages: trimMessages([...prefix, ...storedBody, ...novelTail]), restored: Math.max(0, storedBody.length) };
    }

    if (trusted && incoming.length < stored.length) {
      const incomingBody = incoming.filter((m) => !isSystem(m));
      const novel = incomingBody.filter((m) => !storedSigsSet.has(messageSignature(m)));
      const prefix = currentHasSystem ? [incoming[0]] : (isSystem(stored[0]) ? [stored[0]] : []);
      const base = stored.filter((m) => !isSystem(m));
      return { messages: trimMessages(novel.length > 0 ? [...prefix, ...base, ...novel] : [...prefix, ...base]), restored: novel.length > 0 ? base.length : 0 };
    }

    return { messages: incoming, restored: 0 };
  }

  resolve({ body, endpoint, headers, model, address }) {
    const messages = extractHistory(body, endpoint);
    if (!messages || messages.length === 0) return null;

    const client = clientKey(headers, address);
    const key = providedKey(body, headers);
    const hint = key ? hintId(client, key) : null;
    let matched = hint ? this.byHint.get(hint) : null;
    let session = matched
      ? this.sessions.find((item) => item.id === matched)
      : null;
    let created = false;
    let hintMatched = !!(session && hint);

    if (session && hint) this.stats.matched += 1;

    if (!session) {
      const found = this.find(client, endpoint, messages);
      if (found) {
        session = found.session;
        matched = session.id;
        this.stats.matched += 1;
      }
    }

    if (!session) {
      const stableId = hint && KEY_RE.test(key)
        ? key
        : hint
          ? `cs_${hint}`
          : `cs_${hashText(`session\0${client}\0${endpoint}\0${model ?? ""}\0${firstUserHash(messages) ?? ""}`).slice(0, 32)}`;
      const existing = this.sessions.find((item) => item.id === stableId);
      if (existing && existing.clientKey === client) {
        session = existing;
        matched = session.id;
        if (hint) hintMatched = true;
        this.stats.matched += 1;
      } else {
        created = true;
        const now = new Date().toISOString();
        const id = existing ? `cs_${randomBytes(16).toString("hex")}` : stableId;
        session = {
          id,
          createdAt: now,
          updatedAt: now,
          clientKey: client,
          endpoint,
          model: model ?? null,
          messages: [],
          signatures: [],
          firstUserHash: null,
          lastUserHash: null,
          hints: [],
          encrypted: null,
          restored: 0,
          bytes: 0,
          tokensEstimate: 0,
        };
        this.sessions.unshift(session);
        this.stats.created += 1;
      }
    }

    let plan = this.restore(session, messages, { trusted: true, hintMatched });
    const incomingHasAssistant = messages.some(
      (message) =>
        message?.role === "assistant" ||
        message?.role === "tool" ||
        message?.type === "function_call_output",
    );
    if (
      hintMatched &&
      !created &&
      plan.restored === 0 &&
      !plan.compacted &&
      !incomingHasAssistant &&
      session.messages.length > 0 &&
      messages.some((message) => message?.role === "user")
    ) {
      // Cliente mandou uma thread id estável, mas só o último user. O ledger
      // completa o histórico anterior, preservando o system atual.
      const prefix = isSystem(messages[0]) ? [messages[0]] : [];
      const body = messages.filter((message) => !isSystem(message));
      const merged = trimMessages([
        ...prefix,
        ...session.messages.filter((message) => !isSystem(message)),
        ...body,
      ]);
      plan = {
        messages: merged,
        restored: Math.max(0, merged.length - messages.length),
      };
    }
    let finalMessages = plan.messages;
    if (hintMatched && !created && plan.restored === 0 && finalMessages.length < session.messages.length && !plan.compacted) {
      const storedSigsSet = new Set(session.signatures);
      const finalSigs = finalMessages.map(messageSignature);
      const novelIndices = [];
      for (let i = 0; i < finalMessages.length; i += 1) {
        if (!isSystem(finalMessages[i]) && !storedSigsSet.has(finalSigs[i])) novelIndices.push(i);
      }
      if (novelIndices.length > 0) {
        let lastKnownIndex = -1;
        for (let i = 0; i < finalSigs.length; i += 1) {
          if (storedSigsSet.has(finalSigs[i])) lastKnownIndex = i;
        }
        const novelBeforeLastKnown = novelIndices.some((i) => i < lastKnownIndex);
        if (!novelBeforeLastKnown) {
          // Sliding window: novelties only at tail, restore missing stored body.
          const prefix = isSystem(finalMessages[0]) ? [finalMessages[0]] : (isSystem(session.messages[0]) ? [session.messages[0]] : []);
          const base = session.messages.filter((m) => !isSystem(m));
          const novel = novelIndices.map((i) => finalMessages[i]);
          finalMessages = trimMessages([...prefix, ...base, ...novel]);
        }
        // else: semantic compaction - keep the compacted incoming as-is.
      } else {
        finalMessages = session.messages;
      }
    }
    const signatures = finalMessages.map(messageSignature);
    const encrypted = encryptSecret(JSON.stringify(finalMessages));

    session.messages = finalMessages;
    session.signatures = signatures;
    session.encrypted = encrypted;
    session.model = model ?? session.model;
    session.firstUserHash = firstUserHash(finalMessages);
    session.lastUserHash = lastUserHash(finalMessages);
    session.updatedAt = new Date().toISOString();
    session.bytes = Buffer.byteLength(JSON.stringify(finalMessages), "utf8");
    session.tokensEstimate = Math.ceil(session.bytes / 4);
    session.restored += plan.restored;
    this.stats.restored += plan.restored;
    if (hint && !session.hints.includes(hint)) {
      session.hints.push(hint);
      if (session.hints.length > MAX_HINTS) session.hints.shift();
      this.byHint.set(hint, session.id);
    }
    for (const item of session.hints) this.byHint.set(item, session.id);

    this.updatedAt = session.updatedAt;
    this.prune();
    this.scheduleSave();

    return {
      sessionId: session.id,
      messages: finalMessages,
      restored: plan.restored,
      matched: matched ?? null,
      created,
      messagesCount: finalMessages.length,
    };
  }

  appendAssistant(sessionId, message) {
    if (!sessionId || !message || typeof message !== "object") return false;
    const session = this.sessions.find((item) => item.id === sessionId);
    if (!session) return false;
    if (!message.content && !(Array.isArray(message.tool_calls) && message.tool_calls.length)) {
      return false;
    }

    const signature = messageSignature(message);
    if (session.signatures[session.signatures.length - 1] === signature) {
      return false;
    }

    const last = session.messages[session.messages.length - 1];
    if (last?.role === "assistant") {
      session.messages[session.messages.length - 1] = message;
    } else {
      session.messages.push(message);
    }
    session.messages = trimMessages(session.messages);
    session.signatures = session.messages.map(messageSignature);
    session.firstUserHash = firstUserHash(session.messages);
    session.lastUserHash = lastUserHash(session.messages);
    session.updatedAt = new Date().toISOString();
    session.bytes = Buffer.byteLength(JSON.stringify(session.messages), "utf8");
    session.tokensEstimate = Math.ceil(session.bytes / 4);
    session.encrypted = encryptSecret(JSON.stringify(session.messages));
    this.updatedAt = session.updatedAt;
    this.prune();
    this.scheduleSave();
    return true;
  }

  prune() {
    this.sessions.sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
    if (this.sessions.length > MAX_SESSIONS) {
      this.sessions.length = MAX_SESSIONS;
    }
    let total = this.sessions.reduce((sum, session) => sum + session.bytes, 0);
    while (total > MAX_TOTAL_BYTES && this.sessions.length > 1) {
      const removed = this.sessions.pop();
      total -= removed.bytes;
    }
    const alive = new Set(this.sessions.map((session) => session.id));
    for (const [hint, id] of this.byHint) {
      if (!alive.has(id)) this.byHint.delete(hint);
    }
  }

  clear() {
    this.sessions = [];
    this.byHint.clear();
    this.stats = {
      created: 0,
      matched: 0,
      restored: 0,
      clearedAt: new Date().toISOString(),
    };
    this.updatedAt = new Date().toISOString();
    this.scheduleSave();
    this.flush();
  }

  snapshot() {
    return {
      sessions: this.sessions.map(publicSession),
      stats: {
        ...this.stats,
        sessions: this.sessions.length,
        messages: this.sessions.reduce(
          (sum, session) => sum + session.messages.length,
          0,
        ),
        bytes: this.sessions.reduce((sum, session) => sum + session.bytes, 0),
      },
      updatedAt: this.updatedAt,
    };
  }

  scheduleSave() {
    if (this.pendingSave) return;
    this.pendingSave = setTimeout(() => {
      this.pendingSave = null;
      this.flush();
    }, 900);
    this.pendingSave.unref?.();
  }

  flush() {
    if (this.pendingSave) {
      clearTimeout(this.pendingSave);
      this.pendingSave = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const rows = this.sessions.map((session) => ({
        id: session.id,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        clientKey: session.clientKey,
        endpoint: session.endpoint,
        model: session.model,
        firstUserHash: session.firstUserHash,
        lastUserHash: session.lastUserHash,
        hints: session.hints,
        restored: session.restored,
        messagesEnc:
          session.encrypted ?? encryptSecret(JSON.stringify(session.messages)),
      }));
      const payload = {
        version: VERSION,
        stats: this.stats,
        sessions: rows,
        updatedAt: this.updatedAt,
      };
      const tmp = `${this.file}.${randomBytes(6).toString("hex")}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      try {
        fs.chmodSync(this.file, 0o600);
      } catch {
        // Windows não implementa chmod POSIX; a ACL do usuário continua valendo.
      }
    } catch (error) {
      console.warn(
        `[conversations] não foi possível salvar: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
}
