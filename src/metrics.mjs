import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DEFAULT_METRICS_PATH = path.join(ROOT, "data", "metrics.json");

const RANGE_MS = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

function emptyState() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    totals: {
      totalRequests: 0,
      successCount: 0,
      errorCount: 0,
      totalLatencyMs: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
    },
    requests: [],
  };
}

function formatBucketLabel(ts, range) {
  const d = new Date(ts);
  if (range === "7d" || range === "30d") {
    return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:00`;
  }
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export class MetricsStore {
  constructor({ filePath = DEFAULT_METRICS_PATH, maxRecords = 2000, logger = console } = {}) {
    this.filePath = filePath;
    this.maxRecords = maxRecords;
    this.logger = logger;
    this.state = emptyState();
    this._writeQueue = Promise.resolve();
    this._initialized = false;
  }

  async init() {
    if (this._initialized) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const base = emptyState();
        this.state = {
          version: 1,
          updatedAt: parsed.updatedAt || base.updatedAt,
          totals: { ...base.totals, ...(parsed.totals || {}) },
          requests: Array.isArray(parsed.requests) ? parsed.requests.slice(-this.maxRecords) : [],
        };
      }
    } catch (err) {
      if (err?.code !== "ENOENT") {
        this.logger.warn?.("[metrics] failed to load metrics.json, starting fresh:", err?.message || err);
      }
      this.state = emptyState();
      await this._persist();
    }
    this._initialized = true;
  }

  _persist() {
    this.state.updatedAt = new Date().toISOString();
    const payload = JSON.stringify(this.state, null, 2);
    this._writeQueue = this._writeQueue
      .then(async () => {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const tmpPath = `${this.filePath}.tmp`;
        await fs.writeFile(tmpPath, payload, "utf8");
        await fs.rename(tmpPath, this.filePath);
      })
      .catch((err) => {
        this.logger.error?.("[metrics] persist error:", err);
      });
    return this._writeQueue;
  }

  async record(entry = {}) {
    if (!this._initialized) await this.init();

    const nowIso = new Date().toISOString();
    const promptTokens = Math.max(0, Number(entry.promptTokens) || 0);
    const completionTokens = Math.max(0, Number(entry.completionTokens) || 0);
    const totalTokens = Math.max(0, Number(entry.totalTokens) || promptTokens + completionTokens);
    const latencyMs = Math.max(0, Math.round(Number(entry.latencyMs) || 0));
    const ok = Boolean(entry.ok);
    const status = Number(entry.status) || (ok ? 200 : 500);

    const record = {
      id: entry.id || crypto.randomUUID(),
      timestamp: entry.timestamp || nowIso,
      model: String(entry.model || "unknown"),
      accountId: entry.accountId ? String(entry.accountId) : null,
      accountLabel: String(entry.accountLabel || entry.accountId || "N/A"),
      latencyMs,
      status,
      ok,
      stream: Boolean(entry.stream),
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedInputTokens: Math.max(0, Number(entry.estimatedInputTokens) || 0),
      contextLimit: Math.max(0, Number(entry.contextLimit) || 0),
      contextTrimmed: Boolean(entry.contextTrimmed),
      droppedMessages: Math.max(0, Number(entry.droppedMessages) || 0),
      contextUtilizationPct: Math.min(100, Math.max(0, Number(entry.contextUtilizationPct) || 0)),
      clientCompacted: Boolean(entry.clientCompacted),
      compactionKind: entry.compactionKind ? String(entry.compactionKind) : null,
      error: entry.error ? String(entry.error) : null,
    };

    const t = this.state.totals;
    t.totalRequests += 1;
    if (ok) t.successCount += 1;
    else t.errorCount += 1;
    t.totalLatencyMs += latencyMs;
    t.totalPromptTokens += promptTokens;
    t.totalCompletionTokens += completionTokens;
    t.totalTokens += totalTokens;

    this.state.requests.push(record);
    if (this.state.requests.length > this.maxRecords) {
      this.state.requests = this.state.requests.slice(-this.maxRecords);
    }

    await this._persist();
    return record;
  }

  async reset() {
    if (!this._initialized) await this.init();
    this.state = emptyState();
    await this._persist();
    return { ok: true, resetAt: this.state.updatedAt };
  }

  getDashboardStats({ range = "24h", activeAccountsCount = 0, limitRecent = 50 } = {}) {
    const normalizedRange = RANGE_MS[range] ? range : range === "all" ? "all" : "24h";
    const now = Date.now();
    const rangeMs = RANGE_MS[normalizedRange] || null;
    const cutoff = rangeMs ? now - rangeMs : 0;

    const filtered = this.state.requests.filter((r) => {
      const ts = Date.parse(r.timestamp);
      return Number.isFinite(ts) && ts >= cutoff;
    });

    const totalRequests = filtered.length;
    let successCount = 0;
    let errorCount = 0;
    let sumLatency = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let trimmedRequestsCount = 0;
    let compactionCount = 0;
    let sumContextUtil = 0;
    let contextUtilSamples = 0;
    const latencies = [];

    const modelMap = new Map();
    const accountMap = new Map();

    for (const r of filtered) {
      if (r.ok) successCount += 1;
      else errorCount += 1;

      const lat = Number(r.latencyMs) || 0;
      sumLatency += lat;
      latencies.push(lat);

      promptTokens += Number(r.promptTokens) || 0;
      completionTokens += Number(r.completionTokens) || 0;
      totalTokens += Number(r.totalTokens) || 0;
      if (r.contextTrimmed) trimmedRequestsCount += 1;
      if (r.clientCompacted) compactionCount += 1;
      if (Number(r.contextLimit) > 0) {
        sumContextUtil += Number(r.contextUtilizationPct) || 0;
        contextUtilSamples += 1;
      }

      // By model
      const mKey = r.model || "unknown";
      let mEntry = modelMap.get(mKey);
      if (!mEntry) {
        mEntry = { model: mKey, requests: 0, success: 0, errors: 0, sumLatency: 0, totalTokens: 0 };
        modelMap.set(mKey, mEntry);
      }
      mEntry.requests += 1;
      if (r.ok) mEntry.success += 1;
      else mEntry.errors += 1;
      mEntry.sumLatency += lat;
      mEntry.totalTokens += Number(r.totalTokens) || 0;

      // By account
      const aKey = r.accountId || r.accountLabel || "unknown";
      let aEntry = accountMap.get(aKey);
      if (!aEntry) {
        aEntry = {
          accountId: r.accountId || null,
          accountLabel: r.accountLabel || aKey,
          requests: 0,
          success: 0,
          errors: 0,
          sumLatency: 0,
          totalTokens: 0,
        };
        accountMap.set(aKey, aEntry);
      }
      aEntry.requests += 1;
      if (r.ok) aEntry.success += 1;
      else aEntry.errors += 1;
      aEntry.sumLatency += lat;
      aEntry.totalTokens += Number(r.totalTokens) || 0;
    }

    latencies.sort((a, b) => a - b);
    const p95Index = latencies.length > 0 ? Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95)) : 0;
    const p95LatencyMs = latencies.length > 0 ? latencies[p95Index] : 0;
    const avgLatencyMs = totalRequests > 0 ? Math.round(sumLatency / totalRequests) : 0;
    const successRate = totalRequests > 0 ? Number(((successCount / totalRequests) * 100).toFixed(1)) : 0;

    // Time-series buckets
    const bucketCount = normalizedRange === "1h" ? 12 : normalizedRange === "6h" ? 12 : normalizedRange === "7d" ? 14 : normalizedRange === "30d" ? 30 : 24;
    let startTs = rangeMs ? now - rangeMs : now - RANGE_MS["24h"];
    if (normalizedRange === "all" && filtered.length > 0) {
      const firstTs = Date.parse(filtered[0].timestamp);
      if (Number.isFinite(firstTs) && firstTs < now) {
        startTs = Math.min(firstTs, now - 60 * 60 * 1000);
      }
    }
    const span = Math.max(60 * 1000, now - startTs);
    const bucketSize = span / bucketCount;

    const buckets = Array.from({ length: bucketCount }, (_, i) => {
      const ts = Math.round(startTs + i * bucketSize);
      return {
        timestamp: new Date(ts).toISOString(),
        label: formatBucketLabel(ts, normalizedRange),
        requests: 0,
        success: 0,
        errors: 0,
        sumLatency: 0,
        avgLatencyMs: 0,
      };
    });

    for (const r of filtered) {
      const ts = Date.parse(r.timestamp);
      if (!Number.isFinite(ts)) continue;
      const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((ts - startTs) / bucketSize)));
      const b = buckets[idx];
      b.requests += 1;
      if (r.ok) b.success += 1;
      else b.errors += 1;
      b.sumLatency += Number(r.latencyMs) || 0;
    }

    const timeSeries = buckets.map((b) => ({
      timestamp: b.timestamp,
      label: b.label,
      requests: b.requests,
      success: b.success,
      errors: b.errors,
      avgLatencyMs: b.requests > 0 ? Math.round(b.sumLatency / b.requests) : 0,
    }));

    const byModel = Array.from(modelMap.values())
      .map((m) => ({
        model: m.model,
        requests: m.requests,
        success: m.success,
        errors: m.errors,
        successRate: m.requests > 0 ? Number(((m.success / m.requests) * 100).toFixed(1)) : 0,
        avgLatencyMs: m.requests > 0 ? Math.round(m.sumLatency / m.requests) : 0,
        totalTokens: m.totalTokens,
      }))
      .sort((a, b) => b.requests - a.requests);

    const byAccount = Array.from(accountMap.values())
      .map((a) => ({
        accountId: a.accountId,
        accountLabel: a.accountLabel,
        requests: a.requests,
        success: a.success,
        errors: a.errors,
        successRate: a.requests > 0 ? Number(((a.success / a.requests) * 100).toFixed(1)) : 0,
        avgLatencyMs: a.requests > 0 ? Math.round(a.sumLatency / a.requests) : 0,
        totalTokens: a.totalTokens,
      }))
      .sort((a, b) => b.requests - a.requests);

    const recentRequests = filtered.slice(-limitRecent).reverse();

    return {
      range: normalizedRange,
      kpis: {
        totalRequests,
        successCount,
        errorCount,
        successRate,
        avgLatencyMs,
        p95LatencyMs,
        activeAccountsCount,
        promptTokens,
        completionTokens,
        totalTokens,
        trimmedRequestsCount,
        compactionCount,
        avgContextUtilizationPct: contextUtilSamples > 0 ? Math.round(sumContextUtil / contextUtilSamples) : 0,
      },
      allTimeTotals: { ...this.state.totals },
      timeSeries,
      byModel,
      byAccount,
      recentRequests,
    };
  }
}
