/* ==========================================================================
   DeepAI Proxy — Painel
   Zero dependências. Consome a API local em /api/*.
   ========================================================================== */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const ICONS = {
    ok: "i-check",
    err: "i-alert",
    info: "i-info",
  };

  const RANGE_LABELS = {
    "1h": "Última hora",
    "24h": "Últimas 24 horas",
    "7d": "Últimos 7 dias",
    all: "Todo o período",
  };

  const state = {
    tab: "dashboard",
    range: "1h",
    autoRefresh: true,
    healthOk: null,
    metrics: null,
    metricsError: null,
    accounts: [],
    activeAccountId: null,
    models: [],
    modelsMeta: { total: 0, free: 0, paid: 0 },
    modelsSearch: "",
    modelsTier: "all",
    config: {
      proxyApiKey: "",
      requireApiKey: true,
      rotationStrategy: "round-robin",
      defaultModel: "",
    },
    codeTab: "curl",
    chartSeries: { requests: true, latency: true },
    sort: { key: "timestamp", dir: "desc" },
    authPollTimer: null,
    authTickTimer: null,
    refreshTimer: null,
    paletteIndex: 0,
    paletteItems: [],
    paletteOpen: false,
    modalResolve: null,
  };

  const TAB_INFO = {
    dashboard: { title: "Dashboard", subtitle: "Tráfego, latência e saúde do gateway" },
    accounts: { title: "Contas DeepAI", subtitle: "Conectar, rotacionar e monitorar contas" },
    models: { title: "Modelos", subtitle: "Catálogo disponível no endpoint OpenAI" },
    settings: { title: "Configurações", subtitle: "Segurança, integração e gerenciamento de contexto" },
  };

  /* ------------------------------------------------------------------ */
  /* Utilidades                                                          */
  /* ------------------------------------------------------------------ */

  async function api(path, { method = "GET", body } = {}) {
    const opts = { method, headers: { Accept: "application/json" } };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path.startsWith("/") ? path : `/api/${path}`, opts);
    } catch {
      const err = new Error("Falha de rede — o proxy local não respondeu.");
      err.offline = true;
      throw err;
    }
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok || data?.ok === false) {
      const msg =
        data?.error?.message ||
        data?.detail ||
        (typeof data?.error === "string" ? data.error : null) ||
        data?.message ||
        `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function icon(name, cls = "") {
    return `<svg class="icon ${cls}" aria-hidden="true"><use href="#${name}"/></svg>`;
  }

  const nf = new Intl.NumberFormat("pt-BR");
  const num = (v) => nf.format(Number(v || 0));

  function compact(n) {
    const v = Number(n || 0);
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1).replace(".", ",")}M`;
    if (v >= 10_000) return `${Math.round(v / 1000)}k`;
    if (v >= 1_000) return `${(v / 1000).toFixed(1).replace(".", ",")}k`;
    return String(v);
  }

  function fmtDate(val, { seconds = false } = {}) {
    if (!val) return "—";
    const d = val instanceof Date ? val : new Date(val);
    if (Number.isNaN(d.getTime())) return String(val);
    return d.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      ...(seconds ? { second: "2-digit" } : {}),
    });
  }

  function timeAgo(ts) {
    if (!ts) return "nunca";
    const diff = Date.now() - Number(ts);
    if (!Number.isFinite(diff) || diff < 0) return "agora";
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s}s atrás`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}min atrás`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h atrás`;
    const d = Math.floor(h / 24);
    return `${d}d atrás`;
  }

  function duration(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${s}s`;
  }

  function latencyClass(ms) {
    const v = Number(ms) || 0;
    if (v >= 30000) return "is-very-slow";
    if (v >= 12000) return "is-slow";
    return "";
  }

  function initials(label) {
    const clean = String(label || "?").trim();
    const parts = clean.split(/[\s._-]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return clean.slice(0, 2).toUpperCase();
  }

  /* ------------------------------------------------------------------ */
  /* Toasts                                                              */
  /* ------------------------------------------------------------------ */

  function toast(message, kind = "ok", timeout = 3600) {
    const container = $("toastContainer");
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.setAttribute("role", kind === "err" ? "alert" : "status");
    el.innerHTML = `${icon(ICONS[kind] || ICONS.info)}<span>${esc(message)}</span>`;
    container.appendChild(el);
    const close = () => {
      el.classList.add("is-out");
      setTimeout(() => el.remove(), 220);
    };
    const t = setTimeout(close, timeout);
    el.addEventListener("click", () => {
      clearTimeout(t);
      close();
    });
  }

  async function copyText(text, label = "Copiado!") {
    const value = String(text ?? "").trim();
    if (!value) return toast("Nada para copiar.", "err");
    try {
      await navigator.clipboard.writeText(value);
      toast(label, "ok", 2200);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        toast(label, "ok", 2200);
      } catch {
        toast("Não foi possível copiar.", "err");
      } finally {
        ta.remove();
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Modal (substitui confirm/prompt)                                    */
  /* ------------------------------------------------------------------ */

  function openModal({ title = "Confirmar", desc = "", confirm = "Confirmar", cancel = "Cancelar", danger = false, input = null }) {
    return new Promise((resolve) => {
      const modal = $("modal");
      $("modalTitle").textContent = title;
      $("modalDesc").textContent = desc;
      const field = $("modalField");
      const inputEl = $("modalInput");
      const confirmBtn = $("modalConfirm");

      confirmBtn.textContent = confirm;
      confirmBtn.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;
      $("modalCancel").textContent = cancel;

      if (input) {
        field.hidden = false;
        inputEl.value = input.value || "";
        inputEl.placeholder = input.placeholder || "";
        inputEl.type = input.type || "text";
        if (input.maxlength) inputEl.maxLength = input.maxlength;
      } else {
        field.hidden = true;
      }

      modal.hidden = false;
      state.modalResolve = resolve;

      const done = (value) => {
        modal.hidden = true;
        state.modalResolve = null;
        document.removeEventListener("keydown", onKey);
        resolve(value);
      };

      const finish = () => {
        if (!input) return done(true);
        const v = inputEl.value.trim();
        if (!v) {
          inputEl.focus();
          inputEl.style.borderColor = "var(--err)";
          return;
        }
        done(v);
      };

      const onKey = (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          done(false);
        } else if (e.key === "Enter") {
          e.preventDefault();
          finish();
        }
      };

      confirmBtn.onclick = finish;
      $("modalCancel").onclick = () => done(false);
      $("modalClose").onclick = () => done(false);
      modal.onclick = (e) => {
        if (e.target === modal) done(false);
      };
      document.addEventListener("keydown", onKey);

      setTimeout(() => (input ? inputEl : confirmBtn).focus(), 40);
    });
  }

  const confirmAction = (opts) => openModal(opts);

  /* ------------------------------------------------------------------ */
  /* Tema                                                                */
  /* ------------------------------------------------------------------ */

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("dp-theme", theme);
    } catch {
      /* ignore */
    }
  }

  function initTheme() {
    let theme = null;
    try {
      theme = localStorage.getItem("dp-theme");
    } catch {
      /* ignore */
    }
    if (!theme) {
      theme = window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
    applyTheme(theme);
  }

  function initRange() {
    let range = null;
    try {
      range = localStorage.getItem("dp-range");
    } catch {
      /* ignore */
    }
    if (range && RANGE_LABELS[range]) {
      state.range = range;
      qsa("#metricsRangePills button").forEach((b) => {
        b.setAttribute("aria-pressed", String(b.dataset.range === range));
      });
      $("chartRangeLabel").textContent = RANGE_LABELS[range];
    }
  }

  $("btnThemeToggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    if (state.tab === "dashboard") renderDashboard();
  });

  /* ------------------------------------------------------------------ */
  /* Navegação                                                           */
  /* ------------------------------------------------------------------ */

  const TAB_LOADERS = {
    dashboard: () => loadMetrics(),
    accounts: () => Promise.allSettled([loadAccounts(), refreshAuthStatus()]),
    models: () => loadModels(),
    settings: () => loadConfig(),
  };

  function switchTab(tabName, { push = true } = {}) {
    if (!TAB_INFO[tabName]) tabName = "dashboard";
    state.tab = tabName;

    qsa(".nav-item").forEach((btn) => {
      const on = btn.dataset.tab === tabName;
      btn.classList.toggle("is-active", on);
      if (on) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });

    qsa(".panel").forEach((panel) => {
      panel.classList.toggle("is-active", panel.id === `tab-${tabName}`);
    });

    const info = TAB_INFO[tabName];
    $("pageTitle").textContent = info.title;
    $("pageSubtitle").textContent = info.subtitle;
    closeSidebar();

    if (push) {
      const hash = `#${tabName}`;
      if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
    }

    try {
      TAB_LOADERS[tabName]?.();
    } catch {
      /* loader trata seus erros */
    }
  }

  qsa(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  /* Sidebar mobile */
  function openSidebar() {
    $("sidebar").classList.add("is-open");
    $("sidebarScrim").hidden = false;
  }
  function closeSidebar() {
    $("sidebar").classList.remove("is-open");
    $("sidebarScrim").hidden = true;
  }

  $("mobileMenuBtn")?.addEventListener("click", openSidebar);
  $("sidebarScrim")?.addEventListener("click", closeSidebar);

  /* ------------------------------------------------------------------ */
  /* Health                                                             */
  /* ------------------------------------------------------------------ */

  async function checkHealth() {
    const pill = $("serverHealthPill");
    const text = $("serverHealthText");
    const sub = $("serverHealthSub");
    try {
      const data = await api("/healthz");
      state.healthOk = true;
      pill.classList.add("is-online");
      pill.classList.remove("is-offline");
      text.textContent = "Proxy online";
      const enabled = data?.accounts?.enabled ?? 0;
      const total = data?.accounts?.total ?? 0;
      sub.textContent = total ? `${enabled}/${total} conta(s) ativa(s)` : "nenhuma conta conectada";
      $("sidebarUptime").textContent = duration(data?.uptimeSec);
      hideBanner();
      return true;
    } catch {
      state.healthOk = false;
      pill.classList.remove("is-online");
      pill.classList.add("is-offline");
      text.textContent = "Proxy offline";
      sub.textContent = "verifique se o servidor está rodando";
      $("sidebarUptime").textContent = "—";
      showBanner("Não foi possível conectar ao proxy local em /healthz.");
      return false;
    }
  }

  function showBanner(message) {
    const banner = $("globalBanner");
    if (banner.hidden) {
      $("globalBannerText").textContent = message;
      banner.hidden = false;
    }
  }

  function hideBanner() {
    $("globalBanner").hidden = true;
  }

  $("globalBannerRetry")?.addEventListener("click", async () => {
    const ok = await checkHealth();
    if (ok) {
      toast("Proxy reconectado.", "ok");
      refreshAll();
    }
  });

  /* ------------------------------------------------------------------ */
  /* Dashboard                                                          */
  /* ------------------------------------------------------------------ */

  async function loadMetrics() {
    try {
      const data = await api(`/api/metrics?range=${encodeURIComponent(state.range)}`);
      state.metrics = data?.stats || data?.metrics || data || {};
      state.metricsError = null;
      renderDashboard();
    } catch (err) {
      state.metricsError = err.message;
      renderDashboardError(err.message);
    }
  }

  function renderDashboardError(message) {
    $("kpiTotalRequests").textContent = "—";
    $("kpiSuccessRate").textContent = "—";
    $("kpiAvgLatency").textContent = "—";
    $("kpiTotalSub").textContent = "sem dados";
    $("recentRequestsBody").innerHTML = `<tr><td colspan="7" class="td-empty">${esc(message)}</td></tr>`;
  }

  function renderDashboard() {
    const m = state.metrics || {};
    const kpi = m.kpis || m;

    const total = Number(kpi.totalRequests ?? 0);
    const successRate = kpi.successRate !== undefined ? Number(kpi.successRate) : total > 0 ? 100 : 0;
    const avgLatency = Math.round(Number(kpi.avgLatencyMs ?? 0));
    const p95 = Math.round(Number(kpi.p95LatencyMs ?? 0));
    const promptTokens = Number(kpi.promptTokens ?? 0);
    const completionTokens = Number(kpi.completionTokens ?? 0);
    const totalTokens = Number(kpi.totalTokens ?? promptTokens + completionTokens);
    const errorCount = Number(kpi.errorCount ?? Math.round(total * (1 - successRate / 100)));

    const activeAccounts = state.accounts.filter((a) => a.enabled !== false);
    const activeCount = Number(kpi.activeAccountsCount ?? activeAccounts.length);

    /* KPIs */
    $("kpiTotalRequests").innerHTML = total ? num(total) : "0";
    $("kpiTotalSub").textContent = totalTokens
      ? `${compact(totalTokens)} tokens processados`
      : total
        ? "sem contagem de tokens"
        : "nenhuma chamada no período";

    const rateTone = total === 0 ? "muted" : successRate >= 99 ? "ok" : successRate >= 90 ? "warn" : "err";
    $("kpiSuccessRate").innerHTML =
      total === 0
        ? `<span style="color:var(--fg-3)">—</span>`
        : `${successRate.toFixed(1).replace(".0", "").replace(".", ",")}<small>%</small>`;
    $("kpiSuccessSub").textContent = total
      ? `${num(errorCount)} erro(s)${rateTone === "ok" ? " · tudo saudável" : rateTone === "warn" ? " · atenção" : " · investigar"}`
      : "aguardando requisições";

    $("kpiAvgLatency").innerHTML = total
      ? `${num(avgLatency)}<small>ms</small>`
      : `<span style="color:var(--fg-3)">—</span>`;
    $("kpiLatencySub").textContent = `P95 ${num(p95)} ms`;

    $("kpiActiveAccounts").innerHTML = `${activeCount}<small>/${state.accounts.length}</small>`;
    $("kpiAccountsSub").textContent = state.accounts.length
      ? `${state.accounts.length} conta(s) conectada(s)`
      : "Nenhuma conta conectada";
    $("kpiAccountsBar").style.width = state.accounts.length
      ? `${Math.round((activeCount / state.accounts.length) * 100)}%`
      : "0%";

    const series = m.timeSeries || m.series || [];
    renderSparks(series, { successRate, avgLatency, total });
    renderTimeSeriesChart(series);
    renderModelsDonut(m.byModel || m.modelBreakdown || [], total);
    renderAccountBars(m.byAccount || m.accountBreakdown || []);
    renderContextPanel(kpi);

    renderRecentRequests(m.recentRequests || m.recent || []);
    $("chartRangeLabel").textContent = RANGE_LABELS[state.range] || state.range;
  }

  function renderSparks(series, { avgLatency }) {
    const list = Array.isArray(series) ? series : [];
    const reqs = list.map((d) => Number(d.requests ?? d.count ?? 0));
    const lats = list.map((d) => Number(d.avgLatencyMs ?? d.latencyMs ?? 0));
    const succ = list.map((d) => {
      const req = Number(d.requests ?? 0);
      const err = Number(d.errors ?? 0);
      return req > 0 ? ((req - err) / req) * 100 : 0;
    });

    paintSpark($("kpiReqSpark"), reqs, "var(--brand)");
    paintSpark($("kpiSuccessSpark"), succ, "var(--ok)", { baseline: 100 });
    paintSpark($("kpiLatencySpark"), lats.length ? lats : [avgLatency], "var(--brand-2)");
  }

  function paintSpark(host, values, color, { baseline = null } = {}) {
    if (!host) return;
    const vals = values.filter((v) => Number.isFinite(v));
    if (vals.length < 2 || vals.every((v) => v === 0)) {
      host.innerHTML = `<div style="height:34px;display:flex;align-items:center;color:var(--fg-3);font-size:10px;letter-spacing:.03em">sem histórico</div>`;
      return;
    }
    const w = 220;
    const h = 34;
    const pad = 2;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const xAt = (i) => pad + (i / (vals.length - 1)) * (w - pad * 2);
    const yAt = (v) => pad + (1 - (v - min) / span) * (h - pad * 2);
    const pts = vals.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`);
    const area = `M ${xAt(0).toFixed(1)},${h} L ${pts.join(" L ")} L ${xAt(vals.length - 1).toFixed(1)},${h} Z`;
    const uid = `sp-${Math.random().toString(36).slice(2, 8)}`;

    host.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="${uid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${color}" stop-opacity="0.34"/>
            <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path d="${area}" fill="url(#${uid})"/>
        <polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      </svg>`;
  }

  /* ---------- Gráfico principal ---------- */
  function renderTimeSeriesChart(series) {
    const stage = $("timeSeriesChart");
    if (!stage) return;

    const list = Array.isArray(series) ? series : [];
    const hasData = list.some((d) => Number(d.requests ?? 0) > 0 || Number(d.avgLatencyMs ?? 0) > 0);

    if (!list.length || !hasData) {
      stage.innerHTML = `
        <div class="chart-empty">
          ${icon("i-activity")}
          <span>Sem tráfego registrado ${esc((RANGE_LABELS[state.range] || "").toLowerCase())}.</span>
          <span style="font-size:11px;opacity:.75">Faça uma chamada em <code>/v1/chat/completions</code> para ver dados aqui.</span>
        </div>`;
      return;
    }

    const width = Math.max(320, Math.floor(stage.clientWidth || 760));
    const height = width < 620 ? 210 : 268;
    const pad = { top: 16, right: width < 620 ? 34 : 48, bottom: 26, left: width < 620 ? 30 : 42 };
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;

    const reqVals = list.map((d) => Number(d.requests ?? d.count ?? 0));
    const latVals = list.map((d) => Number(d.avgLatencyMs ?? d.latencyMs ?? 0));
    const maxReq = Math.max(1, ...reqVals);
    const maxLat = Math.max(1, ...latVals);

    const xAt = (i) => (list.length === 1 ? pad.left + innerW / 2 : pad.left + (i / (list.length - 1)) * innerW);
    const yReq = (v) => pad.top + innerH - (v / maxReq) * innerH;
    const yLat = (v) => pad.top + innerH - (v / maxLat) * innerH;

    const reqPts = reqVals.map((v, i) => [xAt(i), yReq(v)]);
    const latPts = latVals.map((v, i) => [xAt(i), yLat(v)]);
    const reqLine = reqPts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const latLine = latPts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const areaPath = `M ${reqPts[0][0].toFixed(1)},${(pad.top + innerH).toFixed(1)} L ${reqLine.replace(/ /g, " L ")} L ${reqPts[reqPts.length - 1][0].toFixed(1)},${(pad.top + innerH).toFixed(1)} Z`;

    const gridCount = 4;
    const grid = Array.from({ length: gridCount + 1 }, (_, i) => {
      const t = i / gridCount;
      const y = pad.top + innerH * t;
      const reqLabel = Math.round(maxReq * (1 - t));
      const latLabel = latencyShort(maxLat * (1 - t));
      return `
        <line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}"
              stroke="currentColor" stroke-opacity="0.075" stroke-width="1" stroke-dasharray="${i === gridCount ? "0" : "3 5"}"/>
        <text x="${pad.left - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end"
              fill="currentColor" fill-opacity="0.42" font-size="9.5" font-family="var(--mono)">${reqLabel}</text>
        ${
          state.chartSeries.latency
            ? `<text x="${width - pad.right + 8}" y="${(y + 3).toFixed(1)}" text-anchor="start"
                     fill="currentColor" fill-opacity="0.34" font-size="9.5" font-family="var(--mono)">${latLabel}</text>`
            : ""
        }`;
    }).join("");

    const labelStep = Math.max(1, Math.ceil(list.length / (width < 620 ? 4 : 7)));
    const xLabels = list
      .map((d, i) => {
        if (i % labelStep !== 0 && i !== list.length - 1) return "";
        const label = d.label || (d.timestamp ? shortTime(d.timestamp) : `#${i + 1}`);
        const anchor = i === 0 ? "start" : i === list.length - 1 ? "end" : "middle";
        return `<text x="${xAt(i).toFixed(1)}" y="${height - 7}" text-anchor="${anchor}"
                      fill="currentColor" fill-opacity="0.4" font-size="9.5">${esc(label)}</text>`;
      })
      .join("");

    const peakIdx = reqVals.indexOf(maxReq);
    const peak = peakIdx >= 0 ? reqPts[peakIdx] : null;

    stage.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="presentation">
        <defs>
          <linearGradient id="gradReq" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--brand)" stop-opacity="0.32"/>
            <stop offset="70%" stop-color="var(--brand)" stop-opacity="0.06"/>
            <stop offset="100%" stop-color="var(--brand)" stop-opacity="0"/>
          </linearGradient>
          <linearGradient id="gradReqLine" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="var(--brand)"/>
            <stop offset="100%" stop-color="var(--brand-2)"/>
          </linearGradient>
        </defs>

        ${grid}
        ${xLabels}

        ${state.chartSeries.requests ? `<path d="${areaPath}" fill="url(#gradReq)"/>` : ""}

        ${
          state.chartSeries.latency
            ? `<polyline points="${latLine}" fill="none" stroke="var(--brand-2)" stroke-width="1.6"
                        stroke-opacity="0.85" stroke-dasharray="4 4" stroke-linejoin="round" stroke-linecap="round"/>`
            : ""
        }

        ${
          state.chartSeries.requests
            ? `<polyline points="${reqLine}" fill="none" stroke="url(#gradReqLine)" stroke-width="2.2"
                        stroke-linejoin="round" stroke-linecap="round"/>`
            : ""
        }

        ${
          state.chartSeries.requests && peak
            ? `<circle cx="${peak[0].toFixed(1)}" cy="${peak[1].toFixed(1)}" r="3.4" fill="var(--brand)"
                       stroke="var(--bg)" stroke-width="2"/>`
            : ""
        }

        <line id="tsGuide" x1="0" y1="${pad.top}" x2="0" y2="${pad.top + innerH}"
              stroke="currentColor" stroke-opacity="0.24" stroke-width="1" stroke-dasharray="3 3" opacity="0"/>
        <circle id="tsHoverDot" r="4.5" fill="var(--brand)" stroke="var(--bg)" stroke-width="2" opacity="0"/>
        <rect id="tsOverlay" x="${pad.left}" y="${pad.top}" width="${innerW}" height="${innerH}"
              fill="transparent" style="cursor:crosshair"/>
      </svg>
      <div class="chart-tooltip" id="tsTooltip"></div>`;

    bindChartHover(stage, { list, xAt, reqVals, latVals, pad, innerW, innerH });
  }

  function latencyShort(v) {
    const n = Math.round(Number(v) || 0);
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(".", ",")}s`;
    return `${n}ms`;
  }

  function shortTime(val) {
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) return String(val);
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  function bindChartHover(stage, { list, xAt, reqVals, latVals, pad, innerW, innerH }) {
    const overlay = qs("#tsOverlay", stage);
    const guide = qs("#tsGuide", stage);
    const dot = qs("#tsHoverDot", stage);
    const tip = qs("#tsTooltip", stage);
    if (!overlay || !tip) return;

    let activeIndex = -1;

    const move = (clientX) => {
      const rect = overlay.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / (rect.width || 1)));
      const idx = Math.min(list.length - 1, Math.max(0, Math.round(ratio * (list.length - 1))));
      if (idx === activeIndex) return;
      activeIndex = idx;

      const item = list[idx] || {};
      const x = xAt(idx);
      guide.setAttribute("x1", x.toFixed(1));
      guide.setAttribute("x2", x.toFixed(1));
      guide.setAttribute("opacity", "1");

      if (state.chartSeries.requests) {
        dot.setAttribute("cx", x.toFixed(1));
        dot.setAttribute("cy", (pad.top + innerH - (reqVals[idx] / Math.max(1, Math.max(...reqVals))) * innerH).toFixed(1));
        dot.setAttribute("opacity", "1");
      } else {
        dot.setAttribute("opacity", "0");
      }

      const label = item.label || fmtDate(item.timestamp, { seconds: true });
      const errs = Number(item.errors ?? 0);
      tip.innerHTML = `
        <b>${esc(label)}</b>
        <div class="row"><span><i style="background:var(--brand)"></i>Requisições</span><em>${num(reqVals[idx])}</em></div>
        <div class="row"><span><i style="background:var(--brand-2)"></i>Latência</span><em>${num(Math.round(latVals[idx]))} ms</em></div>
        ${errs > 0 ? `<div class="row"><span><i style="background:var(--err)"></i>Erros</span><em>${num(errs)}</em></div>` : ""}`;

      tip.classList.add("is-visible");
      const stageRect = stage.getBoundingClientRect();
      const dotRect = dot.getBoundingClientRect();
      const relX = dotRect.left - stageRect.left;
      const relY = dotRect.top - stageRect.top;
      const tipW = tip.offsetWidth || 150;
      const left = Math.min(stageRect.width - tipW - 6, Math.max(6, relX - tipW / 2));
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(4, relY - (tip.offsetHeight || 80) - 12)}px`;
    };

    overlay.addEventListener("mousemove", (e) => move(e.clientX));
    overlay.addEventListener("mouseleave", () => {
      activeIndex = -1;
      guide.setAttribute("opacity", "0");
      dot.setAttribute("opacity", "0");
      tip.classList.remove("is-visible");
    });
    overlay.addEventListener("touchstart", (e) => move(e.touches[0].clientX), { passive: true });
    overlay.addEventListener("touchmove", (e) => move(e.touches[0].clientX), { passive: true });
  }

  qsa("#chartLegend .legend-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.series;
      const next = !state.chartSeries[key];
      const other = key === "requests" ? "latency" : "requests";
      if (!next && !state.chartSeries[other]) return; // mantém ao menos uma série
      state.chartSeries[key] = next;
      btn.classList.toggle("is-on", next);
      btn.setAttribute("aria-pressed", String(next));
      renderTimeSeriesChart(state.metrics?.timeSeries || state.metrics?.series || []);
    });
  });

  /* ---------- Donut por modelo ---------- */
  function renderModelsDonut(items, totalRequests) {
    const host = $("modelsBreakdownChart");
    if (!host) return;
    const list = (Array.isArray(items) ? items : []).slice(0, 6);
    if (!list.length) {
      host.innerHTML = `<div class="chart-empty">${icon("i-cpu")}<span>Nenhum uso por modelo no período.</span></div>`;
      return;
    }

    const total = list.reduce((acc, it) => acc + Number(it.requests ?? it.count ?? 0), 0) || 1;
    const palette = [
      "var(--brand)",
      "var(--brand-2)",
      "var(--brand-3)",
      "#f472b6",
      "#fbbf24",
      "#60a5fa",
    ];

    const R = 44;
    const C = 2 * Math.PI * R;
    let offset = 0;

    const arcs = list
      .map((it, i) => {
        const value = Number(it.requests ?? it.count ?? 0);
        const frac = value / total;
        const len = Math.max(0, frac * C - 2);
        const seg = `<circle cx="60" cy="60" r="${R}" fill="none"
            stroke="${palette[i % palette.length]}" stroke-width="12"
            stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}"
            stroke-dashoffset="${(-offset).toFixed(2)}" stroke-linecap="round"/>`;
        offset += frac * C;
        return seg;
      })
      .join("");

    const legend = list
      .map((it, i) => {
        const name = it.model || it.name || it.label || it.id || "desconhecido";
        const value = Number(it.requests ?? it.count ?? 0);
        const pct = Math.round((value / total) * 100);
        return `<div class="donut-item">
            <i style="background:${palette[i % palette.length]}"></i>
            <span title="${esc(name)}">${esc(name)}</span>
            <b>${pct}%</b>
          </div>`;
      })
      .join("");

    host.innerHTML = `
      <div class="donut">
        <div class="donut-figure">
          <svg viewBox="0 0 120 120" width="104" height="104" aria-hidden="true">
            <circle cx="60" cy="60" r="${R}" fill="none" stroke="currentColor" stroke-opacity="0.08" stroke-width="12"/>
            ${arcs}
          </svg>
          <div class="donut-center">
            <div>
              <strong>${compact(totalRequests || total)}</strong>
              <small>req</small>
            </div>
          </div>
        </div>
        <div class="donut-legend">${legend}</div>
      </div>`;
  }

  /* ---------- Barras por conta ---------- */
  function renderAccountBars(items) {
    const host = $("accountsBreakdownChart");
    if (!host) return;
    const list = Array.isArray(items) ? items.slice(0, 6) : [];
    if (!list.length) {
      host.innerHTML = `<div class="chart-empty">${icon("i-users")}<span>Nenhum uso por conta no período.</span></div>`;
      return;
    }
    const maxVal = Math.max(1, ...list.map((x) => Number(x.requests ?? x.count ?? 0)));

    const bars = list
      .map((it) => {
        const name = it.accountLabel || it.label || it.accountId || "conta";
        const value = Number(it.requests ?? it.count ?? 0);
        const rate = it.successRate !== undefined ? Number(it.successRate) : 100;
        const lat = Number(it.avgLatencyMs ?? 0);
        const errs = Number(it.errors ?? 0);
        const pct = Math.max(3, Math.round((value / maxVal) * 100));
        const tone = rate >= 99 ? "" : rate >= 90 ? "is-warn" : "is-err";
        return `<div class="bar">
            <div class="bar-meta">
              <span title="${esc(name)}">${esc(name)}</span>
              <b>${num(value)} req</b>
            </div>
            <div class="bar-track ${tone}"><span style="width:${pct}%"></span></div>
            <div class="bar-foot">
              <span>${rate.toFixed(0)}% ok</span>
              <span>${lat ? `${num(Math.round(lat))} ms` : "—"}</span>
              ${errs ? `<span style="color:var(--err)">${num(errs)} erro(s)</span>` : ""}
            </div>
          </div>`;
      })
      .join("");

    const totals = list.reduce(
      (acc, it) => {
        acc.req += Number(it.requests ?? 0);
        acc.err += Number(it.errors ?? 0);
        acc.latSum += Number(it.avgLatencyMs ?? 0) * Number(it.requests ?? 0);
        return acc;
      },
      { req: 0, err: 0, latSum: 0 }
    );
    const avgLat = totals.req > 0 ? Math.round(totals.latSum / totals.req) : 0;

    host.innerHTML = `
      <div class="bars">${bars}</div>
      <div class="bar-summary">
        <div><span>Total</span><b>${num(totals.req)}</b></div>
        <div><span>Latência média</span><b>${avgLat ? `${num(avgLat)} ms` : "—"}</b></div>
        <div><span>Erros</span><b style="${totals.err ? "color:var(--err)" : ""}">${num(totals.err)}</b></div>
      </div>`;
  }

  /* ---------- Contexto ---------- */
  function renderContextPanel(kpi) {
    $("ctxIn").textContent = compact(kpi.promptTokens ?? 0);
    $("ctxOut").textContent = compact(kpi.completionTokens ?? 0);
    const util = Math.min(100, Math.max(0, Number(kpi.avgContextUtilizationPct ?? 0)));
    $("ctxUtilValue").textContent = `${util}%`;
    $("ctxUtilBar").style.width = `${util}%`;
    $("ctxP95").textContent = `${num(Math.round(Number(kpi.p95LatencyMs ?? 0)))} ms`;
    $("ctxTrimmed").textContent = num(kpi.compactionCount ?? 0);
  }

  /* ---------- Tabela recente ---------- */
  function sortRows(rows) {
    const { key, dir } = state.sort;
    const mult = dir === "asc" ? 1 : -1;
    const valueOf = (r) => {
      switch (key) {
        case "model":
          return String(r.model || "").toLowerCase();
        case "account":
          return String(r.accountLabel || r.accountId || "").toLowerCase();
        case "latency":
          return Number(r.latencyMs || 0);
        case "context":
          return Number(r.estimatedInputTokens || 0);
        case "status":
          return Number(r.status || 0);
        default:
          return Date.parse(r.timestamp) || 0;
      }
    };
    return [...rows].sort((a, b) => {
      const va = valueOf(a);
      const vb = valueOf(b);
      if (typeof va === "string") return va.localeCompare(vb) * mult;
      return (va - vb) * mult;
    });
  }

  function renderRecentRequests(rows) {
    const tbody = $("recentRequestsBody");
    const list = Array.isArray(rows) ? rows : [];
    $("recentCountBadge").textContent = `${list.length} registro${list.length === 1 ? "" : "s"}`;

    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="td-empty">Nenhuma requisição registrada no período.</td></tr>`;
      return;
    }

    const sorted = sortRows(list).slice(0, 60);

    tbody.innerHTML = sorted
      .map((r) => {
        const ok = r.ok !== undefined ? Boolean(r.ok) : Number(r.status || 200) < 400;
        const statusCode = r.status || (ok ? 200 : 500);
        const statusBadge = ok
          ? `<span class="badge badge-ok">${statusCode}</span>`
          : `<span class="badge badge-err">${statusCode}</span>`;
        const mode = r.stream
          ? `<span class="badge badge-cyan">stream</span>`
          : `<span class="badge badge-muted">json</span>`;

        const est = Number(r.estimatedInputTokens) || 0;
        const limit = Number(r.contextLimit) || 0;
        const utilPct = Number(r.contextUtilizationPct) || (limit > 0 ? Math.round((est / limit) * 100) : 0);
        const ctxLabel = limit > 0 ? `${compact(est)} / ${compact(limit)}` : est ? `${compact(est)}` : "—";
        const trim = r.clientCompacted
          ? `<span class="badge badge-cyan" title="O cliente compactou o histórico (${esc(r.compactionKind || "resumo")})">ckpt</span>`
          : "";

        const d = r.timestamp ? new Date(r.timestamp) : null;
        const validDate = d && !Number.isNaN(d.getTime());
        const dateMain = validDate
          ? d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
          : "—";
        const dateSub = validDate
          ? d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })
          : "";

        return `<tr>
          <td class="cell-time">${dateMain}<small>${dateSub}</small></td>
          <td class="cell-model"><code title="${esc(r.model)}">${esc(r.model || "—")}</code></td>
          <td>${esc(r.accountLabel || r.accountId || "—")}</td>
          <td class="cell-lat ${latencyClass(r.latencyMs)}">${num(Math.round(r.latencyMs || 0))}<span style="opacity:.5;font-size:10px"> ms</span></td>
          <td class="col-ctx">
            <div class="ctx-cell">
              ${limit > 0 ? `<span class="ctx-mini ${utilPct >= 85 ? "is-high" : ""}"><span style="width:${Math.min(100, utilPct)}%"></span></span>` : ""}
              <span style="font-size:11px;color:var(--fg-3)">${ctxLabel}</span>
              ${trim}
            </div>
          </td>
          <td>${statusBadge}</td>
          <td class="col-mode">${mode}</td>
        </tr>`;
      })
      .join("");
  }

  qsa("#recentTable th button.sort").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.sort;
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      } else {
        state.sort.key = key;
        state.sort.dir = key === "timestamp" ? "desc" : "desc";
      }
      qsa("#recentTable th").forEach((th) => th.setAttribute("aria-sort", "none"));
      const th = btn.closest("th");
      th?.setAttribute("aria-sort", state.sort.dir === "asc" ? "ascending" : "descending");
      renderRecentRequests(state.metrics?.recentRequests || state.metrics?.recent || []);
    });
  });

  /* ---------- Range / export / reset ---------- */
  qsa("#metricsRangePills button").forEach((btn) => {
    btn.addEventListener("click", () => {
      qsa("#metricsRangePills button").forEach((b) => b.setAttribute("aria-pressed", "false"));
      btn.setAttribute("aria-pressed", "true");
      state.range = btn.dataset.range;
      $("chartRangeLabel").textContent = RANGE_LABELS[state.range] || state.range;
      try {
        localStorage.setItem("dp-range", state.range);
      } catch {
        /* ignore */
      }
      loadMetrics();
    });
  });

  $("btnExportMetrics").addEventListener("click", async () => {
    try {
      const data = await api(`/api/metrics?range=${encodeURIComponent(state.range)}`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `deepai-proxy-metrics-${state.range}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      toast("Métricas exportadas.", "ok");
    } catch (err) {
      toast(`Falha ao exportar: ${err.message}`, "err");
    }
  });

  $("btnResetMetrics").addEventListener("click", async () => {
    const ok = await confirmAction({
      title: "Resetar métricas?",
      desc: "Todo o histórico de requisições e contadores serão apagados. Contas e configurações não são afetadas. Esta ação não pode ser desfeita.",
      confirm: "Resetar tudo",
      danger: true,
    });
    if (!ok) return;
    try {
      await api("/api/metrics/reset", { method: "POST", body: {} });
      toast("Métricas resetadas.", "ok");
      await loadMetrics();
    } catch (err) {
      toast(`Erro ao resetar: ${err.message}`, "err");
    }
  });

  /* ------------------------------------------------------------------ */
  /* Contas                                                             */
  /* ------------------------------------------------------------------ */

  async function loadAccounts() {
    try {
      const data = await api("/api/accounts");
      state.accounts = Array.isArray(data?.accounts) ? data.accounts : [];
      state.activeAccountId = data?.activeAccountId || null;
      $("navAccountsCount").textContent = String(state.accounts.length);
      $("accountsTotalBadge").textContent = `${state.accounts.length} conta${state.accounts.length === 1 ? "" : "s"}`;
      const enabled = state.accounts.filter((a) => a.enabled !== false).length;
      $("accountsActiveBadge").textContent = `${enabled} ativa${enabled === 1 ? "" : "s"}`;
      renderAccounts();
      if (state.tab === "dashboard") renderDashboard();
    } catch (err) {
      state.accounts = [];
      $("accountsList").innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  }

  function renderAccounts() {
    const host = $("accountsList");
    if (!state.accounts.length) {
      host.innerHTML = `<div class="empty">
        Nenhuma conta conectada. Use o login DeepAI ou importe uma API key acima para começar.
      </div>`;
      return;
    }

    host.innerHTML = state.accounts
      .map((acc) => {
        const isActive = acc.id === state.activeAccountId;
        const enabled = acc.enabled !== false;
        const isPro = Boolean(acc.isPro);
        const cooling = Boolean(acc.isCoolingDown);

        const title = acc.label || acc.username || acc.email || acc.id;
        const keyPreview = acc.keyPreview || acc.maskedKey || acc.apiKeyPreview || "";
        const authType = acc.authType === "oauth" ? "OAuth" : acc.authType === "cookie" ? "Cookie" : "API key";

        const tier = isPro
          ? `<span class="badge badge-pro">PRO</span>`
          : `<span class="badge badge-cyan">FREE</span>`;
        const stateBadge = !enabled
          ? `<span class="badge badge-muted">desabilitada</span>`
          : cooling
            ? `<span class="badge badge-warn">cooldown</span>`
            : isActive
              ? `<span class="badge badge-ok">ativa</span>`
              : `<span class="badge badge-muted">pronta</span>`;

        return `<article class="account-card ${isActive ? "is-active" : ""} ${!enabled ? "is-disabled" : ""}">
          <div class="account-head">
            <span class="account-avatar">${esc(initials(title))}</span>
            <div class="account-id">
              <div class="account-name">
                ${isActive ? icon("i-star") : ""}
                <span style="overflow:hidden;text-overflow:ellipsis">${esc(title)}</span>
              </div>
              <div class="account-user">${acc.username ? esc(acc.username) : esc(authType)}${keyPreview ? ` · ${esc(keyPreview)}` : ""}</div>
            </div>
            <div class="account-badges">${tier}${stateBadge}</div>
          </div>

          <div class="account-stats">
            <div><span>Requisições</span><b>${num(acc.requestCount ?? 0)}</b></div>
            <div><span>Erros</span><b>${num(acc.errorCount ?? 0)}</b></div>
            <div><span>Último uso</span><b>${esc(timeAgo(acc.lastUsedAt))}</b></div>
          </div>

          ${acc.lastError ? `<div class="account-err">${icon("i-alert")}<span>${esc(acc.lastError)}</span></div>` : ""}

          <div class="account-actions">
            ${!isActive ? `<button class="btn btn-ghost btn-xs" data-action="select" data-id="${esc(acc.id)}" type="button">${icon("i-star")} Ativar</button>` : ""}
            <button class="btn btn-secondary btn-xs" data-action="test" data-id="${esc(acc.id)}" type="button">${icon("i-wifi")} Testar</button>
            <button class="btn btn-ghost btn-xs" data-action="rename" data-id="${esc(acc.id)}" type="button" aria-label="Renomear">${icon("i-edit")}</button>
            <button class="btn btn-ghost btn-xs" data-action="toggle" data-id="${esc(acc.id)}" data-enabled="${enabled}" type="button">${enabled ? "Desativar" : "Ativar"}</button>
            <button class="btn btn-danger btn-xs" data-action="delete" data-id="${esc(acc.id)}" type="button" aria-label="Remover">${icon("i-trash")}</button>
          </div>
        </article>`;
      })
      .join("");
  }

  $("accountsList").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const { action, id } = btn.dataset;
    const acc = state.accounts.find((a) => a.id === id);

    if (action === "delete") {
      const ok = await confirmAction({
        title: "Remover conta?",
        desc: `A conta "${acc?.label || id}" será removida deste proxy. Você pode reconectá-la depois.`,
        confirm: "Remover",
        danger: true,
      });
      if (!ok) return;
    }

    if (action === "rename") {
      const name = await confirmAction({
        title: "Renomear conta",
        desc: "Escolha um nome curto para identificar esta conta no painel.",
        confirm: "Salvar",
        input: { value: acc?.label || "", placeholder: "Ex: Conta principal", maxlength: 100 },
      });
      if (!name) return;
      btn.disabled = true;
      try {
        await api(`/api/accounts/${encodeURIComponent(id)}`, { method: "PATCH", body: { label: name } });
        toast("Conta renomeada.", "ok");
        await loadAccounts();
      } catch (err) {
        toast(`Erro: ${err.message}`, "err");
      } finally {
        btn.disabled = false;
      }
      return;
    }

    btn.disabled = true;
    const busy = btn.classList.contains("btn-secondary");
    if (busy) btn.classList.add("is-busy");

    try {
      if (action === "select") {
        await api("/api/accounts/select", { method: "POST", body: { id } });
        toast("Conta ativa definida.", "ok");
        await loadAccounts();
      } else if (action === "test") {
        const res = await api(`/api/accounts/${encodeURIComponent(id)}/test`, { method: "POST", body: {} });
        const result = res?.result || res;
        const valid = result?.ok !== false && result?.valid !== false;
        const isPro = Boolean(result?.isPro ?? res?.account?.isPro);
        toast(
          valid
            ? `Conexão OK · plano ${isPro ? "PRO" : "FREE"}`
            : `Falha na verificação: ${result?.error || "credencial inválida"}`,
          valid ? "ok" : "err",
          4600
        );
        await loadAccounts();
      } else if (action === "toggle") {
        const currentlyEnabled = btn.dataset.enabled === "true";
        await api(`/api/accounts/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: { enabled: !currentlyEnabled },
        });
        toast(currentlyEnabled ? "Conta desabilitada." : "Conta habilitada.", "ok");
        await loadAccounts();
      } else if (action === "delete") {
        await api(`/api/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
        toast("Conta removida.", "ok");
        await loadAccounts();
      }
    } catch (err) {
      toast(`Erro: ${err.message}`, "err");
    } finally {
      btn.disabled = false;
      btn.classList.remove("is-busy");
    }
  });

  /* ---------- Login OAuth ---------- */
  function renderAuthState(auth) {
    const a = auth || {};
    const pending = Boolean(a.pending);
    const status = pending
      ? "pending"
      : a.lastError
        ? "error"
        : a.savedAccount
          ? "connected"
          : "idle";

    const pill = $("authStatusPill");
    pill.dataset.status = status;
    pill.textContent = pending ? "aguardando" : status === "error" ? "erro" : status === "connected" ? "conectado" : "idle";

    const url = a.loginUrl || a.url || "";
    const panel = $("authLinkPanel");
    if (pending && url) {
      panel.hidden = false;
      $("loginUrlInput").value = url;
      $("btnOpenLoginUrl").href = url;
      $("authLoginId").textContent = a.loginId || "—";
      $("authExpiresAt").textContent = a.expiresAt ? fmtDate(a.expiresAt, { seconds: true }) : "—";
      startAuthPolling();
      startAuthCountdown(a.expiresAt);
    } else {
      panel.hidden = true;
      stopAuthCountdown();
      if (!pending) stopAuthPolling();
    }

    $("btnCancelLogin").disabled = !pending;
    $("btnStartLogin").disabled = pending;

    const notice = $("authNotice");
    const text = $("authNoticeText");
    notice.classList.remove("is-ok", "is-err");

    if (pending) {
      text.textContent = "Aguardando login no navegador. A conta aparece automaticamente aqui ao concluir.";
    } else if (a.lastError) {
      notice.classList.add("is-err");
      text.textContent = `Erro no login: ${a.lastError}`;
    } else if (a.savedAccount) {
      notice.classList.add("is-ok");
      text.textContent = `Conta conectada: ${a.savedAccount.label || a.savedAccount.id}`;
    } else {
      text.textContent = "Pronto para conectar uma nova conta.";
    }
  }

  function startAuthCountdown(expiresAt) {
    stopAuthCountdown();
    const el = $("authCountdown");
    if (!expiresAt) {
      el.textContent = "";
      return;
    }
    const tick = () => {
      const left = Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
      el.textContent = left > 0 ? `(${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")})` : "(expirado)";
    };
    tick();
    state.authTickTimer = setInterval(tick, 1000);
  }

  function stopAuthCountdown() {
    if (state.authTickTimer) {
      clearInterval(state.authTickTimer);
      state.authTickTimer = null;
    }
  }

  function startAuthPolling() {
    if (state.authPollTimer) return;
    state.authPollTimer = setInterval(async () => {
      const wasPending = $("authStatusPill").dataset.status === "pending";
      const auth = await refreshAuthStatus();
      if (wasPending && auth && !auth.pending) {
        await loadAccounts();
        if (auth.savedAccount) toast("Conta conectada com sucesso.", "ok");
      }
    }, 1800);
  }

  function stopAuthPolling() {
    if (state.authPollTimer) {
      clearInterval(state.authPollTimer);
      state.authPollTimer = null;
    }
  }

  async function refreshAuthStatus() {
    try {
      const data = await api("/api/auth/status");
      const auth = data?.auth || data?.login || data || {};
      renderAuthState(auth);
      return auth;
    } catch {
      return null;
    }
  }

  $("btnStartLogin").addEventListener("click", async () => {
    const btn = $("btnStartLogin");
    const label = $("newAccountLabel").value.trim();
    btn.disabled = true;
    btn.classList.add("is-busy");
    try {
      const data = await api("/api/auth/login", { method: "POST", body: label ? { label } : {} });
      renderAuthState(data?.auth || data?.login || data);
      toast("Link gerado. Abra no navegador para autorizar.", "ok", 4200);
    } catch (err) {
      toast(`Falha ao iniciar login: ${err.message}`, "err");
      btn.disabled = false;
    } finally {
      btn.classList.remove("is-busy");
    }
  });

  $("btnCancelLogin").addEventListener("click", async () => {
    try {
      const data = await api("/api/auth/cancel", { method: "POST", body: {} });
      renderAuthState(data?.auth || data?.login || data);
      toast("Sessão de login cancelada.", "ok");
    } catch (err) {
      toast(`Falha ao cancelar: ${err.message}`, "err");
    }
  });

  $("btnCopyLoginUrl").addEventListener("click", () => {
    copyText($("loginUrlInput").value, "Link de login copiado.");
  });

  $("btnSubmitManualCallback").addEventListener("click", async (e) => {
    const value = $("manualCallbackInput").value.trim();
    if (!value) return toast("Cole a URL de callback ou o código.", "err");
    const isUrl = /^https?:\/\//i.test(value);
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.classList.add("is-busy");
    try {
      const data = await api("/api/auth/submit", {
        method: "POST",
        body: isUrl ? { callbackUrl: value } : { code: value },
      });
      $("manualCallbackInput").value = "";
      renderAuthState(data?.auth || data);
      await loadAccounts();
      toast("Callback processado.", "ok");
    } catch (err) {
      toast(`Erro no callback: ${err.message}`, "err");
    } finally {
      btn.disabled = false;
      btn.classList.remove("is-busy");
    }
  });

  /* ---------- Importar chave ---------- */
  $("btnToggleImportKey").addEventListener("click", () => {
    const input = $("importKeyValue");
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    $("btnToggleImportKey").innerHTML = icon(showing ? "i-eye" : "i-eye-off");
  });

  $("btnImportKey").addEventListener("click", async () => {
    const apiKey = $("importKeyValue").value.trim();
    const label = $("importKeyLabel").value.trim();
    if (!apiKey) {
      $("importKeyValue").focus();
      return toast("Informe a API key ou token.", "err");
    }
    const btn = $("btnImportKey");
    btn.disabled = true;
    btn.classList.add("is-busy");
    try {
      await api("/api/accounts/import-key", {
        method: "POST",
        body: { apiKey, label: label || undefined },
      });
      $("importKeyValue").value = "";
      $("importKeyLabel").value = "";
      toast("Conta importada.", "ok");
      await loadAccounts();
    } catch (err) {
      toast(`Erro ao importar: ${err.message}`, "err");
    } finally {
      btn.disabled = false;
      btn.classList.remove("is-busy");
    }
  });

  /* ---------- Estratégia ---------- */
  $("rotationStrategyGroup").addEventListener("click", async (e) => {
    const btn = e.target.closest(".strategy");
    if (!btn) return;
    const strategy = btn.dataset.strategy;
    if (strategy === state.config.rotationStrategy) return;
    const previous = state.config.rotationStrategy;
    state.config.rotationStrategy = strategy;
    renderStrategyButtons();
    try {
      const data = await api("/api/config", { method: "PUT", body: { rotationStrategy: strategy } });
      if (data?.config) state.config = { ...state.config, ...data.config };
      renderStrategyButtons();
      toast("Estratégia de rotação atualizada.", "ok");
    } catch (err) {
      state.config.rotationStrategy = previous;
      renderStrategyButtons();
      toast(`Erro: ${err.message}`, "err");
    }
  });

  function renderStrategyButtons() {
    const current = state.config.rotationStrategy || "round-robin";
    qsa(".strategy").forEach((btn) => {
      const on = btn.dataset.strategy === current;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-checked", String(on));
    });
    const labels = { active: "Conta ativa", "round-robin": "Round-robin", failover: "Failover" };
    $("sidebarStrategy").textContent = labels[current] || current;
  }

  /* ------------------------------------------------------------------ */
  /* Modelos                                                            */
  /* ------------------------------------------------------------------ */

  async function loadModels() {
    try {
      const data = await api("/api/models");
      const list = Array.isArray(data?.models) ? data.models : Array.isArray(data?.data) ? data.data : [];
      state.models = list;
      const free = data?.counts?.free ?? list.filter((m) => m.tier !== "paid" && !m.isPro).length;
      const paid = data?.counts?.paid ?? list.filter((m) => m.tier === "paid" || m.isPro).length;
      state.modelsMeta = { total: list.length, free, paid };

      $("navModelsCount").textContent = String(list.length);
      $("countModelsAll").textContent = String(list.length);
      $("countModelsFree").textContent = String(free);
      $("countModelsPaid").textContent = String(paid);

      renderModels();
    } catch (err) {
      $("modelsGrid").innerHTML = `<div class="empty">${esc(err.message)}</div>`;
      $("modelsResultCount").textContent = "Falha ao carregar o catálogo.";
    }
  }

  const MODEL_LOGOS = [
    [/anthropic|claude/i, "anthropic"],
    [/google|gemini/i, "gemini"],
    [/deepseek/i, "deepseek"],
    [/alibaba|qwen/i, "qwen"],
    [/xiaomi|mimo/i, "xiaomi"],
    [/minimax/i, "minimax"],
    [/openai|gpt/i, "openai"],
    [/moonshot|kimi/i, "kimi"],
    [/zhipu|chatglm|\bglm\b/i, "chatglm"],
    [/upstage|solar/i, "upstage"],
    [/deepai|muse|glyph|cyber/i, "deepai"],
  ];

  function modelLogo(m) {
    const hay = `${m.provider || ""} ${m.id || ""} ${m.name || ""}`;
    const hit = MODEL_LOGOS.find(([re]) => re.test(hay));
    return hit ? `/logos/${hit[1]}.svg` : null;
  }

  function renderModels() {
    const grid = $("modelsGrid");
    const q = state.modelsSearch.toLowerCase();

    const filtered = state.models.filter((m) => {
      const isPro = m.tier === "paid" || Boolean(m.isPro);
      if (state.modelsTier === "free" && isPro) return false;
      if (state.modelsTier === "paid" && !isPro) return false;
      if (!q) return true;
      const hay = `${m.id || ""} ${m.name || ""} ${m.provider || ""} ${m.description || ""}`.toLowerCase();
      return hay.includes(q);
    });

    $("modelsResultCount").textContent = `${filtered.length} de ${state.models.length} modelos`;

    if (!filtered.length) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1">Nenhum modelo corresponde a este filtro.</div>`;
      return;
    }

    grid.innerHTML = filtered
      .map((m) => {
        const isPro = m.tier === "paid" || Boolean(m.isPro);
        const tags = [];

        if (m.contextWindow) tags.push(`<span class="badge badge-muted">${compact(m.contextWindow)} ctx</span>`);
        if (m.maxTokens) tags.push(`<span class="badge badge-muted">${compact(m.maxTokens)} out</span>`);
        const caps = Array.isArray(m.capabilities)
          ? m.capabilities
          : m.capabilities?.input || [];
        (Array.isArray(caps) ? caps : []).forEach((c) => {
          if (c === "image") tags.push(`<span class="badge badge-brand">visão</span>`);
          else if (c === "text") return;
          else tags.push(`<span class="badge badge-brand">${esc(c)}</span>`);
        });
        if (m.theosPerRequest && m.theosPerRequest !== "0") {
          tags.push(`<span class="badge badge-warn">${esc(m.theosPerRequest)} theos</span>`);
        }

        const label = isPro ? "PRO" : "FREE";

        return `<article class="model-card ${isPro ? "is-pro" : ""}">
          <div class="model-top">
            <div class="model-ident">
              <span class="model-mark">${modelLogo(m) ? `<span class="model-logo" style="--logo:url(${modelLogo(m)})" aria-hidden="true"></span>` : esc((m.provider || "DA").slice(0, 2))}</span>
              <div style="min-width:0">
                <h3 title="${esc(m.name || m.id)}">${esc(m.name || m.id)}</h3>
                <div class="model-provider">${esc(m.provider || "DeepAI")}</div>
              </div>
            </div>
            <span class="badge ${isPro ? "badge-pro" : "badge-cyan"}">${label}</span>
          </div>

          <div class="model-id">
            <code title="${esc(m.id)}">${esc(m.id)}</code>
            <button class="icon-btn" data-copy-model="${esc(m.id)}" type="button" aria-label="Copiar ID do modelo">${icon("i-copy")}</button>
          </div>

          <p class="model-desc">${esc(m.description || "Compatível com chat completions.")}</p>
          <div class="model-tags">${tags.join("")}</div>
        </article>`;
      })
      .join("");
  }

  $("modelsSearchInput").addEventListener("input", (e) => {
    state.modelsSearch = e.target.value.trim();
    renderModels();
  });

  $("modelsTierFilters").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tier]");
    if (!btn) return;
    qsa("#modelsTierFilters button").forEach((b) => b.setAttribute("aria-pressed", "false"));
    btn.setAttribute("aria-pressed", "true");
    state.modelsTier = btn.dataset.tier;
    renderModels();
  });

  $("modelsGrid").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-copy-model]");
    if (!btn) return;
    copyText(btn.dataset.copyModel, `ID "${btn.dataset.copyModel}" copiado.`);
  });

  /* ------------------------------------------------------------------ */
  /* Configurações                                                      */
  /* ------------------------------------------------------------------ */

  async function loadConfig() {
    try {
      const data = await api("/api/config");
      const cfg = data?.config || data || {};
      state.config = { ...state.config, ...cfg };
      renderConfig();
    } catch (err) {
      toast(`Falha ao carregar configurações: ${err.message}`, "err");
    }
  }

  function renderConfig() {
    $("cfgRequireApiKey").checked = state.config.requireApiKey !== false;
    $("cfgProxyApiKey").value = state.config.proxyApiKey || "";
    renderStrategyButtons();
    renderCodeExample();
    renderContextConfig();
    $("sidebarBaseUrl").textContent = `${window.location.host}/v1`;
  }

  function renderContextConfig() {
    const cm = state.config.contextManagement || {};

    $("ctxModeBadge").textContent = "Pass-through";
    $("cfgCtxDetect").value = cm.detectCompaction === false ? "off" : "on";
  }

  /* ---------- Exemplos de código ---------- */
  const CODE_SAMPLES = () => {
    const baseUrl = `${window.location.origin}/v1`;
    const key = state.config.proxyApiKey || "SUA_CHAVE_AQUI";
    const model = state.models.find((m) => m.tier !== "paid")?.id || "glm-5.3-flash";
    return {
      curl: `curl ${baseUrl}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${key}" \\
  -d '{
    "model": "${model}",
    "messages": [{ "role": "user", "content": "Olá!" }],
    "stream": false
  }'`,
      node: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${baseUrl}",
  apiKey: "${key}",
});

const stream = await client.chat.completions.create({
  model: "${model}",
  messages: [{ role: "user", content: "Olá!" }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}`,
      python: `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}",
    api_key="${key}",
)

stream = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Olá!"}],
    stream=True,
)

for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")`,
    };
  };

  function renderCodeExample() {
    const samples = CODE_SAMPLES();
    $("docsBaseUrl").value = `${window.location.origin}/v1`;
    $("docsCodeExample").textContent = samples[state.codeTab] || samples.curl;
  }

  $("codeTabs").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-code]");
    if (!btn) return;
    qsa("#codeTabs button").forEach((b) => b.setAttribute("aria-selected", "false"));
    btn.setAttribute("aria-selected", "true");
    state.codeTab = btn.dataset.code;
    renderCodeExample();
  });

  $("btnCopyCode").addEventListener("click", () => {
    copyText($("docsCodeExample").textContent, "Exemplo copiado.");
  });

  /* ---------- Chave / segurança ---------- */
  $("btnToggleKeyVisibility").addEventListener("click", () => {
    const input = $("cfgProxyApiKey");
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    $("btnToggleKeyVisibility").innerHTML = icon(showing ? "i-eye" : "i-eye-off");
  });

  $("btnCopyProxyKey").addEventListener("click", () => {
    copyText($("cfgProxyApiKey").value, "Chave do proxy copiada.");
  });

  $("btnCopyBaseUrl").addEventListener("click", () => {
    copyText($("docsBaseUrl").value, "Base URL copiada.");
  });

  $("cfgRequireApiKey").addEventListener("change", async (e) => {
    const next = e.target.checked;
    try {
      const data = await api("/api/config", { method: "PUT", body: { requireApiKey: next } });
      if (data?.config) state.config = { ...state.config, ...data.config };
      toast(next ? "Exigência de chave ativada." : "Exigência de chave desativada.", "ok");
    } catch (err) {
      e.target.checked = !next;
      toast(`Erro: ${err.message}`, "err");
    }
  });

  $("btnSaveConfig").addEventListener("click", async () => {
    const proxyApiKey = $("cfgProxyApiKey").value.trim();
    if (proxyApiKey.length < 8) return toast("A chave precisa de ao menos 8 caracteres.", "err");
    const btn = $("btnSaveConfig");
    btn.disabled = true;
    btn.classList.add("is-busy");
    try {
      const data = await api("/api/config", {
        method: "PUT",
        body: { proxyApiKey, requireApiKey: $("cfgRequireApiKey").checked },
      });
      if (data?.config) state.config = { ...state.config, ...data.config };
      renderConfig();
      toast("Chave salva.", "ok");
    } catch (err) {
      toast(`Erro ao salvar: ${err.message}`, "err");
    } finally {
      btn.disabled = false;
      btn.classList.remove("is-busy");
    }
  });

  $("btnRotateProxyKey").addEventListener("click", async () => {
    const ok = await confirmAction({
      title: "Gerar nova chave?",
      desc: "A chave atual deixa de funcionar imediatamente. Atualize as ferramentas já conectadas.",
      confirm: "Gerar nova chave",
    });
    if (!ok) return;
    try {
      const data = await api("/api/config/rotate-key", { method: "POST", body: {} });
      if (data?.config) state.config = { ...state.config, ...data.config };
      else if (data?.proxyApiKey) state.config.proxyApiKey = data.proxyApiKey;
      renderConfig();
      toast("Nova chave gerada.", "ok");
    } catch (err) {
      toast(`Erro: ${err.message}`, "err");
    }
  });

  /* ---------- Contexto ---------- */
  $("btnSaveContextSettings").addEventListener("click", async () => {
    const contextManagement = {
      detectCompaction: $("cfgCtxDetect").value !== "off",
    };
    const btn = $("btnSaveContextSettings");
    btn.disabled = true;
    btn.classList.add("is-busy");
    try {
      const data = await api("/api/config", { method: "PUT", body: { contextManagement } });
      if (data?.config) state.config = { ...state.config, ...data.config };
      renderContextConfig();
      toast("Configurações de contexto salvas.", "ok");
    } catch (err) {
      toast(`Erro: ${err.message}`, "err");
    } finally {
      btn.disabled = false;
      btn.classList.remove("is-busy");
    }
  });

  /* ------------------------------------------------------------------ */
  /* Command palette                                                    */
  /* ------------------------------------------------------------------ */

  function buildCommands() {
    const cmds = [
      { label: "Ir para Dashboard", hint: "visão geral e métricas", icon: "i-grid", keys: "dashboard métricas tráfego", run: () => switchTab("dashboard") },
      { label: "Ir para Contas", hint: "gerenciar contas", icon: "i-users", keys: "contas accounts login", run: () => switchTab("accounts") },
      { label: "Ir para Modelos", hint: "catálogo de modelos", icon: "i-cpu", keys: "modelos catálogo", run: () => switchTab("models") },
      { label: "Ir para Configurações", hint: "chave, contexto", icon: "i-sliders", keys: "configurações settings chave contexto", run: () => switchTab("settings") },
      { label: "Conectar nova conta", hint: "abre o fluxo de login", icon: "i-bolt", keys: "conectar login oauth", run: () => { switchTab("accounts"); setTimeout(() => $("btnStartLogin").focus(), 120); } },
      { label: "Atualizar todos os dados", hint: "recarrega agora", icon: "i-refresh", keys: "atualizar refresh recarregar", run: () => refreshAll().then(() => toast("Dados atualizados.", "ok")) },
      { label: "Copiar Base URL", hint: "/v1", icon: "i-link", keys: "copiar base url endpoint", run: () => copyText(`${window.location.origin}/v1`, "Base URL copiada.") },
      { label: "Copiar chave do proxy", hint: "Authorization: Bearer", icon: "i-key", keys: "copiar chave api key", run: () => copyText(state.config.proxyApiKey, "Chave copiada.") },
      { label: "Exportar métricas", hint: "JSON", icon: "i-download", keys: "exportar baixar json métricas", run: () => $("btnExportMetrics").click() },
      { label: "Resetar métricas", hint: "apaga histórico", icon: "i-trash", keys: "resetar limpar métricas", run: () => $("btnResetMetrics").click() },
      { label: "Alternar tema", hint: "claro / escuro", icon: "i-moon", keys: "tema claro escuro theme", run: () => $("btnThemeToggle").click() },
      { label: "Verificar saúde do proxy", hint: "/healthz", icon: "i-wifi", keys: "health status saúde proxy", run: async () => { const ok = await checkHealth(); toast(ok ? "Proxy online." : "Proxy offline.", ok ? "ok" : "err"); } },
    ];
    return cmds;
  }

  function openPalette() {
    state.paletteOpen = true;
    const pal = $("palette");
    pal.hidden = false;
    $("paletteInput").value = "";
    state.paletteIndex = 0;
    renderPalette("");
    setTimeout(() => $("paletteInput").focus(), 30);
  }

  function closePalette() {
    state.paletteOpen = false;
    $("palette").hidden = true;
  }

  function renderPalette(query) {
    const q = query.trim().toLowerCase();
    const all = buildCommands();
    const items = q
      ? all.filter((c) => `${c.label} ${c.hint} ${c.keys}`.toLowerCase().includes(q))
      : all;

    state.paletteItems = items;
    state.paletteIndex = Math.min(state.paletteIndex, Math.max(0, items.length - 1));

    const list = $("paletteList");
    const empty = $("paletteEmpty");
    list.innerHTML = items
      .map(
        (c, i) => `<button class="palette-item ${i === state.paletteIndex ? "is-active" : ""}" role="option" aria-selected="${i === state.paletteIndex}" data-index="${i}" type="button">
            ${icon(c.icon)}
            <span>${esc(c.label)}<small>${esc(c.hint)}</small></span>
            <kbd>↵</kbd>
          </button>`
      )
      .join("");
    empty.hidden = items.length > 0;
  }

  function runPalette(index) {
    const cmd = state.paletteItems[index];
    if (!cmd) return;
    closePalette();
    try {
      cmd.run();
    } catch {
      /* ignore */
    }
  }

  $("btnCommand").addEventListener("click", openPalette);
  $("palette").addEventListener("click", (e) => {
    if (e.target === $("palette")) closePalette();
  });
  $("paletteInput").addEventListener("input", (e) => renderPalette(e.target.value));
  $("paletteInput").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      state.paletteIndex = Math.min(state.paletteItems.length - 1, state.paletteIndex + 1);
      renderPalette($("paletteInput").value);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      state.paletteIndex = Math.max(0, state.paletteIndex - 1);
      renderPalette($("paletteInput").value);
    } else if (e.key === "Enter") {
      e.preventDefault();
      runPalette(state.paletteIndex);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    }
  });
  $("paletteList").addEventListener("click", (e) => {
    const btn = e.target.closest(".palette-item");
    if (!btn) return;
    runPalette(Number(btn.dataset.index));
  });
  $("paletteList").addEventListener("mousemove", (e) => {
    const btn = e.target.closest(".palette-item");
    if (!btn) return;
    const i = Number(btn.dataset.index);
    if (i !== state.paletteIndex) {
      state.paletteIndex = i;
      qsa(".palette-item").forEach((el, idx) => {
        el.classList.toggle("is-active", idx === i);
        el.setAttribute("aria-selected", String(idx === i));
      });
    }
  });

  /* Atalhos globais */
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const tag = (document.activeElement?.tagName || "").toLowerCase();
    const typing = tag === "input" || tag === "textarea" || tag === "select";

    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (state.paletteOpen) closePalette();
      else openPalette();
      return;
    }

    if (e.key === "Escape") {
      if (state.paletteOpen) closePalette();
      else if (!$("modal").hidden) {
        /* modal trata o próprio Esc */
      } else closeSidebar();
      return;
    }

    if (typing) return;

    const num = Number(e.key);
    if (!e.altKey && num >= 1 && num <= 4) {
      const tab = ["dashboard", "accounts", "models", "settings"][num - 1];
      switchTab(tab);
    } else if (e.key === "/") {
      e.preventDefault();
      if (state.tab === "models") $("modelsSearchInput").focus();
      else openPalette();
    } else if (e.key.toLowerCase() === "r" && !mod) {
      refreshAll().then(() => toast("Dados atualizados.", "ok"));
    }
  });

  /* ------------------------------------------------------------------ */
  /* Refresh / ciclo de vida                                            */
  /* ------------------------------------------------------------------ */

  async function refreshAll() {
    const btn = $("btnGlobalRefresh");
    btn.disabled = true;
    btn.classList.add("is-busy");
    try {
      await Promise.allSettled([checkHealth(), loadAccounts(), loadConfig(), loadModels()]);
      if (state.tab === "dashboard" || state.tab === "accounts") await loadMetrics();
    } finally {
      btn.disabled = false;
      btn.classList.remove("is-busy");
    }
  }

  $("btnGlobalRefresh").addEventListener("click", async () => {
    await refreshAll();
    toast("Dados atualizados.", "ok");
  });

  $("autoRefreshToggle").addEventListener("change", (e) => {
    state.autoRefresh = e.target.checked;
    setupAutoRefresh();
    toast(`Atualização automática ${state.autoRefresh ? "ativada" : "desativada"}.`, "info", 2200);
  });

  function setupAutoRefresh() {
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
    if (!state.autoRefresh) return;
    state.refreshTimer = setInterval(() => {
      if (document.hidden) return;
      checkHealth();
      if (state.tab === "dashboard") loadMetrics();
    }, 5000);
  }

  /* Re-render do gráfico em resize */
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.tab === "dashboard") {
        renderTimeSeriesChart(state.metrics?.timeSeries || state.metrics?.series || []);
      }
    }, 180);
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.tab === "dashboard" && state.autoRefresh) loadMetrics();
  });

  /* Hash routing */
  window.addEventListener("hashchange", () => {
    const tab = window.location.hash.replace("#", "");
    if (TAB_INFO[tab] && tab !== state.tab) switchTab(tab, { push: false });
  });

  /* Nota de plataforma no atalho do palette */
  if (!/Mac|iPhone|iPad/i.test(navigator.platform || "")) {
    $("cmdKbd").textContent = "Ctrl K";
  } else {
    $("cmdKbd").textContent = "⌘ K";
  }

  /* ------------------------------------------------------------------ */
  /* Init                                                               */
  /* ------------------------------------------------------------------ */

  initTheme();
  initRange();

  const initialTab = window.location.hash.replace("#", "");
  switchTab(TAB_INFO[initialTab] ? initialTab : "dashboard", { push: false });
  refreshAll();
  setupAutoRefresh();
})();
