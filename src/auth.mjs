import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import {
  DEEPAI_ORIGIN,
  DeepAIError,
  exchangeCode,
} from "./deepai.mjs";

const LOGIN_TTL_MS = 10 * 60 * 1000;

function sameSecret(a, b) {
  const left = createHash("sha256").update(String(a)).digest();
  const right = createHash("sha256").update(String(b)).digest();
  return left.equals(right);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char];
  });
}

function page({ title, heading, message, tone = "success", username = "" }) {
  const accent = tone === "error" ? "#fb7185" : "#a855f7";
  const symbol = tone === "error" ? "!" : "✓";
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · DeepAI Proxy</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #f5f2ff; background: #050209; overflow: hidden;
  }
  body::before, body::after {
    content: ""; position: fixed; border-radius: 999px; filter: blur(110px); opacity: .55;
    pointer-events: none;
  }
  body::before { width: 520px; height: 520px; background: #7c3aed; top: -160px; left: -120px; }
  body::after { width: 460px; height: 460px; background: #c026d3; bottom: -180px; right: -100px; opacity: .35; }
  .card {
    position: relative; width: min(520px, 100%); padding: 44px 40px 38px; text-align: center;
    border-radius: 28px; border: 1px solid rgba(192, 132, 252, .24);
    background: linear-gradient(155deg, rgba(34, 20, 54, .82), rgba(9, 4, 18, .92));
    box-shadow: 0 30px 90px rgba(0, 0, 0, .65), inset 0 1px 0 rgba(255, 255, 255, .07);
    backdrop-filter: blur(24px) saturate(150%);
  }
  .mark {
    width: 72px; height: 72px; margin: 0 auto 22px; display: grid; place-items: center;
    border-radius: 24px; font-size: 34px; font-weight: 700; color: #fff;
    background: linear-gradient(145deg, ${accent}, #6d28d9);
    box-shadow: 0 0 0 1px rgba(255,255,255,.16) inset, 0 16px 40px ${accent}55;
  }
  .brand { font-size: 12px; letter-spacing: .22em; text-transform: uppercase; color: #c4b5fd; margin-bottom: 12px; }
  h1 { margin: 0 0 12px; font-size: clamp(26px, 5vw, 34px); letter-spacing: -0.03em; }
  p { margin: 0; color: #b8aecf; line-height: 1.65; font-size: 15px; }
  .user {
    display: inline-flex; margin-top: 20px; padding: 8px 16px; border-radius: 999px;
    background: rgba(168, 85, 247, .12); border: 1px solid rgba(168, 85, 247, .28);
    color: #e9d5ff; font-family: ui-monospace, monospace; font-size: 13px;
  }
  .foot { margin-top: 28px; padding-top: 20px; border-top: 1px solid rgba(255,255,255,.07); font-size: 12.5px; color: #7d7192; }
  a { color: #c4b5fd; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <main class="card">
    <div class="mark">${symbol}</div>
    <div class="brand">DeepAI Proxy</div>
    <h1>${escapeHtml(heading)}</h1>
    <p>${escapeHtml(message)}</p>
    ${username ? `<div class="user">@${escapeHtml(username)}</div>` : ""}
    <div class="foot">Pode fechar esta aba e voltar para o painel.</div>
  </main>
</body>
</html>`;
}

export class LoginManager {
  constructor({ onAccount }) {
    this.onAccount = onAccount;
    this.logins = new Map();
    this.closed = false;
  }

  async start() {
    if (this.closed) throw new Error("Gerenciador de login encerrado.");
    const id = `login_${randomBytes(8).toString("hex")}`;
    const state = randomBytes(32).toString("hex");
    const record = {
      id,
      state,
      status: "pending",
      error: null,
      account: null,
      createdAt: Date.now(),
      expiresAt: Date.now() + LOGIN_TTL_MS,
      server: null,
      port: null,
      busy: false,
      timer: null,
    };

    const server = http.createServer((req, res) => {
      this.#handleCallback(record, req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        }
        res.end("Falha inesperada no callback de login.");
      });
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    record.server = server;
    record.port = server.address().port;
    record.timer = setTimeout(() => this.#expire(record), LOGIN_TTL_MS);
    record.timer.unref?.();
    this.logins.set(id, record);

    const url = new URL(`${DEEPAI_ORIGIN}/deepai_code/desktop_auth/`);
    url.searchParams.set("state", state);
    url.searchParams.set("port", String(record.port));

    return {
      loginId: id,
      url: url.href,
      expiresAt: new Date(record.expiresAt).toISOString(),
    };
  }

  status(id) {
    const record = this.logins.get(id);
    if (!record) return null;
    if (record.status === "pending" && Date.now() > record.expiresAt) {
      this.#expire(record);
    }
    return this.#publicStatus(record);
  }

  async completeManually(id, input) {
    const record = this.logins.get(id);
    if (!record) throw new Error("Este login não existe mais. Gere um novo link.");
    if (record.status === "complete") return this.#publicStatus(record);
    if (record.status === "expired") throw new Error("O link expirou. Gere um novo.");
    if (record.busy) throw new Error("Este login já está sendo concluído.");
    if (Date.now() > record.expiresAt) {
      this.#expire(record);
      throw new Error("O link expirou. Gere um novo.");
    }

    const parsed = this.#parseCallbackInput(input);
    if (parsed.state && !sameSecret(parsed.state, record.state)) {
      throw new Error("O state do callback não confere com este login.");
    }

    return this.#exchange(record, parsed.code);
  }

  cancel(id) {
    const record = this.logins.get(id);
    if (!record) return false;
    if (record.status === "complete") return false;
    record.status = "cancelled";
    this.#closeServer(record);
    clearTimeout(record.timer);
    return true;
  }

  closeAll() {
    this.closed = true;
    for (const record of this.logins.values()) {
      clearTimeout(record.timer);
      this.#closeServer(record);
    }
    this.logins.clear();
  }

  #publicStatus(record) {
    return {
      loginId: record.id,
      status: record.status,
      error: record.error,
      account: record.account,
      expiresAt: new Date(record.expiresAt).toISOString(),
    };
  }

  #expire(record) {
    if (record.status === "complete" || record.status === "cancelled") return;
    record.status = "expired";
    record.error = "O link expirou. Gere um novo.";
    this.#closeServer(record);
    clearTimeout(record.timer);
  }

  #closeServer(record) {
    if (!record.server) return;
    try {
      record.server.close();
    } catch {
      // já fechado
    }
    record.server = null;
  }

  #parseCallbackInput(input) {
    const raw = String(input ?? "").trim();
    if (!raw) throw new Error("Cole o código ou a URL de retorno.");
    if (/^https?:\/\//i.test(raw)) {
      let url;
      try {
        url = new URL(raw);
      } catch {
        throw new Error("A URL de retorno é inválida.");
      }
      const code = url.searchParams.get("code");
      if (!code) throw new Error("A URL não contém um parâmetro code.");
      if (code.length > 4096) throw new Error("O código é grande demais.");
      return { code, state: url.searchParams.get("state") ?? "" };
    }
    if (raw.length > 4096) throw new Error("O código é grande demais.");
    return { code: raw, state: "" };
  }

  async #handleCallback(record, req, res) {
    let url;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      this.#sendPage(res, 400, {
        tone: "error",
        heading: "Callback inválido",
        message: "A URL de retorno não pôde ser lida.",
      });
      return;
    }

    if (req.method !== "GET" || url.pathname !== "/auth-callback") {
      this.#sendPage(res, 404, {
        tone: "error",
        heading: "Rota não encontrada",
        message: "Esta porta é usada apenas pelo callback de login.",
      });
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? "";
    if (!code || code.length > 4096 || !sameSecret(state, record.state)) {
      this.#sendPage(res, 400, {
        tone: "error",
        heading: "Link inválido",
        message:
          "O state não confere com este login. Gere um novo link no painel e tente outra vez.",
      });
      return;
    }

    if (record.status === "complete") {
      this.#sendPage(res, 200, {
        heading: "Conta já conectada",
        message: "Este login já foi concluído. Volte ao painel.",
        username: record.account?.username,
      });
      return;
    }

    if (record.busy) {
      this.#sendPage(res, 200, {
        heading: "Concluindo login",
        message: "Aguarde só um instante enquanto salvamos a conta.",
      });
      return;
    }

    try {
      const status = await this.#exchange(record, code);
      if (status.status === "complete") {
        this.#sendPage(res, 200, {
          heading: "Conta conectada",
          message: "Login aprovado e credencial salva com segurança.",
          username: status.account?.username,
        });
      } else {
        this.#sendPage(res, 400, {
          tone: "error",
          heading: "Não foi possível concluir",
          message: status.error || "Tente gerar um novo link.",
        });
      }
    } catch (error) {
      this.#sendPage(res, 400, {
        tone: "error",
        heading: "Não foi possível concluir",
        message: error instanceof Error ? error.message : "Erro inesperado.",
      });
    }
  }

  async #exchange(record, code) {
    record.busy = true;
    record.status = "exchanging";
    record.error = null;
    try {
      const credentials = await exchangeCode(code);
      const account = await this.onAccount(credentials);
      record.account = account;
      record.status = "complete";
      record.busy = false;
      clearTimeout(record.timer);
      this.#closeServer(record);
      return this.#publicStatus(record);
    } catch (error) {
      record.busy = false;
      record.status = "pending";
      record.error =
        error instanceof DeepAIError || error instanceof Error
          ? error.message
          : "Falha ao concluir o login.";
      throw error;
    }
  }

  #sendPage(res, status, options) {
    const html = page({
      title: options.heading,
      heading: options.heading,
      message: options.message,
      tone: options.tone,
      username: options.username,
    });
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    });
    res.end(html);
  }
}
