import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import {
  DEEPAI_ORIGIN,
  DESKTOP_AUTH_URL,
  DeepAIError,
  exchangeCode,
} from "./deepai.mjs";

export { DEEPAI_ORIGIN, DESKTOP_AUTH_URL, DeepAIError, exchangeCode };

const LOGIN_TTL_MS = 10 * 60 * 1000;
const CALLBACK_PATHS = new Set(["/auth-callback", "/auth/callback", "/callback"]);

function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function listenOnPort(server, port, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : null);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function bindCallbackServer(server) {
  const preferred = Number(process.env.DEEPAI_LOGIN_PORT || 1455);
  if (Number.isInteger(preferred) && preferred > 0 && preferred <= 65535) {
    try {
      const port = await listenOnPort(server, preferred, "127.0.0.1");
      if (port) return port;
    } catch (err) {
      if (err?.code !== "EADDRINUSE" && err?.code !== "EACCES") {
        throw err;
      }
    }
  }
  const ephemeralPort = await listenOnPort(server, 0, "127.0.0.1");
  if (!ephemeralPort) {
    throw new Error("Não foi possível iniciar servidor de callback.");
  }
  return ephemeralPort;
}

/**
 * Checks that DeepAI accepts the generated sign-in URL before showing it.
 * The page answers 400 "Invalid desktop sign-in request." for a malformed
 * state/port, so a broken link must never reach the user.
 */
async function probeSignInUrl(url, { timeoutMs = 8000 } = {}) {
  try {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    if (res.status >= 200 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      return { ok: true, status: res.status };
    }
    const body = await res.text().catch(() => "");
    const detail = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
    return { ok: false, status: res.status, detail };
  } catch (error) {
    // A network failure must not block sign-in: the browser may still reach
    // DeepAI even when the proxy cannot.
    return { ok: true, status: 0, detail: error?.message || null, skipped: true };
  }
}

function parseCallbackInput({ code, state, callbackUrl, rawInput } = {}) {
  const input = String(callbackUrl || rawInput || code || "").trim();
  let parsedCode = typeof code === "string" ? code.trim() : "";
  let parsedState = typeof state === "string" ? state.trim() : "";

  if (input && (input.includes("://") || input.includes("?") || input.includes("code="))) {
    try {
      const normalized = input.startsWith("http")
        ? input
        : input.startsWith("/")
          ? `http://127.0.0.1${input}`
          : `http://127.0.0.1/?${input.replace(/^\?/, "")}`;
      const url = new URL(normalized);
      parsedCode = url.searchParams.get("code") || parsedCode;
      parsedState = url.searchParams.get("state") || parsedState;
    } catch {
      // Fall back to raw code
    }
  }

  return {
    code: parsedCode || input,
    state: parsedState,
  };
}

export class LoginManager {
  constructor({ onComplete } = {}) {
    this.onComplete = onComplete;
    this.records = new Map();
    this.timers = new Map();
  }

  async start({ label } = {}) {
    const id = `login_${randomBytes(12).toString("hex")}`;
    // DeepAI's desktop_auth page only accepts a lowercase hex `state` (>= 16
    // chars). base64url is rejected with 400 "Invalid desktop sign-in request."
    const state = randomBytes(24).toString("hex");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const cleanLabel = typeof label === "string" && label.trim() ? label.trim().slice(0, 120) : null;

    const record = {
      id,
      label: cleanLabel,
      state,
      codeVerifier,
      status: "starting",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + LOGIN_TTL_MS,
      port: null,
      url: null,
      error: null,
      account: null,
      busy: false,
      server: null,
    };

    const server = http.createServer((req, res) => {
      void this.handleCallback(id, req, res);
    });

    try {
      const port = await bindCallbackServer(server);
      record.port = port;
      record.status = "pending";
      record.updatedAt = Date.now();
      record.url = `${DESKTOP_AUTH_URL}?state=${encodeURIComponent(state)}&port=${port}&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=S256`;
      record.server = server;
      this.records.set(id, record);
      this.timers.set(
        id,
        setTimeout(() => {
          this.expire(id);
        }, LOGIN_TTL_MS),
      );

      // Verify the link is actually accepted before handing it to the user.
      // A rejected link would only surface as "Invalid desktop sign-in request"
      // in the browser, so fail here with an actionable message instead.
      const probe = await probeSignInUrl(record.url);
      if (!probe.ok) {
        this.close(id);
        this.records.delete(id);
        throw new DeepAIError(
          `O DeepAI recusou o link de login (HTTP ${probe.status}). ${probe.detail || ""}`.trim(),
          502,
          "sign_in_url_rejected",
          { upstreamStatus: probe.status },
        );
      }

      return this.publicRecord(record);
    } catch (error) {
      try {
        server.close();
      } catch {
        // ignore
      }
      this.records.delete(id);
      throw error;
    }
  }

  get(id) {
    const record = this.records.get(String(id));
    return record ? this.publicRecord(record) : null;
  }

  list() {
    return [...this.records.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((record) => this.publicRecord(record));
  }

  cancel(id) {
    const record = this.records.get(String(id));
    if (!record) return null;
    if (record.status === "pending" || record.status === "starting") {
      record.status = "cancelled";
      record.error = "Login cancelado.";
      record.updatedAt = Date.now();
      this.close(id);
    }
    return this.publicRecord(record);
  }

  findPendingByState(state) {
    if (!state) return null;
    for (const record of this.records.values()) {
      if (record.status === "pending" && sameSecret(state, record.state)) {
        return record;
      }
    }
    return null;
  }

  async completeManually(idOrOpts, rawInput) {
    let loginId = null;
    let code = "";
    let state = "";

    if (idOrOpts && typeof idOrOpts === "object") {
      loginId = idOrOpts.loginId || idOrOpts.id || null;
      const parsed = parseCallbackInput({
        code: idOrOpts.code,
        state: idOrOpts.state,
        callbackUrl: idOrOpts.callbackUrl || idOrOpts.url,
      });
      code = parsed.code;
      state = parsed.state;
    } else {
      loginId = idOrOpts ? String(idOrOpts) : null;
      const parsed = parseCallbackInput({ rawInput });
      code = parsed.code;
      state = parsed.state;
    }

    let record = loginId ? this.records.get(String(loginId)) : null;
    if (!record && state) {
      record = this.findPendingByState(state);
    }
    if (!record && !loginId) {
      const pending = [...this.records.values()].filter((r) => r.status === "pending");
      if (pending.length === 1) {
        record = pending[0];
      }
    }

    if (!record) throw new DeepAIError("Login não encontrado.", 404, "login_not_found");
    if (record.status !== "pending") return this.publicRecord(record);
    if (Date.now() > record.expiresAt) {
      this.expire(record.id);
      throw new DeepAIError("Esse login expirou. Gere outro link.", 410, "login_expired");
    }

    if (!code) throw new DeepAIError("Cole o link completo ou o código.", 400, "missing_callback");
    await this.finish(record.id, { code, state: state || record.state });
    return this.publicRecord(record);
  }

  async handleMainServerCallback(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!CALLBACK_PATHS.has(url.pathname)) {
      return false;
    }
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    const record = this.findPendingByState(state);
    if (!record) {
      this.sendCallbackHtml(
        res,
        410,
        "Login não encontrado",
        "Esse login expirou ou não corresponde a nenhuma sessão pendente. Volte ao proxy e gere outro link.",
      );
      return true;
    }
    await this.handleCallback(record.id, req, res);
    return true;
  }

  async handleCallback(id, req, res) {
    const record = this.records.get(String(id));
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (!CALLBACK_PATHS.has(url.pathname)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    if (!record) {
      this.sendCallbackHtml(res, 410, "Login não encontrado", "Esse login não existe mais. Volte ao proxy e gere outro link.");
      return;
    }
    if (record.status !== "pending") {
      this.sendCallbackHtml(res, 200, "Login já processado", "Você já pode voltar ao painel do proxy.");
      return;
    }
    if (Date.now() > record.expiresAt) {
      this.expire(id);
      this.sendCallbackHtml(res, 410, "Login expirado", "Esse link expirou. Volte ao proxy e gere outro.");
      return;
    }

    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    try {
      await this.finish(id, { code, state });
      this.sendCallbackHtml(
        res,
        200,
        "Conta conectada",
        "A conta DeepAI foi conectada ao proxy. Você pode fechar esta aba e voltar ao painel.",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha ao concluir login.";
      const status = error instanceof DeepAIError ? error.status : 500;
      this.sendCallbackHtml(res, status >= 400 && status < 600 ? status : 500, "Falha no login", message);
    }
  }

  async finish(id, { code, state }) {
    const record = this.records.get(String(id));
    if (!record) throw new DeepAIError("Login não encontrado.", 404, "login_not_found");
    if (record.busy) return;
    if (record.status !== "pending") return;

    if (!code || !state || !sameSecret(state, record.state)) {
      record.status = "failed";
      record.error = "Callback inválido: state não confere.";
      record.updatedAt = Date.now();
      this.close(id);
      throw new DeepAIError(record.error, 400, "invalid_state");
    }

    record.busy = true;
    try {
      const exchanged = await exchangeCode({ code, codeVerifier: record.codeVerifier });
      const account = await this.onComplete?.(record, exchanged);
      record.status = "connected";
      record.account = account ? this.publicAccount(account) : null;
      record.error = null;
      record.updatedAt = Date.now();
      this.close(id);
    } catch (error) {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : "Falha ao concluir login.";
      record.updatedAt = Date.now();
      this.close(id);
      throw error;
    } finally {
      record.busy = false;
    }
  }

  expire(id) {
    const record = this.records.get(String(id));
    if (!record || (record.status !== "pending" && record.status !== "starting")) return;
    record.status = "expired";
    record.error = "Login expirado. Gere outro link.";
    record.updatedAt = Date.now();
    this.close(id);
  }

  close(id) {
    const record = this.records.get(String(id));
    const timer = this.timers.get(String(id));
    if (timer) clearTimeout(timer);
    this.timers.delete(String(id));
    if (record?.server) {
      try {
        record.server.close();
      } catch {
        // ignore
      }
      record.server = null;
    }
  }

  closeAll() {
    for (const id of this.records.keys()) this.close(id);
  }

  publicAccount(account) {
    return {
      id: account.id,
      label: account.label,
      username: account.username ?? null,
      isPro: Boolean(account.isPro),
      keyPreview: account.keyPreview ?? null,
      keyLast4: account.keyLast4 ?? null,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      enabled: account.enabled !== false,
      active: Boolean(account.active),
    };
  }

  publicRecord(record) {
    return {
      id: record.id,
      label: record.label,
      status: record.status,
      url: record.url,
      port: record.port,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      expiresAt: record.expiresAt,
      error: record.error,
      account: record.account,
    };
  }

  sendCallbackHtml(res, status, title, message) {
    const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #060d1a; color: #e2e8f0; display: grid; place-items: center; min-height: 100vh; margin: 0; }
    main { width: min(560px, calc(100vw - 32px)); background: rgba(17,34,64,.75); border: 1px solid rgba(59,130,246,.28); border-radius: 20px; padding: 28px; box-shadow: 0 20px 80px rgba(0,0,0,.55); }
    h1 { margin: 0 0 10px; font-size: 26px; }
    p { margin: 0; line-height: 1.6; color: rgba(226,232,240,.82); }
    .ok { color: #38bdf8; }
    .bad { color: #f87171; }
  </style>
</head>
<body>
  <main>
    <h1 class="${status >= 200 && status < 300 ? "ok" : "bad"}">${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </main>
</body>
</html>`;
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    });
    res.end(html);
  }
}
