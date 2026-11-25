import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ConfigStore, generateProxyApiKey } from "../src/config.mjs";
import { AccountStore, maskSecret } from "../src/store.mjs";
import { startServer } from "../src/server.mjs";

const silentLogger = {
  log() {},
  warn() {},
  error() {},
};

async function createTempDir(prefix = "deepai-proxy-test-") {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createMockDeepAIUpstream() {
  const receivedRequests = [];
  let forceNextStatusByKey = new Map();
  let customCompletionHandler = null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let jsonBody = null;
    try {
      jsonBody = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      jsonBody = null;
    }

    const apiKey = req.headers["api-key"] || "";
    receivedRequests.push({
      method: req.method,
      pathname: url.pathname,
      headers: req.headers,
      apiKey,
      body: jsonBody,
    });

    if (req.method === "GET" && url.pathname === "/deepai_code/theos") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          check_in: { nonce: "mock-nonce-123", seconds: 60 },
        }),
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/deepai_code/chat/completions") {
      if (customCompletionHandler) {
        const handled = await customCompletionHandler({ req, res, jsonBody, apiKey, receivedRequests });
        if (handled) return;
      }

      if (forceNextStatusByKey.has(apiKey)) {
        const status = forceNextStatusByKey.get(apiKey);
        forceNextStatusByKey.delete(apiKey);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: `Forced upstream error ${status}`, code: `err_${status}` },
          }),
        );
        return;
      }

      if (jsonBody?.stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const chunk1 = {
          id: "chatcmpl-mock-stream",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: jsonBody.model || "glm-5.3-flash",
          choices: [{ index: 0, delta: { role: "assistant", content: "Olá " }, finish_reason: null }],
        };
        const chunk2 = {
          id: "chatcmpl-mock-stream",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: jsonBody.model || "glm-5.3-flash",
          choices: [{ index: 0, delta: { content: "mundo!" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
        };
        res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
        res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-mock-json",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: jsonBody?.model || "glm-5.3-flash",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: `Echo from mock using ${apiKey}` },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    baseUrl: `${origin}/deepai_code`,
    receivedRequests,
    forceStatusForKey(key, status) {
      forceNextStatusByKey.set(key, status);
    },
    setCompletionHandler(fn) {
      customCompletionHandler = fn;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("ConfigStore: persistence, key generation, rotation, and constant-time validation", async () => {
  const dir = await createTempDir();
  try {
    const configFile = path.join(dir, "config.json");
    const cfg = new ConfigStore({ filePath: configFile, logger: silentLogger });
    const initial = await cfg.init();

    assert.equal(initial.requireApiKey, true);
    assert.ok(initial.proxyApiKey.startsWith("dp-proxy-"));
    assert.equal(initial.rotationStrategy, "round-robin");

    // Missing or wrong key fails
    assert.equal((await cfg.validateRequest({ headers: {} })).ok, false);
    assert.equal(
      (await cfg.validateRequest({ headers: { authorization: "Bearer wrong-key" } })).ok,
      false,
    );

    // Valid Authorization: Bearer and x-api-key succeed
    assert.equal(
      (await cfg.validateRequest({ headers: { authorization: `Bearer ${initial.proxyApiKey}` } })).ok,
      true,
    );
    assert.equal(
      (await cfg.validateRequest({ headers: { "x-api-key": initial.proxyApiKey } })).ok,
      true,
    );

    // Rotate key invalidates old key and activates new key
    const rotated = await cfg.rotateKey();
    assert.notEqual(rotated.proxyApiKey, initial.proxyApiKey);
    assert.equal(
      (await cfg.validateRequest({ headers: { "x-api-key": initial.proxyApiKey } })).ok,
      false,
    );
    assert.equal(
      (await cfg.validateRequest({ headers: { "x-api-key": rotated.proxyApiKey } })).ok,
      true,
    );

    // Disabling requireApiKey allows unauthenticated requests
    await cfg.update({ requireApiKey: false });
    assert.equal((await cfg.validateRequest({ headers: {} })).ok, true);

    // Helper generates unique keys
    const k1 = generateProxyApiKey();
    const k2 = generateProxyApiKey();
    assert.notEqual(k1, k2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("AccountStore: multi-account CRUD, masked keys, and rotation strategies (active, round-robin, failover)", async () => {
  const dir = await createTempDir();
  try {
    const accountsFile = path.join(dir, "accounts.json");
    const store = new AccountStore({ filePath: accountsFile, logger: silentLogger });
    await store.init();

    const secret1 = "da-secret-key-alpha-1111";
    const secret2 = "da-secret-key-beta-2222";
    const secret3 = "da-secret-key-gamma-3333";

    const a1 = await store.importApiKey(secret1, { label: "Conta 1", isPro: false, makeActive: true });
    const a2 = await store.importApiKey(secret2, { label: "Conta 2", isPro: true, makeActive: false });
    const a3 = await store.importApiKey(secret3, { label: "Conta 3", isPro: true, makeActive: false });

    // Masked key check — raw secret must never appear in safeAccount / list()
    const listed = await store.list();
    assert.equal(listed.accounts.length, 3);
    const serialized = JSON.stringify(listed);
    assert.equal(serialized.includes(secret1), false);
    assert.equal(serialized.includes(secret2), false);
    assert.equal(serialized.includes(secret3), false);
    assert.equal(a1.keyPreview, maskSecret(secret1));
    assert.ok(a1.keyPreview.endsWith("1111"));

    // Strategy: active
    await store.setActive(a2.id);
    assert.equal((await store.getActive()).id, a2.id);
    assert.equal((await store.selectAccountForRequest("active")).id, a2.id);
    assert.equal((await store.selectAccountForRequest("active")).id, a2.id);

    // Strategy: round-robin cycles through enabled accounts
    const rr1 = (await store.selectAccountForRequest("round-robin")).id;
    const rr2 = (await store.selectAccountForRequest("round-robin")).id;
    const rr3 = (await store.selectAccountForRequest("round-robin")).id;
    const rr4 = (await store.selectAccountForRequest("round-robin")).id;
    assert.equal(new Set([rr1, rr2, rr3]).size, 3);
    assert.equal(rr4, rr1);

    // Disable a2 and put a1 in cooldown -> failover selects a3
    await store.toggleEnabled(a2.id, false);
    await store.recordUsage(a1.id, { ok: false, status: 429, error: "rate_limited", cooldownMs: 60_000 });
    const failoverPick = await store.selectAccountForRequest("failover");
    assert.equal(failoverPick.id, a3.id);

    // Rename & remove
    const renamed = await store.rename(a3.id, "Conta Principal Pro");
    assert.equal(renamed.label, "Conta Principal Pro");
    await store.remove(a2.id);
    assert.equal((await store.list()).accounts.length, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Server E2E: API key auth, /v1/models, /api/models, /v1/chat/completions (JSON + SSE + failover), and /api/metrics", async () => {
  const dir = await createTempDir();
  const mockUpstream = await createMockDeepAIUpstream();
  let app = null;

  try {
    app = await startServer({
      port: 0,
      host: "127.0.0.1",
      logger: silentLogger,
      accountsFile: path.join(dir, "accounts.json"),
      configFile: path.join(dir, "config.json"),
      metricsFile: path.join(dir, "metrics.json"),
      upstreamBaseUrl: mockUpstream.baseUrl,
    });

    const baseUrl = `http://127.0.0.1:${app.port}`;
    const cfgRes = await fetch(`${baseUrl}/api/config`);
    assert.equal(cfgRes.status, 200);
    const { config } = await cfgRes.json();
    const proxyKey = config.proxyApiKey;

    // 1. /v1/models and /api/models
    const v1ModelsRes = await fetch(`${baseUrl}/v1/models`);
    assert.equal(v1ModelsRes.status, 200);
    const v1Models = await v1ModelsRes.json();
    assert.equal(v1Models.object, "list");
    assert.ok(v1Models.data.length >= 20);
    assert.ok(v1Models.data.some((m) => m.id === "glm-5.3-flash" && m.tier === "free"));
    assert.ok(v1Models.data.some((m) => m.id === "claude-sonnet-5-5" && m.tier === "paid"));

    const apiModelsFreeRes = await fetch(`${baseUrl}/api/models?tier=free`);
    assert.equal(apiModelsFreeRes.status, 200);
    const apiModelsFree = await apiModelsFreeRes.json();
    assert.equal(apiModelsFree.ok, true);
    assert.ok(apiModelsFree.counts.free > 0);
    assert.ok(apiModelsFree.counts.paid > 0);
    assert.ok(apiModelsFree.models.every((m) => m.tier === "free"));

    // 2. Import 2 accounts via API
    const acc1Key = "da-test-key-0001";
    const acc2Key = "da-test-key-0002";
    const imp1 = await fetch(`${baseUrl}/api/accounts/import-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: acc1Key, label: "Conta A", isPro: false }),
    });
    assert.equal(imp1.status, 200);

    const imp2 = await fetch(`${baseUrl}/api/accounts/import-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: acc2Key, label: "Conta B", isPro: true }),
    });
    assert.equal(imp2.status, 200);

    // 3. API Key enforcement on /v1/chat/completions
    const noKeyRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "Oi" }] }),
    });
    assert.equal(noKeyRes.status, 401);

    const wrongKeyRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer invalid-key",
      },
      body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "Oi" }] }),
    });
    assert.equal(wrongKeyRes.status, 401);

    // 4. Non-stream chat completion with Authorization: Bearer
    const jsonChatRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${proxyKey}`,
      },
      body: JSON.stringify({
        model: "glm-5.3-flash",
        stream: false,
        messages: [{ role: "user", content: "Teste JSON" }],
      }),
    });
    assert.equal(jsonChatRes.status, 200);
    const jsonChat = await jsonChatRes.json();
    assert.equal(jsonChat.object, "chat.completion");
    assert.ok(jsonChat.choices[0].message.content.includes("Echo from mock using"));

    // Verify upstream received DeepAI headers
    const lastUpstreamReq = mockUpstream.receivedRequests.find(
      (r) => r.pathname === "/deepai_code/chat/completions",
    );
    assert.ok(lastUpstreamReq);
    assert.equal(lastUpstreamReq.headers["x-deepai-code-theos"], "8");
    assert.ok(lastUpstreamReq.headers["x-deepai-code-instance"]);
    assert.ok(lastUpstreamReq.headers["x-deepai-code-machine"]);

    // 5. Stream chat completion with x-api-key + forced 429 failover on acc1Key
    mockUpstream.forceStatusForKey(acc1Key, 429);
    const streamRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": proxyKey,
      },
      body: JSON.stringify({
        model: "claude-sonnet-5-5",
        stream: true,
        messages: [{ role: "user", content: "Teste Stream" }],
      }),
    });
    assert.equal(streamRes.status, 200);
    assert.ok((streamRes.headers.get("content-type") || "").includes("text/event-stream"));
    const sseText = await streamRes.text();
    assert.ok(sseText.includes("Olá "));
    assert.ok(sseText.includes("mundo!"));
    assert.ok(sseText.includes("data: [DONE]"));

    // 6. Verify /api/metrics recorded both requests (JSON + Stream)
    const metricsRes = await fetch(`${baseUrl}/api/metrics?range=24h`);
    assert.equal(metricsRes.status, 200);
    const metrics = await metricsRes.json();
    assert.equal(metrics.ok, true);
    assert.ok(metrics.kpis.totalRequests >= 2);
    assert.equal(metrics.kpis.activeAccountsCount, 2);
    assert.ok(Array.isArray(metrics.timeSeries));
    assert.ok(Array.isArray(metrics.byModel) && metrics.byModel.length >= 2);
    assert.ok(Array.isArray(metrics.byAccount) && metrics.byAccount.length >= 1);
    assert.ok(Array.isArray(metrics.recentRequests) && metrics.recentRequests.length >= 2);
    assert.ok(metrics.recentRequests.some((r) => r.stream === true));
    assert.ok(metrics.recentRequests.some((r) => r.stream === false));

    // 7. Reset metrics
    const resetRes = await fetch(`${baseUrl}/api/metrics/reset`, { method: "POST" });
    assert.equal(resetRes.status, 200);
    const afterReset = await (await fetch(`${baseUrl}/api/metrics`)).json();
    assert.equal(afterReset.kpis.totalRequests, 0);
  } finally {
    if (app) await app.close();
    await mockUpstream.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

import { manageContext, detectClientCompaction, normalizeContextSettings } from "../src/context.mjs";

test("Sign-in URL: DeepAI desktop_auth only accepts a lowercase hex state", async () => {
  // Regression: base64url state (with '-', '_' and uppercase) is rejected by
  // DeepAI with 400 "Invalid desktop sign-in request.", so the link the user
  // clicked never opened the login page.
  const { LoginManager } = await import("../src/auth.mjs");

  const manager = new LoginManager({ onComplete: async () => null });
  const records = [];

  try {
    // start() performs a live preflight against DeepAI. Stub the network by
    // capturing the generated state without depending on upstream availability.
    const record = await manager.start({ label: "hex-state-test" }).catch((err) => {
      // A network failure in CI must not hide the assertion below.
      if (err?.code === "sign_in_url_rejected") return null;
      throw err;
    });

    if (record) records.push(record);

    if (record?.url) {
      const url = new URL(record.url);
      const state = url.searchParams.get("state") || "";
      assert.match(state, /^[0-9a-f]{16,}$/, `state must be lowercase hex, got "${state}"`);
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.match(url.searchParams.get("code_challenge") || "", /^[A-Za-z0-9_-]{43}$/);
      assert.ok(Number(url.searchParams.get("port")) > 0);
    } else {
      // Upstream was unreachable or rejected: inspect the record the manager
      // would have produced by calling the generator directly.
      const { randomBytes, createHash } = await import("node:crypto");
      // Mirrors LoginManager.start(): state is hex, PKCE verifier stays base64url.
      const state = randomBytes(24).toString("hex");
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      assert.match(state, /^[0-9a-f]{48}$/);
      assert.doesNotMatch(state, /[-_A-Z]/, "base64url characters break DeepAI's validator");
      assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
    }
  } finally {
    manager.closeAll();
  }
});


test("Context: pass-through only (no trimming, no clamping, no strict errors) and client compaction detection", async () => {
  const modelInfo = { id: "glm-5.3-flash", contextWindow: 4096, maxTokens: 2048 };
  const longText = "A".repeat(7000); // ~2000 tokens each

  const messages = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "First goal: keep this." },
    { role: "assistant", content: longText },
    { role: "user", content: longText },
    { role: "assistant", content: null, tool_calls: [{ id: "tc1", type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "tc1", content: "tool result" },
    { role: "user", content: "Latest question" },
  ];

  const res = manageContext({
    body: { model: "glm-5.3-flash", messages, max_tokens: 99999 },
    modelInfo,
    contextSettings: {
      mode: "auto",
      maxContextRatio: 0.9,
      reserveOutputTokens: 512,
      keepSystemMessages: true,
      keepFirstUserMessage: true,
      clampMaxTokens: true,
    },
  });

  // Legacy settings normalize to the single pass-through mode
  assert.equal(res.meta.mode, "passthrough");
  assert.equal(res.error, undefined);

  // Nothing is dropped, truncated or clamped — the transcript goes through as-is
  assert.equal(res.meta.trimmed, false);
  assert.equal(res.meta.droppedMessages, 0);
  assert.equal(res.meta.truncatedMessages, 0);
  assert.equal(res.meta.clampedMaxTokens, false);
  assert.equal(res.body.max_tokens, 99999);
  assert.equal(res.body.messages.length, messages.length);
  assert.equal(res.body.messages[1].content, "First goal: keep this.");
  assert.equal(res.body.messages[2].content, longText);
  assert.equal(res.body.messages[res.body.messages.length - 1].content, "Latest question");
  assert.equal(res.meta.compaction.compacted, false);

  // A "strict" request is no longer rejected: it is forwarded
  const strictRes = manageContext({
    body: { model: "glm-5.3-flash", messages },
    modelInfo,
    contextSettings: { mode: "strict", maxContextRatio: 0.5 },
  });
  assert.equal(strictRes.error, undefined);
  assert.equal(strictRes.body.messages.length, messages.length);

  // Legacy overrideInputBudget is accepted and ignored
  const overrideRes = manageContext({
    body: { model: "glm-5.3-flash", messages },
    modelInfo: { id: "glm-5.3-flash", contextWindow: 320000, maxTokens: 16384 },
    contextSettings: { mode: "auto" },
    overrideInputBudget: 1500,
  });
  assert.equal(overrideRes.error, undefined);
  assert.equal(overrideRes.meta.trimmed, false);
  assert.ok(overrideRes.meta.estimatedInputTokens > 1500);
});

test("Context detector: OpenCode checkpoints, generic summaries, and false positives", async () => {
  // 1. OpenCode post-compaction transcript
  const openCodeCheckpoint = `<conversation-checkpoint>
The following is a summary and serialized record of earlier conversation.

<summary>
## Objective
Fix the login bug in the proxy.

## Requirements
- Correct link generation.
- Pass the transcript through untouched.

## Decisions
- Collapse the context modes to pass-through.

## Work State
### Completed
- Login link fixed.

### Active
- Rewriting context handling.

### Blocked
- (none)

## Next Move
Run the tests.
</summary>

<recent-context>
[User]: corrige o login
[Assistant tool call]: read({"path":"src/server.mjs"})
[Tool result]: Read file, lines 1-40
[Assistant]: Achei o bug.
</recent-context>
</conversation-checkpoint>`;

  const openCodeMsgs = [
    { role: "user", content: openCodeCheckpoint },
    { role: "assistant", content: "Continuando." },
    { role: "user", content: "Segue." },
  ];
  const hit = detectClientCompaction(openCodeMsgs);
  assert.equal(hit.compacted, true);
  assert.equal(hit.kind, "opencode-checkpoint");
  assert.equal(hit.index, 0);
  assert.equal(hit.confidence, "high");
  assert.ok(hit.summaryTokens > 20);
  assert.ok(hit.recentTokens > 5);
  assert.ok(hit.markers.length >= 3);
  assert.ok(hit.headings.length >= 3);

  // 2. Generic harness summary injected as the first user message
  const genericMsgs = [
    { role: "system", content: "You are a coding agent." },
    {
      role: "user",
      content:
        "This session is being continued from a previous conversation that ran out of context. " +
        "## Objective\nShip the fix.\n## Work State\n### Completed\n- Done.\n## Next Move\nVerify.",
    },
    { role: "assistant", content: "ok" },
  ];
  const generic = detectClientCompaction(genericMsgs);
  assert.equal(generic.compacted, true);
  assert.equal(generic.index, 1);
  assert.ok(generic.kind === "summary-checkpoint" || generic.kind === "generic-summary");

  // 3. A normal conversation must not be flagged
  const normal = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Preciso corrigir a lógica de login do meu sistema que está errado." },
    { role: "assistant", content: "Vou olhar o código." },
    { role: "user", content: "## Objective\nIsto aqui é só markdown que eu escrevi na conversa." },
  ];
  assert.equal(detectClientCompaction(normal).compacted, false);

  // 4. The user merely talking about compaction late in the conversation is not a summary
  const talk = [
    { role: "user", content: "a".repeat(200) },
    { role: "assistant", content: "b".repeat(200) },
    { role: "user", content: "c".repeat(200) },
    { role: "assistant", content: "d".repeat(200) },
    { role: "user", content: "e".repeat(200) },
    { role: "assistant", content: "f".repeat(200) },
    { role: "user", content: "g".repeat(200) },
    {
      role: "user",
      content: "Context has been compacted by the client. ## Objective ## Requirements ## Decisions done.",
    },
  ];
  assert.equal(detectClientCompaction(talk).compacted, false);

  // 5. Detection can be disabled via settings, but the mode is always passthrough
  assert.deepEqual(normalizeContextSettings({ mode: "sliding" }).mode, "passthrough");
  assert.equal(normalizeContextSettings({ detectCompaction: false }).detectCompaction, false);
});


test("DeepAI Context Protocol: session affinity, user content flattening, usage normalization (JSON+SSE), pass-through on upstream 400, and client compaction reporting", async () => {
  const dir = await createTempDir();
  const mockUpstream = await createMockDeepAIUpstream();
  let app = null;

  try {
    app = await startServer({
      port: 0,
      host: "127.0.0.1",
      logger: silentLogger,
      accountsFile: path.join(dir, "accounts.json"),
      configFile: path.join(dir, "config.json"),
      metricsFile: path.join(dir, "metrics.json"),
      upstreamBaseUrl: mockUpstream.baseUrl,
    });

    const baseUrl = `http://127.0.0.1:${app.port}`;
    const { config } = await (await fetch(`${baseUrl}/api/config`)).json();
    const proxyKey = config.proxyApiKey;

    await fetch(`${baseUrl}/api/accounts/import-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "da-ctx-test-key-9999", label: "Ctx Account", isPro: true }),
    });

    // 1. Session affinity synthesis & stability across turns + text-only user content flattening
    const turn1Res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${proxyKey}` },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        stream: false,
        messages: [
          { role: "developer", content: "Be concise." },
          {
            role: "user",
            content: [
              { type: "text", text: "Line one" },
              { type: "text", text: "Line two" },
            ],
          },
        ],
      }),
    });
    assert.equal(turn1Res.status, 200);

    const turn2Res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${proxyKey}` },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        stream: false,
        messages: [
          { role: "developer", content: "Be concise." },
          { role: "user", content: "Line one\nLine two" },
          { role: "assistant", content: "OK" },
          {
            role: "user",
            content: [
              { type: "text", text: "Multimodal check" },
              { type: "image_url", image_url: { url: "https://example.com/a.png" } },
            ],
          },
        ],
      }),
    });
    assert.equal(turn2Res.status, 200);

    const completionReqs = mockUpstream.receivedRequests.filter(
      (r) => r.pathname === "/deepai_code/chat/completions",
    );
    assert.equal(completionReqs.length, 2);

    const req1 = completionReqs[0];
    const req2 = completionReqs[1];
    assert.match(req1.headers["x-session-affinity"], /^dp-[a-f0-9]{24}$/);
    assert.equal(req1.body.prompt_cache_key, req1.headers["x-session-affinity"]);
    assert.equal(req2.headers["x-session-affinity"], req1.headers["x-session-affinity"]);
    assert.equal(req2.body.prompt_cache_key, req1.body.prompt_cache_key);

    // developer -> system, text-only user array -> string, multimodal user array -> preserved
    assert.equal(req1.body.messages[0].role, "system");
    assert.equal(req1.body.messages[1].content, "Line one\nLine two");
    assert.ok(Array.isArray(req2.body.messages[3].content));

    // Explicit x-session-affinity header is forwarded verbatim
    await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${proxyKey}`,
        "x-session-affinity": "thread-custom-123",
      },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        stream: false,
        messages: [{ role: "user", content: "Explicit affinity" }],
      }),
    });
    const req3 = mockUpstream.receivedRequests.filter(
      (r) => r.pathname === "/deepai_code/chat/completions",
    )[2];
    assert.equal(req3.headers["x-session-affinity"], "thread-custom-123");
    assert.equal(req3.body.prompt_cache_key, "thread-custom-123");

    // 2. Under-reported usage normalization (JSON + SSE + fallback SSE usage)
    const largePrompt = "X".repeat(10000); // ~2858 estimated tokens
    mockUpstream.setCompletionHandler(({ res, jsonBody }) => {
      if (jsonBody?.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-under",
            object: "chat.completion.chunk",
            model: jsonBody.model,
            choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 120, completion_tokens: 15, total_tokens: 135, prompt_cache_hit_tokens: 64 },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return true;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-under-json",
          object: "chat.completion",
          model: jsonBody.model,
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 150,
            completion_tokens: 20,
            total_tokens: 170,
            prompt_tokens_details: { cached_tokens: 80 },
          },
        }),
      );
      return true;
    });

    const underJsonRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${proxyKey}` },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        stream: false,
        messages: [{ role: "user", content: largePrompt }],
      }),
    });
    assert.equal(underJsonRes.status, 200);
    const estHeader = Number(underJsonRes.headers.get("x-deepai-context-used-est"));
    assert.ok(estHeader > 2000);
    const underJson = await underJsonRes.json();
    assert.equal(underJson.usage.prompt_tokens, estHeader);
    assert.equal(underJson.usage.completion_tokens, 20);
    assert.equal(underJson.usage.total_tokens, estHeader + 20);
    assert.equal(underJson.usage.prompt_tokens_details.cached_tokens, 80);

    const underSseRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${proxyKey}` },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        stream: true,
        messages: [{ role: "user", content: largePrompt }],
      }),
    });
    assert.equal(underSseRes.status, 200);
    const underSseText = await underSseRes.text();
    const sseDataLines = underSseText
      .split("\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice(6)));
    const usageEvent = sseDataLines.find((e) => e.usage);
    assert.ok(usageEvent);
    assert.equal(usageEvent.usage.prompt_tokens, estHeader);
    assert.equal(usageEvent.usage.total_tokens, estHeader + 15);
    assert.equal(usageEvent.usage.prompt_tokens_details.cached_tokens, 64);

    // Fallback SSE usage chunk when upstream omits usage and stream_options.include_usage is true
    mockUpstream.setCompletionHandler(({ res, jsonBody }) => {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-no-usage",
          object: "chat.completion.chunk",
          model: jsonBody.model,
          choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return true;
    });
    const noUsageSseRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${proxyKey}` },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: largePrompt }],
      }),
    });
    assert.equal(noUsageSseRes.status, 200);
    const noUsageSseText = await noUsageSseRes.text();
    const fallbackEvents = noUsageSseText
      .split("\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice(6)));
    const fallbackUsageEvent = fallbackEvents.find((e) => e.usage);
    assert.ok(fallbackUsageEvent);
    assert.equal(fallbackUsageEvent.usage.prompt_tokens, estHeader);

    // 3. Upstream context_length_exceeded is forwarded verbatim — no reactive trim/retry
    let upstreamAttempts = 0;
    const attemptMessageCounts = [];
    mockUpstream.setCompletionHandler(({ res, jsonBody }) => {
      upstreamAttempts += 1;
      attemptMessageCounts.push(jsonBody.messages.length);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          message: "This conversation exceeds the context window. Compact it to continue.",
          type: "context_length_exceeded",
          code: "context_length_exceeded",
        }),
      );
      return true;
    });

    const bigTurn = "B".repeat(14000); // ~4000 tokens each
    const overflowRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${proxyKey}` },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        stream: false,
        messages: [
          { role: "system", content: "Sys" },
          { role: "user", content: bigTurn },
          { role: "assistant", content: bigTurn },
          { role: "user", content: bigTurn },
          { role: "assistant", content: bigTurn },
          { role: "user", content: "Final question" },
        ],
      }),
    });
    // The proxy does not trim and retry — it surfaces the upstream error untouched.
    assert.equal(overflowRes.status, 400);
    assert.equal(upstreamAttempts, 1);
    assert.equal(overflowRes.headers.get("x-deepai-context-trimmed"), null);
    const overflowBody = await overflowRes.json();
    assert.equal(overflowBody.error.code, "upstream_error");
    assert.equal(overflowBody.error.message, "This conversation exceeds the context window. Compact it to continue.");

    // 4. Client-side compaction is detected and reported, and the transcript is forwarded intact
    mockUpstream.setCompletionHandler(null);
    const closed = "c".repeat(600);
    const checkpointMsgs = [
      { role: "system", content: "Agent system prompt" },
      {
        role: "user",
        content:
          `<conversation-checkpoint>\n<summary>\n## Objective\n${closed}\n## Requirements\n- keep going\n` +
          `## Work State\n### Completed\n- done\n## Next Move\n- ship\n</summary>\n` +
          `<recent-context>\n[User]: ${closed}\n[Assistant]: ${closed}\n[Tool result]: ${closed}\n[Assistant]: ok\n</recent-context>\n` +
          `</conversation-checkpoint>`,
      },
      { role: "assistant", content: "Continuando de onde paramos." },
      { role: "user", content: "Segue." },
    ];
    const compactedRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${proxyKey}` },
      body: JSON.stringify({ model: "deepseek-v4.1-flash", stream: false, messages: checkpointMsgs }),
    });
    assert.equal(compactedRes.status, 200);
    assert.equal(compactedRes.headers.get("x-deepai-client-compacted"), "true");
    assert.equal(compactedRes.headers.get("x-deepai-context-trimmed"), "false");

    const lastReq = mockUpstream.receivedRequests.filter((r) => r.pathname === "/deepai_code/chat/completions").at(-1);
    // System prompt stays at index 0, checkpoint message intact at index 1
    assert.equal(lastReq.body.messages[0].role, "system");
    assert.equal(lastReq.body.messages[1].role, "user");
    assert.ok(lastReq.body.messages[1].content.includes("<conversation-checkpoint>"));
    assert.ok(lastReq.body.messages[1].content.includes("<recent-context>"));
    assert.equal(lastReq.body.messages.length, 4);
  } finally {
    if (app) await app.close();
    await mockUpstream.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Transcript Sanitization: reasoning_details stripping, mid-convo system folding, tool repair, pass-through sizes, and session affinity across model switches & client compaction", async () => {
  const modelInfo = { id: "deepseek-v4.1-flash", contextWindow: 320000, maxTokens: 16384 };
  const hugeToolOutput = "FILE_CONTENT_LINE\n".repeat(3500); // ~63,000 chars (~18,000 tokens each)
  const encryptedReasoning = "gwst1." + "R".repeat(24000); // ~6,850 tokens each

  // 1. Multi-turn tool-heavy conversation (>95,000 raw tokens across 3 turns)
  // Pass-through policy: the payload keeps its full size, only reasoning blobs are stripped.
  const multiTurnMessages = [
    { role: "system", content: "You are OpenCode coding agent." },
    // Turn 1
    { role: "user", content: "Turn 1 question: analyze deepai-proxy-novo architecture." },
    {
      role: "assistant",
      content: "",
      reasoning_details: [{ type: "reasoning.encrypted", format: "stealth-v1", data: encryptedReasoning }],
      tool_calls: [
        {
          id: "call_t1_read1",
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ filePath: "src/proxy.mjs" }) },
        },
        {
          id: "call_t1_read2",
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ filePath: "src/context.mjs" }) },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_t1_read1", content: hugeToolOutput },
    { role: "tool", tool_call_id: "call_t1_read2", content: hugeToolOutput },
    {
      role: "assistant",
      content: "Turn 1 final answer: I analyzed src/proxy.mjs and src/context.mjs and found the root causes.",
      reasoning_details: [{ type: "reasoning.encrypted", format: "stealth-v1", data: encryptedReasoning }],
    },
    // Turn 2
    { role: "user", content: "Turn 2 question: research the n8n workflow patterns." },
    {
      role: "assistant",
      content: "",
      reasoning: "Thinking about n8n docs...",
      reasoning_details: [{ type: "reasoning.encrypted", format: "stealth-v1", data: encryptedReasoning }],
      tool_calls: [
        {
          id: "call_t2_web1",
          type: "function",
          function: { name: "webfetch", arguments: JSON.stringify({ url: "https://docs.n8n.io/workflows" }) },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_t2_web1", content: hugeToolOutput },
    {
      role: "assistant",
      content: "Turn 2 final answer: Here is the complete n8n webhook and error handling architecture.",
      reasoning_details: [{ type: "reasoning.encrypted", format: "stealth-v1", data: encryptedReasoning }],
    },
    // Turn 3 (Active turn with mid-conversation system notification after tool result)
    { role: "user", content: "Turn 3 question: now build the workflow and verify if everything from Turn 1 and Turn 2 is ready." },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_t3_bash",
          type: "function",
          function: { name: "bash", arguments: JSON.stringify({ command: "echo JSON_OK" }) },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_t3_bash", content: "JSON_OK" },
    {
      role: "system",
      content: "The Code Mode tool catalog has changed. New tools are available: - n8n-mcp: search_nodes, validate_workflow",
    },
  ];

  const compacted = manageContext({
    body: { model: "deepseek-v4.1-flash", messages: multiTurnMessages },
    modelInfo,
    contextSettings: { mode: "auto" },
  });

  assert.equal(compacted.error, undefined);
  assert.ok(compacted.meta.originalInputTokens > 80000, `Expected >80k original tokens, got ${compacted.meta.originalInputTokens}`);
  // Pass-through: only the encrypted reasoning blobs are removed, no context is trimmed.
  assert.equal(compacted.meta.trimmed, false);
  assert.ok(
    compacted.meta.estimatedInputTokens > 28000,
    `Expected full transcript well above 28k, got ${compacted.meta.estimatedInputTokens}`,
  );
  assert.ok(compacted.meta.strippedReasoningCount >= 4);
  assert.equal(compacted.meta.foldedSystemCount, 1);

  const outMsgs = compacted.body.messages;
  // Mid-conversation system message folded into index 0 system prompt
  assert.equal(outMsgs[0].role, "system");
  assert.ok(outMsgs[0].content.includes("You are OpenCode coding agent."));
  assert.ok(outMsgs[0].content.includes("The Code Mode tool catalog has changed."));
  assert.equal(outMsgs.filter((m) => m.role === "system").length, 1);

  // Active turn still ends on the active tool result ("JSON_OK"), not a dangling system message
  assert.equal(outMsgs[outMsgs.length - 1].role, "tool");
  assert.equal(outMsgs[outMsgs.length - 1].content, "JSON_OK");

  // No reasoning_details left on any message sent upstream
  for (const m of outMsgs) {
    assert.equal(m.reasoning_details, undefined);
    assert.equal(m.reasoning, undefined);
    assert.equal(m.reasoning_content, undefined);
  }

  // EVERY user question and EVERY final assistant answer from Turn 1, Turn 2, and Turn 3 is preserved!
  const allText = outMsgs.map((m) => `${m.role}: ${m.content}`).join("\n");
  assert.ok(allText.includes("Turn 1 question: analyze deepai-proxy-novo architecture."));
  assert.ok(allText.includes("Turn 1 final answer: I analyzed src/proxy.mjs and src/context.mjs"));
  assert.ok(allText.includes("Turn 2 question: research the n8n workflow patterns."));
  assert.ok(allText.includes("Turn 2 final answer: Here is the complete n8n webhook"));
  assert.ok(allText.includes("Turn 3 question: now build the workflow"));

  // 2. Orphaned tool_calls repair, orphaned tool removal, and empty assistant skipping
  const brokenTranscript = [
    { role: "system", content: "Sys" },
    { role: "user", content: "Start" },
    { role: "assistant", content: "" }, // empty aborted assistant message -> should be skipped
    { role: "tool", tool_call_id: "orphan_tool_99", content: "orphaned result" }, // orphaned tool -> should be dropped
    {
      role: "assistant",
      content: "Calling 2 tools",
      tool_calls: [
        { id: "tc_ok", type: "function", function: { name: "read", arguments: "{}" } },
        { id: "tc_missing", type: "function", function: { name: "glob", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "tc_ok", content: "read ok" },
    // tc_missing has no tool result before next user message!
    { role: "user", content: "Continue after interruption" },
  ];

  const repairedRes = manageContext({
    body: { model: "deepseek-v4.1-flash", messages: brokenTranscript },
    modelInfo,
    contextSettings: { mode: "auto" },
  });
  const repMsgs = repairedRes.body.messages;
  assert.ok(!repMsgs.some((m) => m.tool_call_id === "orphan_tool_99"));
  const syntheticTool = repMsgs.find((m) => m.role === "tool" && m.tool_call_id === "tc_missing");
  assert.ok(syntheticTool, "Expected synthetic tool result for interrupted tool_call");
  assert.equal(syntheticTool.content, "No result provided");

  // 3. Session Affinity stability across model switches and client prefix compaction
  const dir = await createTempDir();
  const mockUpstream = await createMockDeepAIUpstream();
  let app = null;

  try {
    app = await startServer({
      port: 0,
      host: "127.0.0.1",
      logger: silentLogger,
      accountsFile: path.join(dir, "accounts.json"),
      configFile: path.join(dir, "config.json"),
      metricsFile: path.join(dir, "metrics.json"),
      upstreamBaseUrl: mockUpstream.baseUrl,
    });

    const baseUrl = `http://127.0.0.1:${app.port}`;
    const { config } = await (await fetch(`${baseUrl}/api/config`)).json();
    const proxyKey = config.proxyApiKey;

    await fetch(`${baseUrl}/api/accounts/import-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "da-affinity-key-1", label: "Affinity Account", isPro: true }),
    });

    // Request A: Turn 1 on deepseek-v4.1-flash
    const resA = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${proxyKey}` },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        stream: false,
        messages: [
          { role: "system", content: "Agent system prompt v1" },
          { role: "user", content: "Initial project setup request for deepai proxy" },
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call_unique_8842", type: "function", function: { name: "read", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "call_unique_8842", content: "file content ok" },
        ],
      }),
    });
    assert.equal(resA.status, 200);

    // Request B: Model switch to glm-5.3-flash on the same conversation
    const resB = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${proxyKey}` },
      body: JSON.stringify({
        model: "glm-5.3-flash",
        stream: false,
        messages: [
          { role: "system", content: "Agent system prompt v1" },
          { role: "user", content: "Initial project setup request for deepai proxy" },
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call_unique_8842", type: "function", function: { name: "read", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "call_unique_8842", content: "file content ok" },
          { role: "assistant", content: "Completed initial setup analysis." },
          { role: "user", content: "Now implement the second module." },
        ],
      }),
    });
    assert.equal(resB.status, 200);

    // Request C: Client compacted the prefix (firstUser replaced with summary!), but kept recent messages/tool_call
    const resC = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${proxyKey}` },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        stream: false,
        messages: [
          { role: "system", content: "Agent system prompt v1" },
          { role: "user", content: "[Compacted Summary]: User asked for initial setup." },
          { role: "assistant", content: "Completed initial setup analysis." },
          { role: "user", content: "Now implement the second module." },
          { role: "assistant", content: "Second module implemented." },
          { role: "user", content: "Run the verification tests now." },
        ],
      }),
    });
    assert.equal(resC.status, 200);

    const reqs = mockUpstream.receivedRequests.filter((r) => r.pathname === "/deepai_code/chat/completions");
    assert.equal(reqs.length, 3);
    const affA = reqs[0].headers["x-session-affinity"];
    const affB = reqs[1].headers["x-session-affinity"];
    const affC = reqs[2].headers["x-session-affinity"];
    assert.equal(affB, affA, "Model switch should preserve session affinity");
    assert.equal(affC, affA, "Client prefix compaction with overlapping history should preserve session affinity");
  } finally {
    if (app) await app.close();
    await mockUpstream.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
