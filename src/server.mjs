import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCb, spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveModelAlias } from "./aliases.mjs";
import { LoginManager } from "./auth.mjs";
import { normalizeChatPayload } from "./compat.mjs";
import { modelMeta } from "./model-meta.mjs";
import { applyCacheIdentity } from "./context.mjs";
import {
  ConversationStore,
  estimatePayloadOverheadTokens,
  prepareUpstreamMessages,
} from "./conversations.mjs";
import { Telemetry } from "./telemetry.mjs";
import {
  checkIn,
  DeepAIError,
  fetchModels,
  fetchUsageSummary,
  forwardModelRequest,
  normalizeAllowance,
  normalizeUsageSummary,
  transcribeAudio,
} from "./deepai.mjs";
import {
  accountSecret,
  DATA_DIR,
  deleteAccount,
  getAccount,
  getActiveAccount,
  isAdminInitialized,
  listAccounts,
  loadConfig,
  publicAccount,
  publicAccounts,
  resetAdminPassword,
  rotateProxyToken,
  setActiveAccount,
  setAdminPassword,
  touchAllowance,
  touchCheckIn,
  touchEntitlement,
  upsertAccount,
  verifyAdminPassword,
} from "./store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8790);
const VERSION = "0.3.0";
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const CHECK_IN_INTERVAL_MS = 10 * 60 * 1000;
// Upstream timeouts matching DeepAI Code Desktop official:
// - Idle timeout: 330s (reset on each SSE chunk)
// - Total timeout: 930s (hard limit)
const DEEPAI_IDLE_TIMEOUT_MS = 330_000;
const DEEPAI_TOTAL_TIMEOUT_MS = 930_000;
const UPSTREAM_TIMEOUT_MS = DEEPAI_TOTAL_TIMEOUT_MS;

const execFile = promisify(execFileCb);
const UPDATE_REPO = process.env.DEEPAI_UPDATE_REPO || "lixyzn/deepai-proxy";
const UPDATE_BRANCH = process.env.DEEPAI_UPDATE_BRANCH || "main";
const UPDATE_CHECK_TTL_MS = 30 * 60 * 1000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
let updateCache = { checkedAt: 0, data: null, error: null, promise: null };
let updateApplying = false;

function normalizeVersion(v) {
  return String(v || "").trim().replace(/^v/i, "");
}

function versionParts(v) {
  const clean = normalizeVersion(v).split("-")[0];
  return clean
    .split(".")
    .map((n) => Number.parseInt(n, 10))
    .map((n) => (Number.isFinite(n) && n >= 0 ? n : 0));
}

function compareVersions(a, b) {
  const aa = versionParts(a);
  const bb = versionParts(b);
  const len = Math.max(aa.length, bb.length, 3);
  for (let i = 0; i < len; i += 1) {
    const da = aa[i] || 0;
    const db = bb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

async function fetchLatestUpdate() {
  const repo = UPDATE_REPO;
  const headers = {
    "User-Agent": "deepai-proxy-updater",
    Accept: "application/vnd.github+json",
  };

  try {
    const relRes = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers,
      signal: AbortSignal.timeout(12_000),
    });
    if (relRes.ok) {
      const rel = await relRes.json();
      const version = normalizeVersion(rel.tag_name || rel.name || "");
      if (version) {
        return {
          version,
          name: rel.name || rel.tag_name || `v${version}`,
          notes: String(rel.body || "").slice(0, 4000),
          url: rel.html_url || `https://github.com/${repo}/releases`,
          publishedAt: rel.published_at || null,
          source: "release",
        };
      }
    }
  } catch {
    // fallback to raw package.json
  }

  const pkgRes = await fetch(
    `https://raw.githubusercontent.com/${repo}/${UPDATE_BRANCH}/package.json`,
    {
      headers: { "User-Agent": "deepai-proxy-updater" },
      signal: AbortSignal.timeout(12_000),
    },
  );
  if (!pkgRes.ok) {
    throw new Error(`Não foi possível consultar atualização no GitHub (${pkgRes.status}).`);
  }
  const pkg = await pkgRes.json();
  const version = normalizeVersion(pkg?.version);
  if (!version) throw new Error("Versão remota não encontrada no package.json.");
  return {
    version,
    name: `v${version}`,
    notes: "",
    url: `https://github.com/${repo}`,
    publishedAt: null,
    source: "package",
  };
}

async function checkForUpdates({ force = false } = {}) {
  const now = Date.now();
  if (!force && updateCache.data && now - updateCache.checkedAt < UPDATE_CHECK_TTL_MS) {
    return updateCache.data;
  }
  if (updateCache.promise) return updateCache.promise;

  updateCache.promise = (async () => {
    try {
      const latest = await fetchLatestUpdate();
      const current = normalizeVersion(VERSION);
      const latestVersion = normalizeVersion(latest.version);
      const hasUpdate = compareVersions(latestVersion, current) > 0;
      const data = {
        ok: true,
        currentVersion: current,
        latestVersion,
        hasUpdate,
        repo: UPDATE_REPO,
        branch: UPDATE_BRANCH,
        release: latest,
        checkedAt: new Date().toISOString(),
      };
      updateCache = { checkedAt: Date.now(), data, error: null, promise: null };
      return data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const data = {
        ok: false,
        currentVersion: normalizeVersion(VERSION),
        latestVersion: null,
        hasUpdate: false,
        repo: UPDATE_REPO,
        branch: UPDATE_BRANCH,
        error: message,
        checkedAt: new Date().toISOString(),
      };
      updateCache = {
        checkedAt: Date.now() - (UPDATE_CHECK_TTL_MS - 60_000),
        data,
        error: message,
        promise: null,
      };
      return data;
    }
  })();

  return updateCache.promise;
}

async function runGit(args, opts = {}) {
  return execFile("git", args, {
    cwd: ROOT,
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    ...opts,
  });
}

async function applyUpdate() {
  if (updateApplying) {
    const err = new Error("Uma atualização já está em andamento.");
    err.status = 409;
    throw err;
  }
  updateApplying = true;
  try {
    try {
      await runGit(["rev-parse", "--is-inside-work-tree"]);
    } catch {
      throw new Error("O proxy não está rodando dentro de um repositório git. Atualize manualmente com git pull/atualizador do seu ambiente.");
    }

    try {
      await runGit(["diff", "--quiet"]);
      await runGit(["diff", "--cached", "--quiet"]);
    } catch {
      throw new Error("Há alterações locais no repositório do proxy. Faça commit/stash ou atualize manualmente antes de usar o botão de atualizar.");
    }

    try {
      await runGit(["fetch", "--tags", "origin", UPDATE_BRANCH, "--prune", "--depth", "50"]);
    } catch {
      try {
        await runGit(["fetch", "origin", UPDATE_BRANCH]);
      } catch (e2) {
        throw new Error(`Falha ao buscar atualizações do remote origin: ${String(e2?.message || e2)}. Verifique internet/acesso ao GitHub.`);
      }
    }

    const info = await fetchLatestUpdate();
    const current = getCurrentVersion();

    if (isVersionOutdated(current, info.latestVersion)) {
      const ref = info.releaseTag || `v${info.latestVersion}`;
      try {
        await runGit(["checkout", ref, "--detach"]);
      } catch (e) {
        const msg = String(e?.message || e || "");
        if (msg.includes("not found") || msg.toLowerCase().includes("pathspec") || msg.includes("did not match")) {
          throw new Error(`Tag '${ref}' não encontrada após fetch. Verifique a release e DEEPAI_UPDATE_REPO.`);
        }
        throw new Error(`Falha ao fazer checkout da tag '${ref}': ${msg}`);
      }
    } else {
      const branchExists = await gitRefExists(`refs/heads/${UPDATE_BRANCH}`);
      if (!branchExists) {
        throw new Error(`Branch '${UPDATE_BRANCH}' não existe localmente no checkout atual.`);
      }
      try {
        await runGit(["checkout", UPDATE_BRANCH]);
      } catch (e) {
        throw new Error(`Não foi possível alternar para a branch '${UPDATE_BRANCH}': ${String(e?.message || e)}`);
      }
      try {
        await runGit(["pull", "--ff-only", "origin", UPDATE_BRANCH]);
      } catch (e) {
        const msg = String(e?.message || e || "");
        throw new Error(`git pull --ff-only falhou: ${msg}. Faça git pull manual na pasta do projeto.`);
      }
    }

    try {
      await runCommandInProxyRoot(getInstallCommand());
    } catch (e) {
      throw new Error(`Arquivos atualizados, mas falhou ao instalar dependências: ${String(e?.message || e)}`);
    }

    updateCache = { checkedAt: 0, data: null, error: null, promise: null };
    const startCommand = buildStartCommand();

    return {
      ok: true,
      currentVersion: current,
      latestVersion: normalizeVersion(info.latestVersion),
      releaseUrl: info.releaseUrl,
      releaseTag: info.releaseTag || null,
      notes: "",
      publishedAt: info.publishedAt || null,
      installedAt: info.installedAt || new Date().toISOString(),
      releaseName: info.releaseName || null,
      updated: true,
      restartRequired: true,
      nextStep: "Reinicie o proxy na pasta do projeto para usar a versão atualizada.",
      startCommand,
      hint: "Se o processo foi iniciado por pnpm start/npm start/arquivo .bat, pare e suba de novo nesse mesmo contexto.",
    };
  } catch (e) {
    throw e;
  } finally {
    updateApplying = false;
  }
}
function scheduleRestart(delayMs = 1500) {
  setTimeout(() => {
    server.close(() => {
      const child = spawn(process.execPath, process.argv.slice(1), {
        cwd: ROOT,
        detached: true,
        stdio: "ignore",
        env: process.env,
        windowsHide: true,
      });
      child.unref();
      setTimeout(() => process.exit(0), 500);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  }, delayMs);
}

const config = loadConfig();
const telemetry = new Telemetry();
const conversations = new ConversationStore();

function sameSecret(a, b) {
  const left = createHash("sha256").update(String(a)).digest();
  const right = createHash("sha256").update(String(b)).digest();
  return left.equals(right);
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(body);
}

function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: message, ...extra });
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("Corpo da requisição grande demais.");
      error.status = 413;
      throw error;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const raw = await readBody(req, limit);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    const error = new Error("JSON inválido.");
    error.status = 400;
    throw error;
  }
}

const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BLOCK_AFTER_FAILURES = 5;
const BLOCK_MS = 30 * 1000;
const adminSessions = new Map();
const loginFailures = new Map();

function sessionTokenFrom(req) {
  const authorization = req.headers.authorization ?? "";
  if (authorization.startsWith("Bearer ")) return authorization.slice(7).trim();
  return String(req.headers["x-admin-session"] ?? "");
}

function createAdminSession() {
  const token = `ses_${randomBytes(32).toString("base64url")}`;
  adminSessions.set(token, { expiresAt: Date.now() + ADMIN_SESSION_TTL_MS });
  return token;
}

function validAdminSession(token) {
  const session = adminSessions.get(token);
  if (!session) return false;
  if (session.expiresAt <= Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

function revokeAdminSession(token) {
  if (token) adminSessions.delete(token);
}

function requireAdmin(req, res) {
  if (validAdminSession(sessionTokenFrom(req))) return true;
  sendError(res, 401, "Sessão expirada. Entre com sua senha novamente.", {
    code: "admin_unauthorized",
  });
  return false;
}

function isLoopbackRequest(req) {
  const raw = String(req.socket.remoteAddress ?? "");
  const address = raw.startsWith("::ffff:") ? raw.slice(7) : raw;
  return address === "127.0.0.1" || address === "::1" || address === "localhost";
}

function loginBlocked(ip) {
  const record = loginFailures.get(ip);
  return Boolean(record?.blockedUntil && record.blockedUntil > Date.now());
}

function noteLoginFailure(ip) {
  const now = Date.now();
  const record = loginFailures.get(ip) ?? { count: 0, blockedUntil: 0 };
  record.count += 1;
  if (record.count >= BLOCK_AFTER_FAILURES) {
    record.count = 0;
    record.blockedUntil = now + BLOCK_MS;
  }
  loginFailures.set(ip, record);
  if (loginFailures.size > 256) {
    for (const [key, value] of loginFailures) {
      if (!value.blockedUntil || value.blockedUntil < now) loginFailures.delete(key);
    }
  }
}

function clearLoginFailures(ip) {
  loginFailures.delete(ip);
}

function proxyTokenFrom(req) {
  const authorization = req.headers.authorization ?? "";
  if (authorization.startsWith("Bearer ")) return authorization.slice(7).trim();
  return String(req.headers["x-api-key"] ?? "");
}

function requireProxy(req, res) {
  if (sameSecret(proxyTokenFrom(req), config.proxyToken)) return true;
  sendError(res, 401, "Token do proxy inválido.", {
    code: "proxy_unauthorized",
  });
  return false;
}

function accountForRequest(req) {
  const requested = String(req.headers["x-deepai-account"] ?? "").trim();
  if (requested) {
    const account = getAccount(requested);
    if (!account) {
      const error = new Error("Conta solicitada não existe.");
      error.status = 404;
      throw error;
    }
    return account;
  }
  return getActiveAccount();
}

const RETRYABLE_UPSTREAM_STATUS = new Set([401, 402, 403, 429]);
const accountCooldownUntil = new Map();

function accountCooling(account) {
  return (accountCooldownUntil.get(account.id) ?? 0) > Date.now();
}

function accountCandidates(account, req) {
  if (String(req.headers["x-deepai-account"] ?? "").trim()) return [account];
  const all = listAccounts();
  const ordered = [account, ...all.filter((item) => item.id !== account.id)];
  const ready = ordered.filter((item) => !accountCooling(item));
  const cooling = ordered.filter((item) => accountCooling(item));
  // Se todas estiverem em cooldown, ainda tenta na ordem original.
  return ready.length ? [...ready, ...cooling] : ordered;
}

function upstreamCode(body) {
  if (!body || typeof body !== "object") return null;
  const value = body.error?.code ?? body.code ?? body.error?.type;
  return typeof value === "string" ? value : null;
}

function markAccountCooldown(account, status, retryAfter, body) {
  const seconds = Number(retryAfter);
  const now = Date.now();
  let wait = status === 401 || status === 403 ? 120_000 : 60_000;

  if (status === 429 && Number.isFinite(seconds) && seconds > 0) {
    wait = Math.min(seconds * 1000, 10 * 60_000);
  } else if (status === 402) {
    const code = upstreamCode(body) ?? "";
    const refreshAt = Date.parse(account.allowance?.refreshAt ?? "");
    // Saldo Theos: não adianta tentar de novo em 60s. A conta só volta
    // quando o grant diário renovar (ou depois de um intervalo conservador).
    if (/theos/i.test(code) && Number.isFinite(refreshAt) && refreshAt > now) {
      wait = Math.min(refreshAt + 30_000 - now, 24 * 60 * 60 * 1000);
    } else {
      wait = 15 * 60_000;
    }
  }
  accountCooldownUntil.set(account.id, now + Math.max(5_000, wait));
}

function clearAccountCooldown(account) {
  accountCooldownUntil.delete(account.id);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      resolve();
    };
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      reject(signal.reason);
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

async function sessionBusy(upstream) {
  if (upstream.status !== 409) return false;
  const body = await upstream
    .clone()
    .json()
    .catch(() => null);
  return upstreamCode(body) === "session_busy";
}

async function upstreamFailure(upstream) {
  const text = await upstream.text().catch(() => "");
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // resposta de erro não JSON
  }
  return new DeepAIError(
    extractUpstreamError(body) ||
      `A DeepAI recusou a requisição (${upstream.status}).`,
    upstream.status,
    body,
  );
}

function publicBaseUrl(req) {
  const host = String(req.headers.host ?? "").trim();
  if (/^[a-zA-Z0-9.\-:[\]]{1,255}$/.test(host)) return `http://${host}`;
  return `http://${HOST}:${PORT}`;
}

const checkInState = new Map();

async function refreshAccountUsage(account, timeoutMs = 10000) {
  const secret = accountSecret(account);
  const entitlementPromise = fetchUsageSummary(secret, {
    signal: AbortSignal.timeout(timeoutMs),
  })
    .then(normalizeUsageSummary)
    .catch(() => null);
  const payload = await checkIn(secret, account.keyHash, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  const entitlement = await entitlementPromise;
  const allowance = normalizeAllowance(payload);
  if (allowance) touchAllowance(account.id, allowance);
  if (entitlement) touchEntitlement(account.id, entitlement);
  touchCheckIn(account.id);
  return {
    account: publicAccount(getAccount(account.id)),
    allowance,
    entitlement,
  };
}

async function ensureCheckIn(account) {
  if (!account) return;
  const last = account.lastCheckInAt ? Date.parse(account.lastCheckInAt) : 0;
  if (Date.now() - last < CHECK_IN_INTERVAL_MS) return;

  const existing = checkInState.get(account.id);
  if (existing) return existing.promise;

  const entry = {};
  entry.promise = (async () => {
    try {
      await refreshAccountUsage(account, 8000);
    } catch (error) {
      console.warn(
        `[check-in] ${account.id}: ${
          error instanceof Error ? error.message : "falhou"
        }`,
      );
    } finally {
      checkInState.delete(account.id);
    }
  })();
  checkInState.set(account.id, entry);
  return entry.promise;
}

const loginManager = new LoginManager({
  onAccount: async (credentials) => {
    const { account } = upsertAccount(credentials);
    ensureCheckIn(account).catch(() => {});
    return publicAccount(account);
  },
});

// Aquece o saldo/check-in das contas já conectadas sem bloquear o start.
for (const account of listAccounts()) {
  ensureCheckIn(account).catch(() => {});
}

const modelCache = new Map();

function theosAmount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    return Number(value);
  }
  return null;
}

function normalizeModelCatalog(payload, account) {
  const models = Array.isArray(payload?.models) ? payload.models : [];
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: models.map((model) => {
      const meta = modelMeta(model.id, model.name);
      const price = theosAmount(model.theosPerRequest);
      const premier = model.premier === true;
      const tier =
        price === 0 ? "free" : price !== null && price > 0 ? "paid" : premier ? "paid" : "unknown";
      const pricing = {
        ...(price === null ? {} : { theos_per_request: price }),
        ...(model.theosPerSecond && typeof model.theosPerSecond === "object"
          ? { theos_per_second: { ...model.theosPerSecond } }
          : {}),
      };
      return {
        id: `deepai/${model.id}`,
        slug: model.id,
        object: "model",
        created,
        owned_by: "deepai",
        name: model.name,
        context_window: model.contextWindow,
        max_output_tokens: model.maxTokens,
        input: model.input,
        reasoning: model.reasoning,
        premier,
        tier,
        family: meta.family,
        provider: meta.label,
        logo: meta.logo,
        color: meta.color,
        free: tier === "free",
        paid: tier === "paid",
        requires_pro: premier,
        ...(Object.keys(pricing).length ? { pricing } : {}),
        ...(model.api ? { api: model.api } : {}),
        ...(account?.isPro === undefined
          ? {}
          : { account_tier: account.isPro ? "pro" : "free" }),
      };
    }),
    default: payload?.default ?? null,
  };
}

async function modelsFor(account, { force = false } = {}) {
  const cached = modelCache.get(account.id);
  if (!force && cached && Date.now() - cached.at < 5 * 60 * 1000) {
    return cached.data;
  }
  try {
    const payload = await fetchModels(accountSecret(account), {
      signal: AbortSignal.timeout(10000),
    });
    const data = normalizeModelCatalog(payload, account);
    modelCache.set(account.id, { at: Date.now(), data });
    return data;
  } catch (error) {
    if (cached) return cached.data;
    throw error;
  }
}

async function catalogForRequest(account, req, options = {}) {
  let lastError = null;
  for (const candidate of accountCandidates(account, req)) {
    try {
      const catalog = await modelsFor(candidate, options);
      return { account: candidate, catalog };
    } catch (error) {
      if (
        error instanceof DeepAIError &&
        RETRYABLE_UPSTREAM_STATUS.has(error.status)
      ) {
        markAccountCooldown(candidate, error.status);
      }
      lastError = error;
    }
  }
  throw lastError ?? new DeepAIError("Nenhuma conta conseguiu listar modelos.", 502);
}

function resolveModelId(account, value) {
  const raw = String(value ?? "").replace(/^deepai\//, "").trim();
  if (!raw) return raw;
  const cached = modelCache.get(account.id);
  if (!cached) return resolveModelAlias(raw, account, cached);
  const lower = raw.toLowerCase();
  const found = cached.data.data.find(
    (model) =>
      model.slug === raw ||
      model.id === value ||
      String(model.name).toLowerCase() === lower,
  );
  if (found) return found.slug;
  // Só usa alias quando o id pedido não existe no catálogo real, para nunca
  // trocar um modelo pago existente por outro.
  return resolveModelAlias(raw, account, cached);
}

// Aquece o catálogo da conta ativa para resolver ids/nomes já na primeira chamada.
{
  const active = getActiveAccount();
  if (active) modelsFor(active).catch(() => {});
}

const COMPACTION_RESERVE_TOKENS = 16384;
const COMPACTION_KEEP_RECENT_TOKENS = 14000;
const DEFAULT_CONTEXT_WINDOW = 128000;
// A DeepAI impõe um teto efetivo silencioso (~36.5k prompt_tokens) nos modelos
// gratuitos mesmo anunciando 320k no /models. Quando excedido com tool_calls, o
// servidor da DeepAI descarta o histórico intermediário silenciosamente.
const ENV_UPSTREAM_CONTEXT_CAP = Number(process.env.DEEPAI_UPSTREAM_CONTEXT_CAP);
const DEFAULT_FREE_INPUT_CAP =
  Number.isFinite(ENV_UPSTREAM_CONTEXT_CAP) && ENV_UPSTREAM_CONTEXT_CAP >= 0
    ? ENV_UPSTREAM_CONTEXT_CAP
    : 36500;
const observedModelInputCap = new Map();

function findCachedModelEntry(accountId, model) {
  if (!model) return null;
  const lower = String(model).toLowerCase();
  const match = (entry) =>
    entry &&
    (entry.id === `deepai/${model}` ||
      entry.id === model ||
      entry.slug === model ||
      String(entry.id ?? "").toLowerCase() === `deepai/${lower}` ||
      String(entry.slug ?? "").toLowerCase() === lower);

  const primary = modelCache.get(accountId);
  if (primary?.data?.data) {
    const found = primary.data.data.find(match);
    if (found) return found;
  }
  for (const cached of modelCache.values()) {
    const found = cached?.data?.data?.find(match);
    if (found) return found;
  }
  return null;
}

function contextWindowFor(accountId, model) {
  const entry = findCachedModelEntry(accountId, model);
  const cw = entry?.context_window;
  if (typeof cw === "number" && Number.isFinite(cw) && cw > 0) return cw;
  return DEFAULT_CONTEXT_WINDOW;
}

function maxOutputTokensFor(accountId, model) {
  const entry = findCachedModelEntry(accountId, model);
  const out = entry?.max_output_tokens;
  if (typeof out === "number" && Number.isFinite(out) && out > 0) return out;
  return null;
}

function effectiveInputCapFor(accountId, model) {
  if (ENV_UPSTREAM_CONTEXT_CAP === 0) return null;
  if (Number.isFinite(ENV_UPSTREAM_CONTEXT_CAP) && ENV_UPSTREAM_CONTEXT_CAP > 0) {
    return ENV_UPSTREAM_CONTEXT_CAP;
  }
  const key = String(model ?? "").toLowerCase();
  const observed = key ? observedModelInputCap.get(key) : null;
  const entry = findCachedModelEntry(accountId, model);
  const isFree = entry ? entry.free === true || entry.tier === "free" : true;
  const baseCap = isFree ? DEFAULT_FREE_INPUT_CAP : null;
  if (observed && baseCap) return Math.min(observed, baseCap);
  return observed ?? baseCap;
}

function observeUpstreamInputTokens(model, sentEstTokens, actualInputTokens) {
  if (
    !model ||
    !Number.isFinite(sentEstTokens) ||
    !Number.isFinite(actualInputTokens) ||
    sentEstTokens < 20000 ||
    actualInputTokens <= 0
  ) {
    return;
  }
  // Se o upstream leu muito menos tokens do que enviamos (< 65%), houve
  // truncamento silencioso no servidor da DeepAI: calibra o teto deste modelo.
  if (actualInputTokens < sentEstTokens * 0.65) {
    const key = String(model).toLowerCase();
    const prev = observedModelInputCap.get(key) ?? sentEstTokens;
    const calibrated =
      actualInputTokens >= 18000
        ? Math.max(16000, Math.floor(actualInputTokens * 0.9))
        : Math.max(16000, Math.floor(Math.min(prev, sentEstTokens) * 0.8));
    if (calibrated < prev || !observedModelInputCap.has(key)) {
      observedModelInputCap.set(key, calibrated);
      console.warn(
        `[context] truncamento silencioso detectado em ${model}: enviado ~${sentEstTokens}, upstream leu ${actualInputTokens}. Novo teto efetivo: ${calibrated} tokens.`,
      );
    }
  }
}

function pricingFor(accountId, model) {
  const cached = modelCache.get(accountId);
  if (!cached || !model) return null;
  const entry = cached.data.data.find(
    (item) => item.id === `deepai/${model}` || item.id === model,
  );
  const raw = entry?.pricing?.theos_per_request;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return null;
}

function tokenCount(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function extractUsage(payload) {
  if (!payload || typeof payload !== "object") return null;
  const usage = payload.usage ?? payload.response?.usage;
  if (!usage || typeof usage !== "object") return null;
  const input = tokenCount(usage.input_tokens ?? usage.prompt_tokens);
  const output = tokenCount(usage.output_tokens ?? usage.completion_tokens);
  const cached = tokenCount(
    usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens ??
      usage.cached_tokens ??
      usage.cache_read_input_tokens ??
      usage.prompt_cache_hit_tokens,
  );
  if (input === null && output === null && cached === null) return null;
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...(cached === null ? {} : { cachedInputTokens: cached }),
  };
}

function extractUpstreamError(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.error === "string") return payload.error;
  if (payload.error && typeof payload.error.message === "string") {
    return payload.error.message;
  }
  if (typeof payload.message === "string") return payload.message;
  return null;
}

/**
 * Lê o corpo sem alterá-lo: conta bytes, extrai usage de JSON ou SSE e
 * captura a mensagem de erro. Nada de prompt, token ou header é armazenado.
 */
function createResponseScanner(contentType) {
  const type = String(contentType ?? "").toLowerCase();
  const isSse = type.includes("text/event-stream");
  const isJson = type.includes("application/json");
  const maxBuffer = 8 * 1024 * 1024;
  let tail = "";
  let bytes = 0;
  let usage = null;
  let error = null;
  let overflow = false;
  let completed = false;

  const consumeObject = (payload) => {
    const nextUsage = extractUsage(payload);
    if (nextUsage) usage = nextUsage;
    if (!error) {
      const nextError = extractUpstreamError(payload);
      if (nextError) error = nextError;
    }
    const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
    if (choice && typeof choice.finish_reason === "string") {
      completed = true;
    }
  };

  const consumeLine = (line) => {
    const trimmed = (line.endsWith(String.fromCharCode(13)) ? line.slice(0, -1) : line).trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data) return;
    if (data === "[DONE]") {
      completed = true;
      return;
    }
    try {
      consumeObject(JSON.parse(data));
    } catch {
      // linha parcial ou keep-alive
    }
  };

  return {
    push(chunk) {
      bytes += chunk.length;
      if ((!isSse && !isJson) || overflow) return;
      tail += Buffer.from(chunk).toString("utf8");
      if (isSse) {
        let index;
        while ((index = tail.indexOf("\n")) !== -1) {
          const line = tail.slice(0, index);
          tail = tail.slice(index + 1);
          consumeLine(line);
        }
        if (tail.length > maxBuffer) tail = tail.slice(-4096);
      } else if (tail.length > maxBuffer) {
        overflow = true;
        tail = "";
      }
    },
    finish() {
      if (!overflow) {
        if (isSse && tail) consumeLine(tail);
        else if (isJson && tail) {
          try {
            consumeObject(JSON.parse(tail));
          } catch {
            // corpo truncado
          }
        }
      }
      return { bytes, usage, error, completed };
    },
  };
}

function collectChunkText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) =>
      part && typeof part === "object" && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("");
}

function mergeToolCall(map, part) {
  if (!part || typeof part !== "object") return;
  let index;
  if (Number.isInteger(part.index)) {
    index = part.index;
  } else if (typeof part.id === "string" && part.id) {
    const existing = [...map.entries()].find(([, call]) => call.id === part.id);
    index = existing ? existing[0] : map.size;
  } else {
    index = map.size > 0 ? map.size - 1 : 0;
  }
  const current =
    map.get(index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
  if (typeof part.id === "string" && part.id) current.id = part.id;
  if (typeof part.type === "string" && part.type) current.type = part.type;
  if (part.function && typeof part.function === "object") {
    if (typeof part.function.name === "string" && part.function.name) {
      if (!current.function.name) {
        current.function.name = part.function.name;
      } else if (
        current.function.name !== part.function.name &&
        !part.id
      ) {
        current.function.name += part.function.name;
      }
    }
    if (typeof part.function.arguments === "string") {
      current.function.arguments += part.function.arguments;
    }
  }
  map.set(index, current);
}

/**
 * A DeepAI devolve SSE mesmo quando o cliente pede stream:false. Aqui o
 * stream é consumido e remontado como um chat.completion JSON comum.
 */
async function collectChatCompletionStream(upstream, res, meta, fallbackModel) {
  const startedAt = meta.startedAt;
  let bytes = 0;
  let tail = "";
  let id = null;
  let created = null;
  let model = null;
  let systemFingerprint = null;
  let content = "";
  let reasoning = "";
  let finishReason = null;
  let usage = null;
  let sawData = false;
  let sawDone = false;
  const toolCalls = new Map();

  const consume = (payload) => {
    if (!payload || typeof payload !== "object") return;
    sawData = true;
    if (typeof payload.id === "string") id = payload.id;
    if (typeof payload.created === "number") created = payload.created;
    if (typeof payload.model === "string") model = payload.model;
    if (typeof payload.system_fingerprint === "string") {
      systemFingerprint = payload.system_fingerprint;
    }
    if (payload.usage && typeof payload.usage === "object") usage = payload.usage;
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    if (!choice || typeof choice !== "object") return;
    if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
    const delta = choice.delta ?? choice.message;
    if (!delta || typeof delta !== "object") return;
    content += collectChunkText(delta.content);
    if (typeof delta.reasoning === "string") reasoning += delta.reasoning;
    else if (typeof delta.reasoning_content === "string") {
      reasoning += delta.reasoning_content;
    } else if (Array.isArray(delta.reasoning_details)) {
      reasoning += delta.reasoning_details
        .map((part) => (part && typeof part.text === "string" ? part.text : ""))
        .join("");
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const part of delta.tool_calls) mergeToolCall(toolCalls, part);
    }
    if (delta.function_call && typeof delta.function_call === "object") {
      mergeToolCall(toolCalls, {
        index: 0,
        type: "function",
        function: delta.function_call,
      });
    }
  };

  const consumeLine = (line) => {
    const trimmed = (line.endsWith(String.fromCharCode(13)) ? line.slice(0, -1) : line).trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data) return;
    if (data === "[DONE]") {
      sawDone = true;
      return;
    }
    try {
      consume(JSON.parse(data));
    } catch {
      // linha parcial/keep-alive
    }
  };

  try {
    for await (const chunk of upstream.body) {
      bytes += chunk.length;
      tail += Buffer.from(chunk).toString("utf8");
      let index;
      while ((index = tail.indexOf(String.fromCharCode(10))) !== -1) {
        const line = tail.slice(0, index);
        tail = tail.slice(index + 1);
        consumeLine(line);
      }
    }
    if (tail) consumeLine(tail);
  } catch (error) {
    const completed =
      upstream.status < 400 && (sawDone || finishReason !== null);
    const aborted = meta.signal?.aborted === true && !completed;
    telemetry.record({
      ...meta,
      status: completed ? upstream.status : aborted ? 499 : 502,
      durationMs: performance.now() - startedAt,
      bytes,
      error: completed
        ? null
        : aborted
          ? "Cliente desconectou durante a resposta."
          : `A conexão com a DeepAI caiu durante a resposta${
              error instanceof Error ? `: ${error.message}` : "."
            }`,
    });
    if (!res.destroyed) {
      if (!res.headersSent) {
        sendError(res, 502, "A conexão com a DeepAI caiu antes da resposta.");
      } else {
        res.destroy();
      }
    }
    return;
  }

  const parsedUsage = extractUsage({ usage });
  if (!sawData || (!content && !reasoning && toolCalls.size === 0 && !parsedUsage)) {
    telemetry.record({
      ...meta,
      status: upstream.status >= 400 ? upstream.status : 502,
      durationMs: performance.now() - startedAt,
      bytes,
      ...(parsedUsage ?? {}),
      error: "A DeepAI devolveu um stream vazio.",
    });
    sendError(res, 502, "A DeepAI devolveu uma resposta vazia. Tente novamente.");
    return;
  }

  const message = {
    role: "assistant",
    content: content || (toolCalls.size ? null : ""),
  };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.size) {
    message.tool_calls = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call);
  }
  const body = {
    id: id ?? `chatcmpl_${randomBytes(8).toString("hex")}`,
    object: "chat.completion",
    created: created ?? Math.floor(Date.now() / 1000),
    model: model ?? fallbackModel ?? "deepai",
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason:
          finishReason ?? (toolCalls.size ? "tool_calls" : "stop"),
      },
    ],
    ...(parsedUsage ? { usage } : {}),
    ...(systemFingerprint ? { system_fingerprint: systemFingerprint } : {}),
  };

  if (upstream.status < 400 && parsedUsage?.inputTokens > 0) {
    observeUpstreamInputTokens(meta.model, meta.sentEstTokens, parsedUsage.inputTokens);
  }
  telemetry.record({
    ...meta,
    status: upstream.status,
    durationMs: performance.now() - startedAt,
    bytes,
    ...(parsedUsage ?? {}),
    theos: upstream.status < 400 ? meta.theos : null,
    error: upstream.status >= 400 ? "A DeepAI recusou a requisição." : null,
  });
  sendJson(res, upstream.status, body, {
    ...(upstream.headers.has("x-request-id")
      ? { "X-Request-Id": upstream.headers.get("x-request-id") }
      : {}),
  });
}

/**
 * Captura a mensagem final do assistente sem alterar o stream entregue ao
 * cliente. É isso que permite ao ledger reconstruir contexto mesmo quando o
 * cliente manda só o último user em um turno seguinte.
 */
function createAssistantCapture(contentType) {
  const type = String(contentType ?? "").toLowerCase();
  const isSse = type.includes("text/event-stream");
  const isJson = type.includes("application/json");
  const maxBuffer = 8 * 1024 * 1024;
  let tail = "";
  let content = "";
  let reasoning = "";
  let finishReason = null;
  let overflow = false;
  let saw = false;
  const toolCalls = new Map();

  const consume = (payload) => {
    if (!payload || typeof payload !== "object") return;
    saw = true;
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    if (choice && typeof choice === "object") {
      if (typeof choice.finish_reason === "string") {
        finishReason = choice.finish_reason;
      }
      const delta = choice.delta ?? choice.message;
      if (delta && typeof delta === "object") {
        content += collectChunkText(delta.content);
        if (typeof delta.reasoning === "string") reasoning += delta.reasoning;
        else if (typeof delta.reasoning_content === "string") {
          reasoning += delta.reasoning_content;
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const part of delta.tool_calls) mergeToolCall(toolCalls, part);
        }
        if (delta.function_call && typeof delta.function_call === "object") {
          mergeToolCall(toolCalls, {
            index: 0,
            type: "function",
            function: delta.function_call,
          });
        }
      }
    }
  };

  const consumeLine = (line) => {
    const trimmed = (line.endsWith(String.fromCharCode(13)) ? line.slice(0, -1) : line).trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      consume(JSON.parse(data));
    } catch {
      // linha parcial/keep-alive
    }
  };

  return {
    push(chunk) {
      if (overflow) return;
      if (isSse) {
        tail += Buffer.from(chunk).toString("utf8");
        let index;
        while ((index = tail.indexOf(String.fromCharCode(10))) !== -1) {
          const line = tail.slice(0, index);
          tail = tail.slice(index + 1);
          consumeLine(line);
        }
        if (tail.length > maxBuffer) tail = tail.slice(-4096);
      } else if (isJson) {
        tail += Buffer.from(chunk).toString("utf8");
        if (tail.length > maxBuffer) {
          overflow = true;
          tail = "";
        }
      }
    },
    finish() {
      if (overflow) return null;
      if (isSse && tail) consumeLine(tail);
      if (isJson && tail) {
        try {
          consume(JSON.parse(tail));
        } catch {
          return null;
        }
      }
      if (!saw || (!content && !reasoning && toolCalls.size === 0)) return null;
      const message = {
        role: "assistant",
        content: content || (toolCalls.size ? null : ""),
      };
      if (reasoning) message.reasoning_content = reasoning;
      if (toolCalls.size) {
        message.tool_calls = [...toolCalls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, call]) => call);
      }
      return message;
    },
    get finishReason() {
      return finishReason;
    },
  };
}

async function pipeUpstream(upstream, res, meta) {
  const contentType =
    upstream.headers.get("content-type") ?? "application/json; charset=utf-8";
  const scanner = createResponseScanner(contentType);
  const transform = new Transform({
    transform(chunk, encoding, callback) {
      scanner.push(chunk);
      callback(null, chunk);
    },
  });
  const isSse = contentType.toLowerCase().includes("text/event-stream");
  const heartbeat = isSse
    ? setInterval(() => {
        if (!res.writableEnded && !res.destroyed) res.write(": keepalive" + String.fromCharCode(10, 10));
      }, 15_000)
    : null;
  heartbeat?.unref?.();

  try {
    await pipeline(Readable.fromWeb(upstream.body), transform, res);
    const scanned = scanner.finish();
    if (heartbeat) clearInterval(heartbeat);
    if (upstream.status < 400 && scanned.usage?.inputTokens > 0) {
      observeUpstreamInputTokens(meta.model, meta.sentEstTokens, scanned.usage.inputTokens);
    }
    telemetry.record({
      ...meta,
      status: upstream.status,
      durationMs: performance.now() - meta.startedAt,
      bytes: scanned.bytes,
      ...(scanned.usage ?? {}),
      theos: upstream.status < 400 ? meta.theos : null,
      error: upstream.status >= 400 ? scanned.error : null,
    });
  } catch (error) {
    if (heartbeat) clearInterval(heartbeat);
    const scanned = scanner.finish();
    const completed = scanned.completed === true && upstream.status < 400;
    const aborted = meta.signal?.aborted === true && !completed;
    telemetry.record({
      ...meta,
      status: completed ? upstream.status : aborted ? 499 : 502,
      durationMs: performance.now() - meta.startedAt,
      bytes: scanned.bytes,
      ...(scanned.usage ?? {}),
      theos: completed ? meta.theos : null,
      error: completed
        ? null
        : aborted
          ? "Cliente desconectou durante a resposta."
          : `A conexão com a DeepAI caiu durante o streaming${
              error instanceof Error ? `: ${error.message}` : "."
            }`,
    });
    res.destroy();
  }
}

async function handleProxy(req, res, url) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-Api-Key, X-DeepAI-Account, X-Session-Affinity, X-Session-Id, X-Conversation-Id, X-Thread-Id, X-Client-Session-Id",
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!requireProxy(req, res)) return;

  let account = accountForRequest(req);
  if (!account) {
    sendError(res, 401, "Nenhuma conta DeepAI conectada. Abra o painel e adicione uma conta.", {
      code: "account_required",
    });
    return;
  }

  if (url.pathname === "/v1/models" && req.method === "GET") {
    const startedAt = performance.now();
    try {
      const { account: catalogAccount, catalog } = await catalogForRequest(
        account,
        req,
      );
      account = catalogAccount;
      telemetry.record({
        accountId: account.id,
        endpoint: "models",
        status: 200,
        durationMs: performance.now() - startedAt,
      });
      sendJson(res, 200, catalog);
    } catch (error) {
      telemetry.record({
        accountId: account.id,
        endpoint: "models",
        status: error.status || 502,
        durationMs: performance.now() - startedAt,
        error: error instanceof Error ? error.message : "falha no catálogo",
      });
      sendUpstreamError(res, error);
    }
    return;
  }

  if (url.pathname.startsWith("/v1/models/") && req.method === "GET") {
    const startedAt = performance.now();
    const requested = decodeURIComponent(url.pathname.slice("/v1/models/".length));
    try {
      const { account: catalogAccount, catalog } = await catalogForRequest(
        account,
        req,
      );
      account = catalogAccount;
      const lookup = (value) => {
        const raw = value.replace(/^deepai\//, "");
        return catalog.data.find(
          (item) =>
            item.slug === raw ||
            item.id === value ||
            String(item.name).toLowerCase() === value.toLowerCase(),
        );
      };
      let model = lookup(requested);
            if (!model) {
              const catalogAccount = accountCandidates(account, req)[0];
              const cached = modelCache.get(catalogAccount.id);
              const aliased = resolveModelAlias(requested, account, cached);
              if (aliased !== requested) model = lookup(aliased);
            }
      telemetry.record({
        accountId: account.id,
        endpoint: "models",
        status: model ? 200 : 404,
        durationMs: performance.now() - startedAt,
        model: model?.slug ?? null,
      });
      if (!model) {
        sendError(res, 404, "Modelo não encontrado.", {
          code: "model_not_found",
        });
        return;
      }
      sendJson(res, 200, model);
    } catch (error) {
      telemetry.record({
        accountId: account.id,
        endpoint: "models",
        status: error.status || 502,
        durationMs: performance.now() - startedAt,
        error: error instanceof Error ? error.message : "falha no catálogo",
      });
      sendUpstreamError(res, error);
    }
    return;
  }

  if (url.pathname === "/v1/audio/transcriptions" && req.method === "POST") {
    const startedAt = performance.now();
    const contentType = String(req.headers["content-type"] ?? "");
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      sendError(res, 400, "Envie o áudio como multipart/form-data.", {
        code: "invalid_content_type",
      });
      return;
    }
    try {
      const raw = await readBody(req, 10 * 1024 * 1024);
      const formRequest = new Request("http://127.0.0.1/v1/audio/transcriptions", {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: raw,
      });
      const form = await formRequest.formData();
      const file = form.get("file") ?? form.get("audio");
      if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
        sendError(res, 400, "Campo de áudio ausente (use `file`).", {
          code: "audio_required",
        });
        return;
      }
      const data = Buffer.from(await file.arrayBuffer());
      const mimeType = String(file.type || "audio/webm").toLowerCase();
      const text = await transcribeAudio(accountSecret(account), {
        data,
        mimeType,
        filename: file.name || "rec.webm",
        signal: AbortSignal.timeout(120000),
      });
      const format = String(
        form.get("response_format") ?? url.searchParams.get("response_format") ?? "json",
      );
      telemetry.record({
        accountId: account.id,
        endpoint: "audio/transcriptions",
        status: 200,
        durationMs: performance.now() - startedAt,
        bytes: data.length,
        model: "speech_to_text",
      });
      if (format === "text") {
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(text);
        return;
      }
      sendJson(res, 200, { text });
    } catch (error) {
      const upstreamError = error instanceof DeepAIError;
      const status = upstreamError
        ? error.status >= 400 && error.status < 500
          ? error.status
          : 502
        : 400;
      telemetry.record({
        accountId: account.id,
        endpoint: "audio/transcriptions",
        status,
        durationMs: performance.now() - startedAt,
        model: "speech_to_text",
        error: error instanceof Error ? error.message : "falha na transcrição",
      });
      if (upstreamError) sendUpstreamError(res, error);
      else sendError(res, 400, error.message || "Não foi possível transcrever o áudio.");
    }
    return;
  }

  if (
    (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/responses") &&
    req.method === "POST"
  ) {
    const endpoint =
      url.pathname === "/v1/chat/completions" ? "chat/completions" : "responses";
    const startedAt = performance.now();
    let payload;
    try {
      payload = await readJsonBody(req);
    } catch (error) {
      telemetry.record({
        accountId: account.id,
        endpoint,
        status: error.status || 400,
        durationMs: performance.now() - startedAt,
        error: error.message,
      });
      sendError(res, error.status || 400, error.message);
      return;
    }

    if (!modelCache.has(account.id)) {
      await modelsFor(account).catch(() => null);
    }

    if (endpoint === "chat/completions") {
      payload = normalizeChatPayload(payload, (value) =>
        resolveModelId(account, value),
      );
    } else if (payload && typeof payload.model === "string") {
      payload = { ...payload, model: resolveModelId(account, payload.model) };
    }
    const model = typeof payload?.model === "string" ? payload.model : null;
    const wantsStream = payload?.stream === true;

    // Identidade de cache/afinidade sem alterar o histórico enviado pelo cliente.
    const identity = applyCacheIdentity({
      body: payload,
      headers: req.headers,
      accountId: account.id,
      endpoint,
    });
    const conversation = { sessionId: identity.key, restored: 0 };

    // Prepara o histórico para o upstream respeitando o teto efetivo real da DeepAI:
    // 1) remove reasoning antigo; 2) poda outputs de tool antigos preservando todos os turnos;
    // 3) só descarta turnos antigos em último caso. O ledger completo segue intacto.
    const resolvedModel = payload.model || model;
    const cw = contextWindowFor(account.id, resolvedModel);
    const modelMaxOut = maxOutputTokensFor(account.id, resolvedModel);
    const requestedMaxOut =
          typeof payload?.max_tokens === "number" && Number.isFinite(payload.max_tokens)
            ? payload.max_tokens
            : typeof payload?.max_output_tokens === "number" &&
                Number.isFinite(payload.max_output_tokens)
              ? payload.max_output_tokens
              : 0;
    const reserveTokens = Math.min(
      Math.floor(cw * 0.4),
      Math.max(COMPACTION_RESERVE_TOKENS, requestedMaxOut || modelMaxOut || 0),
    );
    const prepareOpts = {
      contextWindow: cw,
      reserveTokens,
      effectiveInputCap: effectiveInputCapFor(account.id, resolvedModel),
      keepRecentTokens: COMPACTION_KEEP_RECENT_TOKENS,
      keepRecentTools: 3,
      extraTokens: estimatePayloadOverheadTokens(payload),
    };
    let sentEstTokens = null;
    if (Array.isArray(payload.messages)) {
      const prepared = prepareUpstreamMessages(payload.messages, prepareOpts);
      payload = { ...payload, messages: prepared.messages };
      sentEstTokens = prepared.estimatedTokens;
    } else if (Array.isArray(payload.input)) {
      const prepared = prepareUpstreamMessages(payload.input, prepareOpts);
      payload = { ...payload, input: prepared.messages };
      sentEstTokens = prepared.estimatedTokens;
    }

    const controller = new AbortController();
    res.once("close", () => {
      // Só aborta o upstream quando o cliente realmente saiu no meio da resposta.
      if (!res.writableEnded) controller.abort();
    });

    // Total timeout (hard limit)
    const upstreamSignal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(DEEPAI_TOTAL_TIMEOUT_MS),
    ]);
    const candidates = accountCandidates(account, req);
    let upstream = null;
    let lastFailure = null;

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      // SEMPRE faz check-in antes de cada tentativa (match official behavior)
      await ensureCheckIn(candidate);

      // Usa prompt_cache_key do cliente se fornecido, senão fallback para identity.key
      const clientCacheKey = String(
    req.headers["x-session-affinity"] ??
    req.headers["x-session-id"] ??
    req.headers["session-id"] ??
    payload?.prompt_cache_key ??
    conversation.sessionId
      ).trim();

      const affinityHeaders = {
    "X-Session-Affinity": clientCacheKey,
      };

      const busyStartedAt = Date.now();
      for (let busyAttempt = 0; ; busyAttempt += 1) {
    try {
      upstream = await forwardModelRequest(
        url.pathname === "/v1/chat/completions"
          ? "/chat/completions"
          : "/responses",
        accountSecret(candidate),
        {
          method: "POST",
          body: JSON.stringify(payload),
          headers: affinityHeaders,
          signal: upstreamSignal,
        },
      );
    } catch (error) {
      if (controller.signal.aborted) {
        telemetry.record({
          accountId: candidate.id,
          endpoint,
          model,
          status: 499,
          durationMs: performance.now() - startedAt,
          error: "Cliente desconectou antes da resposta.",
        });
        return;
      }
      const timedOut =
        error?.name === "TimeoutError" || error?.name === "AbortError";
      const status = timedOut ? 504 : error.status || 502;
      telemetry.record({
        accountId: candidate.id,
        endpoint,
        model,
        status,
        durationMs: performance.now() - startedAt,
        error: timedOut
          ? "A DeepAI não respondeu dentro do tempo limite."
          : error instanceof Error
            ? error.message
            : "falha de conexão",
      });
      if (timedOut) {
        sendError(res, 504, "A DeepAI não respondeu dentro do tempo limite.", {
          code: "upstream_timeout",
        });
        return;
      }
      sendUpstreamError(res, error);
      return;
    }

    // Retry ONLY on 409 session_busy (match official waitForDeepAICapacity)
    if (
      upstream.status === 409 &&
      (await sessionBusy(upstream)) &&
      busyAttempt < 3 &&
      Date.now() - busyStartedAt < 30_000
    ) {
      const retryAfter = Number(upstream.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter)
        ? Math.min(30_000, Math.max(1_000, retryAfter * 1000))
        : 2_000;
      await upstream.body?.cancel().catch(() => {});
      try {
        await sleep(delay, controller.signal);
      } catch {
        telemetry.record({
          accountId: candidate.id,
          endpoint,
          model,
          status: 499,
          durationMs: performance.now() - startedAt,
          error: "Cliente desconectou antes da resposta.",
        });
        return;
      }
      continue;
    }
    break;
      }

      if (RETRYABLE_UPSTREAM_STATUS.has(upstream.status)) {
    const errorBody = await upstream
      .clone()
      .json()
      .catch(() => null);
    markAccountCooldown(
      candidate,
      upstream.status,
      upstream.headers.get("retry-after"),
      errorBody,
    );
    if (index < candidates.length - 1) {
      lastFailure = await upstreamFailure(upstream);
      await upstream.body?.cancel().catch(() => {});
      continue;
    }
      }

      account = candidate;
      if (!RETRYABLE_UPSTREAM_STATUS.has(upstream.status)) {
    clearAccountCooldown(candidate);
      }
      break;
    }

    if (!upstream) {
      if (lastFailure) sendUpstreamError(res, lastFailure);
      else {
    sendError(res, 502, "Nenhuma conta conseguiu concluir a requisição.", {
      code: "no_account_available",
    });
      }
      return;
    }
    const theos = pricingFor(account.id, model);

    const contentType =
      upstream.headers.get("content-type") ?? "application/json; charset=utf-8";

    if (
      endpoint === "chat/completions" &&
      !wantsStream &&
      contentType.toLowerCase().includes("text/event-stream") &&
      upstream.body
    ) {
      await collectChatCompletionStream(
    upstream,
    res,
    {
      accountId: account.id,
      endpoint,
      model,
      sessionId: conversation.sessionId,
      sentEstTokens,
      startedAt,
      signal: controller.signal,
      theos: upstream.status < 400 ? theos : null,
    },
    model,
      );
      return;
    }

    res.writeHead(upstream.status, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(upstream.headers.has("retry-after")
    ? { "Retry-After": upstream.headers.get("retry-after") }
    : {}),
      ...(upstream.headers.has("x-request-id")
    ? { "X-Request-Id": upstream.headers.get("x-request-id") }
    : {}),
    });

    if (!upstream.body) {
      telemetry.record({
    accountId: account.id,
    endpoint,
    model,
    status: upstream.status,
    durationMs: performance.now() - startedAt,
    error: upstream.status >= 400 ? "Sem corpo de resposta." : null,
      });
      res.end();
      return;
    }

    await pipeUpstream(upstream, res, {
      accountId: account.id,
      endpoint,
      model,
      sessionId: conversation.sessionId,
      sentEstTokens,
      startedAt,
      signal: controller.signal,
      theos: upstream.status < 400 ? theos : null,
    });
    return;
      }

      sendError(res, 404, "Rota de API não encontrada.", { code: "not_found" });
    }

function sendUpstreamError(res, error) {
  if (error instanceof DeepAIError) {
    const status =
      error.status >= 400 && error.status < 500 ? error.status : 502;
    const code = upstreamCode(error.body);
    const type =
      status === 401
        ? "authentication_error"
        : status === 402
          ? "payment_required"
          : status === 429
            ? "rate_limit_error"
            : "upstream_error";
    sendJson(res, status, {
      error: {
        message: error.message,
        type,
        code:
          code ??
          (status === 401
            ? "deepai_auth_failed"
            : status === 402
              ? "deepai_payment_required"
              : status === 429
                ? "deepai_rate_limited"
                : "deepai_unavailable"),
      },
    });
    return;
  }
  sendJson(res, 502, {
    error: {
      message:
        error instanceof Error
          ? error.message
          : "Falha inesperada ao falar com a DeepAI.",
      type: "upstream_error",
      code: "deepai_unavailable",
    },
  });
}

async function handleAdmin(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  // /admin/api/...
  const section = parts[2];
  const action = parts[3];
  const id = parts[4];
  const ip = req.socket.remoteAddress ?? "local";

  if (section === "setup" && !action) {
    if (req.method === "GET") {
      sendJson(res, 200, { initialized: isAdminInitialized() });
      return;
    }
    if (req.method === "POST") {
      if (isAdminInitialized()) {
        sendError(res, 409, "A senha já foi criada. Entre no painel.", {
          code: "setup_complete",
        });
        return;
      }
      const body = await readJsonBody(req, 8 * 1024);
      if (typeof body.password !== "string") {
        sendError(res, 400, "Informe uma senha válida.");
        return;
      }
      try {
        setAdminPassword(body.password);
      } catch (error) {
        sendError(res, 400, error.message);
        return;
      }
      const sessionToken = createAdminSession();
      sendJson(res, 201, { ok: true, sessionToken });
      return;
    }
    sendError(res, 405, "Método não permitido.");
    return;
  }

  if (section === "login" && !action) {
    if (req.method !== "POST") {
      sendError(res, 405, "Método não permitido.");
      return;
    }
    if (!isAdminInitialized()) {
      sendError(res, 409, "Crie a senha de administrador no primeiro acesso.", {
        code: "setup_required",
      });
      return;
    }
    if (loginBlocked(ip)) {
      sendError(
        res,
        429,
        "Muitas tentativas. Aguarde 30 segundos e tente novamente.",
      );
      return;
    }
    const body = await readJsonBody(req, 8 * 1024);
    if (typeof body.password !== "string" || !verifyAdminPassword(body.password)) {
      noteLoginFailure(ip);
      sendError(res, 401, "Senha incorreta.");
      return;
    }
    clearLoginFailures(ip);
    const sessionToken = createAdminSession();
    sendJson(res, 200, { ok: true, sessionToken });
    return;
  }

  if (section === "reset-password" && !action) {
    if (req.method !== "POST") {
      sendError(res, 405, "Método não permitido.");
      return;
    }
    if (!isLoopbackRequest(req)) {
      sendError(
        res,
        403,
        "O reset de senha só funciona no computador que roda o proxy.",
        { code: "reset_local_only" },
      );
      return;
    }
    const body = await readJsonBody(req, 8 * 1024);
    if (body.confirm !== "RESETAR") {
      sendError(res, 400, "Confirmação inválida. Digite RESETAR para continuar.");
      return;
    }
    resetAdminPassword();
    adminSessions.clear();
    loginFailures.clear();
    sendJson(res, 200, { ok: true, initialized: false });
    return;
  }

  if (section === "logout" && !action) {
    revokeAdminSession(sessionTokenFrom(req));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!requireAdmin(req, res)) return;

  if (req.method === "GET" && section === "session") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && section === "state") {
    sendJson(res, 200, {
      baseUrl: publicBaseUrl(req),
      proxyToken: config.proxyToken,
      activeAccountId: getActiveAccount()?.id ?? null,
      accounts: publicAccounts(),
      dataDir: DATA_DIR,
      conversations: conversations.snapshot().stats,
    });
    return;
  }

  if (section === "telemetry") {
    if (req.method === "GET" && !action) {
      sendJson(res, 200, telemetry.snapshot());
      return;
    }
    if (req.method === "POST" && action === "clear") {
      telemetry.clear();
      sendJson(res, 200, { ok: true });
      return;
    }
    sendError(res, 404, "Rota de telemetria não encontrada.");
    return;
  }

  if (section === "conversations") {
    if (req.method === "GET" && !action) {
      sendJson(res, 200, conversations.snapshot());
      return;
    }
    if (req.method === "POST" && action === "clear") {
      conversations.clear();
      sendJson(res, 200, { ok: true, ...conversations.snapshot() });
      return;
    }
    sendError(res, 404, "Rota de conversas não encontrada.");
    return;
  }

  if (section === "models") {
    if (req.method !== "GET") {
      sendError(res, 405, "Método não permitido.");
      return;
    }
    const requested = String(url.searchParams.get("account") ?? "").trim();
    let account = requested ? getAccount(requested) : getActiveAccount();
    if (!account) {
      sendError(res, 409, "Conecte uma conta para listar os modelos.", {
        code: "account_required",
      });
      return;
    }
    const refresh = url.searchParams.get("refresh") === "1";
    try {
      let data;
      if (requested) {
        data = await modelsFor(account, { force: refresh });
      } else {
        const result = await catalogForRequest(account, req, { force: refresh });
        account = result.account;
        data = result.catalog;
      }
      const cached = modelCache.get(account.id);
      const rows = data.data;
      sendJson(res, 200, {
        object: "list",
        data: rows,
        default: data.default ?? null,
        fetchedAt: cached ? new Date(cached.at).toISOString() : null,
        account: {
          id: account.id,
          username: account.username ?? "",
          isPro: account.isPro === true,
        },
        counts: {
          total: rows.length,
          free: rows.filter((model) => model.free).length,
          paid: rows.filter((model) => model.paid).length,
          premier: rows.filter((model) => model.premier).length,
        },
      });
    } catch (error) {
      sendUpstreamError(res, error);
    }
    return;
  }

  if (section === "accounts") {
    const accountId = action;
    const verb = id;

    if (req.method === "GET" && !accountId) {
      sendJson(res, 200, { accounts: publicAccounts() });
      return;
    }

    if (req.method === "POST" && accountId === "import") {
      const body = await readJsonBody(req, 64 * 1024);
      const apiKey = String(body.apiKey ?? "").trim();
      if (!apiKey || /[\r\n]/.test(apiKey)) {
        sendError(res, 400, "Informe uma API key válida.");
        return;
      }
      try {
        await fetchModels(apiKey, { signal: AbortSignal.timeout(12000) });
      } catch (error) {
        if (error instanceof DeepAIError && error.status === 401) {
          sendError(res, 400, "A DeepAI recusou esta API key.");
          return;
        }
        if (error instanceof DeepAIError) {
          sendError(res, 502, `Não foi possível validar a chave: ${error.message}`);
          return;
        }
        sendError(res, 502, "Não foi possível validar a API key agora.");
        return;
      }
      const { account, created } = upsertAccount(
        { apiKey, username: "", isPro: false },
        { label: String(body.label ?? "").slice(0, 80) },
      );
      ensureCheckIn(account).catch(() => {});
      sendJson(res, created ? 201 : 200, {
        account: publicAccount(account),
        created,
      });
      return;
    }

    if (req.method === "POST" && accountId && verb) {
      if (verb === "activate") {
        try {
          const account = setActiveAccount(accountId);
          sendJson(res, 200, { account: publicAccount(account) });
        } catch (error) {
          sendError(res, 404, error.message);
        }
        return;
      }
      if (verb === "check-in" || verb === "usage") {
        const account = getAccount(accountId);
        if (!account) {
          sendError(res, 404, "Conta não encontrada.");
          return;
        }
        try {
          const updated = await refreshAccountUsage(account);
          sendJson(res, 200, { ok: true, ...updated });
        } catch (error) {
          sendUpstreamError(res, error);
        }
        return;
      }
    }

    if (req.method === "DELETE" && accountId) {
      if (!deleteAccount(accountId)) {
        sendError(res, 404, "Conta não encontrada.");
        return;
      }
      modelCache.delete(accountId);
      sendJson(res, 200, { ok: true });
      return;
    }

    sendError(res, 404, "Rota de contas não encontrada.");
    return;
  }

  if (section === "login") {
    if (req.method === "POST" && action === "start") {
      try {
        const result = await loginManager.start();
        sendJson(res, 201, result);
      } catch (error) {
        sendError(
          res,
          500,
          `Não foi possível abrir a porta de callback: ${error.message}`,
        );
      }
      return;
    }

    if (req.method === "GET" && action) {
      const status = loginManager.status(action);
      if (!status) {
        sendError(res, 404, "Login não encontrado.");
        return;
      }
      sendJson(res, 200, status);
      return;
    }

    if (req.method === "POST" && action && id === "complete") {
      try {
        const body = await readJsonBody(req, 16 * 1024);
        const status = await loginManager.completeManually(
          action,
          body.callbackUrl ?? body.code,
        );
        sendJson(res, 200, status);
      } catch (error) {
        sendError(res, 400, error.message);
      }
      return;
    }

    if (req.method === "DELETE" && action) {
      const cancelled = loginManager.cancel(action);
      sendJson(res, 200, { cancelled });
      return;
    }

    sendError(res, 404, "Rota de login não encontrada.");
    return;
  }

  if (req.method === "POST" && section === "proxy-token" && action === "rotate") {
    const token = rotateProxyToken();
    sendJson(res, 200, { proxyToken: token });
    return;
  }

  if (section === "update") {
    if (req.method === "GET" && !action) {
      const force = url.searchParams.get("force") === "1";
      const status = await checkForUpdates({ force });
      sendJson(res, status.ok ? 200 : 200, status);
      return;
    }

    if (req.method === "POST" && action === "apply") {
      try {
        const result = await applyUpdate();
        sendJson(res, 200, result);
        if (result.updated) {
          scheduleRestart(1500);
        }
      } catch (error) {
        const status = error?.status ?? 500;
        sendError(res, status, error?.message ?? "Falha ao aplicar atualização.");
      }
      return;
    }

    sendError(res, 405, "Método não permitido.");
    return;
  }

  sendError(res, 404, "Rota administrativa não encontrada.");
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/" || pathname === "/login") pathname = "/index.html";
  const file = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (file !== PUBLIC_DIR && !file.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    sendError(res, 403, "Acesso negado.");
    return;
  }
  try {
    const data = await fs.readFile(file);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      ...(ext === ".html"
        ? {
            "Content-Security-Policy":
              "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
          }
        : {}),
    });
    res.end(data);
  } catch {
    sendError(res, 404, "Arquivo não encontrado.");
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const run = async () => {
    if (url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "deepai-proxy", version: VERSION });
      return;
    }
    if (url.pathname.startsWith("/admin/api/")) {
      await handleAdmin(req, res, url);
      return;
    }
    if (url.pathname.startsWith("/v1/")) {
      await handleProxy(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  };
  run().catch((error) => {
    console.error("[http]", error);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendError(
      res,
      error?.status || 500,
      error instanceof Error ? error.message : "Erro interno.",
    );
  });
});

server.listen(PORT, HOST, () => {
  const address = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST;
  const base = `http://${address}:${PORT}`;
  const line = "─".repeat(58);
  console.log(`\n  \x1b[35m◆\x1b[0m \x1b[1mDeepAI Proxy\x1b[0m  \x1b[2mv${VERSION}\x1b[0m`);
  console.log(`  ${line}`);
  console.log(`  Painel:  \x1b[4m${base}/\x1b[0m`);
  console.log(
    isAdminInitialized()
      ? `  Acesso:  \x1b[2msenha de administrador já configurada\x1b[0m`
      : `  Acesso:  \x1b[2mcrie sua senha no primeiro acesso ao painel\x1b[0m`,
  );
  console.log(`  Dados:   \x1b[2m${DATA_DIR}\x1b[0m`);
  console.log(`  ${line}\n`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `\n  A porta ${PORT} já está em uso. Defina PORT=outra_porta e tente de novo.\n`,
    );
  } else {
    console.error("[server]", error);
  }
  process.exit(1);
});

function shutdown() {
  console.log("\n  Encerrando DeepAI Proxy...");
  telemetry.flush();
  conversations.flush();
  loginManager.closeAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
