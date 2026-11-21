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

function longestOverlap(stored, incoming) {
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
      if (length > best.length) {
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
 * Compacta mensagens no estilo Pi SDK: quando o contexto excede
 * `contextWindow - reserveTokens`, mantém as mensagens mais recentes
 * dentro de `keepRecentTokens`, preservando system/developer no início.
 */
export function compactMessages(
  messages,
  { contextWindow = 128000, reserveTokens = 16384, keepRecentTokens = 20000 } = {},
) {
  if (!Array.isArray(messages) || messages.length <= 2) return messages;

  const budget = Math.max(1024, contextWindow - reserveTokens);
  const totalTokens = estimateTokens(messages);
  if (totalTokens <= budget) return messages;

  const systemMsgs = [];
  const bodyMsgs = [];
  for (const msg of messages) {
    if (isSystem(msg)) systemMsgs.push(msg);
    else bodyMsgs.push(msg);
  }

  // Mantém as mensagens mais recentes dentro de keepRecentTokens
  const kept = [];
  let keptTokens = 0;
  for (let i = bodyMsgs.length - 1; i >= 0; i -= 1) {
    const msg = bodyMsgs[i];
    const msgTokens = estimateTokens([msg]);
    if (keptTokens + msgTokens > keepRecentTokens && kept.length > 0) break;
    kept.unshift(msg);
    keptTokens += msgTokens;
  }

  // Evita cortar no meio de uma sequência tool_call/tool_result
  let cutIndex = bodyMsgs.length - kept.length;
  while (cutIndex > 0 && bodyMsgs[cutIndex]?.role === "tool") {
    cutIndex -= 1;
    const msg = bodyMsgs[cutIndex];
    kept.unshift(msg);
    keptTokens += estimateTokens([msg]);
  }
  // Se o corte caiu em assistant com tool_calls, inclui os tool results seguintes já presentes;
  // se o primeiro kept é assistant com tool_calls cujos resultados foram parcialmente cortados, recua mais.
  if (cutIndex > 0) {
    const first = kept[0];
    if (first?.role === "assistant" && Array.isArray(first.tool_calls) && first.tool_calls.length > 0) {
      const toolCallIds = new Set(first.tool_calls.map((tc) => tc?.id).filter(Boolean));
      const hasAllResults = [...kept.slice(1)].filter((m) => m?.role === "tool").some((m) => toolCallIds.has(m.tool_call_id));
      // se nenhum resultado presente, recua para incluir o par inteiro anterior ou descarta o assistant órfão
      if (!hasAllResults) {
        // remove assistant órfão do início do kept
        kept.shift();
        keptTokens -= estimateTokens([first]);
      }
    }
  }

  // Garante que o system prompt caiba; se não couber, trunca só o texto do system
  let systemTokens = estimateTokens(systemMsgs);
  let finalSystem = systemMsgs;
  const availableForSystem = Math.max(512, budget - keptTokens);
  if (systemTokens > availableForSystem && systemMsgs.length > 0) {
    finalSystem = systemMsgs.map((msg) => {
      if (typeof msg.content !== "string") return msg;
      const maxChars = Math.max(256, availableForSystem * 4);
      if (msg.content.length <= maxChars) return msg;
      return { ...msg, content: msg.content.slice(0, maxChars) + "\n[...system prompt truncado...]" };
    });
    systemTokens = estimateTokens(finalSystem);
  }

  let result = [...finalSystem, ...kept];

  // Se ainda estiver acima do budget, remove do início do body (após system)
  while (estimateTokens(result) > budget && result.length > systemMsgs.length + 1) {
    result.splice(finalSystem.length, 1);
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

  restore(session, incoming) {
    if (!session || session.messages.length === 0) {
      return { messages: incoming, restored: 0 };
    }
    const storedSigs = session.signatures;
    const incomingSigs = incoming.map(messageSignature);
    const overlap = longestOverlap(storedSigs, incomingSigs);
    if (overlap.length === 0) return { messages: incoming, restored: 0 };

    const currentHasSystem = isSystem(incoming[0]);
    let missing = [];

    const leadingOnlySystem =
      overlap.incomingStart > 0 &&
      incoming.slice(0, overlap.incomingStart).every(isSystem);

    if (
      (overlap.incomingStart === 0 || leadingOnlySystem) &&
      overlap.storedStart > 0
    ) {
      // O cliente mandou só a cauda (compactou/truncou o começo), mas pode
      // ter injetado um system novo. Preserva o system atual e restaura o
      // histórico que veio antes do trecho em comum.
      missing = session.messages.slice(0, overlap.storedStart);
    } else if (
      overlap.incomingStart === 0 &&
      overlap.storedStart === 0 &&
      incoming.length < session.messages.length
    ) {
      // O cliente mandou só um prefixo menor; o restante está no ledger.
      const prefix = currentHasSystem ? [incoming[0]] : [];
      const storedBody = session.messages.filter((message) => !isSystem(message));
      const messages = trimMessages([...prefix, ...storedBody]);
      return {
        messages,
        restored: Math.max(0, messages.length - incoming.length),
      };
    } else {
      return { messages: incoming, restored: 0 };
    }

    if (currentHasSystem) {
      missing = missing.filter((message) => !isSystem(message));
    }
    if (missing.length === 0) return { messages: incoming, restored: 0 };

    // O system atual do cliente manda no topo; o histórico entra depois.
    const prefix = currentHasSystem ? [incoming[0]] : [];
    const rest = currentHasSystem ? incoming.slice(1) : incoming;
    const messages = trimMessages([...prefix, ...missing, ...rest]);
    return {
      messages,
      restored: Math.max(0, messages.length - incoming.length),
    };
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
      created = true;
      const now = new Date().toISOString();
      session = {
        id: `cs_${randomBytes(16).toString("hex")}`,
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

    let plan = this.restore(session, messages);
    const incomingHasAssistant = messages.some(
      (message) =>
        message?.role === "assistant" ||
        message?.role === "tool" ||
        message?.type === "function_call_output",
    );
    if (
      hint &&
      matched &&
      plan.restored === 0 &&
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
    const finalMessages = plan.messages;
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
