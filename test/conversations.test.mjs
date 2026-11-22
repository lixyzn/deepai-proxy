import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConversationStore, messageSignature, compactMessages } from "../src/conversations.mjs";

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deepai-conversations-"));
  return { store: new ConversationStore(path.join(dir, "conversations.json")), dir };
}

const system = { role: "system", content: "Você é um assistente." };
const user1 = { role: "user", content: "Analise o arquivo A." };
const assistant1 = { role: "assistant", content: "Arquivo A analisado." };
const user2 = { role: "user", content: "Agora corrija o bug." };

test("reconhece a mesma conversa pelo histórico e mantém o session id", () => {
  const { store, dir } = tempStore();
  const first = store.resolve({
    body: { model: "gpt-6-luna", messages: [system, user1] },
    endpoint: "chat/completions",
    headers: { authorization: "Bearer dai_teste" },
    model: "gpt-6-luna",
  });
  const second = store.resolve({
    body: {
      model: "deepseek-v4.1-flash",
      messages: [system, user1, assistant1, user2],
    },
    endpoint: "chat/completions",
    headers: { authorization: "Bearer dai_teste" },
    model: "deepseek-v4.1-flash",
  });
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(second.messages.length, 4);
  assert.equal(second.restored, 0);
  store.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("restaura prefixo quando o cliente compacta o histórico", () => {
  const { store, dir } = tempStore();
  store.resolve({
    body: { model: "gpt-6-luna", messages: [system, user1, assistant1] },
    endpoint: "chat/completions",
    headers: { authorization: "Bearer dai_teste" },
    model: "gpt-6-luna",
  });
  const compacted = store.resolve({
    body: { model: "gpt-6-luna", messages: [assistant1, user2] },
    endpoint: "chat/completions",
    headers: { authorization: "Bearer dai_teste" },
    model: "gpt-6-luna",
  });
  assert.equal(compacted.restored, 2);
  assert.deepEqual(
    compacted.messages.map((message) => message.content),
    [system.content, user1.content, assistant1.content, user2.content],
  );
  store.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("conta e modelo não fazem parte da identidade da conversa", () => {
  const { store, dir } = tempStore();
  const first = store.resolve({
    body: { model: "gpt-6-luna", messages: [system, user1] },
    endpoint: "chat/completions",
    headers: { authorization: "Bearer dai_teste" },
    model: "gpt-6-luna",
  });
  const second = store.resolve({
    body: {
      model: "claude-sonnet-5-5",
      messages: [system, user1, assistant1, user2],
    },
    endpoint: "chat/completions",
    headers: { authorization: "Bearer dai_teste" },
    model: "claude-sonnet-5-5",
  });
  assert.equal(first.sessionId, second.sessionId);
  store.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("conversa diferente cria outro session id", () => {
  const { store } = tempStore();
  const first = store.resolve({
    body: { model: "gpt-6-luna", messages: [system, user1] },
    endpoint: "chat/completions",
    headers: { authorization: "Bearer dai_teste" },
    model: "gpt-6-luna",
  });
  const other = store.resolve({
    body: {
      model: "gpt-6-luna",
      messages: [system, { role: "user", content: "Outro assunto totalmente." }],
    },
    endpoint: "chat/completions",
    headers: { authorization: "Bearer dai_teste" },
    model: "gpt-6-luna",
  });
  assert.notEqual(first.sessionId, other.sessionId);
});

test("session ids e histórico sobrevivem ao restart", () => {
  const { store, dir } = tempStore();
  const first = store.resolve({
    body: { model: "gpt-6-luna", messages: [system, user1] },
    endpoint: "chat/completions",
    headers: { authorization: "Bearer dai_teste" },
    model: "gpt-6-luna",
  });
  store.flush();
  const reloaded = new ConversationStore(path.join(dir, "conversations.json"));
  const next = reloaded.resolve({
    body: { model: "gpt-6-luna", messages: [system, user1, assistant1, user2] },
    endpoint: "chat/completions",
    headers: { authorization: "Bearer dai_teste" },
    model: "gpt-6-luna",
  });
  assert.equal(first.sessionId, next.sessionId);
  assert.equal(next.messages.length, 4);
});

test("clear apaga sessões e metadados", () => {
  const { store, dir } = tempStore();
  store.resolve({
    body: { model: "gpt-6-luna", messages: [system, user1] },
    endpoint: "chat/completions",
    headers: {},
    model: "gpt-6-luna",
  });
  store.clear();
  assert.equal(store.snapshot().stats.sessions, 0);
  const raw = fs.readFileSync(path.join(dir, "conversations.json"), "utf8");
  assert.equal(JSON.parse(raw).sessions.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("assinatura ignora ordem de campos e normaliza argumentos de tool", () => {
  const a = messageSignature({
    role: "assistant",
    tool_calls: [
      { id: "x", type: "function", function: { name: "read", arguments: '{"b":2,"a":1}' } },
    ],
  });
  const b = messageSignature({
    tool_calls: [
      { function: { arguments: '{"a":1,"b":2}', name: "read" }, type: "function", id: "x" },
    ],
    role: "assistant",
  });
  assert.equal(a, b);
});

test("thread id do cliente completa o histórico quando só o último user é enviado", () => {
  const { store, dir } = tempStore();
  const first = store.resolve({
    body: {
      model: "gpt-6-luna",
      prompt_cache_key: "thread-estavel-1",
      messages: [system, user1],
    },
    endpoint: "chat/completions",
    headers: { authorization: "Bearer dai_teste" },
    model: "gpt-6-luna",
  });
  store.appendAssistant(first.sessionId, assistant1);
  const second = store.resolve({
    body: {
      model: "gpt-6-luna",
      prompt_cache_key: "thread-estavel-1",
      messages: [{ role: "system", content: "system novo" }, user2],
    },
    endpoint: "chat/completions",
    headers: { authorization: "Bearer dai_teste" },
    model: "gpt-6-luna",
  });
  assert.equal(first.sessionId, second.sessionId);
  assert.deepEqual(
    second.messages.map((message) => message.content),
    ["system novo", user1.content, assistant1.content, user2.content],
  );
  assert.ok(second.restored >= 2);
  store.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("prefixo menor restaura o restante na ordem correta", () => {
  const { store } = tempStore();
  const first = store.resolve({
    body: { model: "gpt-6-luna", messages: [system, user1, assistant1, user2] },
    endpoint: "chat/completions",
    headers: { authorization: "Bearer dai_teste" },
    model: "gpt-6-luna",
  });
  const shorter = store.resolve({
    body: { model: "gpt-6-luna", messages: [system, user1] },
    endpoint: "chat/completions",
    headers: { authorization: "Bearer dai_teste" },
    model: "gpt-6-luna",
  });
  assert.equal(first.sessionId, shorter.sessionId);
  assert.deepEqual(
    shorter.messages.map((message) => message.content),
    [system.content, user1.content, assistant1.content, user2.content],
  );
});


test("janela deslizante com hint não encolhe o ledger e preserva cauda nova", () => {
  const { store, dir } = tempStore();
  const headers = { "x-session-affinity": "sess-slide" };
  const base = [
    { role: "system", content: "S" },
    { role: "user", content: "U1" },
    { role: "assistant", content: "A1" },
    { role: "user", content: "U2" },
    { role: "assistant", content: "A2" },
    { role: "user", content: "U3" },
  ];
  const r1 = store.resolve({
    body: { messages: base, prompt_cache_key: "sess-slide" },
    headers,
    endpoint: "/v1/chat/completions",
    model: "gpt-5",
  });
  assert.equal(r1.created, true);
  assert.equal(r1.messages.length, 6);

  const windowed = [
    { role: "system", content: "S" },
    { role: "assistant", content: "A2" },
    { role: "user", content: "U3" },
    { role: "assistant", content: "A3" },
    { role: "user", content: "U4" },
  ];
  const r2 = store.resolve({
    body: { messages: windowed, prompt_cache_key: "sess-slide" },
    headers,
    endpoint: "/v1/chat/completions",
    model: "gpt-5",
  });
  assert.equal(r2.sessionId, r1.sessionId);
  assert.equal(r2.messages.length, 8);
  assert.deepEqual(r2.messages.map((m) => m.content), ["S", "U1", "A1", "U2", "A2", "U3", "A3", "U4"]);
  store.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("compactMessages usa histerese e não cai em cliff de 20k", () => {
  const big = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 200; i++) {
    big.push({ role: "user", content: "u".repeat(2000) + i });
    big.push({ role: "assistant", content: "a".repeat(2000) + i });
  }
  const maxTokens = 112000;
  const out = compactMessages(big, { maxTokens, keepRecentTokens: 20000 });
  assert.equal(out[0].role, "system");
  // deve manter bem mais que 20k tokens e ficar abaixo do orçamento
  const est = out.reduce((s, m) => s + Math.ceil(JSON.stringify(m.content || "").length / 4), 0);
  assert.ok(est > 30000, `esperava >30k, veio ${est}`);
  assert.ok(est <= maxTokens, `passou do orçamento: ${est}`);
  // última mensagem preservada
  assert.equal(out[out.length - 1].content.endsWith("199"), true);
});

test("session id fica estável após clear quando cliente manda prompt_cache_key", () => {
  const { store, dir } = tempStore();
  const body = { model: "gpt-6-luna", prompt_cache_key: "thread-fixa", messages: [system, user1] };
  const headers = { authorization: "Bearer dai_teste" };
  const first = store.resolve({ body, endpoint: "chat/completions", headers, model: "gpt-6-luna" });
  store.clear();
  const second = store.resolve({ body, endpoint: "chat/completions", headers, model: "gpt-6-luna" });
  assert.equal(first.sessionId, "thread-fixa");
  assert.equal(second.sessionId, "thread-fixa");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("session id determinístico após clear sem hint do cliente", () => {
  const { store, dir } = tempStore();
  const body = { model: "gpt-6-luna", messages: [system, user1] };
  const headers = { authorization: "Bearer dai_teste" };
  const first = store.resolve({ body, endpoint: "chat/completions", headers, model: "gpt-6-luna" });
  store.clear();
  const second = store.resolve({ body, endpoint: "chat/completions", headers, model: "gpt-6-luna" });
  assert.equal(first.sessionId, second.sessionId);
  assert.match(first.sessionId, /^cs_/);
  fs.rmSync(dir, { recursive: true, force: true });
});
