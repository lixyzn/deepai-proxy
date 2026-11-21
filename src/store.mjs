import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.DEEPAI_PROXY_DATA
  ? path.resolve(process.env.DEEPAI_PROXY_DATA)
  : path.join(ROOT, "data");

const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const ACCOUNTS_PATH = path.join(DATA_DIR, "accounts.json");
const KEY_PATH = path.join(DATA_DIR, "secret.key");

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function atomicWrite(file, contents, mode = 0o600) {
  ensureDataDir();
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, contents, { mode });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, mode);
  } catch {
    // Windows não implementa chmod do POSIX; a ACL do usuário continua valendo.
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function newToken(prefix, bytes = 24) {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

function encryptionKey() {
  ensureDataDir();
  try {
    const hex = fs.readFileSync(KEY_PATH, "utf8").trim();
    if (/^[a-f0-9]{64}$/i.test(hex)) return Buffer.from(hex, "hex");
  } catch {
    // gera abaixo
  }
  const key = randomBytes(32);
  atomicWrite(KEY_PATH, key.toString("hex"));
  return key;
}

export function encryptSecret(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plain), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(payload) {
  const [version, ivPart, tagPart, dataPart] = String(payload).split(".");
  if (version !== "v1" || !ivPart || !tagPart || !dataPart) {
    throw new Error("Credencial armazenada em formato desconhecido.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivPart, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function hashSecret(secret) {
  return createHash("sha256").update(String(secret)).digest("hex");
}

function defaultConfig() {
  return {
    version: 2,
    initialized: false,
    adminPassword: null,
    proxyToken: newToken("dai", 26),
    activeAccountId: null,
    createdAt: new Date().toISOString(),
  };
}

let configCache = null;

export function loadConfig() {
  ensureDataDir();
  if (configCache) return configCache;
  const existing = readJson(CONFIG_PATH, null);
  configCache = { ...defaultConfig(), ...(existing ?? {}) };
  if (configCache.adminToken) delete configCache.adminToken;
  if (!existing) saveConfig(configCache);
  return configCache;
}

export function saveConfig(config) {
  configCache = config;
  atomicWrite(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

export function rotateProxyToken() {
  const config = loadConfig();
  config.proxyToken = newToken("dai", 26);
  saveConfig(config);
  return config.proxyToken;
}

export function isAdminInitialized() {
  const config = loadConfig();
  return Boolean(config.initialized && config.adminPassword?.salt && config.adminPassword?.hash);
}

export function setAdminPassword(password) {
  const value = String(password);
  if (value.length < 8 || value.length > 200) {
    throw new Error("A senha precisa ter entre 8 e 200 caracteres.");
  }
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(value, salt, 64).toString("hex");
  const config = loadConfig();
  config.adminPassword = {
    salt,
    hash,
    updatedAt: new Date().toISOString(),
  };
  config.initialized = true;
  saveConfig(config);
}

export function verifyAdminPassword(password) {
  const record = loadConfig().adminPassword;
  if (!record?.salt || !record?.hash) return false;
  const expected = Buffer.from(record.hash, "hex");
  if (expected.length === 0) return false;
  const actual = scryptSync(String(password), record.salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function resetAdminPassword() {
  const config = loadConfig();
  config.initialized = false;
  config.adminPassword = null;
  saveConfig(config);
}

let accountsCache = null;

function loadAccountsFile() {
  if (accountsCache) return accountsCache;
  const data = readJson(ACCOUNTS_PATH, { version: 1, accounts: [] });
  accountsCache = {
    version: 1,
    accounts: Array.isArray(data.accounts) ? data.accounts : [],
  };
  return accountsCache;
}

function saveAccounts() {
  atomicWrite(
    ACCOUNTS_PATH,
    `${JSON.stringify(loadAccountsFile(), null, 2)}\n`,
  );
}

export function listAccounts() {
  return loadAccountsFile().accounts;
}

export function getAccount(id) {
  return listAccounts().find((account) => account.id === id) ?? null;
}

export function getActiveAccount() {
  const config = loadConfig();
  const accounts = listAccounts();
  const active = accounts.find((account) => account.id === config.activeAccountId);
  return active ?? accounts[0] ?? null;
}

export function setActiveAccount(id) {
  const account = getAccount(id);
  if (!account) throw new Error("Conta não encontrada.");
  const config = loadConfig();
  config.activeAccountId = id;
  saveConfig(config);
  return account;
}

export function upsertAccount(credentials, options = {}) {
  const apiKey = String(credentials.apiKey ?? "").trim();
  if (!apiKey || /[\r\n]/.test(apiKey)) {
    throw new Error("A DeepAI devolveu uma API key inválida.");
  }
  const keyHash = hashSecret(apiKey);
  const accounts = loadAccountsFile().accounts;
  const now = new Date().toISOString();
  const existing = accounts.find((account) => account.keyHash === keyHash);

  if (existing) {
    existing.username = credentials.username || existing.username;
    existing.isPro = Boolean(credentials.isPro);
    existing.apiKeyEnc = encryptSecret(apiKey);
    existing.keyLast4 = apiKey.slice(-4);
    existing.updatedAt = now;
    if (options.label) existing.label = options.label;
    saveAccounts();
    setActiveAccount(existing.id);
    return { account: existing, created: false };
  }

  const account = {
    id: `acc_${randomBytes(9).toString("hex")}`,
    username: String(credentials.username ?? "").slice(0, 120),
    isPro: Boolean(credentials.isPro),
    label: String(options.label ?? "").slice(0, 80),
    apiKeyEnc: encryptSecret(apiKey),
    keyHash,
    keyLast4: apiKey.slice(-4),
    createdAt: now,
    updatedAt: now,
    lastCheckInAt: null,
  };
  accounts.push(account);
  saveAccounts();
  setActiveAccount(account.id);
  return { account, created: true };
}

export function deleteAccount(id) {
  const data = loadAccountsFile();
  const index = data.accounts.findIndex((account) => account.id === id);
  if (index === -1) return false;
  data.accounts.splice(index, 1);
  saveAccounts();
  const config = loadConfig();
  if (config.activeAccountId === id) {
    config.activeAccountId = data.accounts[0]?.id ?? null;
    saveConfig(config);
  }
  return true;
}

export function touchCheckIn(id, at = new Date().toISOString()) {
  const account = getAccount(id);
  if (!account) return null;
  account.lastCheckInAt = at;
  saveAccounts();
  return account;
}

export function touchAllowance(id, allowance) {
  const account = getAccount(id);
  if (!account || !allowance) return null;
  account.allowance = {
    ...allowance,
    checkedAt: allowance.checkedAt ?? new Date().toISOString(),
  };
  saveAccounts();
  return account;
}

export function touchEntitlement(id, entitlement) {
  const account = getAccount(id);
  if (!account || !entitlement) return null;
  account.entitlement = {
    ...entitlement,
    checkedAt: entitlement.checkedAt ?? new Date().toISOString(),
  };
  if (entitlement.isPro === true) account.isPro = true;
  else if (entitlement.isPro === false) account.isPro = false;
  saveAccounts();
  return account;
}

export function accountSecret(account) {
  return decryptSecret(account.apiKeyEnc);
}

export function publicAccount(account) {
  if (!account) return null;
  const active = getActiveAccount();
  return {
    id: account.id,
    username: account.username || "",
    isPro: Boolean(account.isPro),
    label: account.label || "",
    keyLast4: account.keyLast4 || "",
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastCheckInAt: account.lastCheckInAt,
    allowance: account.allowance ?? null,
    entitlement: account.entitlement ?? null,
    active: active?.id === account.id,
  };
}

export function publicAccounts() {
  return listAccounts().map(publicAccount);
}

export function dataPaths() {
  return { dataDir: DATA_DIR, config: CONFIG_PATH, accounts: ACCOUNTS_PATH };
}
