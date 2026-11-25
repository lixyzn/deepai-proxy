import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const STORE_FILE = path.join(DATA_DIR, "accounts.json");

function now() {
  return Date.now();
}

function randomId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

function normalizeLabel(label, fallback = "Conta DeepAI") {
  const v = String(label ?? "").trim();
  if (!v) return fallback;
  return v.slice(0, 120);
}

export function maskSecret(secret) {
  const s = String(secret ?? "").trim();
  if (!s) return null;
  if (s.length <= 6) return "****";
  if (s.length <= 10) return `${s.slice(0, 2)}...${s.slice(-2)}`;
  return `${s.slice(0, 3)}...${s.slice(-4)}`;
}

export function safeAccount(account, activeAccountId = null) {
  if (!account) return null;
  const rawSecret = account.apiKey || account.tokens?.accessToken || account.cookie || "";
  const cooldownUntil = typeof account.cooldownUntil === "number" ? account.cooldownUntil : null;
  return {
    id: account.id,
    label: account.label,
    username: account.username ?? null,
    isPro: Boolean(account.isPro),
    authType: account.authType || (account.cookie ? "cookie" : account.tokens?.accessToken ? "oauth" : "api_key"),
    keyPreview: maskSecret(rawSecret),
    keyLast4: rawSecret ? rawSecret.slice(-4) : null,
    hasApiKey: Boolean(account.apiKey || account.tokens?.accessToken),
    hasAccessToken: Boolean(account.tokens?.accessToken || account.apiKey),
    hasRefreshToken: Boolean(account.tokens?.refreshToken),
    hasCookie: Boolean(account.cookie),
    tokenType: account.tokens?.tokenType || "Bearer",
    scope: account.tokens?.scope ?? null,
    expiresAt: account.expiresAt ?? account.tokens?.expiresAt ?? null,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastUsedAt: account.lastUsedAt ?? null,
    requestCount: Number(account.requestCount || 0),
    errorCount: Number(account.errorCount || 0),
    lastError: account.lastError ?? null,
    enabled: account.enabled !== false,
    cooldownUntil,
    isCoolingDown: Boolean(cooldownUntil && cooldownUntil > now()),
    ...(activeAccountId !== null ? { active: account.id === activeAccountId } : {}),
  };
}

function normalizeAccountRecord(account, index = 0) {
  const ts = now();
  const apiKey = account.apiKey || account.tokens?.accessToken || null;
  return {
    id: account.id || randomId(),
    label: normalizeLabel(account.label, `Conta DeepAI ${index + 1}`),
    username: account.username ?? null,
    isPro: Boolean(account.isPro),
    authType: account.authType || (account.cookie ? "cookie" : account.tokens?.accessToken ? "oauth" : "api_key"),
    apiKey,
    cookie: account.cookie || null,
    expiresAt: account.expiresAt ?? account.tokens?.expiresAt ?? null,
    createdAt: typeof account.createdAt === "number" ? account.createdAt : ts,
    updatedAt: typeof account.updatedAt === "number" ? account.updatedAt : ts,
    lastUsedAt: typeof account.lastUsedAt === "number" ? account.lastUsedAt : null,
    requestCount: Number(account.requestCount || 0),
    errorCount: Number(account.errorCount || 0),
    lastError: account.lastError ?? null,
    enabled: account.enabled !== false,
    cooldownUntil: typeof account.cooldownUntil === "number" ? account.cooldownUntil : null,
    tokens: {
      accessToken: account.tokens?.accessToken || apiKey || null,
      refreshToken: account.tokens?.refreshToken || null,
      tokenType: account.tokens?.tokenType || "Bearer",
      scope: account.tokens?.scope ?? null,
      expiresAt: account.tokens?.expiresAt ?? account.expiresAt ?? null,
      obtainedAt: account.tokens?.obtainedAt || account.createdAt || ts,
    },
  };
}

export class AccountStore {
  constructor({ logger = console, filePath = STORE_FILE } = {}) {
    this.logger = logger;
    this.filePath = filePath;
    this._lock = Promise.resolve();
    this._lastRrId = null;
  }

  async _withLock(fn) {
    const run = this._lock.then(fn, fn);
    this._lock = run.then(() => undefined, () => undefined);
    return run;
  }

  async _ensureFile() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      const initial = { version: 2, activeAccountId: null, accounts: [] };
      await fs.writeFile(this.filePath, JSON.stringify(initial, null, 2), "utf8");
    }
  }

  async _read() {
    await this._ensureFile();
    const raw = await fs.readFile(this.filePath, "utf8");
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") throw new Error("invalid store");
      const accounts = Array.isArray(parsed.accounts)
        ? parsed.accounts.map((acc, idx) => normalizeAccountRecord(acc, idx))
        : [];
      const activeAccountId =
        parsed.activeAccountId && accounts.some((a) => a.id === parsed.activeAccountId)
          ? parsed.activeAccountId
          : (accounts[0]?.id ?? null);
      return {
        version: parsed.version || 2,
        activeAccountId,
        accounts,
      };
    } catch {
      const backup = `${this.filePath}.corrupt-${Date.now()}.bak`;
      await fs.writeFile(backup, raw, "utf8").catch(() => {});
      const reset = { version: 2, activeAccountId: null, accounts: [] };
      await fs.writeFile(this.filePath, JSON.stringify(reset, null, 2), "utf8");
      return reset;
    }
  }

  async _write(store) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    const payload = JSON.stringify(store, null, 2);
    await fs.writeFile(tmp, payload, "utf8");
    await fs.rename(tmp, this.filePath);
  }

  async init() {
    return this._withLock(async () => {
      const store = await this._read();
      await this._write(store);
      return {
        activeAccountId: store.activeAccountId,
        accounts: store.accounts.map((a) => safeAccount(a, store.activeAccountId)),
      };
    });
  }

  async list() {
    return this._withLock(async () => {
      const store = await this._read();
      const accounts = store.accounts.map((a) => safeAccount(a, store.activeAccountId));
      return { activeAccountId: store.activeAccountId, accounts };
    });
  }

  async getById(id) {
    return this._withLock(async () => {
      const store = await this._read();
      const account = store.accounts.find((a) => a.id === id) || null;
      return safeAccount(account, store.activeAccountId);
    });
  }

  async getRawById(id) {
    return this._withLock(async () => {
      const store = await this._read();
      return store.accounts.find((a) => a.id === id) || null;
    });
  }

  async getActive() {
    return this._withLock(async () => {
      const store = await this._read();
      const active =
        store.accounts.find((a) => a.id === store.activeAccountId) ||
        store.accounts.find((a) => a.enabled !== false) ||
        store.accounts[0] ||
        null;
      return safeAccount(active, store.activeAccountId);
    });
  }

  async getActiveRaw() {
    return this._withLock(async () => {
      const store = await this._read();
      return (
        store.accounts.find((a) => a.id === store.activeAccountId) ||
        store.accounts.find((a) => a.enabled !== false) ||
        store.accounts[0] ||
        null
      );
    });
  }

  async setActive(id) {
    return this._withLock(async () => {
      const store = await this._read();
      const account = store.accounts.find((a) => a.id === id);
      if (!account) {
        const err = new Error("Conta não encontrada");
        err.code = "NOT_FOUND";
        err.status = 404;
        throw err;
      }
      store.activeAccountId = id;
      account.updatedAt = now();
      await this._write(store);
      return safeAccount(account, store.activeAccountId);
    });
  }

  async rename(id, label) {
    return this._withLock(async () => {
      const store = await this._read();
      const account = store.accounts.find((a) => a.id === id);
      if (!account) {
        const err = new Error("Conta não encontrada");
        err.code = "NOT_FOUND";
        err.status = 404;
        throw err;
      }
      const next = normalizeLabel(label, "");
      if (!next) {
        const err = new Error("Label inválido");
        err.code = "INVALID_LABEL";
        err.status = 400;
        throw err;
      }
      account.label = next;
      account.updatedAt = now();
      await this._write(store);
      return safeAccount(account, store.activeAccountId);
    });
  }

  async toggleEnabled(id, enabled) {
    return this._withLock(async () => {
      const store = await this._read();
      const account = store.accounts.find((a) => a.id === id);
      if (!account) {
        const err = new Error("Conta não encontrada");
        err.code = "NOT_FOUND";
        err.status = 404;
        throw err;
      }
      const nextEnabled = typeof enabled === "boolean" ? enabled : account.enabled === false;
      account.enabled = nextEnabled;
      if (nextEnabled) {
        account.cooldownUntil = null;
      }
      account.updatedAt = now();
      await this._write(store);
      return safeAccount(account, store.activeAccountId);
    });
  }

  async updateMetadata(id, patch = {}) {
    return this._withLock(async () => {
      const store = await this._read();
      const account = store.accounts.find((a) => a.id === id);
      if (!account) {
        const err = new Error("Conta não encontrada");
        err.code = "NOT_FOUND";
        err.status = 404;
        throw err;
      }
      if ("label" in patch && patch.label !== undefined) {
        const next = normalizeLabel(patch.label, "");
        if (next) account.label = next;
      }
      if ("username" in patch && patch.username !== undefined) {
        account.username = patch.username ? String(patch.username).trim() : null;
      }
      if ("isPro" in patch && typeof patch.isPro === "boolean") {
        account.isPro = patch.isPro;
      }
      if ("enabled" in patch && typeof patch.enabled === "boolean") {
        account.enabled = patch.enabled;
      }
      if ("lastError" in patch) {
        account.lastError = patch.lastError ? String(patch.lastError).slice(0, 300) : null;
      }
      if ("cooldownUntil" in patch) {
        account.cooldownUntil = typeof patch.cooldownUntil === "number" ? patch.cooldownUntil : null;
      }
      account.updatedAt = now();
      await this._write(store);
      return safeAccount(account, store.activeAccountId);
    });
  }

  async remove(id) {
    return this._withLock(async () => {
      const store = await this._read();
      const idx = store.accounts.findIndex((a) => a.id === id);
      if (idx === -1) {
        const err = new Error("Conta não encontrada");
        err.code = "NOT_FOUND";
        err.status = 404;
        throw err;
      }
      const [removed] = store.accounts.splice(idx, 1);
      if (store.activeAccountId === id) {
        const nextActive = store.accounts.find((a) => a.enabled !== false) || store.accounts[0] || null;
        store.activeAccountId = nextActive?.id ?? null;
      }
      await this._write(store);
      return { removed: safeAccount(removed), activeAccountId: store.activeAccountId };
    });
  }

  async saveFromTokens(tokens, { label, makeActive = true } = {}) {
    const apiKey = tokens?.apiKey || tokens?.api_key || tokens?.accessToken || tokens?.access_token || null;
    const refreshToken = tokens?.refreshToken || tokens?.refresh_token || null;
    if (!tokens || (!apiKey && !refreshToken)) {
      const err = new Error("Tokens ou API key inválidos para persistência");
      err.code = "INVALID_TOKENS";
      err.status = 400;
      throw err;
    }

    return this._withLock(async () => {
      const store = await this._read();
      const ts = now();
      const id = randomId();
      const username =
        (typeof tokens.username === "string" && tokens.username.trim()) ||
        (typeof tokens.user?.login === "string" && tokens.user.login.trim()) ||
        (typeof tokens.email === "string" && tokens.email.trim()) ||
        null;
      const isPro = Boolean(tokens.isPro ?? tokens.is_pro ?? tokens.isProSubscription ?? false);
      const fallbackLabel = username ? `DeepAI (${username})` : `Conta DeepAI ${store.accounts.length + 1}`;

      const account = normalizeAccountRecord(
        {
          id,
          label: normalizeLabel(label, fallbackLabel),
          username,
          isPro,
          authType: "oauth",
          apiKey,
          expiresAt: tokens.expiresAt ?? tokens.expires_at ?? null,
          createdAt: ts,
          updatedAt: ts,
          lastUsedAt: makeActive ? ts : null,
          requestCount: 0,
          errorCount: 0,
          lastError: null,
          enabled: true,
          cooldownUntil: null,
          tokens: {
            accessToken: tokens.accessToken || tokens.access_token || apiKey,
            refreshToken,
            tokenType: tokens.tokenType || "Bearer",
            scope: tokens.scope ?? null,
            expiresAt: tokens.expiresAt ?? tokens.expires_at ?? null,
            obtainedAt: tokens.obtainedAt || ts,
          },
        },
        store.accounts.length,
      );

      store.accounts.push(account);
      if (makeActive || !store.activeAccountId) {
        store.activeAccountId = account.id;
      }

      await this._write(store);
      this.logger?.log?.(
        `[store] conta salva: ${account.id} (${account.label}) active=${store.activeAccountId === account.id}`,
      );
      return safeAccount(account, store.activeAccountId);
    });
  }

  async importApiKey(apiKey, { label, username = null, isPro = false, makeActive = true } = {}) {
    const cleanKey = String(apiKey ?? "").trim();
    if (!cleanKey) {
      const err = new Error("API key não pode ser vazia");
      err.code = "INVALID_API_KEY";
      err.status = 400;
      throw err;
    }

    return this._withLock(async () => {
      const store = await this._read();
      const ts = now();
      const id = randomId();
      const account = normalizeAccountRecord(
        {
          id,
          label: normalizeLabel(label, `API Key ${store.accounts.length + 1}`),
          username: username ? String(username).trim() : null,
          isPro: Boolean(isPro),
          authType: "api_key",
          apiKey: cleanKey,
          createdAt: ts,
          updatedAt: ts,
          lastUsedAt: makeActive ? ts : null,
          enabled: true,
          tokens: {
            accessToken: cleanKey,
            refreshToken: null,
            tokenType: "Bearer",
            obtainedAt: ts,
          },
        },
        store.accounts.length,
      );

      store.accounts.push(account);
      if (makeActive || !store.activeAccountId) {
        store.activeAccountId = account.id;
      }
      await this._write(store);
      this.logger?.log?.(`[store] API key importada: ${account.id} (${account.label})`);
      return safeAccount(account, store.activeAccountId);
    });
  }

  async importCookie(cookie, { label, username = null, isPro = false, makeActive = true } = {}) {
    const cleanCookie = String(cookie ?? "").trim();
    if (!cleanCookie) {
      const err = new Error("Cookie não pode ser vazio");
      err.code = "INVALID_COOKIE";
      err.status = 400;
      throw err;
    }

    return this._withLock(async () => {
      const store = await this._read();
      const ts = now();
      const id = randomId();
      const account = normalizeAccountRecord(
        {
          id,
          label: normalizeLabel(label, `Cookie ${store.accounts.length + 1}`),
          username: username ? String(username).trim() : null,
          isPro: Boolean(isPro),
          authType: "cookie",
          apiKey: null,
          cookie: cleanCookie,
          createdAt: ts,
          updatedAt: ts,
          lastUsedAt: makeActive ? ts : null,
          enabled: true,
          tokens: {
            accessToken: null,
            refreshToken: null,
            tokenType: "Cookie",
            obtainedAt: ts,
          },
        },
        store.accounts.length,
      );

      store.accounts.push(account);
      if (makeActive || !store.activeAccountId) {
        store.activeAccountId = account.id;
      }
      await this._write(store);
      this.logger?.log?.(`[store] Cookie importado: ${account.id} (${account.label})`);
      return safeAccount(account, store.activeAccountId);
    });
  }

  async updateTokens(id, patchTokens = {}) {
    return this._withLock(async () => {
      const store = await this._read();
      const account = store.accounts.find((a) => a.id === id);
      if (!account) {
        const err = new Error("Conta não encontrada");
        err.code = "NOT_FOUND";
        err.status = 404;
        throw err;
      }
      if (patchTokens.apiKey) {
        account.apiKey = patchTokens.apiKey;
      }
      if (patchTokens.accessToken) {
        account.apiKey = account.apiKey || patchTokens.accessToken;
      }
      account.tokens = {
        ...account.tokens,
        ...patchTokens,
      };
      if (patchTokens.expiresAt !== undefined) {
        account.expiresAt = patchTokens.expiresAt;
      }
      account.updatedAt = now();
      await this._write(store);
      return safeAccount(account, store.activeAccountId);
    });
  }

  async selectAccountForRequest(strategy = "round-robin", { excludeIds = [] } = {}) {
    return this._withLock(async () => {
      const store = await this._read();
      const ts = now();
      const excluded = new Set(excludeIds);

      const eligible = store.accounts.filter((a) => {
        if (a.enabled === false) return false;
        if (excluded.has(a.id)) return false;
        if (a.cooldownUntil && a.cooldownUntil > ts) return false;
        return Boolean(a.apiKey || a.tokens?.accessToken || a.cookie);
      });

      if (eligible.length === 0) {
        return null;
      }

      let chosen = null;
      if (strategy === "active") {
        chosen = eligible.find((a) => a.id === store.activeAccountId) || eligible[0];
      } else if (strategy === "failover") {
        const active = eligible.find((a) => a.id === store.activeAccountId);
        if (active && (!active.lastError || active.errorCount === 0)) {
          chosen = active;
        } else {
          const sorted = [...eligible].sort((a, b) => {
            if (a.errorCount !== b.errorCount) return a.errorCount - b.errorCount;
            return (a.lastUsedAt || 0) - (b.lastUsedAt || 0);
          });
          chosen = sorted[0];
        }
      } else {
        // round-robin
        const lastIdx = this._lastRrId ? eligible.findIndex((a) => a.id === this._lastRrId) : -1;
        chosen = eligible[(lastIdx + 1) % eligible.length];
        this._lastRrId = chosen.id;
      }

      return chosen;
    });
  }

  async recordUsage(id, { ok = true, error = null, status = null, cooldownMs = null } = {}) {
    return this._withLock(async () => {
      const store = await this._read();
      const account = store.accounts.find((a) => a.id === id);
      if (!account) return null;

      const ts = now();
      account.requestCount = Number(account.requestCount || 0) + 1;
      account.lastUsedAt = ts;
      account.updatedAt = ts;

      if (ok) {
        account.lastError = null;
        account.cooldownUntil = null;
      } else {
        account.errorCount = Number(account.errorCount || 0) + 1;
        account.lastError = error ? String(error).slice(0, 300) : `HTTP ${status || "error"}`;

        let effectiveCooldown = typeof cooldownMs === "number" ? cooldownMs : 0;
        if (!effectiveCooldown) {
          if (status === 429) effectiveCooldown = 60_000;
          else if (status === 401 || status === 403) effectiveCooldown = 5 * 60_000;
          else if (status >= 500) effectiveCooldown = 15_000;
        }
        if (effectiveCooldown > 0) {
          account.cooldownUntil = ts + effectiveCooldown;
        }
      }

      await this._write(store);
      return safeAccount(account, store.activeAccountId);
    });
  }
}
