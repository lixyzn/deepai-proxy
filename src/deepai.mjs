import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PRODUCTION_ORIGIN = "https://api.deepai.org";

function resolveDeepAIOrigin() {
  if (process.env.DEEPAI_PROXY_LOCAL_TEST !== "true") return PRODUCTION_ORIGIN;
  const origin = process.env.DEEPAI_PROXY_DEV_API_ORIGIN?.trim() ?? "";
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin)) {
    throw new Error(
      "DEEPAI_PROXY_LOCAL_TEST=true exige DEEPAI_PROXY_DEV_API_ORIGIN=http://127.0.0.1:<porta>.",
    );
  }
  const url = new URL(origin);
  if (url.origin !== origin || Number(url.port) > 65535) {
    throw new Error("A origem local de teste da DeepAI é inválida.");
  }
  return origin;
}

export const DEEPAI_ORIGIN = resolveDeepAIOrigin();
export const DEEPAI_MODEL_BASE = `${DEEPAI_ORIGIN}/deepai_code`;
const LANE_VERSION = "7";
const INSTANCE_ID = randomBytes(16).toString("hex");
const MACHINE_HEADER = "X-DeepAI-Code-Machine";
const CHECK_IN_HEADER = "X-DeepAI-Code-Check-In";
const BEACON_HEADER = "X-DeepAI-Code-Beacon";
const UUID =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SMBIOS_PLACEHOLDERS = new Set([
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "03000200-0400-0500-0006-000700080009",
]);

export class DeepAIError extends Error {
  constructor(message, status = 502, body = undefined) {
    super(message);
    this.name = "DeepAIError";
    this.status = status;
    this.body = body;
  }
}

function parseUuid(output) {
  const uuid = UUID.exec(String(output))?.[0]?.toLowerCase();
  return uuid && !SMBIOS_PLACEHOLDERS.has(uuid) ? uuid : null;
}

async function run(file, args, timeout = 8000) {
  try {
    const { stdout } = await execFileAsync(file, args, {
      encoding: "utf8",
      timeout,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return "";
  }
}

async function detectMachineId() {
  if (process.platform === "win32") {
    const smbios = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-CimInstance Win32_ComputerSystemProduct).UUID",
    ]);
    const fromSmbios = parseUuid(smbios);
    if (fromSmbios) return fromSmbios;

    const registry = await run("reg", [
      "query",
      "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
      "/v",
      "MachineGuid",
    ]);
    const fromRegistry = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(registry)?.[1];
    if (fromRegistry && UUID.test(fromRegistry)) {
      return fromRegistry.toLowerCase();
    }
    return null;
  }

  if (process.platform === "darwin") {
    const output = await run("ioreg", [
      "-rd1",
      "-c",
      "IOPlatformExpertDevice",
    ]);
    return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(output)?.[1]?.toLowerCase() ?? null;
  }

  for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    const value = await readFile(file, "utf8").catch(() => "");
    const id = value.trim().toLowerCase();
    if (/^[0-9a-f]{32}$/.test(id) && !/^0+$/.test(id)) return id;
  }
  return null;
}

let machinePromise;

export function machineHash() {
  machinePromise ??= detectMachineId().then((raw) =>
    raw ? createHash("sha256").update(raw).digest("hex") : null,
  );
  return machinePromise;
}

export async function deepAIHeaders(apiKey, extra = {}) {
  const machine = await machineHash();
  return {
    "Content-Type": "application/json",
    "X-DeepAI-Code-Theos": LANE_VERSION,
    "X-DeepAI-Code-Instance": INSTANCE_ID,
    ...(machine ? { [MACHINE_HEADER]: machine } : {}),
    ...(apiKey ? { "Api-Key": apiKey } : {}),
    ...extra,
  };
}

function errorMessageFromBody(body, fallback) {
  if (body && typeof body === "object") {
    if (typeof body.error === "string") return body.error;
    if (body.error && typeof body.error.message === "string") {
      return body.error.message;
    }
    if (typeof body.message === "string") return body.message;
  }
  return fallback;
}

export async function exchangeCode(code, { signal } = {}) {
  const response = await fetch(`${DEEPAI_MODEL_BASE}/desktop_auth/exchange/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
    redirect: "error",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
      : AbortSignal.timeout(20000),
  }).catch((error) => {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new DeepAIError(
        "A DeepAI não respondeu a tempo. Tente gerar um novo link.",
        504,
      );
    }
    throw new DeepAIError(
      "Não foi possível falar com a DeepAI. Verifique a conexão e tente novamente.",
      502,
    );
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      response.status === 400 || response.status === 401
        ? "Este código de login expirou ou já foi usado. Gere um novo link."
        : response.status === 429
          ? "Muitas tentativas de login. Aguarde um pouco e tente de novo."
          : errorMessageFromBody(
              body,
              "A DeepAI não concluiu o login agora. Tente novamente.",
            );
    throw new DeepAIError(message, response.status, body);
  }

  const apiKey = body?.api_key;
  if (typeof apiKey !== "string" || !apiKey || /[\r\n]/.test(apiKey)) {
    throw new DeepAIError(
      "A DeepAI devolveu uma resposta de login inválida. Tente novamente.",
      502,
      body,
    );
  }

  return {
    apiKey,
    username: typeof body.username === "string" ? body.username : "",
    isPro: body.is_pro === true,
  };
}

async function requestJson(pathname, apiKey, { signal, method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${DEEPAI_MODEL_BASE}${pathname}`, {
    method,
    headers: await deepAIHeaders(apiKey, headers),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal,
  }).catch((error) => {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") throw error;
    throw new DeepAIError(
      "Falha de conexão com a DeepAI. Verifique a rede do proxy.",
      502,
    );
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new DeepAIError(
      errorMessageFromBody(payload, `A DeepAI recusou a requisição (${response.status}).`),
      response.status,
      payload,
    );
  }
  return payload;
}

export function fetchModels(apiKey, { signal } = {}) {
  return requestJson("/models", apiKey, { signal });
}

/**
 * Plano/entitlement da conta. Fica na raiz da API, não em /deepai_code.
 * Não confundir com o saldo de Theos (/theos).
 */
export async function fetchUsageSummary(apiKey, { signal } = {}) {
  const response = await fetch(`${DEEPAI_ORIGIN}/get_usage_summary`, {
    method: "GET",
    headers: await deepAIHeaders(apiKey),
    redirect: "error",
    signal,
  }).catch((error) => {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") throw error;
    throw new DeepAIError(
      "Falha de conexão com a DeepAI ao ler o plano da conta.",
      502,
    );
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new DeepAIError(
      errorMessageFromBody(payload, `A DeepAI recusou a leitura do plano (${response.status}).`),
      response.status,
      payload,
    );
  }
  return payload;
}

function summaryNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    return Number(value);
  }
  return null;
}

export function normalizeUsageSummary(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.is_authenticated !== true) return null;
  if (typeof payload.is_pro !== "boolean") return null;
  const credits = summaryNumber(payload.credits_remaining);
  const overage = summaryNumber(payload.total_overage_cost);
  return {
    authenticated: true,
    isPro: payload.is_pro,
    ...(typeof payload.plan === "string" && payload.plan.trim()
      ? { plan: payload.plan.trim().slice(0, 40) }
      : {}),
    ...(credits === null ? {} : { creditsRemaining: credits }),
    ...(overage === null ? {} : { overageCost: overage }),
    ...(typeof payload.has_overages === "boolean"
      ? { hasOverages: payload.has_overages }
      : {}),
    ...(typeof payload.period_description === "string" &&
    payload.period_description.trim()
      ? { periodDescription: payload.period_description.trim().slice(0, 160) }
      : {}),
    checkedAt: new Date().toISOString(),
  };
}

function allowanceAmount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    return value.trim();
  }
  return undefined;
}

export function normalizeAllowance(payload) {
  if (!payload || typeof payload !== "object" || typeof payload.enabled !== "boolean") {
    return null;
  }
  const balance = allowanceAmount(payload.balance);
  const granted = allowanceAmount(payload.granted);
  if (!payload.enabled && balance === undefined) return null;
  return {
    enabled: payload.enabled,
    ...(balance === undefined ? {} : { balance }),
    ...(granted === undefined ? {} : { granted }),
    ...(typeof payload.refresh_at === "string"
      ? { refreshAt: payload.refresh_at }
      : {}),
    checkedAt: new Date().toISOString(),
  };
}

const checkInNonces = new Map();

export async function checkIn(apiKey, accountKeyHash, { signal } = {}) {
  const beacon = `v=0.3.0;up=${Math.floor(process.uptime())}`;
  const nonce = checkInNonces.get(accountKeyHash);
  const payload = await requestJson("/theos", apiKey, {
    signal,
    headers: {
      [BEACON_HEADER]: beacon,
      ...(nonce ? { [CHECK_IN_HEADER]: nonce } : {}),
    },
  });
  const next = payload?.check_in;
  if (
    next &&
    typeof next.nonce === "string" &&
    /^[0-9a-f]{32}$/.test(next.nonce) &&
    typeof next.seconds === "number" &&
    next.seconds > 0
  ) {
    checkInNonces.set(accountKeyHash, next.nonce);
  }
  return payload;
}

/**
 * Transcrição de áudio. O app oficial usa multipart com o campo
 * `voiceRecording` e aceita webm/opus ou mp4; a resposta é { text }.
 */
export async function transcribeAudio(
  apiKey,
  { data, mimeType = "audio/webm", filename = "rec.webm", signal } = {},
) {
  if (!data || data.length === 0) {
    throw new DeepAIError("Áudio vazio.", 400);
  }
  if (data.length > 8 * 1024 * 1024) {
    throw new DeepAIError("Áudio grande demais (máximo 8 MB).", 413);
  }
  if (!/^(audio\/webm(?:;codecs=opus)?|audio\/mp4)$/.test(mimeType)) {
    throw new DeepAIError(
      "Formato de áudio não suportado. Use webm/opus ou mp4.",
      415,
    );
  }
  const form = new FormData();
  form.append("voiceRecording", new Blob([data], { type: mimeType }), filename);
  const response = await fetch(`${DEEPAI_ORIGIN}/speech_to_text`, {
    method: "POST",
    headers: { "api-key": apiKey },
    body: form,
    redirect: "error",
    signal,
  }).catch((error) => {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") throw error;
    throw new DeepAIError("Falha de conexão com a DeepAI ao transcrever.", 502);
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // resposta não JSON
    }
    throw new DeepAIError(
      errorMessageFromBody(body, `A DeepAI recusou a transcrição (${response.status}).`),
      response.status,
      body,
    );
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new DeepAIError("A DeepAI devolveu uma transcrição inválida.", 502);
  }
  if (!payload || typeof payload.text !== "string" || !payload.text.trim()) {
    throw new DeepAIError("A DeepAI não devolveu texto na transcrição.", 502);
  }
  return payload.text.trim();
}

export async function forwardModelRequest(pathname, apiKey, init = {}) {
  const headers = await deepAIHeaders(apiKey, init.headers ?? {});
  return fetch(`${DEEPAI_MODEL_BASE}${pathname}`, {
    ...init,
    headers,
    redirect: "error",
  });
}
