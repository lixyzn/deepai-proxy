/**
 * Aliases de compatibilidade para clientes que têm nomes de modelos fixos.
 * Regra de ouro: alias só aponta para modelo grátis. Nunca redireciona uma
 * requisição para um modelo pago/predador sem o usuário escolher.
 */
const EXACT = new Map([
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

const PATTERNS = [
  [/^gpt-(?:3\.5|4o|4\.1|4\.5|5)(?:$|[-.])/i, "gpt-6-luna"],
  [/^o[1-9](?:$|[-.])/i, "gpt-6-luna"],
  [/^deepseek-(?:chat|reasoner|v3|r1)(?:$|[-.])/i, "deepseek-v4.1-flash"],
  [/^qwen-(?:max|plus|turbo|2\.5|3)(?:$|[-.])/i, "qwen-3.8-flash"],
  [/^glm-(?:4)(?:$|[-.])/i, "glm-5.3-flash"],
  [/^minimax-(?:m1|m2|abab)(?:$|[-.])/i, "minimax-m3.1-flash"],
  [/^mimo-(?:v?2)(?:$|[-.])/i, "mimo-2.6-flash"],
];

export function resolveModelAlias(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return raw;
  const withoutPrefix = raw.replace(/^deepai\//, "");
  const exact = EXACT.get(withoutPrefix.toLowerCase());
  if (exact) return exact;
  for (const [pattern, target] of PATTERNS) {
    if (pattern.test(withoutPrefix)) return target;
  }
  return raw;
}

export function aliasEntries() {
  return [...EXACT.entries()].map(([alias, target]) => ({ alias, target }));
}
