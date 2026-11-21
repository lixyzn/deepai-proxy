const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const STORAGE_KEY = "deepai-proxy-session";
const LOGIN_STORAGE = "deepai-proxy-login";
const PASSWORD_CHARSET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*+-_=?";
const state = {
  sessionToken: "",
  gateMode: "login",
  baseUrl: "",
  proxyToken: "",
  accounts: [],
  activeAccountId: null,
  telemetry: { summary: {}, accounts: {}, requests: [], updatedAt: null },
  conversations: { sessions: [], stats: {}, updatedAt: null },
  models: {
    data: [],
    counts: {},
    account: null,
    fetchedAt: null,
    default: null,
    loaded: false,
    loading: false,
    filter: "all",
    provider: "all",
    sort: "default",
    providerSignature: "",
    search: "",
  },
  activeTab: "login",
  login: null,
  countdownTimer: null,
  pollTimer: null,
  healthTimer: null,
  telemetryTimer: null,
};

const els = {
  app: $("#app"),
  gate: $("#gate"),
  gateForm: $("#gateForm"),
  gateKicker: $("#gateKicker"),
  gateTitle: $("#gateTitle"),
  gateSubtitle: $("#gateSubtitle"),
  gateSubmit: $("#gateSubmit"),
  gateForgot: $("#gateForgot"),
  setupFields: $("#setupFields"),
  loginFields: $("#loginFields"),
  setupPassword: $("#setupPassword"),
  setupConfirm: $("#setupConfirm"),
  loginPassword: $("#loginPassword"),
  generatePassword: $("#generatePassword"),
  copyGenerated: $("#copyGenerated"),
  strength: $("#strength"),
  gateError: $("#gateError"),
  lockBtn: $("#lockBtn"),
  serverStatus: $("#serverStatus"),
  loginStart: $("#loginStart"),
  linkPanel: $("#linkPanel"),
  startBtn: $("#startBtn"),
  restartBtn: $("#restartBtn"),
  loginUrl: $("#loginUrl"),
  copyLinkBtn: $("#copyLinkBtn"),
  openLinkBtn: $("#openLinkBtn"),
  waiting: $("#waiting"),
  waitSpinner: $("#waitSpinner"),
  waitSuccess: $("#waitSuccess"),
  waitTitle: $("#waitTitle"),
  waitSub: $("#waitSub"),
  countdown: $("#countdown"),
  callbackInput: $("#callbackInput"),
  completeBtn: $("#completeBtn"),
  apiKeyInput: $("#apiKeyInput"),
  importBtn: $("#importBtn"),
  baseUrl: $("#baseUrl"),
  proxyToken: $("#proxyToken"),
  revealBtn: $("#revealBtn"),
  snippet: $("#snippet code"),
  copySnippet: $("#copySnippet"),
  rotateBtn: $("#rotateBtn"),
  accountCount: $("#accountCount"),
  accountsGrid: $("#accountsGrid"),
  emptyState: $("#emptyState"),
  metricRequests: $("#metricRequests"),
  metricRequestsHint: $("#metricRequestsHint"),
  metricSuccess: $("#metricSuccess"),
  metricSuccessHint: $("#metricSuccessHint"),
  metricLatency: $("#metricLatency"),
  metricLatencyHint: $("#metricLatencyHint"),
  metricTokens: $("#metricTokens"),
  metricTokensHint: $("#metricTokensHint"),
  metricCache: $("#metricCache"),
  metricCacheHint: $("#metricCacheHint"),
  metricTheos: $("#metricTheos"),
  metricTheosHint: $("#metricTheosHint"),
  telemetryUpdated: $("#telemetryUpdated"),
  refreshTelemetry: $("#refreshTelemetry"),
  clearTelemetry: $("#clearTelemetry"),
  activityWrap: $("#activityWrap"),
  activityBody: $("#activityBody"),
  activityEmpty: $("#activityEmpty"),
  conversationsUpdated: $("#conversationsUpdated"),
  conversationSessions: $("#conversationSessions"),
  conversationMessages: $("#conversationMessages"),
  conversationRestored: $("#conversationRestored"),
  conversationBytes: $("#conversationBytes"),
  conversationList: $("#conversationList"),
  conversationsEmpty: $("#conversationsEmpty"),
  clearConversations: $("#clearConversations"),
  tabs: $$(".tab"),
  views: $$(".tab-view"),
  chartRequests: $("#chartRequests"),
  chartRequestsNote: $("#chartRequestsNote"),
  chartLatency: $("#chartLatency"),
  chartLatencyNote: $("#chartLatencyNote"),
  chartModels: $("#chartModels"),
  chartModelsNote: $("#chartModelsNote"),
  modelsGrid: $("#modelsGrid"),
  modelsEmpty: $("#modelsEmpty"),
  modelsSummary: $("#modelsSummary"),
  modelsUpdated: $("#modelsUpdated"),
  refreshModels: $("#refreshModels"),
  modelSearch: $("#modelSearch"),
  modelProvider: $("#modelProvider"),
  modelSort: $("#modelSort"),
  modelFilters: $$("#modelFilters .chip"),
  countAll: $("#countAll"),
  countFree: $("#countFree"),
  countPaid: $("#countPaid"),
  countPremier: $("#countPremier"),
  clientSnippet: $("#clientSnippet code"),
  copyClientSnippet: $("#copyClientSnippet"),
  toasts: $("#toasts"),
  confirmDialog: $("#confirmDialog"),
  confirmTitle: $("#confirmTitle"),
  confirmMessage: $("#confirmMessage"),
  confirmOk: $("#confirmOk"),
  confirmCancel: $("#confirmCancel"),
  steps: $$("#steps .step"),
};

/* ---------- boot ---------- */

async function init() {
  bindEvents();
  startHealthLoop();
  localStorage.removeItem("deepai-proxy-admin");
  const token = localStorage.getItem(STORAGE_KEY) || "";
  if (!token) {
    await showGate();
    return;
  }
  state.sessionToken = token;
  try {
    await adminFetch("/admin/api/session");
    await refreshState();
    hideGate();
    restorePendingLogin();
    applyTab(initialTab(), { persist: false });
  } catch {
    await showGate();
  }
}

/* ---------- rede ---------- */

async function adminFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${state.sessionToken}`);
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }
  if (response.status === 401) {
    lock();
    throw new Error("Sessão expirada. Entre com sua senha novamente.");
  }
  if (!response.ok) {
    const message =
      (payload && (payload.error || payload.message)) ||
      `Falha na requisição (${response.status}).`;
    throw new Error(typeof message === "string" ? message : "Falha na requisição.");
  }
  return payload;
}

async function refreshState() {
  const [data, telemetry, conversations] = await Promise.all([
    adminFetch("/admin/api/state"),
    adminFetch("/admin/api/telemetry").catch(() => null),
    adminFetch("/admin/api/conversations").catch(() => null),
  ]);
  state.baseUrl = data.baseUrl;
  state.proxyToken = data.proxyToken;
  const previousActive = state.activeAccountId;
  state.accounts = Array.isArray(data.accounts) ? data.accounts : [];
  state.activeAccountId = data.activeAccountId;
  state.telemetry = normalizeTelemetry(telemetry);
  state.conversations = normalizeConversations(conversations);

  if (previousActive && previousActive !== data.activeAccountId) {
    state.models = {
      ...state.models,
      data: [],
      counts: {},
      account: null,
      fetchedAt: null,
      loaded: false,
    };
    if (state.activeTab === "models") loadModels({ quiet: true });
  }

  if (els.baseUrl.value !== data.baseUrl) {
    els.baseUrl.value = data.baseUrl;
    els.snippet.textContent = buildSnippet(data.baseUrl);
  }
  if (els.proxyToken.value !== data.proxyToken) {
    els.proxyToken.value = data.proxyToken;
  }
  if (els.clientSnippet) {
    els.clientSnippet.textContent = buildClientSnippet(data.baseUrl);
  }
  renderTelemetry();
  renderConversations();
  renderAccounts();
}

function validTab(value) {
  return ["login", "panel", "models", "access"].includes(value) ? value : null;
}

function initialTab() {
  const hash = validTab(location.hash.replace(/^#/, ""));
  if (hash) return hash;
  return state.accounts.length ? "panel" : "login";
}

function applyTab(tab, { persist = true } = {}) {
  const next = validTab(tab) || "login";
  state.activeTab = next;
  for (const button of els.tabs) {
    const active = button.dataset.tab === next;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
  for (const view of els.views) {
    view.classList.toggle("hidden", view.dataset.view !== next);
  }
  if (persist) {
    try {
      history.replaceState(null, "", `#${next}`);
    } catch {
      // ambiente sem history
    }
  }
  if (next === "panel") {
    refreshTelemetry();
    startTelemetryLoop();
  } else {
    stopTelemetryLoop();
  }
  if (next === "models" && state.sessionToken) {
    if (!state.models.loaded) loadModels({ quiet: true });
    else renderModels();
  }
}

function normalizeTelemetry(data) {
  return {
    summary: data?.summary && typeof data.summary === "object" ? data.summary : {},
    accounts: data?.accounts && typeof data.accounts === "object" ? data.accounts : {},
    requests: Array.isArray(data?.requests) ? data.requests : [],
    updatedAt: typeof data?.updatedAt === "string" ? data.updatedAt : null,
  };
}

function normalizeConversations(data) {
  return {
    sessions: Array.isArray(data?.sessions) ? data.sessions : [],
    stats: data?.stats && typeof data.stats === "object" ? data.stats : {},
    updatedAt: typeof data?.updatedAt === "string" ? data.updatedAt : null,
  };
}

async function refreshTelemetry({ quiet = true } = {}) {
  if (!state.sessionToken) return;
  try {
    // Atualiza contas (saldo/allowance) e telemetria no mesmo ciclo.
    await refreshState();
  } catch (error) {
    if (!quiet) toast("error", error.message);
  }
}

function startTelemetryLoop() {
  stopTelemetryLoop();
  if (state.activeTab !== "panel") return;
  state.telemetryTimer = setInterval(() => {
    if (document.visibilityState === "visible") refreshTelemetry();
  }, 10000);
}

function stopTelemetryLoop() {
  clearInterval(state.telemetryTimer);
  state.telemetryTimer = null;
}

function startHealthLoop() {
  const check = async () => {
    try {
      const response = await fetch("/health", { cache: "no-store" });
      setServerHealth(response.ok);
    } catch {
      setServerHealth(false);
    }
  };
  check();
  clearInterval(state.healthTimer);
  state.healthTimer = setInterval(check, 15000);
}

function setServerHealth(online) {
  els.serverStatus.classList.toggle("offline", !online);
  els.serverStatus.querySelector("span").textContent = online ? "Online" : "Offline";
}

/* ---------- gate ---------- */

async function showGate() {
  els.gate.classList.remove("hidden");
  els.app.setAttribute("aria-hidden", "true");
  els.gateError.textContent = "";

  let initialized = true;
  try {
    const response = await fetch("/admin/api/setup", { cache: "no-store" });
    const data = await response.json();
    initialized = Boolean(data.initialized);
  } catch {
    // se a rede falhar, mostra o login normal
  }
  setGateMode(initialized ? "login" : "setup");
}

function setGateMode(mode) {
  state.gateMode = mode;
  const setup = mode === "setup";
  els.setupFields.classList.toggle("hidden", !setup);
  els.loginFields.classList.toggle("hidden", setup);
  els.gateForgot.classList.toggle("hidden", setup);
  els.gateKicker.textContent = setup ? "Primeiro acesso" : "Acesso restrito";
  els.gateTitle.textContent = setup ? "Crie sua senha" : "Entrar no painel";
  els.gateSubtitle.textContent = setup
    ? "Proteja o painel e as credenciais das contas com uma senha de administrador."
    : "Digite a senha de administrador para acessar as contas e a API do proxy.";
  els.gateSubmit.textContent = setup ? "Criar senha e entrar" : "Entrar";
  els.gateError.textContent = "";
  els.setupPassword.value = "";
  els.setupConfirm.value = "";
  els.loginPassword.value = "";
  els.setupPassword.type = "password";
  els.setupConfirm.type = "password";
  els.loginPassword.type = "password";
  els.copyGenerated.classList.add("hidden");
  syncPasswordToggles();
  renderStrength("");
  setTimeout(() => {
    (setup ? els.setupPassword : els.loginPassword).focus();
  }, 60);
}

function hideGate() {
  els.gate.classList.add("hidden");
  els.app.removeAttribute("aria-hidden");
}

async function lock() {
  const token = state.sessionToken;
  state.sessionToken = "";
  localStorage.removeItem(STORAGE_KEY);
  clearLoginTimers();
  stopTelemetryLoop();
  if (token) {
    fetch("/admin/api/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
  await showGate();
}

async function submitGate(event) {
  event.preventDefault();
  els.gateError.textContent = "";

  const setup = state.gateMode === "setup";
  let body;
  if (setup) {
    const password = els.setupPassword.value;
    if (password.length < 8) {
      els.gateError.textContent = "A senha precisa ter pelo menos 8 caracteres.";
      return;
    }
    if (password !== els.setupConfirm.value) {
      els.gateError.textContent = "As senhas não conferem.";
      return;
    }
    body = { password };
  } else {
    const password = els.loginPassword.value;
    if (!password) {
      els.gateError.textContent = "Informe sua senha.";
      return;
    }
    body = { password };
  }

  const previousLabel = els.gateSubmit.textContent;
  els.gateSubmit.disabled = true;
  els.gateSubmit.textContent = setup ? "Criando senha…" : "Entrando…";

  try {
    const response = await fetch(setup ? "/admin/api/setup" : "/admin/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "Não foi possível entrar no painel.");
    }
    await activateSession(data.sessionToken);
    toast(
      "success",
      setup
        ? "Senha criada. Guarde-a em local seguro."
        : "Painel desbloqueado.",
    );
  } catch (error) {
    els.gateError.textContent = error.message;
    if (/primeiro acesso|já foi criada|já está configurada/i.test(error.message)) {
      await showGate();
    }
  } finally {
    els.gateSubmit.disabled = false;
    els.gateSubmit.textContent = previousLabel;
  }
}

async function activateSession(token) {
  state.sessionToken = token;
  localStorage.setItem(STORAGE_KEY, token);
  await refreshState();
  els.setupPassword.value = "";
  els.setupConfirm.value = "";
  els.loginPassword.value = "";
  hideGate();
  restorePendingLogin();
  applyTab(initialTab(), { persist: false });
}

function generateStrongPassword() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let password = "";
  for (const byte of bytes) password += PASSWORD_CHARSET[byte % PASSWORD_CHARSET.length];
  return password;
}

function passwordScore(value) {
  if (!value) return 0;
  let points = 0;
  if (value.length >= 8) points += 1;
  if (value.length >= 12) points += 1;
  if (value.length >= 16) points += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) points += 1;
  if (/\d/.test(value)) points += 1;
  if (/[^a-zA-Z0-9]/.test(value)) points += 1;
  if (points <= 3) return 1;
  if (points <= 5) return 2;
  return 3;
}

function renderStrength(value) {
  const score = passwordScore(value);
  els.strength.className = `strength${score ? ` s${score}` : ""}`;
}

function syncPasswordToggles() {
  $$(".password-toggle").forEach((button) => {
    const input = document.getElementById(button.dataset.target);
    const showing = input?.type === "text";
    button.title = showing ? "Ocultar senha" : "Mostrar senha";
    button.setAttribute("aria-label", showing ? "Ocultar senha" : "Mostrar senha");
  });
}

function useGeneratedPassword() {
  const password = generateStrongPassword();
  els.setupPassword.value = password;
  els.setupConfirm.value = password;
  els.setupPassword.type = "text";
  els.setupConfirm.type = "text";
  els.copyGenerated.classList.remove("hidden");
  syncPasswordToggles();
  renderStrength(password);
  els.gateError.textContent = "";
  toast("success", "Senha forte gerada. Copie e guarde antes de continuar.");
}

async function copyGeneratedPassword() {
  const ok = await copyText(els.setupPassword.value);
  if (!ok) {
    toast("error", "Não foi possível copiar a senha.");
    return;
  }
  toast("success", "Senha copiada. Guarde-a em local seguro.");
}

/* ---------- login ---------- */

function setSteps(active, done = []) {
  els.steps.forEach((step) => {
    const number = Number(step.dataset.step);
    step.classList.toggle("active", number === active);
    step.classList.toggle("done", done.includes(number));
  });
}

function resetLoginUi() {
  clearLoginTimers();
  clearPersistedLogin();
  state.login = null;
  els.linkPanel.classList.add("hidden");
  els.loginStart.classList.remove("hidden");
  els.startBtn.disabled = false;
  els.startBtn.innerHTML = startButtonContent();
  els.waiting.classList.remove("success", "error");
  els.waitSuccess.classList.add("hidden");
  els.waitSpinner.classList.remove("hidden");
  els.waitTitle.textContent = "Aguardando aprovação";
  els.waitSub.innerHTML = 'O link expira em <span id="countdown">10:00</span>';
  els.countdown = $("#countdown");
  els.loginUrl.value = "";
  els.callbackInput.value = "";
  setSteps(1);
}

function startButtonContent() {
  return `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M10.5 13.5 13.5 10.5" />
    <path d="M7.2 16.8 5.4 18.6a3.9 3.9 0 0 1-5.5-5.5l3.6-3.6a3.9 3.9 0 0 1 5.5 0" transform="translate(2.2 -1.2) scale(.82)" />
    <path d="M16.8 7.2 18.6 5.4a3.9 3.9 0 0 1 5.5 5.5l-3.6 3.6a3.9 3.9 0 0 1-5.5 0" transform="translate(-1.2 2.2) scale(.82)" />
  </svg> Gerar link de login`;
}

async function startLogin() {
  if (state.login) return;
  els.startBtn.disabled = true;
  els.startBtn.textContent = "Gerando link…";
  try {
    const data = await adminFetch("/admin/api/login/start", {
      method: "POST",
      body: "{}",
    });
    state.login = {
      id: data.loginId,
      url: data.url,
      expiresAt: Date.parse(data.expiresAt),
      settled: false,
    };
    persistLogin();
    els.loginStart.classList.add("hidden");
    els.linkPanel.classList.remove("hidden");
    els.loginUrl.value = data.url;
    els.openLinkBtn.href = data.url;
    els.waiting.classList.remove("success", "error");
    els.waitSuccess.classList.add("hidden");
    els.waitSpinner.classList.remove("hidden");
    els.waitTitle.textContent = "Aguardando aprovação";
    els.waitSub.innerHTML = 'O link expira em <span id="countdown">10:00</span>';
    els.countdown = $("#countdown");
    els.restartBtn.textContent = "Cancelar";
    setSteps(2, [1]);
    startCountdown();
    startPolling();
  } catch (error) {
    toast("error", error.message);
    els.startBtn.disabled = false;
    els.startBtn.innerHTML = startButtonContent();
  }
}

function startCountdown() {
  clearInterval(state.countdownTimer);
  const tick = () => {
    if (!state.login) return;
    const remaining = Math.max(0, state.login.expiresAt - Date.now());
    if (els.countdown) els.countdown.textContent = formatDuration(remaining);
    if (remaining === 0) {
      clearInterval(state.countdownTimer);
      if (!state.login.settled) {
        markLoginError("O link expirou. Gere um novo.");
      }
    }
  };
  tick();
  state.countdownTimer = setInterval(tick, 1000);
}

function startPolling() {
  clearInterval(state.pollTimer);
  const poll = async () => {
    if (!state.login || state.login.settled) return;
    try {
      const status = await adminFetch(`/admin/api/login/${state.login.id}`);
      handleLoginStatus(status);
    } catch (error) {
      if (/não encontrado/i.test(error.message)) {
        markLoginError("Este login não existe mais. Gere um novo link.");
      }
    }
  };
  state.pollTimer = setInterval(poll, 2000);
  poll();
}

function handleLoginStatus(status) {
  if (!state.login || state.login.settled) return;

  if (status.status === "pending") {
    els.waitTitle.textContent = "Aguardando aprovação";
    els.waitSub.innerHTML = 'O link expira em <span id="countdown"></span>';
    els.countdown = $("#countdown");
    if (els.countdown && state.login.expiresAt) {
      els.countdown.textContent = formatDuration(
        Math.max(0, state.login.expiresAt - Date.now()),
      );
    }
    if (status.error) {
      els.waitSub.textContent = status.error;
    }
    return;
  }

  if (status.status === "exchanging") {
    els.waitTitle.textContent = "Concluindo login…";
    els.waitSub.textContent = "Trocando o código pela API key.";
    return;
  }

  if (status.status === "complete") {
    state.login.settled = true;
    clearLoginTimers();
    clearPersistedLogin();
    els.waiting.classList.remove("error");
    els.waiting.classList.add("success");
    els.waitSpinner.classList.add("hidden");
    els.waitSuccess.classList.remove("hidden");
    els.waitTitle.textContent = "Conta conectada";
    const username = status.account?.username;
    els.waitSub.textContent = username
      ? `@${username} adicionada ao proxy.`
      : "Credencial salva com segurança.";
    els.restartBtn.textContent = "Adicionar outra conta";
    setSteps(3, [1, 2]);
    toast(
      "success",
      username ? `Conta @${username} conectada.` : "Conta conectada com sucesso.",
    );
    refreshState().catch(() => {});
    return;
  }

  if (status.status === "expired") {
    markLoginError("O link expirou. Gere um novo.");
    return;
  }

  if (status.status === "cancelled") {
    resetLoginUi();
    return;
  }

  if (status.status === "failed") {
    markLoginError(status.error || "O login falhou. Gere um novo link.");
  }
}

function markLoginError(message) {
  if (!state.login) return;
  state.login.settled = true;
  clearLoginTimers();
  clearPersistedLogin();
  els.waiting.classList.remove("success");
  els.waiting.classList.add("error");
  els.waitSpinner.classList.remove("hidden");
  els.waitSuccess.classList.add("hidden");
  els.waitTitle.textContent = "Não foi possível concluir";
  els.waitSub.textContent = message;
  els.restartBtn.textContent = "Gerar novo link";
  setSteps(2, [1]);
}

async function cancelLogin() {
  if (state.login && !state.login.settled) {
    try {
      await adminFetch(`/admin/api/login/${state.login.id}`, {
        method: "DELETE",
      });
    } catch {
      // melhor esforço
    }
  }
  resetLoginUi();
}

function persistLogin() {
  if (!state.login) return;
  try {
    sessionStorage.setItem(
      LOGIN_STORAGE,
      JSON.stringify({
        id: state.login.id,
        url: state.login.url,
        expiresAt: state.login.expiresAt,
      }),
    );
  } catch {
    // sessão sem storage
  }
}

function clearPersistedLogin() {
  try {
    sessionStorage.removeItem(LOGIN_STORAGE);
  } catch {
    // sessão sem storage
  }
}

function restorePendingLogin() {
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem(LOGIN_STORAGE) || "null");
  } catch {
    saved = null;
  }
  if (!saved?.id || !saved?.url || !saved?.expiresAt) return;
  if (Date.now() >= saved.expiresAt) {
    clearPersistedLogin();
    return;
  }

  state.login = {
    id: saved.id,
    url: saved.url,
    expiresAt: saved.expiresAt,
    settled: false,
  };
  els.loginStart.classList.add("hidden");
  els.linkPanel.classList.remove("hidden");
  els.loginUrl.value = saved.url;
  els.openLinkBtn.href = saved.url;
  els.waiting.classList.remove("success", "error");
  els.waitSuccess.classList.add("hidden");
  els.waitSpinner.classList.remove("hidden");
  els.waitTitle.textContent = "Aguardando aprovação";
  els.waitSub.innerHTML = 'O link expira em <span id="countdown">10:00</span>';
  els.countdown = $("#countdown");
  els.restartBtn.textContent = "Cancelar";
  setSteps(2, [1]);
  startCountdown();
  startPolling();
}

async function completeManually() {
  const value = els.callbackInput.value.trim();
  if (!value) {
    toast("error", "Cole o código ou a URL de retorno.");
    return;
  }
  if (!state.login) {
    toast("error", "Gere um link de login primeiro para vincular o retorno.");
    return;
  }
  els.completeBtn.disabled = true;
  try {
    const status = await adminFetch(
      `/admin/api/login/${state.login.id}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ callbackUrl: value }),
      },
    );
    handleLoginStatus(status);
    if (status.status === "complete") {
      els.callbackInput.value = "";
    } else {
      toast("error", status.error || "Não foi possível concluir o login.");
    }
  } catch (error) {
    toast("error", error.message);
  } finally {
    els.completeBtn.disabled = false;
  }
}

/* ---------- contas ---------- */

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderConversations() {
  const data = state.conversations ?? {};
  const stats = data.stats ?? {};
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  if (!els.conversationSessions) return;

  els.conversationSessions.textContent = formatNumber(stats.sessions ?? sessions.length);
  els.conversationMessages.textContent = formatNumber(stats.messages ?? 0);
  els.conversationRestored.textContent = formatNumber(stats.restored ?? 0);
  els.conversationBytes.textContent = formatBytes(stats.bytes ?? 0);
  els.conversationsUpdated.textContent = data.updatedAt
    ? `Atualizado ${formatClock(data.updatedAt)}`
    : "—";

  els.conversationList.replaceChildren();
  const recent = sessions.slice(0, 6);
  els.conversationsEmpty.classList.toggle("hidden", recent.length > 0);
  for (const session of recent) {
    const row = document.createElement("div");
    row.className = "conversation-row";

    const identity = document.createElement("div");
    identity.className = "conversation-identity";
    const id = document.createElement("code");
    id.textContent = session.id;
    id.title = "ID estável enviado como prompt_cache_key";
    const model = document.createElement("span");
    model.textContent = session.model || "modelo não informado";
    identity.append(id, model);

    const meta = document.createElement("div");
    meta.className = "conversation-meta";
    const messageCount = document.createElement("span");
    messageCount.textContent = `${formatNumber(session.messages || 0)} msg`;
    const restored = document.createElement("span");
    restored.textContent = `${formatNumber(session.restored || 0)} restauradas`;
    restored.title = "Mensagens que o proxy recolocou no contexto após compactação.";
    const when = document.createElement("span");
    when.textContent = formatClock(session.updatedAt);
    meta.append(messageCount, restored, when);

    row.append(identity, meta);
    els.conversationList.append(row);
  }
}

function renderTelemetry() {
  const summary = state.telemetry.summary ?? {};
  const requests = state.telemetry.requests ?? [];
  const requestsCount = Number(summary.requests) || 0;
  const successes = Number(summary.successes) || 0;
  const errors = Number(summary.errors) || 0;
  const cancelled = Number(summary.cancelled) || 0;
  const completed = Math.max(0, requestsCount - cancelled);
  const inputTokens = Number(summary.inputTokens) || 0;
  const outputTokens = Number(summary.outputTokens) || 0;
  const totalTokens = inputTokens + outputTokens;
  const successRate = completed ? (successes / completed) * 100 : null;
  const completedRows = requests.filter(
    (request) => Number(request.status) !== 499,
  );
  const averageLatency = completedRows.length
    ? Math.round(
        completedRows.reduce(
          (sum, request) => sum + (Number(request.durationMs) || 0),
          0,
        ) / completedRows.length,
      )
    : null;
  const lastRequest = completedRows[0] ?? null;

  els.metricRequests.textContent = formatNumber(requestsCount);
  els.metricRequestsHint.textContent = errors
    ? `${formatNumber(errors)} ${errors === 1 ? "erro" : "erros"}`
    : cancelled
      ? `${formatNumber(cancelled)} canceladas`
      : requestsCount
        ? "sem erros"
        : "nenhuma ainda";

  els.metricSuccess.textContent =
    successRate === null ? "—" : `${Math.round(successRate)}%`;
  els.metricSuccessHint.textContent = completed
    ? `${formatNumber(successes)}/${formatNumber(completed)} concluídas`
    : "sem dados";

  els.metricLatency.textContent =
    averageLatency === null ? "—" : formatMs(averageLatency);
  els.metricLatencyHint.textContent = lastRequest
    ? `última ${formatMs(lastRequest.durationMs)}`
    : "sem dados";

  els.metricTokens.textContent = formatCompact(totalTokens);
  els.metricTokensHint.textContent = `in ${formatCompact(
    inputTokens,
  )} · out ${formatCompact(outputTokens)}`;

  const cachedTokens = Number(summary.cachedInputTokens) || 0;
  const cacheRate =
    inputTokens > 0 ? Math.min(100, (cachedTokens / inputTokens) * 100) : null;
  els.metricCache.textContent =
    cacheRate === null ? "—" : `${Math.round(cacheRate)}%`;
  els.metricCacheHint.textContent = cachedTokens
    ? `${formatCompact(cachedTokens)} lidos`
    : inputTokens
      ? "sem cache ainda"
      : "sem dados";

  const active =
    state.accounts.find((account) => account.id === state.activeAccountId) ??
    state.accounts[0];
  const allowance = active?.allowance ?? null;
  if (allowance && allowance.balance !== undefined && allowance.balance !== null) {
    els.metricTheos.textContent = formatAmount(allowance.balance);
    const parts = [];
    if (allowance.granted !== undefined && allowance.granted !== null) {
      parts.push(`concedido ${formatAmount(allowance.granted)}`);
    }
    if (Number(summary.estimatedTheos) > 0) {
      parts.push(`~${formatAmount(summary.estimatedTheos)} estimados`);
    }
    els.metricTheosHint.textContent = parts.length
      ? parts.join(" · ")
      : "saldo atual";
  } else if (allowance && allowance.enabled === false) {
    els.metricTheos.textContent = "off";
    els.metricTheosHint.textContent = "allowance desativada";
  } else {
    els.metricTheos.textContent = "—";
    els.metricTheosHint.textContent = "sem leitura de saldo";
  }

  els.telemetryUpdated.textContent = state.telemetry.updatedAt
    ? `Atualizado ${formatClock(state.telemetry.updatedAt)}`
    : "—";

  renderCharts(requests);

  els.activityBody.replaceChildren();
  const rows = requests.slice(0, 50);
  els.activityWrap.classList.toggle("hidden", rows.length === 0);
  els.activityEmpty.classList.toggle("hidden", rows.length > 0);

  const byId = new Map(state.accounts.map((account) => [account.id, account]));
  for (const request of rows) {
    const row = document.createElement("tr");
    if (request.error) row.title = request.error;

    const time = document.createElement("td");
    time.className = "activity-time";
    time.textContent = formatClock(request.at);

    const account = document.createElement("td");
    account.className = "activity-account";
    const owner = byId.get(request.accountId);
    account.textContent = owner
      ? owner.username
        ? `@${owner.username}`
        : owner.label || "Conta"
      : "—";

    const model = document.createElement("td");
    model.className = "activity-model";
    model.textContent = request.model || "—";

    const route = document.createElement("td");
    route.className = "activity-route";
    route.textContent = request.endpoint || "—";

    const statusCell = document.createElement("td");
    const status = document.createElement("span");
    const code = Number(request.status) || 0;
    status.className = `status-code ${
      code >= 200 && code < 400
        ? "ok"
        : code === 499
          ? "warn"
          : code >= 500
            ? "bad"
            : "warn"
    }`;
    status.textContent = code ? String(code) : "—";
    if (request.error) {
      status.title = code === 499 ? "Cliente cancelou a requisição." : request.error;
    }
    statusCell.append(status);

    const latency = document.createElement("td");
    latency.textContent = formatMs(request.durationMs);

    const tokens = document.createElement("td");
    const inTokens = Number(request.inputTokens) || 0;
    const outTokens = Number(request.outputTokens) || 0;
    tokens.textContent =
      inTokens || outTokens
        ? `${formatCompact(inTokens)} / ${formatCompact(outTokens)}`
        : "—";

    const cacheCell = document.createElement("td");
    const cached = Number(request.cachedInputTokens) || 0;
    cacheCell.textContent = cached
      ? formatCompact(cached)
      : request.cacheHit === false
        ? "0"
        : "—";
    if (cached > 0) cacheCell.className = "cache-hit";

    const theos = document.createElement("td");
    theos.textContent =
      request.theos === null || request.theos === undefined
        ? "—"
        : formatAmount(request.theos);

    row.append(
      time,
      account,
      model,
      route,
      statusCell,
      latency,
      tokens,
      cacheCell,
      theos,
    );
    els.activityBody.append(row);
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svgNode(tag, attrs = {}, parent = null, text = null) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  if (text !== null) node.textContent = text;
  if (parent) parent.append(node);
  return node;
}

function chartEmpty(target, text) {
  target.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "chart-empty";
  empty.textContent = text;
  target.append(empty);
}

function renderCharts(requests) {
  renderRequestsChart(requests);
  renderLatencyChart(requests);
  renderModelsChart(requests);
}

function renderRequestsChart(requests) {
  const target = els.chartRequests;
  if (!target) return;
  const hourStart = new Date();
  hourStart.setMinutes(0, 0, 0);
  const buckets = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(hourStart.getTime() - (11 - index) * 3600000);
    return {
      at: date.getTime(),
      label: `${String(date.getHours()).padStart(2, "0")}h`,
      count: 0,
    };
  });
  let total = 0;
  for (const request of requests) {
    const time = Date.parse(request.at);
    if (!Number.isFinite(time)) continue;
    const index = 11 + Math.floor((time - hourStart.getTime()) / 3600000);
    if (index < 0 || index > 11) continue;
    buckets[index].count += 1;
    total += 1;
  }
  if (total === 0) {
    chartEmpty(target, "Sem requisições nas últimas 12 horas.");
    els.chartRequestsNote.textContent = "últimas 12h";
    return;
  }

  const width = 600;
  const height = 180;
  const pad = { left: 30, right: 8, top: 12, bottom: 24 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const svg = svgNode("svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": "Requisições por hora nas últimas 12 horas",
  });
  const defs = svgNode("defs", {}, svg);
  const gradient = svgNode(
    "linearGradient",
    { id: "barGrad", x1: "0", y1: "0", x2: "0", y2: "1" },
    defs,
  );
  svgNode("stop", { offset: "0", "stop-color": "#e879f9" }, gradient);
  svgNode("stop", { offset: "1", "stop-color": "#7c3aed" }, gradient);

  for (let line = 0; line <= 3; line += 1) {
    const y = pad.top + (innerH / 3) * line;
    svgNode(
      "line",
      { x1: pad.left, y1: y, x2: width - pad.right, y2: y, class: "chart-grid-line" },
      svg,
    );
    svgNode(
      "text",
      { x: pad.left - 6, y: y + 3, "text-anchor": "end", class: "chart-axis" },
      svg,
      String(Math.round(max - (max / 3) * line)),
    );
  }

  const slot = innerW / buckets.length;
  buckets.forEach((bucket, index) => {
    const barW = Math.max(5, slot * 0.58);
    const x = pad.left + slot * index + (slot - barW) / 2;
    const barH = (bucket.count / max) * innerH;
    const y = pad.top + innerH - barH;
    const rect = svgNode(
      "rect",
      {
        x,
        y,
        width: barW,
        height: Math.max(2, barH),
        rx: 3,
        class: "chart-bar",
      },
      svg,
    );
    svgNode("title", {}, rect, `${bucket.label}: ${bucket.count}`);
  });

  for (const index of [0, 3, 6, 9, 11]) {
    const x = pad.left + slot * index + slot / 2;
    svgNode(
      "text",
      { x, y: height - 6, "text-anchor": "middle", class: "chart-axis" },
      svg,
      buckets[index].label,
    );
  }

  target.replaceChildren(svg);
  els.chartRequestsNote.textContent = `${formatNumber(total)} req · 12h`;
}

function renderLatencyChart(requests) {
  const target = els.chartLatency;
  if (!target) return;
  const rows = requests
    .filter((request) => Number(request.status) !== 499)
    .slice(0, 30)
    .reverse();
  const values = rows
    .map((request) => Number(request.durationMs))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (values.length === 0) {
    chartEmpty(target, "Sem latência registrada ainda.");
    els.chartLatencyNote.textContent = "últimas 30";
    return;
  }

  const width = 600;
  const height = 180;
  const pad = { left: 38, right: 10, top: 12, bottom: 24 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...values);
  const svg = svgNode("svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": "Latência das últimas requisições",
  });

  for (let line = 0; line <= 3; line += 1) {
    const y = pad.top + (innerH / 3) * line;
    svgNode(
      "line",
      { x1: pad.left, y1: y, x2: width - pad.right, y2: y, class: "chart-grid-line" },
      svg,
    );
    svgNode(
      "text",
      { x: pad.left - 6, y: y + 3, "text-anchor": "end", class: "chart-axis" },
      svg,
      formatMs(Math.round(max - (max / 3) * line)),
    );
  }

  const step = values.length > 1 ? innerW / (values.length - 1) : 0;
  const points = values.map((value, index) => {
    const x = pad.left + step * index;
    const y = pad.top + innerH - (value / max) * innerH;
    return { x, y, value };
  });
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
  svgNode("path", { d: path, class: "chart-line" }, svg);
  for (const point of points) {
    const circle = svgNode(
      "circle",
      { cx: point.x, cy: point.y, r: 2.6, class: "chart-point" },
      svg,
    );
    svgNode("title", {}, circle, formatMs(point.value));
  }

  const labels = [rows[0], rows[rows.length - 1]];
  labels.forEach((row, index) => {
    if (!row) return;
    svgNode(
      "text",
      {
        x: index === 0 ? pad.left : width - pad.right,
        y: height - 6,
        "text-anchor": index === 0 ? "start" : "end",
        class: "chart-axis",
      },
      svg,
      formatClock(row.at),
    );
  });

  target.replaceChildren(svg);
  els.chartLatencyNote.textContent = `${formatNumber(values.length)} req`;
}

function renderModelsChart(requests) {
  const target = els.chartModels;
  if (!target) return;
  const counts = new Map();
  for (const request of requests) {
    const model = request.model || "—";
    counts.set(model, (counts.get(model) || 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (rows.length === 0) {
    chartEmpty(target, "Sem modelos usados ainda.");
    els.chartModelsNote.textContent = "—";
    return;
  }
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  const max = rows[0][1];
  const list = document.createElement("div");
  list.className = "model-bars";
  for (const [model, count] of rows) {
    const row = document.createElement("div");
    row.className = "model-bar-row";
    const label = document.createElement("span");
    label.className = "model-bar-label";
    label.textContent = model;
    label.title = model;
    const value = document.createElement("span");
    value.className = "model-bar-value";
    value.textContent = `${Math.round((count / total) * 100)}% · ${formatNumber(count)}`;
    const track = document.createElement("div");
    track.className = "model-bar-track";
    const fill = document.createElement("div");
    fill.className = "model-bar-fill";
    fill.style.width = `${Math.max(3, (count / max) * 100)}%`;
    track.append(fill);
    row.append(label, value, track);
    list.append(row);
  }
  target.replaceChildren(list);
  els.chartModelsNote.textContent =
    counts.size === 1 ? "1 modelo" : `${formatNumber(counts.size)} modelos`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("pt-BR").format(Number(value) || 0);
}

function formatCompact(value) {
  const number = Number(value) || 0;
  if (Math.abs(number) < 1000) return String(Math.round(number));
  return new Intl.NumberFormat("pt-BR", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(number);
}

function formatAmount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? "—");
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(number);
}

function formatMs(value) {
  const number = Math.max(0, Number(value) || 0);
  if (number < 1000) return `${Math.round(number)} ms`;
  return `${(number / 1000).toFixed(1)} s`;
}

function formatClock(value) {
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(value));
  } catch {
    return "—";
  }
}

function buildClientSnippet(baseUrl) {
  return `baseURL: "${baseUrl}/v1"
apiKey:  "$DEEPAI_PROXY_TOKEN"
model:   "deepai/glm-5.3-flash"`;
}

function normalizeModels(data) {
  const rows = Array.isArray(data?.data) ? data.data : [];
  return {
    data: rows,
    counts: data?.counts && typeof data.counts === "object" ? data.counts : {},
    account: data?.account ?? null,
    fetchedAt: typeof data?.fetchedAt === "string" ? data.fetchedAt : null,
    default: typeof data?.default === "string" ? data.default : null,
    loaded: true,
    loading: false,
  };
}

async function loadModels({ force = false, quiet = true } = {}) {
  if (!state.sessionToken || state.models.loading) return;
  state.models.loading = true;
  if (els.refreshModels) {
    els.refreshModels.disabled = true;
    els.refreshModels.textContent = force ? "Atualizando…" : "Carregando…";
  }
  try {
    const data = await adminFetch(
      `/admin/api/models${force ? "?refresh=1" : ""}`,
    );
    state.models = { ...state.models, ...normalizeModels(data) };
    renderModels();
    if (force) toast("success", "Catálogo atualizado na DeepAI.");
  } catch (error) {
    if (!quiet) toast("error", error.message);
    if (els.modelsSummary && !state.models.loaded) {
      els.modelsSummary.textContent = error.message;
    }
  } finally {
    state.models.loading = false;
    if (els.refreshModels) {
      els.refreshModels.disabled = false;
      els.refreshModels.textContent = "Atualizar catálogo";
    }
  }
}

function syncModelProviders(data) {
  if (!els.modelProvider) return;
  const providers = new Map();
  for (const model of data) {
    if (!model.family || !model.provider) continue;
    if (!providers.has(model.family)) {
      providers.set(model.family, {
        label: model.provider,
        color: model.color,
      });
    }
  }
  const entries = [...providers.entries()].sort((a, b) =>
    a[1].label.localeCompare(b[1].label, "pt-BR"),
  );
  const signature = entries
    .map(([family, meta]) => `${family}:${meta.label}`)
    .join("|");
  if (state.models.providerSignature !== signature) {
    const current = state.models.provider;
    els.modelProvider.replaceChildren();
    const all = document.createElement("option");
    all.value = "all";
    all.textContent = "Todos os fabricantes";
    els.modelProvider.append(all);
    for (const [family, meta] of entries) {
      const option = document.createElement("option");
      option.value = family;
      option.textContent = meta.label;
      els.modelProvider.append(option);
    }
    state.models.providerSignature = signature;
    state.models.provider = providers.has(current) ? current : "all";
  }
  els.modelProvider.value = state.models.provider;
}

function modelUsage(slug) {
  const requests = state.telemetry.requests ?? [];
  let count = 0;
  let tokens = 0;
  let inputTokens = 0;
  let cached = 0;
  for (const request of requests) {
    if (request.model !== slug) continue;
    count += 1;
    const input = Number(request.inputTokens) || 0;
    inputTokens += input;
    tokens += input + (Number(request.outputTokens) || 0);
    cached += Number(request.cachedInputTokens) || 0;
  }
  return {
    count,
    tokens,
    cached,
    cacheRate: inputTokens ? (cached / inputTokens) * 100 : 0,
  };
}

function renderModels() {
  const data = state.models.data;
  const counts = state.models.counts ?? {};
  const filter = state.models.filter;
  const provider = state.models.provider;
  const sort = state.models.sort;
  const search = state.models.search.trim().toLowerCase();
  syncModelProviders(data);

  if (els.countAll) els.countAll.textContent = String(counts.total ?? data.length);
  if (els.countFree) els.countFree.textContent = String(counts.free ?? 0);
  if (els.countPaid) els.countPaid.textContent = String(counts.paid ?? 0);
  if (els.countPremier) els.countPremier.textContent = String(counts.premier ?? 0);

  for (const chip of els.modelFilters) {
    chip.classList.toggle("active", chip.dataset.filter === filter);
  }

  if (els.modelsUpdated) {
    els.modelsUpdated.textContent = state.models.fetchedAt
      ? `Atualizado ${formatClock(state.models.fetchedAt)}`
      : "—";
  }

  if (!state.models.loaded) {
    if (els.modelsSummary) {
      els.modelsSummary.textContent = "Conecte uma conta para carregar o catálogo.";
    }
    els.modelsGrid.replaceChildren();
    els.modelsEmpty.classList.add("hidden");
    return;
  }

  const account = state.models.account;
  const providerCount = new Set(
    data.map((model) => model.family).filter(Boolean),
  ).size;
  const bits = [
    `${formatNumber(data.length)} modelos`,
    `${formatNumber(counts.free ?? 0)} grátis`,
    `${formatNumber(counts.paid ?? 0)} pagos`,
  ];
  if (providerCount) {
    bits.push(
      `${formatNumber(providerCount)} ${
        providerCount === 1 ? "fabricante" : "fabricantes"
      }`,
    );
  }
  if (account?.username) {
    bits.push(`conta @${account.username}${account.isPro ? " (PRO)" : ""}`);
  }
  if (els.modelsSummary) els.modelsSummary.textContent = bits.join(" · ");

  const filtered = data.filter((model) => {
    if (filter === "free" && !model.free) return false;
    if (filter === "paid" && !model.paid) return false;
    if (filter === "premier" && !model.premier) return false;
    if (provider !== "all" && model.family !== provider) return false;
    if (!search) return true;
    return (
      String(model.name ?? "").toLowerCase().includes(search) ||
      String(model.slug ?? "").toLowerCase().includes(search) ||
      String(model.id ?? "").toLowerCase().includes(search) ||
      String(model.provider ?? "").toLowerCase().includes(search)
    );
  });

  const priceOf = (model) => {
    const value = Number(model.pricing?.theos_per_request);
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  };
  if (sort === "name") {
    filtered.sort((a, b) =>
      String(a.name ?? a.slug ?? "").localeCompare(
        String(b.name ?? b.slug ?? ""),
        "pt-BR",
      ),
    );
  } else if (sort === "price-asc") {
    filtered.sort((a, b) => priceOf(a) - priceOf(b));
  } else if (sort === "price-desc") {
    filtered.sort((a, b) => {
      const left = Number.isFinite(priceOf(a)) ? priceOf(a) : -1;
      const right = Number.isFinite(priceOf(b)) ? priceOf(b) : -1;
      return right - left;
    });
  } else if (sort === "context-desc") {
    filtered.sort(
      (a, b) =>
        (Number(b.context_window) || 0) - (Number(a.context_window) || 0),
    );
  }

  els.modelsGrid.replaceChildren();
  for (const model of filtered) {
    els.modelsGrid.append(buildModelCard(model));
  }
  els.modelsEmpty.classList.toggle("hidden", filtered.length > 0);
}

function buildModelCard(model) {
  const card = document.createElement("article");
  card.className = "model-card";

  const top = document.createElement("div");
  top.className = "model-top";
  const identity = document.createElement("div");
  identity.className = "model-identity";
  const logo = document.createElement("span");
  logo.className = "model-logo";
  logo.style.setProperty("--model-color", model.color || "#7c3aed");
  const logoImage = document.createElement("img");
  logoImage.src = model.logo || "/logos/generic.svg";
  logoImage.alt = "";
  logoImage.loading = "lazy";
  logoImage.decoding = "async";
  logoImage.addEventListener(
    "error",
    () => {
      logoImage.src = "/logos/generic.svg";
    },
    { once: true },
  );
  logo.append(logoImage);

  const info = document.createElement("div");
  info.className = "model-copy";
  const name = document.createElement("h3");
  name.className = "model-name";
  name.textContent = model.name || model.slug || "Modelo";
  const slug = document.createElement("div");
  slug.className = "model-slug";
  slug.textContent = model.provider
    ? `${model.provider} · ${model.slug || model.id || ""}`
    : model.slug || model.id || "";
  slug.title = model.id || "";
  const badges = document.createElement("div");
  badges.className = "model-badges";

  const tier = document.createElement("span");
  tier.className = `model-tag ${model.free ? "free" : "paid"}`;
  tier.textContent = model.free ? "Grátis" : "Pago";
  badges.append(tier);

  if (model.slug && model.slug === state.models.default) {
    const standard = document.createElement("span");
    standard.className = "model-tag default";
    standard.textContent = "Padrão";
    badges.append(standard);
  }
  if (model.premier) {
    const premier = document.createElement("span");
    premier.className = "model-tag premier";
    premier.textContent = "Premier";
    badges.append(premier);
  }
  if (model.requires_pro) {
    const pro = document.createElement("span");
    pro.className = "model-tag pro";
    pro.textContent =
      state.models.account?.isPro === false ? "Requer PRO" : "PRO";
    badges.append(pro);
  }
  if (Array.isArray(model.input) && model.input.includes("image")) {
    const vision = document.createElement("span");
    vision.className = "model-tag";
    vision.textContent = "Visão*";
    vision.title =
      "Capacidade do catálogo. Envio de imagens pelo proxy ainda é experimental.";
    badges.append(vision);
  }
  if (model.api === "openai-responses") {
    const responses = document.createElement("span");
    responses.className = "model-tag";
    responses.textContent = "Responses";
    badges.append(responses);
  }

  info.append(name, slug, badges);

  const price = document.createElement("div");
  price.className = "model-price";
  const priceValue = Number(model.pricing?.theos_per_request);
  if (model.free) {
    price.textContent = "Grátis";
  } else if (Number.isFinite(priceValue)) {
    price.textContent = `${formatAmount(priceValue)} `;
    const unit = document.createElement("small");
    unit.textContent = "Theos/req";
    price.append(unit);
  } else {
    price.textContent = "—";
  }
  identity.append(logo, info);
  top.append(identity, price);

  const stats = document.createElement("div");
  stats.className = "model-stats";
  stats.append(
    modelStat("Contexto", formatCompact(model.context_window ?? 0)),
    modelStat("Saída", formatCompact(model.max_output_tokens ?? 0)),
    modelStat(
      "Entrada",
      Array.isArray(model.input)
        ? model.input.map((value) => (value === "text" ? "texto" : "img")).join("/")
        : "—",
    ),
  );

  const usage = document.createElement("div");
  usage.className = "model-usage";
  const usageData = modelUsage(model.slug);
  const dot = document.createElement("span");
  dot.className = "usage-dot";
  usage.append(dot);
  if (usageData.count) {
    const text = document.createElement("span");
    text.textContent = `${formatNumber(usageData.count)} req · ${formatCompact(
      usageData.tokens,
    )} tokens`;
    usage.append(text);
    if (usageData.cached > 0) {
      const cache = document.createElement("span");
      cache.className = "usage-cache";
      cache.textContent = `· ${formatNumber(usageData.cacheRate)}% cache`;
      usage.append(cache);
    }
  } else {
    const text = document.createElement("span");
    text.textContent = "Sem uso ainda";
    usage.append(text);
  }

  const actions = document.createElement("div");
  actions.className = "model-actions";
  const copy = document.createElement("button");
  copy.className = "btn btn-ghost btn-sm";
  copy.type = "button";
  copy.textContent = "Copiar id";
  copy.title = `Copiar ${model.id}`;
  copy.addEventListener("click", async () => {
    const ok = await copyText(model.id);
    if (ok) {
      markCopied(copy);
      toast("success", "Id do modelo copiado.");
    } else {
      toast("error", "Não foi possível copiar.");
    }
  });
  actions.append(copy);

  card.append(top, stats, usage, actions);
  return card;
}

function modelStat(label, value) {
  const item = document.createElement("div");
  item.className = "model-stat";
  const name = document.createElement("span");
  name.textContent = label;
  const number = document.createElement("strong");
  number.textContent = value;
  item.append(name, number);
  return item;
}

function renderAccounts() {
  els.accountsGrid.replaceChildren();
  els.accountCount.textContent = String(state.accounts.length);
  const hasAccounts = state.accounts.length > 0;
  els.emptyState.classList.toggle("hidden", hasAccounts);
  els.accountsGrid.classList.toggle("hidden", !hasAccounts);

  for (const account of state.accounts) {
    els.accountsGrid.append(buildAccountCard(account));
  }
}

function buildAccountCard(account) {
  const card = document.createElement("article");
  card.className = `account${account.active ? " active" : ""}`;

  const top = document.createElement("div");
  top.className = "account-top";

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  const name = account.username || account.label || "DeepAI";
  avatar.textContent = (name.replace(/^@/, "")[0] || "D").toUpperCase();

  const identity = document.createElement("div");
  identity.className = "account-id";
  const title = document.createElement("h3");
  title.textContent = account.username ? `@${account.username}` : account.label || "Conta DeepAI";
  const sub = document.createElement("span");
  sub.textContent = account.keyLast4 ? `Api-Key •••• ${account.keyLast4}` : "Api-Key protegida";
  identity.append(title, sub);

  const badges = document.createElement("div");
  badges.style.display = "flex";
  badges.style.flexDirection = "column";
  badges.style.gap = "5px";
  badges.style.alignItems = "flex-end";
  if (account.isPro) {
    const pro = document.createElement("span");
    pro.className = "badge-pro";
    pro.textContent = "PRO";
    badges.append(pro);
  }
  if (account.active) {
    const active = document.createElement("span");
    active.className = "badge-active";
    active.innerHTML = "<i></i> Ativa";
    badges.append(active);
  }

  top.append(avatar, identity, badges);

  const meta = document.createElement("dl");
  meta.className = "account-meta";
  const entitlement = account.entitlement ?? null;
  const plan = String(entitlement?.plan || (account.isPro ? "pro" : "free"));
  const credits =
    entitlement?.creditsRemaining !== undefined &&
    entitlement?.creditsRemaining !== null
      ? formatAmount(entitlement.creditsRemaining)
      : "—";
  meta.append(
    metaPair("Conectada", formatDate(account.createdAt)),
    metaPair("Check-in", account.lastCheckInAt ? formatDate(account.lastCheckInAt) : "pendente"),
    metaPair("Plano", plan.toUpperCase()),
    metaPair("Créditos", credits),
  );
  if (entitlement?.checkedAt) {
    meta.title = `Plano lido às ${formatClock(entitlement.checkedAt)}${
      entitlement.hasOverages ? " · com overage" : ""
    }`;
  }

  const stats = state.telemetry.accounts?.[account.id] ?? null;
  const allowance = account.allowance ?? null;
  const usage = document.createElement("div");
  usage.className = "account-usage";
  const tokens =
    (Number(stats?.inputTokens) || 0) + (Number(stats?.outputTokens) || 0);
  usage.append(
    usageItem(
      "Req.",
      formatNumber(stats?.requests || 0),
      Number(stats?.errors) > 0 ? "warn" : "",
    ),
    usageItem("Tokens", formatCompact(tokens)),
    usageItem(
      "Latência",
      stats?.lastLatencyMs !== null && stats?.lastLatencyMs !== undefined
        ? formatMs(stats.lastLatencyMs)
        : "—",
    ),
    usageItem(
      "Theos",
      allowance?.balance !== undefined && allowance?.balance !== null
        ? formatAmount(allowance.balance)
        : "—",
      allowance?.balance !== undefined ? "good" : "",
    ),
  );
  if (allowance) {
    const bits = [];
    if (allowance.granted !== undefined && allowance.granted !== null) {
      bits.push(`concedido ${formatAmount(allowance.granted)}`);
    }
    if (allowance.checkedAt) {
      bits.push(`lido às ${formatClock(allowance.checkedAt)}`);
    }
    usage.title = bits.join(" · ");
  }

  const actions = document.createElement("div");
  actions.className = "account-actions";

  const activate = document.createElement("button");
  activate.className = account.active ? "btn btn-ghost" : "btn btn-secondary";
  activate.type = "button";
  activate.textContent = account.active ? "Em uso" : "Usar esta";
  activate.disabled = Boolean(account.active);
  activate.addEventListener("click", () => activateAccount(account));

  const refresh = document.createElement("button");
  refresh.className = "btn btn-ghost";
  refresh.type = "button";
  refresh.textContent = "Uso";
  refresh.title = "Atualizar saldo e check-in";
  refresh.addEventListener("click", () => refreshAccountUsage(account, refresh));

  const remove = document.createElement("button");
  remove.className = "btn btn-danger-ghost";
  remove.type = "button";
  remove.textContent = "Remover";
  remove.addEventListener("click", () => removeAccount(account));

  actions.append(activate, refresh, remove);
  card.append(top, meta, usage, actions);
  return card;
}

function usageItem(label, value, className = "") {
  const item = document.createElement("div");
  item.className = "usage-item";
  const name = document.createElement("span");
  name.textContent = label;
  const number = document.createElement("strong");
  number.textContent = value;
  if (className) number.className = className;
  item.append(name, number);
  return item;
}

async function refreshAccountUsage(account, button) {
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = "…";
  try {
    await adminFetch(`/admin/api/accounts/${account.id}/usage`, {
      method: "POST",
      body: "{}",
    });
    await refreshState();
    toast("success", "Saldo e check-in atualizados.");
  } catch (error) {
    toast("error", error.message);
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = previous;
    }
  }
}

function metaPair(label, value) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  const fragment = document.createDocumentFragment();
  fragment.append(dt, dd);
  return fragment;
}

async function activateAccount(account) {
  try {
    await adminFetch(`/admin/api/accounts/${account.id}/activate`, {
      method: "POST",
      body: "{}",
    });
    await refreshState();
    toast("success", "Conta ativa atualizada.");
  } catch (error) {
    toast("error", error.message);
  }
}

async function removeAccount(account) {
  const label = account.username ? `@${account.username}` : "esta conta";
  const confirmed = await confirmAction({
    title: "Remover conta",
    message: `A credencial de ${label} será apagada do proxy. Essa ação não pode ser desfeita.`,
    confirmLabel: "Remover",
  });
  if (!confirmed) return;
  try {
    await adminFetch(`/admin/api/accounts/${account.id}`, { method: "DELETE" });
    await refreshState();
    toast("success", "Conta removida.");
  } catch (error) {
    toast("error", error.message);
  }
}

async function importKey() {
  const apiKey = els.apiKeyInput.value.trim();
  if (!apiKey) {
    toast("error", "Cole uma API key para adicionar.");
    return;
  }
  els.importBtn.disabled = true;
  els.importBtn.textContent = "Validando…";
  try {
    const result = await adminFetch("/admin/api/accounts/import", {
      method: "POST",
      body: JSON.stringify({ apiKey }),
    });
    els.apiKeyInput.value = "";
    await refreshState();
    toast(
      "success",
      result.created
        ? "API key validada e conta adicionada."
        : "Essa conta já existia — credencial atualizada.",
    );
  } catch (error) {
    toast("error", error.message);
  } finally {
    els.importBtn.disabled = false;
    els.importBtn.textContent = "Adicionar";
  }
}

/* ---------- token / snippet ---------- */

async function rotateToken() {
  const confirmed = await confirmAction({
    title: "Rotacionar token do proxy",
    message:
      "O token atual deixa de funcionar imediatamente. Atualize seus clientes com o novo token.",
    confirmLabel: "Rotacionar",
  });
  if (!confirmed) return;
  try {
    const data = await adminFetch("/admin/api/proxy-token/rotate", {
      method: "POST",
      body: "{}",
    });
    state.proxyToken = data.proxyToken;
    els.proxyToken.value = data.proxyToken;
    toast("success", "Token do proxy rotacionado.");
  } catch (error) {
    toast("error", error.message);
  }
}

function buildSnippet(baseUrl) {
  return `curl ${baseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer $DEEPAI_PROXY_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "deepai/glm-5.3-flash",
    "messages": [{ "role": "user", "content": "Olá!" }]
  }'`;
}

/* ---------- utilidades ---------- */

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(new Date(value));
  } catch {
    return "—";
  }
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function clearLoginTimers() {
  clearInterval(state.pollTimer);
  clearInterval(state.countdownTimer);
  state.pollTimer = null;
  state.countdownTimer = null;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}

async function copyFromInput(input, button) {
  if (!input.value) return;
  const ok = await copyText(input.value);
  if (!ok) {
    toast("error", "Não foi possível copiar.");
    return;
  }
  markCopied(button);
  toast("success", "Copiado para a área de transferência.");
}

function markCopied(button) {
  if (!button) return;
  const label = button.querySelector("span");
  button.classList.add("copied");
  if (label) {
    const previous = label.textContent;
    label.textContent = "Copiado";
    setTimeout(() => {
      label.textContent = previous;
      button.classList.remove("copied");
    }, 1600);
  } else {
    setTimeout(() => button.classList.remove("copied"), 1600);
  }
}

function toast(type, message) {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.textContent = type === "error" ? "!" : "✓";
  const text = document.createElement("div");
  text.textContent = message;
  node.append(icon, text);
  els.toasts.append(node);

  const remove = () => {
    node.classList.add("leaving");
    setTimeout(() => node.remove(), 260);
  };
  const timer = setTimeout(remove, type === "error" ? 6500 : 4200);
  node.addEventListener("click", () => {
    clearTimeout(timer);
    remove();
  });
}

function confirmAction({ title, message, confirmLabel = "Confirmar" }) {
  return new Promise((resolve) => {
    els.confirmTitle.textContent = title;
    els.confirmMessage.textContent = message;
    els.confirmOk.textContent = confirmLabel;

    const finish = (value) => {
      els.confirmOk.removeEventListener("click", ok);
      els.confirmCancel.removeEventListener("click", cancel);
      els.confirmDialog.removeEventListener("close", closed);
      if (els.confirmDialog.open) els.confirmDialog.close();
      resolve(value);
    };
    const ok = () => finish(true);
    const cancel = () => finish(false);
    const closed = () => finish(false);

    els.confirmOk.addEventListener("click", ok);
    els.confirmCancel.addEventListener("click", cancel);
    els.confirmDialog.addEventListener("close", closed);
    els.confirmDialog.showModal();
  });
}

/* ---------- eventos ---------- */

function bindEvents() {
  els.gateForm.addEventListener("submit", submitGate);
  els.lockBtn.addEventListener("click", lock);
  els.startBtn.addEventListener("click", startLogin);

  for (const button of els.tabs) {
    button.addEventListener("click", () => applyTab(button.dataset.tab));
  }
  window.addEventListener("hashchange", () => {
    if (state.sessionToken) applyTab(location.hash.replace(/^#/, ""));
  });

  els.generatePassword.addEventListener("click", useGeneratedPassword);
  els.copyGenerated.addEventListener("click", copyGeneratedPassword);

  $$(".password-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.target);
      if (!input) return;
      input.type = input.type === "password" ? "text" : "password";
      syncPasswordToggles();
    });
  });

  els.setupPassword.addEventListener("input", () => {
    renderStrength(els.setupPassword.value);
    els.gateError.textContent = "";
  });
  els.setupConfirm.addEventListener("input", () => {
    els.gateError.textContent = "";
  });
  els.loginPassword.addEventListener("input", () => {
    els.gateError.textContent = "";
  });

  els.restartBtn.addEventListener("click", async () => {
    if (state.login && state.login.settled) {
      resetLoginUi();
    } else {
      await cancelLogin();
    }
  });

  els.copyLinkBtn.addEventListener("click", () =>
    copyFromInput(els.loginUrl, els.copyLinkBtn),
  );

  els.completeBtn.addEventListener("click", completeManually);
  els.callbackInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      completeManually();
    }
  });

  els.importBtn.addEventListener("click", importKey);
  els.apiKeyInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      importKey();
    }
  });

  $$(".copy-btn[data-copy-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.copyTarget);
      copyFromInput(input, button);
    });
  });

  els.copySnippet.addEventListener("click", async () => {
    const ok = await copyText(els.snippet.textContent);
    if (ok) {
      markCopied(els.copySnippet);
      toast("success", "Exemplo copiado.");
    } else {
      toast("error", "Não foi possível copiar.");
    }
  });

  els.revealBtn.addEventListener("click", () => {
    const showing = els.proxyToken.type === "text";
    els.proxyToken.type = showing ? "password" : "text";
    els.revealBtn.title = showing ? "Mostrar token" : "Ocultar token";
    els.revealBtn.setAttribute(
      "aria-label",
      showing ? "Mostrar token" : "Ocultar token",
    );
  });

  els.rotateBtn.addEventListener("click", rotateToken);

  if (els.refreshModels) {
    els.refreshModels.addEventListener("click", () =>
      loadModels({ force: true, quiet: false }),
    );
  }
  for (const chip of els.modelFilters) {
    chip.addEventListener("click", () => {
      state.models.filter = chip.dataset.filter || "all";
      renderModels();
    });
  }
  if (els.modelSearch) {
    els.modelSearch.addEventListener("input", () => {
      state.models.search = els.modelSearch.value;
      renderModels();
    });
  }
  if (els.modelProvider) {
    els.modelProvider.addEventListener("change", () => {
      state.models.provider = els.modelProvider.value || "all";
      renderModels();
    });
  }
  if (els.modelSort) {
    els.modelSort.addEventListener("change", () => {
      state.models.sort = els.modelSort.value || "default";
      renderModels();
    });
  }
  if (els.copyClientSnippet) {
    els.copyClientSnippet.addEventListener("click", async () => {
      const ok = await copyText(els.clientSnippet.textContent);
      if (ok) {
        markCopied(els.copyClientSnippet);
        toast("success", "Configuração copiada.");
      } else {
        toast("error", "Não foi possível copiar.");
      }
    });
  }

  els.refreshTelemetry.addEventListener("click", async () => {
    const previous = els.refreshTelemetry.textContent;
    els.refreshTelemetry.disabled = true;
    els.refreshTelemetry.textContent = "Atualizando…";
    try {
      await refreshTelemetry({ quiet: false });
      toast("success", "Telemetria atualizada.");
    } finally {
      els.refreshTelemetry.disabled = false;
      els.refreshTelemetry.textContent = previous;
    }
  });

  els.clearTelemetry.addEventListener("click", async () => {
    const confirmed = await confirmAction({
      title: "Limpar telemetria",
      message:
        "O histórico de requisições e os totais locais serão apagados. Contas e credenciais não são afetadas.",
      confirmLabel: "Limpar",
    });
    if (!confirmed) return;
    try {
      await adminFetch("/admin/api/telemetry/clear", {
        method: "POST",
        body: "{}",
      });
      await refreshTelemetry({ quiet: false });
      toast("success", "Histórico de telemetria limpo.");
    } catch (error) {
      toast("error", error.message);
    }
  });

  if (els.clearConversations) {
    els.clearConversations.addEventListener("click", async () => {
      const confirmed = await confirmAction({
        title: "Limpar conversas",
        message:
          "As sessões e o histórico criptografado usados para continuidade e cache serão apagados. Contas, token e telemetria não são afetados.",
        confirmLabel: "Limpar conversas",
      });
      if (!confirmed) return;
      try {
        const next = await adminFetch("/admin/api/conversations/clear", {
          method: "POST",
          body: "{}",
        });
        state.conversations = normalizeConversations(next);
        renderConversations();
        toast("success", "Conversas apagadas.");
      } catch (error) {
        toast("error", error.message);
      }
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (
      document.visibilityState === "visible" &&
      state.sessionToken &&
      state.activeTab === "panel"
    ) {
      refreshTelemetry();
    }
  });
}

init();
