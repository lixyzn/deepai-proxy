import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ConversationStore,
  messageSignature,
  compactMessages,
  estimatePayloadOverheadTokens,
  prepareUpstreamMessages,
} from "../src/conversations.mjs";

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

test("compactMessages contabiliza extraTokens de tools e não estoura orçamento", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "x".repeat(40000),
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    },
  ];
  const extraTokens = estimatePayloadOverheadTokens({ tools });
  assert.ok(extraTokens >= 10000);

  const msgs = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 40; i++) {
    msgs.push({ role: "user", content: "u".repeat(2000) + i });
    msgs.push({ role: "assistant", content: "a".repeat(2000) + i });
  }
  const out = compactMessages(msgs, {
    contextWindow: 32000,
    reserveTokens: 4000,
    keepRecentTokens: 4000,
    extraTokens,
  });
  assert.ok(out.length < msgs.length);
  assert.equal(out[0].role, "system");
  assert.equal(out[out.length - 1].content.endsWith("39"), true);
});

test("compactMessages não deixa assistant com tool_calls órfão nem corta par tool", () => {
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "u1 ".repeat(1200) },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "ls", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "r1 ".repeat(1200) },
    { role: "user", content: "u2 ".repeat(1200) },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_2", type: "function", function: { name: "cat", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "call_2", content: "ok" },
  ];
  const out = compactMessages(msgs, {
    maxTokens: 2500,
    keepRecentTokens: 1200,
  });
  // Se call_2 está presente, seu tool result também está; nenhum tool fica sem assistant antes.
  for (let i = 1; i < out.length; i++) {
    if (out[i].role === "tool") {
      assert.ok(
        out.slice(1, i).some(
          (m) =>
            m.role === "assistant" &&
            Array.isArray(m.tool_calls) &&
            m.tool_calls.some((tc) => tc.id === out[i].tool_call_id),
        ),
        "tool result sem assistant correspondente antes",
      );
    }
  }
});

test("compactMessages preserva par function_call e function_call_output em responses", () => {
  const input = [
    { role: "system", content: "sys" },
    { role: "user", content: "a".repeat(6000) },
    { type: "function_call", call_id: "fc_1", name: "read", arguments: '{"path":"a.js"}' },
    { type: "function_call_output", call_id: "fc_1", output: "b".repeat(4000) },
    { role: "user", content: "continua" },
  ];
  const out = compactMessages(input, {
    maxTokens: 2200,
    keepRecentTokens: 1200,
  });
  const hasOutput = out.some((m) => m.type === "function_call_output" && m.call_id === "fc_1");
  const hasCall = out.some((m) => m.type === "function_call" && m.call_id === "fc_1");
  assert.equal(hasOutput, hasCall);
});

test("prepareUpstreamMessages remove reasoning antigo e poda tools antigos mantendo todos os turnos", () => {
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "leia o arquivo 1" },
    {
      role: "assistant",
      content: null,
      reasoning: "pensamento gigante ".repeat(400),
      reasoning_details: [{ type: "reasoning.text", text: "detalhe ".repeat(400) }],
      tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"p":"a.js"}' } }],
    },
    { role: "tool", tool_call_id: "c1", content: "Read file a.js\n" + "linha de codigo\n".repeat(4000) },
    { role: "assistant", content: "Li o arquivo a.js e encontrei o bug X.", reasoning_content: "r".repeat(2000) },
    { role: "user", content: "agora leia b.js" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c2", type: "function", function: { name: "read", arguments: '{"p":"b.js"}' } }],
    },
    { role: "tool", tool_call_id: "c2", content: "Read file b.js\nconteudo curto" },
    { role: "assistant", content: "Li b.js tambem." },
    { role: "user", content: "qual era o bug em a.js?" },
  ];

  const prepared = prepareUpstreamMessages(msgs, {
    contextWindow: 320000,
    reserveTokens: 16384,
    effectiveInputCap: 8000,
    keepRecentTools: 1,
  });

  // Todos os 10 turnos preservados (nenhum user/assistant descartado!)
  assert.equal(prepared.messages.length, msgs.length);
  assert.ok(prepared.stats.strippedReasoning >= 2);
  assert.equal(prepared.stats.prunedTools, 1);
  assert.equal(prepared.stats.compacted, false);
  assert.ok(prepared.estimatedTokens <= 8000);
  // Reasoning removido dos assistants
  assert.equal(prepared.messages[2].reasoning, undefined);
  assert.equal(prepared.messages[2].reasoning_details, undefined);
  assert.equal(prepared.messages[4].reasoning_content, undefined);
  // Tool antigo compactado preservando cabeçalho; tool recente intacto
  assert.match(prepared.messages[3].content, /Read file a\.js/);
  assert.match(prepared.messages[3].content, /compactada pelo proxy/);
  assert.equal(prepared.messages[7].content, "Read file b.js\nconteudo curto");
});

test("prepareUpstreamMessages mantém tudo intacto abaixo do teto", () => {
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "oi" },
    { role: "assistant", content: "olá", reasoning: "pensando" },
  ];
  const prepared = prepareUpstreamMessages(msgs, {
    contextWindow: 320000,
    reserveTokens: 16384,
    effectiveInputCap: 33000,
  });
  assert.strictEqual(prepared.messages, msgs);
  assert.equal(prepared.stats.strippedReasoning, 0);
  assert.equal(prepared.stats.prunedTools, 0);
  assert.equal(prepared.stats.compacted, false);
});
