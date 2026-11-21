import test from "node:test";
import assert from "node:assert/strict";
import { normalizeChatPayload } from "../src/compat.mjs";
import { applyCacheIdentity, resolveCacheIdentity } from "../src/context.mjs";
import { resolveModelAlias } from "../src/aliases.mjs";
import { modelMeta } from "../src/model-meta.mjs";

test("compat injeta system e converte max_completion_tokens", () => {
  const payload = normalizeChatPayload(
    {
      model: "gpt-4o",
      max_completion_tokens: 123,
      messages: [{ role: "user", content: [{ type: "text", text: "oi" }] }],
    },
    () => "gpt-6-luna",
  );
  assert.equal(payload.model, "gpt-6-luna");
  assert.equal(payload.max_tokens, 123);
  assert.equal(payload.max_completion_tokens, undefined);
  assert.equal(payload.messages[0].role, "system");
  assert.equal(payload.messages[1].content, "oi");
});

test("compat inclui usage no stream", () => {
  const payload = normalizeChatPayload(
    { stream: true, messages: [{ role: "user", content: "oi" }] },
    (value) => value,
  );
  assert.equal(payload.stream_options.include_usage, true);
});

test("cache usa chave do cliente e não a sobrescreve", () => {
  const body = { prompt_cache_key: "minha-chave" };
  const identity = applyCacheIdentity({
    body,
    headers: {},
    accountId: "acc_1",
    endpoint: "chat/completions",
  });
  assert.equal(identity.source, "client");
  assert.equal(body.prompt_cache_key, "minha-chave");
});

test("cache deriva fingerprint estável para a mesma conversa", () => {
  const one = resolveCacheIdentity({
    body: {
      model: "glm-5.3-flash",
      messages: [{ role: "user", content: "conversa A" }],
    },
    headers: {},
    accountId: "acc_1",
    endpoint: "chat/completions",
  });
  const two = resolveCacheIdentity({
    body: {
      model: "glm-5.3-flash",
      messages: [
        { role: "user", content: "conversa A" },
        { role: "assistant", content: "resposta" },
        { role: "user", content: "continuação" },
      ],
    },
    headers: {},
    accountId: "acc_1",
    endpoint: "chat/completions",
  });
  assert.equal(one.key, two.key);
  assert.match(one.key, /^pc_[a-f0-9]{32}$/);
});

test("aliases só apontam para modelos grátis conhecidos", () => {
  assert.equal(resolveModelAlias("gpt-4o"), "gpt-6-luna");
  assert.equal(resolveModelAlias("deepseek-chat"), "deepseek-v4.1-flash");
  assert.equal(resolveModelAlias("qwen-max"), "qwen-3.8-flash");
  assert.equal(resolveModelAlias("modelo-inexistente"), "modelo-inexistente");
});

test("metadados de família e logo", () => {
  assert.equal(modelMeta("glm-5.3-flash", "GLM 5.3 Flash").family, "glm");
  assert.equal(modelMeta("gpt-6-luna", "GPT-6 Luna").family, "openai");
  assert.equal(modelMeta("solar-mini-4", "Solar Mini 4").family, "upstage");
  assert.equal(modelMeta("muse-ember", "Muse Ember").family, "deepai");
  assert.match(modelMeta("desconhecido", "Desconhecido").logo, /generic\.svg$/);
});
