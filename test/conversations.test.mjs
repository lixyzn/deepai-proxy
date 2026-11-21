import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConversationStore, messageSignature } from "../src/conversations.mjs";

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
