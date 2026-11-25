import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const RAW_MODELS = [
  // ---- Free Models (11) ----
  {
    id: "glm-5.3-flash",
    name: "GLM 5.3 Flash",
    provider: "Zhipu AI",
    premier: false,
    theosPerRequest: "0",
    input: ["text", "image"],
    contextWindow: 320000,
    maxTokens: 131072,
    api: "openai-completions",
    thinkingLevelMap: { off: "none" },
    description: "Modelo rápido e gratuito da família GLM com suporte a raciocínio e imagens.",
  },
  {
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash 1017",
    provider: "DeepSeek",
    premier: false,
    theosPerRequest: "0",
    input: ["text", "image"],
    contextWindow: 320000,
    maxTokens: 131072,
    api: "openai-completions",
    thinkingLevelMap: { off: "none" },
    description: "Modelo DeepSeek Flash gratuito com raciocínio e entrada multimodal.",
  },
  {
    id: "mimo-2.6-flash",
    name: "MiMo 2.6 Flash",
    provider: "Xiaomi",
    premier: false,
    theosPerRequest: "0",
    input: ["text", "image"],
    contextWindow: 320000,
    maxTokens: 131072,
    api: "openai-completions",
    thinkingLevelMap: { off: "none" },
    description: "Modelo MiMo Flash gratuito otimizado para velocidade e raciocínio.",
  },
  {
    id: "qwen-3.8-flash",
    name: "Qwen 3.8 Flash",
    provider: "Alibaba",
    premier: false,
    theosPerRequest: "0",
    input: ["text", "image"],
    contextWindow: 320000,
    maxTokens: 128000,
    api: "openai-completions",
    thinkingLevelMap: { off: "none" },
    description: "Modelo Qwen 3.8 Flash gratuito para código, texto e visão.",
  },
  {
    id: "minimax-m3.1-flash",
    name: "MiniMax M3.1 Flash",
    provider: "MiniMax",
    premier: false,
    theosPerRequest: "0",
    input: ["text", "image"],
    contextWindow: 320000,
    maxTokens: 131072,
    api: "openai-completions",
    thinkingLevelMap: { off: "none" },
    description: "Modelo MiniMax M3.1 Flash gratuito com janela de 320k tokens.",
  },
  {
    id: "muse-ember",
    name: "Muse Ember",
    provider: "DeepAI",
    premier: false,
    theosPerRequest: "0",
    input: ["text", "image"],
    contextWindow: 320000,
    maxTokens: 131072,
    api: "openai-completions",
    thinkingLevelMap: { off: "none", max: "max", xhigh: "xhigh" },
    description: "Modelo gratuito com níveis avançados de raciocínio (max e xhigh).",
  },
  {
    id: "solar-mini-4",
    name: "Solar Mini 4",
    provider: "Upstage",
    premier: false,
    theosPerRequest: "0",
    input: ["text"],
    contextWindow: 320000,
    maxTokens: 131072,
    api: "openai-completions",
    thinkingLevelMap: { off: "none" },
    description: "Modelo compacto e gratuito focado em texto e raciocínio rápido.",
  },
  {
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    provider: "OpenAI",
    premier: false,
    theosPerRequest: "0",
    input: ["text", "image"],
    contextWindow: 320000,
    maxTokens: 128000,
    api: "openai-completions",
    thinkingLevelMap: { off: "none" },
    description: "Modelo GPT-6 Luna gratuito com suporte multimodal e raciocínio.",
  },
  {
    id: "mimo-2.6-pro",
    name: "MiMo 2.6 Pro",
    provider: "Xiaomi",
    premier: false,
    theosPerRequest: "0",
    input: ["text", "image"],
    contextWindow: 320000,
    maxTokens: 131072,
    api: "openai-completions",
    thinkingLevelMap: { off: "none" },
    description: "Versão Pro gratuita da linha MiMo 2.6 com suporte a imagem e texto.",
  },
  {
    id: "glyph-cluster",
    name: "Glyph Cluster",
    provider: "DeepAI",
    premier: false,
    theosPerRequest: "0",
    input: ["text"],
    contextWindow: 256000,
    maxTokens: 131072,
    api: "openai-completions",
    thinkingLevelMap: { off: "none" },
    description: "Modelo gratuito especializado em texto com contexto de 256k tokens.",
  },
  {
    id: "deepai-cyber",
    name: "DeepAI Cyber",
    provider: "DeepAI",
    premier: false,
    theosPerRequest: "0",
    input: ["text"],
    contextWindow: 320000,
    maxTokens: 131072,
    api: "openai-completions",
    thinkingLevelMap: { off: "none", max: "max" },
    description: "Modelo gratuito da DeepAI com suporte a raciocínio nível max.",
  },

  // ---- Paid / Pro Models (16) ----
  {
    id: "minimax-m3",
    name: "MiniMax M3",
    provider: "MiniMax",
    premier: true,
    theosPerRequest: "2",
    input: ["text"],
    contextWindow: 320000,
    maxTokens: 131000,
    api: "openai-completions",
    thinkingLevelMap: { off: "none" },
    description: "Modelo MiniMax M3 Pro de alta capacidade (2 Theos/req).",
  },
  {
    id: "glm-5.3",
    name: "GLM 5.3",
    provider: "Zhipu AI",
    premier: true,
    theosPerRequest: "3",
    input: ["text"],
    contextWindow: 320000,
    maxTokens: 131072,
    api: "openai-completions",
    thinkingLevelMap: { off: "none" },
    description: "Modelo completo GLM 5.3 Pro para raciocínio complexo (3 Theos/req).",
  },
  {
    id: "kimi-k3",
    name: "Kimi K3",
    provider: "Moonshot",
    premier: true,
    theosPerRequest: "3",
    input: ["text", "image"],
    contextWindow: 320000,
    maxTokens: 131072,
    api: "openai-completions",
    thinkingLevelMap: { off: "none" },
    description: "Modelo Kimi K3 Pro multimodal com contexto de 320k (3 Theos/req).",
  },
  {
    id: "kimi-k3.1-pro",
    name: "Kimi K3.1 Pro",
    provider: "Moonshot",
    premier: true,
    theosPerRequest: "3",
    input: ["text", "image"],
    contextWindow: 320000,
    maxTokens: 131072,
    api: "openai-completions",
    thinkingLevelMap: { off: "none" },
    description: "Versão aprimorada Kimi K3.1 Pro multimodal (3 Theos/req).",
  },
  {
    id: "gpt-6.1-terra",
    name: "GPT-6.1 Terra",
    provider: "OpenAI",
    premier: true,
    theosPerRequest: "5",
    input: ["text", "image"],
    contextWindow: 320000,
    maxTokens: 128000,
    api: "openai-completions",
    thinkingLevelMap: { off: "none" },
    description: "Modelo GPT-6.1 Terra Pro equilibrado entre custo e inteligência (5 Theos/req).",
  },
  {
    id: "muse-spark-1.3",
    name: "Muse Spark 1.3",
    provider: "DeepAI",
    premier: true,
    theosPerRequest: "6",
    input: ["text", "image"],
    contextWindow: 320000,
    maxTokens: 131072,
    api: "openai-completions",
    thinkingLevelMap: { off: "none" },
    description: "Modelo Muse Spark 1.3 Pro multimodal com raciocínio avançado (6 Theos/req).",
  },
  {
    id: "gemini-4-hydrogen",
    name: "Gemini 4 Hydrogen",
    provider: "Google",
    premier: true,
    theosPerRequest: "8",
    input: ["text", "image"],
    contextWindow: 320000,
    maxTokens: 131072,
    api: "openai-completions",
    thinkingLevelMap: { off: "none" },
    description: "Modelo Gemini 4 Hydrogen Pro rápido e multimodal (8 Theos/req).",
  },
  {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    provider: "OpenAI",
    premier: true,
    theosPerRequest: "10",
    input: ["text", "image"],
    contextWindow: 320000,
    maxTokens: 128000,
    api: "openai-completions",
    thinkingLevelMap: { off: "none" },
    description: "Modelo GPT-6.1 Sol Pro de alto desempenho (10 Theos/req).",
  },
  {
    id: "gemini-4-argon",
    name: "Gemini 4 Argon",
    provider: "Google",
    premier: true,
    theosPerRequest: "10",
    input: ["text", "image"],
    contextWindow: 320000,
    maxTokens: 131072,
    api: "openai-completions",
    thinkingLevelMap: { off: "none" },
    description: "Modelo Gemini 4 Argon Pro para engenharia e raciocínio (10 Theos/req).",
  },
  {
    id: "gemini-4-carbon",
    name: "Gemini 4 Carbon",
    provider: "Google",
    premier: true,
    theosPerRequest: "10",
    input: ["text", "image"],
    contextWindow: 320000,
    maxTokens: 131072,
    api: "openai-completions",
    thinkingLevelMap: { off: "none" },
    description: "Modelo Gemini 4 Carbon Pro multimodal de alta precisão (10 Theos/req).",
  },
  {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    provider: "Anthropic",
    premier: true,
    theosPerRequest: "10",
    input: ["text", "image"],
    contextWindow: 320000,
    maxTokens: 64000,
    api: "openai-completions",
    thinkingLevelMap: { off: "none" },
    description: "Modelo Claude Sonnet 5.5 Pro excelente para programação e agentes (10 Theos/req).",
  },
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    provider: "Anthropic",
    premier: true,
    theosPerRequest: "15",
    input: ["text", "image"],
    contextWindow: 320000,
    maxTokens: 64000,
    api: "openai-completions",
    thinkingLevelMap: { off: "none" },
    description: "Modelo Claude Opus 5.5 Pro de máxima capacidade analítica (15 Theos/req).",
  },
  {
    id: "muse-wonder",
    name: "Muse Wonder",
    provider: "DeepAI",
    premier: true,
    theosPerRequest: "15",
    input: ["text", "image"],
    contextWindow: 320000,
    maxTokens: 131072,
    api: "openai-completions",
    thinkingLevelMap: { off: "none" },
    description: "Modelo Muse Wonder Pro multimodal de alto nível (15 Theos/req).",
  },
  {
    id: "qwen-3.8-max-prime",
    name: "Qwen 3.8 Max Prime",
    provider: "Alibaba",
    premier: true,
    theosPerRequest: "15",
    input: ["text", "image"],
    contextWindow: 320000,
    maxTokens: 131072,
    api: "openai-completions",
    thinkingLevelMap: { off: "none" },
    description: "Modelo Qwen 3.8 Max Prime Pro para raciocínio profundo (15 Theos/req).",
  },
  {
    id: "claude-fable-5-2",
    name: "Claude Fable 5.2",
    provider: "Anthropic",
    premier: true,
    theosPerRequest: "20",
    input: ["text", "image"],
    contextWindow: 320000,
    maxTokens: 64000,
    api: "openai-completions",
    thinkingLevelMap: { off: "none" },
    description: "Modelo Claude Fable 5.2 Pro avançado para tarefas complexas (20 Theos/req).",
  },
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    provider: "OpenAI",
    premier: true,
    theosPerRequest: "50",
    input: ["text", "image"],
    contextWindow: 320000,
    maxTokens: 128000,
    api: "openai-responses",
    thinkingLevelMap: { off: "none" },
    description: "Modelo flagship GPT-6 Astra Pro via Responses API (50 Theos/req).",
  },
];

// ---------------------------------------------------------------------------
// Live catalog
//
// The DeepAI Code desktop app keeps a complete, always-current model catalog on
// disk. Rather than duplicating it by hand (and going stale every release), we
// read that file. When it is missing we fall back to the static list above.
// ---------------------------------------------------------------------------

const HOME = os.homedir();

/** Paths the desktop app writes its catalog to, most authoritative first. */
const CATALOG_CANDIDATES = [
  path.join(HOME, ".deepai-code", "userdata", "deepai", "pi", "deepai", "models.json"),
  path.join(HOME, ".deepai-code", "caches", "deepai.json"),
];

const PROVIDERS = new Map(
  RAW_MODELS.map((m) => [m.id, m.provider]),
);

function resolveCatalogPath() {
  if (process.env.DEEPAI_MODELS_FILE) {
    return { file: path.resolve(process.env.DEEPAI_MODELS_FILE), candidates: [] };
  }
  return { file: null, candidates: CATALOG_CANDIDATES };
}

function toEntry(raw) {
  const id = String(raw?.id || raw?.slug || "").replace(/^deepai\//, "").trim();
  if (!id) return null;

  const input = Array.isArray(raw.input)
    ? raw.input.filter((v) => v === "text" || v === "image")
    : ["text"];

  const contextWindow = Number(raw.contextWindow);
  const maxTokens = Number(raw.maxTokens);

  const thinkingLevelMap =
    raw?.thinkingLevelMap && typeof raw.thinkingLevelMap === "object"
      ? { ...raw.thinkingLevelMap }
      : { off: "none" };

  const premier = raw.premier === true;

  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
    provider: PROVIDERS.get(id) || "DeepAI",
    tier: premier ? "paid" : "free",
    isPro: premier,
    premier,
    theosPerRequest: typeof raw.theosPerRequest === "string" ? raw.theosPerRequest : "0",
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 128000,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 16384,
    api: raw.api === "openai-responses" ? "openai-responses" : "openai-completions",
    capabilities: {
      reasoning: raw.reasoning !== false,
      vision: input.includes("image"),
      input,
      thinkingLevelMap,
    },
    description: "",
  };
}

/** Accepts either the app's pi models.json or the caches/deepai.json shape. */
function extractRawModels(parsed) {
  const pi = parsed?.providers?.deepai?.models;
  if (Array.isArray(pi)) return pi;

  const cached = parsed?.models;
  if (Array.isArray(cached)) {
    return cached.map((m) => ({
      ...m,
      id: m.id ?? String(m.slug || "").replace(/^deepai\//, ""),
      // The cache omits input/reasoning; infer from the capability descriptors.
      input: m.input ?? (Array.isArray(m.capabilities?.input) ? m.capabilities.input : ["text", "image"]),
      reasoning: m.reasoning !== false,
    }));
  }

  if (Array.isArray(parsed)) return parsed;
  return null;
}

const STATIC_ENTRIES = RAW_MODELS.map((m) => ({
  id: m.id,
  name: m.name,
  provider: m.provider,
  tier: m.premier ? "paid" : "free",
  isPro: Boolean(m.premier),
  premier: Boolean(m.premier),
  theosPerRequest: m.theosPerRequest,
  contextWindow: m.contextWindow,
  maxTokens: m.maxTokens,
  api: m.api,
  capabilities: {
    reasoning: true,
    vision: m.input.includes("image"),
    input: [...m.input],
    thinkingLevelMap: { ...m.thinkingLevelMap },
  },
  description: m.description,
}));

/** Preserve curated descriptions for ids we already know about. */
const STATIC_BY_ID = new Map(STATIC_ENTRIES.map((m) => [m.id, m]));

function withDescriptions(entries) {
  return entries.map((entry) => {
    const known = STATIC_BY_ID.get(entry.id);
    if (known?.description) return { ...entry, description: known.description };
    const vision = entry.capabilities.vision ? "texto e imagem" : "texto";
    const tier = entry.premier ? "Pro" : "gratuito";
    return {
      ...entry,
      description: `Modelo ${tier} (${vision}) com contexto de ${entry.contextWindow.toLocaleString("pt-BR")} tokens.`,
    };
  });
}

let currentEntries = STATIC_ENTRIES;
let currentSource = "static";
let currentSourceFile = null;
let currentMtimeMs = 0;
let loadedAt = null;
let lastError = null;
let watcher = null;
let lastStatAt = 0;

const STAT_TTL_MS = 2000;

function applyEntries(entries, source, file, mtimeMs) {
  if (!entries.length) return false;
  currentEntries = withDescriptions(entries);
  currentSource = source;
  currentSourceFile = file;
  currentMtimeMs = mtimeMs;
  loadedAt = Date.now();
  lastError = null;
  return true;
}

function readSync(file) {
  const raw = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(raw);
  const list = extractRawModels(parsed);
  if (!list) return null;
  return list.map(toEntry).filter(Boolean);
}

/**
 * Load the catalog from disk. Synchronous on purpose: callers include request
 * handlers that need a model resolved immediately.
 */
export function refreshModels({ force = false } = {}) {
  const { file: pinned, candidates } = resolveCatalogPath();
  const files = pinned ? [pinned] : candidates;

  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!force && stat.mtimeMs === currentMtimeMs && currentSource === "app") {
      return { ok: true, updated: false, source: "app", file, count: currentEntries.length };
    }
    try {
      const entries = readSync(file);
      if (!entries || !entries.length) continue;
      const updated = applyEntries(entries, "app", file, stat.mtimeMs);
      return {
        ok: true,
        updated: Boolean(updated),
        source: "app",
        file,
        count: currentEntries.length,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  if (currentSource !== "static") {
    return {
      ok: true,
      updated: false,
      source: currentSource,
      file: currentSourceFile,
      count: currentEntries.length,
      error: lastError,
    };
  }
  return { ok: false, source: "static", file: null, count: currentEntries.length, error: lastError };
}

/** Cheap staleness check so new models appear without a restart. */
function ensureFresh() {
  const now = Date.now();
  if (now - lastStatAt < STAT_TTL_MS) return;
  lastStatAt = now;
  refreshModels();
}

export function startModelsWatcher({ logger = console } = {}) {
  const result = refreshModels({ force: true });
  if (result.source === "app") {
    logger?.log?.(`[models] catálogo carregado do app: ${result.count} modelos (${result.file})`);
  } else {
    logger?.warn?.(
      `[models] catálogo do app não encontrado; usando lista estática (${currentEntries.length} modelos).`,
    );
  }

  const target = currentSourceFile || CATALOG_CANDIDATES[0];
  if (watcher || !target) return result;

  try {
    const dir = path.dirname(target);
    const base = path.basename(target);
    watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
      if (filename && String(filename) !== base) return;
      const next = refreshModels({ force: true });
      if (next.ok && next.source === "app") {
        logger?.log?.(`[models] catálogo atualizado: ${next.count} modelos`);
      }
    });
    watcher.on?.("error", () => {
      try {
        watcher?.close?.();
      } catch {
        // ignore
      }
      watcher = null;
    });
  } catch {
    // Watching is best-effort; the TTL check still catches updates.
  }

  return result;
}

export function getCatalogInfo() {
  return {
    source: currentSource,
    file: currentSourceFile,
    count: currentEntries.length,
    loadedAt,
    error: lastError,
  };
}

export function getModels() {
  ensureFresh();
  return currentEntries;
}

/** Kept for backwards compatibility; resolves to the live list. */
export function getDeepAiModels() {
  return getModels();
}

export function normalizeModelId(modelId) {
  const raw = String(modelId || "").trim();
  if (raw.startsWith("deepai/")) {
    return raw.slice("deepai/".length);
  }
  return raw;
}

export function getModelById(modelId) {
  const normalized = normalizeModelId(modelId);
  if (!normalized) return null;
  ensureFresh();
  return currentEntries.find((m) => m.id === normalized) || null;
}

export function listOpenAiModels() {
  const models = getModels();
  return {
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created: 1735689600,
      owned_by: "deepai",
      name: m.name,
      provider: m.provider,
      tier: m.tier,
      is_pro: m.isPro,
      context_window: m.contextWindow,
    })),
  };
}

export function listDashboardModels({ tier = "all", search = "" } = {}) {
  const normalizedTier = String(tier || "all").toLowerCase();
  const q = String(search || "").trim().toLowerCase();
  const models = getModels();

  const freeCount = models.filter((m) => m.tier === "free").length;
  const paidCount = models.filter((m) => m.tier === "paid").length;

  const filtered = models.filter((m) => {
    if (normalizedTier === "free" && m.tier !== "free") return false;
    if ((normalizedTier === "paid" || normalizedTier === "pro") && m.tier !== "paid") return false;
    if (q) {
      const hay = `${m.id} ${m.name} ${m.provider} ${m.description}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return {
    models: filtered,
    counts: {
      total: models.length,
      free: freeCount,
      paid: paidCount,
      filtered: filtered.length,
    },
  };
}
