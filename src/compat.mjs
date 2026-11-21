function isPlainTextPart(part) {
  return (
    part &&
    typeof part === "object" &&
    part.type === "text" &&
    typeof part.text === "string" &&
    Object.keys(part).length === 2
  );
}

/**
 * Ajustes de compatibilidade para clientes OpenAI (OpenCode, Hermes,
 * DeepSeek, Arnis, SDKs etc.) sem alterar o conteúdo da conversa.
 */
export function normalizeChatPayload(payload, resolveModel) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const next = { ...payload };

  if (typeof next.model === "string" && resolveModel) {
    next.model = resolveModel(next.model);
  }

  // Alguns SDKs novos só mandam max_completion_tokens; a DeepAI usa max_tokens.
  if (next.max_tokens === undefined && next.max_completion_tokens !== undefined) {
    next.max_tokens = next.max_completion_tokens;
  }
  delete next.max_completion_tokens;

  if (Array.isArray(next.messages)) {
    next.messages = next.messages.map((message) => {
      if (!message || typeof message !== "object") return message;
      let normalized = message;

      if (normalized.role === "developer") {
        normalized = { ...normalized, role: "system" };
      }

      // O upstream trata arrays como multimodal. Texto puro vira string para
      // não cair no processador de imagem e para preservar o prefixo do cache.
      if (
        normalized.role === "user" &&
        Array.isArray(normalized.content) &&
        normalized.content.length > 0 &&
        normalized.content.every(isPlainTextPart)
      ) {
        normalized = {
          ...normalized,
          content: normalized.content.map((part) => part.text).join(""),
        };
      }

      return normalized;
    });
  }

  // A DeepAI recusa chat sem mensagem de sistema; clientes simples podem
  // mandar só user/assistant. Injeta um system mínimo quando falta.
  if (Array.isArray(next.messages)) {
    const hasSystem = next.messages.some(
      (message) =>
        message &&
        (message.role === "system" || message.role === "developer") &&
        (typeof message.content === "string"
          ? message.content.trim().length > 0
          : Array.isArray(message.content) && message.content.length > 0),
    );
    if (!hasSystem) {
      next.messages = [
        { role: "system", content: "You are a helpful assistant." },
        ...next.messages,
      ];
    }
  }

  // Garante usage no chunk final de SSE, sem mudar o formato para o cliente.
  if (next.stream === true) {
    next.stream_options = {
      ...(next.stream_options && typeof next.stream_options === "object"
        ? next.stream_options
        : {}),
      include_usage: true,
    };
  }

  return next;
}
