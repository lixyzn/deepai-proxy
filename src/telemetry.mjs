import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./store.mjs";

const MAX_REQUESTS = 200;
const SAVE_DEBOUNCE_MS = 1200;

function emptySummary() {
  return {
    requests: 0,
    successes: 0,
    errors: 0,
    cancelled: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheHits: 0,
    totalDurationMs: 0,
    totalBytes: 0,
    estimatedTheos: 0,
  };
}

function emptyAccountStats() {
  return {
    requests: 0,
    successes: 0,
    errors: 0,
    cancelled: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheHits: 0,
    totalDurationMs: 0,
    estimatedTheos: 0,
    lastRequestAt: null,
    lastLatencyMs: null,
    lastStatus: null,
    lastModel: null,
    lastError: null,
  };
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function positiveOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class Telemetry {
  constructor(file = path.join(DATA_DIR, "telemetry.json")) {
    this.file = file;
    this.summary = emptySummary();
    this.accounts = {};
    this.requests = [];
    this.updatedAt = null;
    this.pendingSave = null;
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (data && typeof data === "object") {
        this.summary = { ...emptySummary(), ...(data.summary ?? {}) };
        this.accounts = data.accounts && typeof data.accounts === "object" ? data.accounts : {};
        this.requests = Array.isArray(data.requests) ? data.requests.slice(0, MAX_REQUESTS) : [];
        this.updatedAt = typeof data.updatedAt === "string" ? data.updatedAt : null;
        if (data.version !== 2) this.migrateCancelled();
      }
    } catch {
      // primeiro uso ou arquivo corrompido: começa limpo
    }
  }

  migrateCancelled() {
    let summaryCancelled = 0;
    const byAccount = new Map();
    for (const request of this.requests) {
      if (Number(request.status) !== 499) continue;
      summaryCancelled += 1;
      byAccount.set(
        request.accountId,
        (byAccount.get(request.accountId) ?? 0) + 1,
      );
    }
    if (summaryCancelled > 0) {
      this.summary.errors = Math.max(
        0,
        numberOrZero(this.summary.errors) - summaryCancelled,
      );
      this.summary.cancelled =
        numberOrZero(this.summary.cancelled) + summaryCancelled;
      for (const [accountId, count] of byAccount) {
        const account = this.accounts[accountId];
        if (!account) continue;
        account.errors = Math.max(0, numberOrZero(account.errors) - count);
        account.cancelled = numberOrZero(account.cancelled) + count;
      }
      this.scheduleSave();
    }
  }

  record(input) {
    const accountId = input.accountId ?? "unknown";
    const status = Number(input.status) || 0;
    const success = status >= 200 && status < 400;
    const cancelled = status === 499;
    const at = input.at ?? new Date().toISOString();
    const durationMs = Math.max(0, Math.round(numberOrZero(input.durationMs)));
    const inputTokens = Math.max(0, Math.round(numberOrZero(input.inputTokens)));
    const outputTokens = Math.max(0, Math.round(numberOrZero(input.outputTokens)));
    const cachedInputTokens = Math.max(
      0,
      Math.round(numberOrZero(input.cachedInputTokens)),
    );
    const cacheKnown =
      input.cachedInputTokens !== undefined && input.cachedInputTokens !== null;
    const cacheHit = cacheKnown ? cachedInputTokens > 0 : null;
    const bytes = Math.max(0, Math.round(numberOrZero(input.bytes)));
    const theos = positiveOrNull(input.theos);
    const error = input.error
      ? String(input.error).replace(/\s+/g, " ").slice(0, 240)
      : null;

    const entry = {
      id: `req_${randomBytes(6).toString("hex")}`,
      at,
      accountId,
      endpoint: input.endpoint ?? "unknown",
      model: input.model ? String(input.model).slice(0, 128) : null,
      status,
      durationMs,
      bytes,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheHit,
      theos,
      error,
    };

    this.requests.unshift(entry);
    if (this.requests.length > MAX_REQUESTS) {
      this.requests.length = MAX_REQUESTS;
    }

    const account = this.accounts[accountId] ?? emptyAccountStats();
    account.requests += 1;
    if (success) account.successes += 1;
    else if (cancelled) {
      account.cancelled = numberOrZero(account.cancelled) + 1;
    } else account.errors += 1;
    account.inputTokens += inputTokens;
    account.outputTokens += outputTokens;
    account.cachedInputTokens =
      numberOrZero(account.cachedInputTokens) + cachedInputTokens;
    account.cacheHits = numberOrZero(account.cacheHits) + (cacheHit ? 1 : 0);
    account.totalDurationMs += durationMs;
    if (theos !== null) account.estimatedTheos += theos;
    account.lastRequestAt = at;
    account.lastLatencyMs = durationMs;
    account.lastStatus = status;
    account.lastModel = entry.model;
    account.lastError = success ? null : error;
    this.accounts[accountId] = account;

    this.summary.requests += 1;
    if (success) this.summary.successes += 1;
    else if (cancelled) this.summary.cancelled += 1;
    else this.summary.errors += 1;
    this.summary.inputTokens += inputTokens;
    this.summary.outputTokens += outputTokens;
    this.summary.cachedInputTokens += cachedInputTokens;
    this.summary.cacheHits += cacheHit ? 1 : 0;
    this.summary.totalDurationMs += durationMs;
    this.summary.totalBytes += bytes;
    if (theos !== null) this.summary.estimatedTheos += theos;
    this.updatedAt = at;

    this.scheduleSave();
    return entry;
  }

  snapshot() {
    return {
      summary: { ...this.summary },
      accounts: { ...this.accounts },
      requests: this.requests.slice(0, MAX_REQUESTS),
      updatedAt: this.updatedAt,
    };
  }

  clear() {
    this.summary = emptySummary();
    this.accounts = {};
    this.requests = [];
    this.updatedAt = new Date().toISOString();
    this.scheduleSave();
  }

  scheduleSave() {
    if (this.pendingSave) return;
    this.pendingSave = setTimeout(() => {
      this.pendingSave = null;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
    this.pendingSave.unref?.();
  }

  flush() {
    if (this.pendingSave) {
      clearTimeout(this.pendingSave);
      this.pendingSave = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${randomBytes(6).toString("hex")}.tmp`;
      fs.writeFileSync(
        tmp,
        `${JSON.stringify(
          {
            version: 2,
            summary: this.summary,
            accounts: this.accounts,
            requests: this.requests,
            updatedAt: this.updatedAt,
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.warn(
        `[telemetry] não foi possível salvar: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
