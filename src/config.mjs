import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { normalizeContextSettings } from "./context.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

export const VALID_ROTATION_STRATEGIES = ["round-robin", "active", "failover"];

export function generateProxyApiKey() {
  return `dp-proxy-${crypto.randomBytes(24).toString("base64url")}`;
}

export function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (!a || !b) return false;
  const left = crypto.createHash("sha256").update(a, "utf8").digest();
  const right = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(left, right);
}

export function extractApiKeyFromHeaders(headersOrReq) {
  const headers = headersOrReq?.headers ?? headersOrReq;
  if (!headers) return "";

  const getHeader = (name) => {
    if (typeof headers.get === "function") {
      return headers.get(name) || "";
    }
    const lower = name.toLowerCase();
    const raw = headers[lower] ?? headers[name];
    if (Array.isArray(raw)) return String(raw[0] ?? "");
    return typeof raw === "string" ? raw : "";
  };

  const auth = getHeader("authorization").trim();
  if (auth) {
    const match = /^bearer\s+(.+)$/i.exec(auth);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  const xApiKey = getHeader("x-api-key").trim();
  if (xApiKey) return xApiKey;

  return "";
}

function normalizeConfig(raw = {}) {
  const strategy = VALID_ROTATION_STRATEGIES.includes(raw.rotationStrategy)
    ? raw.rotationStrategy
    : "round-robin";
  const requireApiKey = typeof raw.requireApiKey === "boolean" ? raw.requireApiKey : true;
  const defaultModel =
    typeof raw.defaultModel === "string" && raw.defaultModel.trim()
      ? raw.defaultModel.trim().slice(0, 120)
      : "glm-5.3-flash";
  const proxyApiKey =
    typeof raw.proxyApiKey === "string" && raw.proxyApiKey.trim()
      ? raw.proxyApiKey.trim()
      : generateProxyApiKey();

  return {
    version: 1,
    proxyApiKey,
    requireApiKey,
    rotationStrategy: strategy,
    defaultModel,
    contextManagement: normalizeContextSettings(raw.contextManagement),
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
  };
}

export class ConfigStore {
  constructor({ logger = console, filePath = CONFIG_FILE } = {}) {
    this.logger = logger;
    this.filePath = filePath;
    this._lock = Promise.resolve();
    this._cache = null;
  }

  async _withLock(fn) {
    const run = this._lock.then(fn, fn);
    this._lock = run.then(() => undefined, () => undefined);
    return run;
  }

  async _readFromDisk() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") throw new Error("invalid config");
      const normalized = normalizeConfig(parsed);
      const needsRewrite =
        !parsed.proxyApiKey ||
        typeof parsed.requireApiKey !== "boolean" ||
        !VALID_ROTATION_STRATEGIES.includes(parsed.rotationStrategy);
      if (needsRewrite) {
        await this._writeToDisk(normalized);
      }
      return normalized;
    } catch (err) {
      if (err?.code !== "ENOENT") {
        const backup = `${this.filePath}.corrupt-${Date.now()}.bak`;
        await fs.copyFile(this.filePath, backup).catch(() => {});
      }
      const initial = normalizeConfig({});
      await this._writeToDisk(initial);
      return initial;
    }
  }

  async _writeToDisk(config) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(config, null, 2), "utf8");
    await fs.rename(tmp, this.filePath);
    this._cache = { ...config };
  }

  async init() {
    return this._withLock(async () => {
      const config = await this._readFromDisk();
      this._cache = { ...config };
      return { ...config };
    });
  }

  async get() {
    return this._withLock(async () => {
      if (!this._cache) {
        const config = await this._readFromDisk();
        this._cache = { ...config };
      }
      return { ...this._cache };
    });
  }

  getSync() {
    return this._cache ? { ...this._cache } : null;
  }

  async update(patch = {}) {
    if (!patch || typeof patch !== "object") {
      const err = new Error("Configuração inválida");
      err.code = "INVALID_CONFIG";
      err.status = 400;
      throw err;
    }

    return this._withLock(async () => {
      const current = this._cache || (await this._readFromDisk());
      const next = { ...current };

      if ("requireApiKey" in patch) {
        if (typeof patch.requireApiKey !== "boolean") {
          const err = new Error("requireApiKey deve ser booleano");
          err.code = "INVALID_CONFIG";
          err.status = 400;
          throw err;
        }
        next.requireApiKey = patch.requireApiKey;
      }

      if ("rotationStrategy" in patch) {
        if (!VALID_ROTATION_STRATEGIES.includes(patch.rotationStrategy)) {
          const err = new Error(
            `rotationStrategy inválido. Use: ${VALID_ROTATION_STRATEGIES.join(", ")}`,
          );
          err.code = "INVALID_CONFIG";
          err.status = 400;
          throw err;
        }
        next.rotationStrategy = patch.rotationStrategy;
      }

      if ("defaultModel" in patch) {
        const model = String(patch.defaultModel ?? "").trim();
        if (!model) {
          const err = new Error("defaultModel não pode ser vazio");
          err.code = "INVALID_CONFIG";
          err.status = 400;
          throw err;
        }
        next.defaultModel = model.slice(0, 120);
      }

      if ("proxyApiKey" in patch && patch.proxyApiKey !== undefined) {
        const key = String(patch.proxyApiKey ?? "").trim();
        if (key.length < 8) {
          const err = new Error("proxyApiKey deve ter pelo menos 8 caracteres");
          err.code = "INVALID_CONFIG";
          err.status = 400;
          throw err;
        }
        next.proxyApiKey = key;
      }

      if ("contextManagement" in patch && patch.contextManagement && typeof patch.contextManagement === "object") {
        next.contextManagement = normalizeContextSettings({
          ...(current.contextManagement || {}),
          ...patch.contextManagement,
        });
      }

      next.updatedAt = Date.now();
      await this._writeToDisk(next);
      return { ...next };
    });
  }

  async rotateKey() {
    return this._withLock(async () => {
      const current = this._cache || (await this._readFromDisk());
      const next = {
        ...current,
        proxyApiKey: generateProxyApiKey(),
        updatedAt: Date.now(),
      };
      await this._writeToDisk(next);
      this.logger?.log?.("[config] proxyApiKey rotacionada");
      return { ...next };
    });
  }

  async validateRequest(reqOrHeaders) {
    const config = await this.get();
    if (!config.requireApiKey) {
      return { ok: true, required: false };
    }
    const provided = extractApiKeyFromHeaders(reqOrHeaders);
    if (!provided) {
      return { ok: false, required: true, reason: "missing_api_key" };
    }
    if (!constantTimeEqual(provided, config.proxyApiKey)) {
      return { ok: false, required: true, reason: "invalid_api_key" };
    }
    return { ok: true, required: true };
  }
}
