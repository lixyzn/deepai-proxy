const FAMILIES = [
  {
    family: "claude",
    label: "Anthropic",
    logo: "/logos/claude.svg",
    color: "#D97757",
    match: /(^|[-_ ])(claude|anthropic|opus|sonnet|haiku|fable)([-_ ]|$)/i,
  },
  {
    family: "gemini",
    label: "Google",
    logo: "/logos/gemini.svg",
    color: "#4285F4",
    match: /(^|[-_ ])(gemini|google|palm)([-_ ]|$)/i,
  },
  {
    family: "deepseek",
    label: "DeepSeek",
    logo: "/logos/deepseek.svg",
    color: "#4D6BFE",
    match: /deepseek/i,
  },
  {
    family: "qwen",
    label: "Qwen",
    logo: "/logos/qwen.svg",
    color: "#6B4EFF",
    match: /(^|[-_ ])(qwen|alibaba|tongyi)([-_ ]|$)/i,
  },
  {
    family: "glm",
    label: "Zhipu",
    logo: "/logos/chatglm.svg",
    color: "#3B82F6",
    match: /(^|[-_ ])(glm|chatglm|zhipu)([-_ ]|$)/i,
  },
  {
    family: "minimax",
    label: "MiniMax",
    logo: "/logos/minimax.svg",
    color: "#F97316",
    match: /minimax/i,
  },
  {
    family: "kimi",
    label: "Moonshot",
    logo: "/logos/kimi.svg",
    color: "#8B5CF6",
    match: /(^|[-_ ])(kimi|moonshot)([-_ ]|$)/i,
  },
  {
    family: "mimo",
    label: "Xiaomi",
    logo: "/logos/xiaomi.svg",
    color: "#FF6900",
    match: /(^|[-_ ])(mimo|xiaomi)([-_ ]|$)/i,
  },
  {
    family: "upstage",
    label: "Upstage",
    logo: "/logos/upstage.svg",
    color: "#0EA5E9",
    match: /(^|[-_ ])(solar|upstage)([-_ ]|$)/i,
  },
  {
    family: "deepai",
    label: "DeepAI",
    logo: "/logos/deepai.svg",
    color: "#A855F7",
    match: /(^|[-_ ])(deepai|muse|glyph|cyber)([-_ ]|$)/i,
  },
  {
    family: "openai",
    label: "OpenAI",
    logo: "/logos/openai.svg",
    color: "#10A37F",
    match: /(^|[-_ ])(gpt|openai|o[1-9])([-_ ]|$)/i,
  },
];

const GENERIC = {
  family: "generic",
  label: "Outros",
  logo: "/logos/generic.svg",
  color: "#7C3AED",
};

export function modelMeta(id, name = "") {
  const haystack = `${id ?? ""} ${name ?? ""}`.trim();
  if (!haystack) return { ...GENERIC };
  for (const entry of FAMILIES) {
    if (entry.match.test(haystack)) {
      return {
        family: entry.family,
        label: entry.label,
        logo: entry.logo,
        color: entry.color,
      };
    }
  }
  return { ...GENERIC };
}

export function familyList() {
  return [
    ...FAMILIES.map(({ family, label, color }) => ({ family, label, color })),
    { family: GENERIC.family, label: GENERIC.label, color: GENERIC.color },
  ];
}
