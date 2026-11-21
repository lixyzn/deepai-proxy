import { createHash } from "node:crypto";

const CACHE_KEY = /^[A-Za-z0-9._:-]{1,256}$/;
const HEADER_KEYS = [
  "x-session-affinity",
  "x-session-id",
  "session-id",
  "x-conversation-id",
  "conversation-id",
  "x-thread-id",
  "thread-id",
  "x-client-session-id",
];
const BODY_KEYS = [
  "prompt_cache_key",
  "session_id",
  "conversation_id",
  "thread_id",
  "sessionId",
  "conversationId",
  "threadId",
];

function validKey(value) {
  return typeof value === "string" && CACHE_KEY.test(value) ? value : null;
}

function headerValue(headers, name) {
  const raw = headers?.[name];
  if (Array.isArray(raw)) return typeof raw[0] === "string" ? raw[0] : null;
  return typeof raw === "string" ? raw : null;
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

function messageText(message) {
  if (!message || typeof message !== "object") return "";
  return textOf(message.content).trim();
}

function firstUserText(body, endpoint) {
  if (endpoint === "responses") {
    if (typeof body?.input === "string") return body.input.trim();
    if (!Array.isArray(body?.input)) return "";
    const item = body.input.find(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        (entry.role === "user" || entry.type === "message") &&
        messageText(entry),
    );
    return messageText(item);
  }

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const user = messages.find(
    (message) => message?.role === "user" && messageText(message),
  );
  if (user) return messageText(user);
  const system = messages.find(
    (message) =>
      (message?.role === "system" || message?.role === "developer") &&
      messageText(message),
  );
  return system ? messageText(system) : "";
}

/**
 * Chave de contexto estável. O app oficial usa o id da thread; aqui usamos,
 * nesta ordem: chave do cliente, sessão do cliente e um hash do começo da
 * conversa. O hash nunca guarda o texto, só o digest.
 */
export function resolveCacheIdentity({
  body,
  headers,
  accountId,
  endpoint,
}) {
  for (const name of BODY_KEYS) {
    const key = validKey(body?.[name]);
    if (key) return { key, source: "client" };
  }
  for (const name of HEADER_KEYS) {
    const key = validKey(headerValue(headers, name));
    if (key) return { key, source: "header" };
  }

  const model = typeof body?.model === "string" ? body.model : "";
  const seed = firstUserText(body, endpoint).slice(0, 12000);
  const digest = createHash("sha256")
    .update(`v1\n${accountId}\n${model}\n${seed}`)
    .digest("hex")
    .slice(0, 32);
  return { key: `pc_${digest}`, source: "fingerprint" };
}

/**
 * Ativa o cache de prompt no upstream. Não sobrescreve uma chave válida do
 * cliente; só completa quando ela falta.
 */
export function applyCacheIdentity(input) {
  const identity = resolveCacheIdentity(input);
  const body = input.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    if (!validKey(body.prompt_cache_key)) {
      body.prompt_cache_key = identity.key;
    }
  }
  return identity;
}
