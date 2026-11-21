import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Telemetry } from "../src/telemetry.mjs";

test("telemetria separa cancelado de erro", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deepai-telemetry-"));
  const file = path.join(dir, "telemetry.json");
  const telemetry = new Telemetry(file);
  telemetry.record({ accountId: "a", endpoint: "chat", status: 200, inputTokens: 10 });
  telemetry.record({ accountId: "a", endpoint: "chat", status: 499 });
  telemetry.record({ accountId: "a", endpoint: "chat", status: 500, error: "falhou" });
  telemetry.flush();
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(data.summary.requests, 3);
  assert.equal(data.summary.successes, 1);
  assert.equal(data.summary.cancelled, 1);
  assert.equal(data.summary.errors, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("telemetria antiga migra 499 de erro para cancelado", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deepai-telemetry-"));
  const file = path.join(dir, "telemetry.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      summary: { requests: 1, successes: 0, errors: 1 },
      accounts: { a: { requests: 1, successes: 0, errors: 1 } },
      requests: [{ accountId: "a", status: 499 }],
      updatedAt: null,
    }),
  );
  const telemetry = new Telemetry(file);
  const snap = telemetry.snapshot();
  assert.equal(snap.summary.errors, 0);
  assert.equal(snap.summary.cancelled, 1);
  assert.equal(snap.accounts.a.errors, 0);
  assert.equal(snap.accounts.a.cancelled, 1);
  telemetry.flush();
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
