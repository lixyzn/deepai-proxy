import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LoginManager } from "./auth.mjs";
import { AccountStore } from "./store.mjs";
import { ConfigStore } from "./config.mjs";
import { verifyAccount } from "./deepai.mjs";
import { MetricsStore } from "./metrics.mjs";
import {
  getCatalogInfo,
  listDashboardModels,
  listOpenAiModels,
  refreshModels,
  startModelsWatcher,
} from "./models.mjs";
import { createChatCompletionsHandler } from "./proxy.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, X-Session-Affinity");
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  setCorsHeaders(res);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

async function readBody(req, limitBytes = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      const err = new Error("Body too large");
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return "";
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("Invalid JSON body");
    err.status = 400;
    throw err;
  }
}

function methodNotAllowed(res, allowed) {
  res.setHeader("Allow", allowed.join(", "));
  json(res, 405, { ok: false, error: "method_not_allowed", allowed });
}

async function serveStatic(res, relativePath) {
  const safePath = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
  const fullPath = path.resolve(PUBLIC_DIR, safePath);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    json(res, 403, { ok: false, error: "forbidden" });
    return;
  }
  try {
    const content = await fs.readFile(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Content-Length": content.length,
      "Cache-Control": "no-store",
    });
    res.end(content);
  } catch (err) {
    if (err?.code === "ENOENT") {
      json(res, 404, { ok: false, error: "not_found" });
      return;
    }
    json(res, 500, { ok: false, error: "static_error", detail: String(err?.message || err) });
  }
}

export async function startServer({
  port = Number(process.env.PORT || 8787),
  host = process.env.HOST || "::",
  logger = console,
  accountsFile,
  configFile,
  metricsFile,
  upstreamBaseUrl = null,
  fetchImpl = fetch,
} = {}) {
  const store = new AccountStore({
    logger,
    ...(accountsFile ? { filePath: accountsFile } : {}),
  });
  const configStore = new ConfigStore({
    logger,
    ...(configFile ? { filePath: configFile } : {}),
  });
  const metricsStore = new MetricsStore({
    logger,
    ...(metricsFile ? { filePath: metricsFile } : {}),
  });

  await Promise.all([store.init(), configStore.init(), metricsStore.init()]);

  startModelsWatcher({ logger });

  let lastError = null;
  let lastSavedAccount = null;

  const loginManager = new LoginManager({
    logger,
    onComplete: async (record, exchanged) => {
      try {
        const apiKey = exchanged?.apiKey || exchanged?.api_key || exchanged?.raw?.api_key || "";
        const username = exchanged?.username || exchanged?.raw?.username || null;
        const isPro = Boolean(exchanged?.isPro ?? exchanged?.is_pro ?? exchanged?.raw?.is_pro);
        const tokens = {
          apiKey,
          accessToken: apiKey || exchanged?.accessToken || exchanged?.access_token,
          refreshToken: exchanged?.refreshToken || exchanged?.refresh_token,
          expiresAt: exchanged?.expiresAt || exchanged?.expires_at,
          username,
          isPro,
          connectToken: exchanged?.connectToken || exchanged?.connect_token || null,
          connectExpiresAt: exchanged?.connectExpiresAt || exchanged?.connect_expires_at || null,
          raw: exchanged?.raw ?? exchanged,
        };
        const label = record?.label || username || undefined;
        const account = await store.saveFromTokens(tokens, { label, makeActive: true });
        lastSavedAccount = account;
        lastError = null;
        logger.log?.("[auth] account connected", account?.id || "");
      } catch (err) {
        lastError = String(err?.message || err);
        logger.error?.("[auth] failed to persist account", err);
        throw err;
      }
    },
  });

  const handleChatCompletions = createChatCompletionsHandler({
    accountStore: store,
    configStore,
    metricsStore,
    logger,
    upstreamBaseUrl,
    fetchImpl,
  });

  function authStatus() {
    const records = loginManager.list();
    const pending =
      records
        .filter((r) => r.status === "pending")
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0] || null;
    const active = store.getActive ? store.getActive() : null;
    const activeAccountId = active?.id || null;
    const errorRecord =
      records
        .filter((r) => r.status === "failed" || r.status === "error")
        .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))[0] || null;
    return {
      pending: !!pending,
      loginId: pending?.id || null,
      loginUrl: pending?.url || null,
      url: pending?.url || null,
      expiresAt: pending?.expiresAt || null,
      activeAccountId,
      lastError: lastError || errorRecord?.error || null,
      savedAccount: lastSavedAccount
        ? { id: lastSavedAccount.id, label: lastSavedAccount.label, isPro: Boolean(lastSavedAccount.isPro) }
        : null,
    };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const hostHeader = req.headers.host || "localhost";
      const url = new URL(req.url || "/", `http://${hostHeader}`);
      const rawPath = (url.pathname || "/").replace(/\/+/g, "/");
      const pathname = rawPath.length > 1 ? rawPath.replace(/\/+$/, "") : rawPath;
      const method = (req.method || "GET").toUpperCase();

      if (method === "OPTIONS") {
        setCorsHeaders(res);
        res.writeHead(204);
        res.end();
        return;
      }

      // Callback from DeepAI desktop auth
      if (pathname === "/auth/callback" || pathname === "/auth-callback" || pathname === "/callback") {
        const handled = await loginManager.handleMainServerCallback(req, res);
        if (handled) return;
      }

      // ---- Static UI ----
      if (method === "GET") {
        if (pathname === "/" || pathname === "/ui" || pathname === "/ui/") {
          await serveStatic(res, "index.html");
          return;
        }
        if (pathname === "/styles.css" || pathname === "/app.js" || pathname === "/favicon.ico") {
          await serveStatic(res, pathname.slice(1));
          return;
        }
        if (pathname.startsWith("/logos/") && pathname.endsWith(".svg")) {
          await serveStatic(res, pathname.slice(1));
          return;
        }
      }

      // ---- Health ----
      if (pathname === "/healthz" || pathname === "/api/health") {
        if (method !== "GET") return methodNotAllowed(res, ["GET"]);
        const accountsData = await store.list();
        const enabledCount = accountsData.accounts.filter((a) => a.enabled).length;
        json(res, 200, {
          ok: true,
          status: "healthy",
          uptimeSec: Math.floor(process.uptime()),
          accounts: {
            total: accountsData.accounts.length,
            enabled: enabledCount,
            activeAccountId: accountsData.activeAccountId,
          },
        });
        return;
      }

      // ---- OpenAI Compatible Proxy ----
      if (pathname === "/v1/models" || pathname === "/models") {
        if (method !== "GET") return methodNotAllowed(res, ["GET"]);
        json(res, 200, listOpenAiModels());
        return;
      }

      if (pathname === "/v1/chat/completions" || pathname === "/chat/completions") {
        if (method !== "POST") return methodNotAllowed(res, ["POST"]);
        const body = await readJsonBody(req);
        await handleChatCompletions(req, res, body);
        return;
      }

      // ---- Models & Metrics & Config API ----
      if (pathname === "/api/models") {
        if (method !== "GET") return methodNotAllowed(res, ["GET"]);
        const tier = url.searchParams.get("tier") || "all";
        const search = url.searchParams.get("search") || "";
        json(res, 200, {
          ok: true,
          catalog: getCatalogInfo(),
          ...listDashboardModels({ tier, search }),
        });
        return;
      }

      if (pathname === "/api/models/catalog") {
        if (method !== "GET") return methodNotAllowed(res, ["GET"]);
        const result = refreshModels({ force: true });
        json(res, 200, { ok: result.ok, result, catalog: getCatalogInfo() });
        return;
      }

      if (pathname === "/api/metrics") {
        if (method !== "GET") return methodNotAllowed(res, ["GET"]);
        const range = url.searchParams.get("range") || "24h";
        const accountsData = await store.list();
        const activeAccountsCount = accountsData.accounts.filter((a) => a.enabled).length;
        const stats = metricsStore.getDashboardStats({ range, activeAccountsCount });
        json(res, 200, { ok: true, ...stats });
        return;
      }

      if (pathname === "/api/metrics/reset") {
        if (method !== "POST") return methodNotAllowed(res, ["POST"]);
        const result = await metricsStore.reset();
        json(res, 200, result);
        return;
      }

      if (pathname === "/api/config") {
        if (method === "GET") {
          const config = await configStore.get();
          json(res, 200, { ok: true, config });
          return;
        }
        if (method === "PUT") {
          const body = await readJsonBody(req);
          const config = await configStore.update(body);
          json(res, 200, { ok: true, config });
          return;
        }
        return methodNotAllowed(res, ["GET", "PUT"]);
      }

      if (pathname === "/api/config/rotate-key") {
        if (method !== "POST") return methodNotAllowed(res, ["POST"]);
        const config = await configStore.rotateKey();
        json(res, 200, { ok: true, config });
        return;
      }

      // ---- Auth ----
      if (pathname === "/api/auth/status") {
        if (method !== "GET") return methodNotAllowed(res, ["GET"]);
        json(res, 200, { ok: true, auth: authStatus() });
        return;
      }

      if (pathname === "/api/auth/login") {
        if (method !== "POST") return methodNotAllowed(res, ["POST"]);
        const body = await readJsonBody(req).catch(() => ({}));
        const label = typeof body?.label === "string" ? body.label : undefined;
        const record = await loginManager.start({ label });
        lastError = null;
        json(res, 200, {
          ok: true,
          auth: authStatus(),
          login: { id: record.id, loginUrl: record.url, url: record.url, port: record.port, expiresAt: record.expiresAt },
        });
        return;
      }

      if (pathname === "/api/auth/cancel") {
        if (method !== "POST") return methodNotAllowed(res, ["POST"]);
        const body = await readJsonBody(req).catch(() => ({}));
        const id = body?.id || body?.loginId;
        if (id) {
          loginManager.cancel(String(id));
        } else {
          for (const r of loginManager.list()) {
            if (r.status === "pending") loginManager.cancel(r.id);
          }
        }
        json(res, 200, { ok: true, auth: authStatus() });
        return;
      }

      if (pathname === "/api/auth/submit") {
        if (method !== "POST") return methodNotAllowed(res, ["POST"]);
        const body = await readJsonBody(req).catch(() => ({}));
        const result = await loginManager.completeManually({
          loginId: body?.loginId || body?.id,
          code: body?.code,
          state: body?.state,
          codeVerifier: body?.codeVerifier,
          callbackUrl: body?.callbackUrl || body?.url,
          error: body?.error,
          errorDescription: body?.errorDescription || body?.error_description,
        });
        json(res, 200, { ok: true, result, auth: authStatus() });
        return;
      }

      // ---- Accounts ----
      if (pathname === "/api/accounts") {
        if (method !== "GET") return methodNotAllowed(res, ["GET"]);
        const data = await store.list();
        json(res, 200, { ok: true, ...data });
        return;
      }

      if (pathname === "/api/accounts/active") {
        if (method !== "GET") return methodNotAllowed(res, ["GET"]);
        const active = store.getActive ? store.getActive() : null;
        json(res, 200, { ok: true, active });
        return;
      }

      if (pathname === "/api/accounts/select") {
        if (method !== "POST") return methodNotAllowed(res, ["POST"]);
        const body = await readJsonBody(req);
        const id = String(body?.id || "").trim();
        if (!id) return json(res, 400, { ok: false, error: "missing_id" });
        const active = await store.setActive(id);
        json(res, 200, { ok: true, active });
        return;
      }

      if (pathname === "/api/accounts/import-key") {
        if (method !== "POST") return methodNotAllowed(res, ["POST"]);
        const body = await readJsonBody(req);
        const apiKey = String(body?.apiKey || body?.api_key || body?.key || "").trim();
        const label = typeof body?.label === "string" ? body.label : undefined;
        const username = typeof body?.username === "string" ? body.username : null;
        const isPro = Boolean(body?.isPro ?? body?.is_pro);
        if (!apiKey) return json(res, 400, { ok: false, error: "missing_api_key" });
        const account = await store.importApiKey(apiKey, { label, username, isPro, makeActive: true });
        json(res, 200, { ok: true, account });
        return;
      }

      if (pathname === "/api/accounts/import-cookie") {
        if (method !== "POST") return methodNotAllowed(res, ["POST"]);
        const body = await readJsonBody(req);
        const cookie = String(body?.cookie || "").trim();
        const label = typeof body?.label === "string" ? body.label : undefined;
        if (!cookie) return json(res, 400, { ok: false, error: "missing_cookie" });
        const account = await store.importCookie(cookie, { label, makeActive: true });
        json(res, 200, { ok: true, account });
        return;
      }

      // /api/accounts/:id/test (POST)
      {
        const m = pathname.match(/^\/api\/accounts\/([^/]+)\/test$/);
        if (m) {
          if (method !== "POST") return methodNotAllowed(res, ["POST"]);
          const id = decodeURIComponent(m[1]);
          const rawAccount = store.getRawById(id);
          if (!rawAccount) return json(res, 404, { ok: false, error: "account_not_found" });

          const result = await verifyAccount(rawAccount, { fetchImpl });
          let updatedAccount = store.getById(id);
          if (result.ok) {
            updatedAccount = await store.updateMetadata(id, { isPro: Boolean(result.isPro) });
          } else {
            await store.recordUsage(id, {
              ok: false,
              status: result.status || 401,
              error: result.error || "Falha na verificação",
            });
            updatedAccount = store.getById(id);
          }
          json(res, 200, { ok: true, result, account: updatedAccount });
          return;
        }
      }

      // /api/accounts/:id (DELETE & PATCH)
      {
        const m = pathname.match(/^\/api\/accounts\/([^/]+)$/);
        if (m) {
          const id = decodeURIComponent(m[1]);
          if (method === "DELETE") {
            const result = await store.remove(id);
            json(res, 200, { ok: true, ...result });
            return;
          }
          if (method === "PATCH") {
            const body = await readJsonBody(req);
            let account = null;
            if (typeof body?.label === "string") {
              account = await store.rename(id, body.label);
            }
            if (typeof body?.enabled === "boolean") {
              account = await store.toggleEnabled(id, body.enabled);
            }
            if (!account) {
              return json(res, 400, { ok: false, error: "nothing_to_update" });
            }
            json(res, 200, { ok: true, account });
            return;
          }
          return methodNotAllowed(res, ["DELETE", "PATCH"]);
        }
      }

      json(res, 404, { ok: false, error: "not_found" });
    } catch (err) {
      logger.error?.("[server] request error", err);
      json(res, err?.status || 500, {
        ok: false,
        error: err?.code || "internal_error",
        detail: String(err?.message || err),
      });
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      if (host === "::" && (err?.code === "EAFNOSUPPORT" || err?.code === "EADDRNOTAVAIL")) {
        server.listen(port, "0.0.0.0", () => {
          resolve();
        });
        return;
      }
      reject(err);
    };
    server.once("error", onError);
    if (host === "::") {
      server.listen({ port, host: "::", ipv6Only: false }, () => {
        server.off("error", onError);
        resolve();
      });
    } else {
      server.listen(port, host, () => {
        server.off("error", onError);
        resolve();
      });
    }
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const displayHost = host === "::" || host === "0.0.0.0" ? "localhost" : host;
  logger.log?.(`[server] listening on http://${displayHost}:${actualPort} (bind: ${host})`);

  return {
    server,
    port: actualPort,
    host,
    store,
    configStore,
    metricsStore,
    loginManager,
    async close() {
      try {
        await loginManager.closeAll();
      } catch {
        // ignore
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
