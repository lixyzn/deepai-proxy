/**
 * Aliases de compatibilidade para clientes que têm nomes de modelos fixos.
 * Regra de ouro: alias só aponta para modelo da mesma tier (free→free, paid→paid).
 * Nunca redireciona uma requisição para um modelo de tier diferente sem o usuário escolher.
 */
const FREE_ALIASES = new Map([
  ["gpt-4o", "gpt-6-luna"],
  ["gpt-4o-mini", "gpt-6-luna"],
  ["gpt-4.1", "gpt-6-luna"],
  ["gpt-4.1-mini", "gpt-6-luna"],
  ["gpt-4.5", "gpt-6-luna"],
  ["gpt-5", "gpt-6-luna"],
  ["gpt-5-mini", "gpt-6-luna"],
  ["gpt-3.5-turbo", "gpt-6-luna"],
  ["o1", "gpt-6-luna"],
  ["o1-mini", "gpt-6-luna"],
  ["o3", "gpt-6-luna"],
  ["o3-mini", "gpt-6-luna"],
  ["o4-mini", "gpt-6-luna"],
  ["deepseek-chat", "deepseek-v4.1-flash"],
  ["deepseek-reasoner", "deepseek-v4.1-flash"],
  ["deepseek-v3", "deepseek-v4.1-flash"],
  ["deepseek-r1", "deepseek-v4.1-flash"],
  ["qwen-max", "qwen-3.8-flash"],
  ["qwen-plus", "qwen-3.8-flash"],
  ["qwen-turbo", "qwen-3.8-flash"],
  ["glm-4", "glm-5.3-flash"],
  ["glm-4.5", "glm-5.3-flash"],
  ["glm-4.6", "glm-5.3-flash"],
  ["minimax-m1", "minimax-m3.1-flash"],
  ["minimax-m2", "minimax-m3.1-flash"],
  ["mimo-v2", "mimo-2.6-flash"],
  ["mimo-2", "mimo-2.6-flash"],
]);

const PAID_ALIASES = new Map([
  ["gpt-4o", "gpt-6-astra"],
  ["gpt-4o-mini", "gpt-6-astra"],
  ["gpt-4.1", "gpt-6-astra"],
  ["gpt-4.1-mini", "gpt-6-astra"],
  ["gpt-4.5", "gpt-6-astra"],
  ["gpt-5", "gpt-6-astra"],
  ["gpt-5-mini", "gpt-6-astra"],
  ["gpt-3.5-turbo", "gpt-6-astra"],
  ["o1", "gpt-6-astra"],
  ["o1-mini", "gpt-6-astra"],
  ["o3", "gpt-6-astra"],
  ["o3-mini", "gpt-6-astra"],
  ["o4-mini", "gpt-6-astra"],
  ["deepseek-chat", "deepseek-v4.1-flash"],
  ["deepseek-reasoner", "deepseek-v4.1-flash"],
  ["deepseek-v3", "deepseek-v4.1-flash"],
  ["deepseek-r1", "deepseek-v4.1-flash"],
  ["qwen-max", "qwen-3.8-max-prime"],
  ["qwen-plus", "qwen-3.8-max-prime"],
  ["qwen-turbo", "qwen-3.8-flash"],
  ["glm-4", "glm-5.3"],
  ["glm-4.5", "glm-5.3"],
  ["glm-4.6", "glm-5.3"],
  ["minimax-m1", "minimax-m3"],
  ["minimax-m2", "minimax-m3"],
  ["mimo-v2", "mimo-2.6-pro"],
  ["mimo-2", "mimo-2.6-pro"],
]);

const PATTERNS_FREE = [
  [/^gpt-(?:3\.5|4o|4\.1|4\.5|5)(?:$|[-.])/i, "gpt-6-luna"],
  [/^o[1-9](?:$|[-.])/i, "gpt-6-luna"],
  [/^deepseek-(?:chat|reasoner|v3|r1)(?:$|[-.])/i, "deepseek-v4.1-flash"],
  [/^qwen-(?:max|plus|turbo|2\.5|3)(?:$|[-.])/i, "qwen-3.8-flash"],
  [/^glm-(?:4)(?:$|[-.])/i, "glm-5.3-flash"],
  [/^minimax-(?:m1|m2|abab)(?:$|[-.])/i, "minimax-m3.1-flash"],
  [/^mimo-(?:v?2)(?:$|[-.])/i, "mimo-2.6-flash"],
];

const PATTERNS_PAID = [
  [/^gpt-(?:3\.5|4o|4\.1|4\.5|5)(?:$|[-.])/i, "gpt-6-astra"],
  [/^o[1-9](?:$|[-.])/i, "gpt-6-astra"],
  [/^deepseek-(?:chat|reasoner|v3|r1)(?:$|[-.])/i, "deepseek-v4.1-flash"],
  [/^qwen-(?:max|plus|turbo|2\.5|3)(?:$|[-.])/i, "qwen-3.8-max-prime"],
  [/^glm-(?:4)(?:$|[-.])/i, "glm-5.3"],
  [/^minimax-(?:m1|m2|abab)(?:$|[-.])/i, "minimax-m3"],
  [/^mimo-(?:v?2)(?:$|[-.])/i, "mimo-2.6-pro"],
];

function getAccountTier(cachedCatalog) {
  if (!cachedCatalog) return "free";
  // If any model in catalog is paid, account has paid access
  return cachedCatalog.data.some((m) => m.free === false || m.tier === "paid") ? "paid" : "free";
}

function isFreeModel(modelId, cachedCatalog) {
  if (!cachedCatalog) return true;
  const entry = cachedCatalog.data.find(
    (m) => m.slug === modelId || m.id === `deepai/${modelId}` || m.id === modelId,
  );
  // If model not in catalog, infer from account tier
  if (!entry) return getAccountTier(cachedCatalog) === "free";
  return entry?.free === true || entry?.tier === "free";
}

export function resolveModelAlias(value, account = null, cachedCatalog = null) {
  const raw = String(value ?? "").trim();
  if (!raw) return raw;
  const withoutPrefix = raw.replace(/^deepai\//, "");
  const lower = withoutPrefix.toLowerCase();
  
  const isFree = isFreeModel(withoutPrefix, cachedCatalog);
  const exactMap = isFree ? FREE_ALIASES : PAID_ALIASES;
  const patterns = isFree ? PATTERNS_FREE : PATTERNS_PAID;
  
  const exact = exactMap.get(lower);
  if (exact) return exact;
  for (const [pattern, target] of patterns) {
    if (pattern.test(withoutPrefix)) return target;
  }
  return raw;
}

export function aliasEntries() {
  return [...FREE_ALIASES.entries()].map(([alias, target]) => ({ alias, target, tier: "free" }))
    .concat([...PAID_ALIASES.entries()].map(([alias, target]) => ({ alias, target, tier: "paid" })));
}
