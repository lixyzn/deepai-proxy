import { createHash, randomBytes } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEEPAI_ORIGIN = process.env.DEEPAI_ORIGIN || "https://api.deepai.org";
export const DEEPAI_MODEL_BASE = `${DEEPAI_ORIGIN}/deepai_code`;
export const DESKTOP_AUTH_URL = `${DEEPAI_ORIGIN}/deepai_code/desktop_auth/`;

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_EXCHANGE_RETRIES = 2;
const INSTANCE_ID = randomBytes(16).toString("hex");

let cachedMachineHash = null;

export function getMachineHash() {
  if (cachedMachineHash) return cachedMachineHash;
  let seed = "";
  if (process.platform === "win32") {
    // Prefer the SMBIOS UUID, which is what the official desktop client hashes.
    try {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "(Get-CimInstance Win32_ComputerSystemProduct).UUID",
        ],
        { encoding: "utf8", timeout: 5000, windowsHide: true },
      );
      const uuid = String(out || "").trim();
      if (uuid && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(uuid) && !/^ffffffff/i.test(uuid)) {
        seed = uuid;
      }
    } catch {
      // fall back below
    }
    if (!seed) {
      try {
        const out = execFileSync(
          "reg",
          ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
          { encoding: "utf8", timeout: 2000, windowsHide: true },
        );
        const match = /MachineGuid\s+REG_SZ\s+([^\r\n]+)/i.exec(out);
        if (match?.[1]) seed = match[1].trim();
      } catch {
        // fall back below
      }
    }
  }
  if (!seed) {
    seed = `${os.hostname()}:${os.platform()}:${os.arch()}:${os.userInfo().username}`;
  }
  cachedMachineHash = createHash("sha256").update(seed, "utf8").digest("hex");
  return cachedMachineHash;
}

export function buildDeepAIHeaders(account, extraHeaders = {}) {
  const apiKey =
    typeof account === "string"
      ? account.trim()
      : String(account?.apiKey || account?.tokens?.accessToken || "").trim();
  const cookie = typeof account === "object" && account?.cookie ? String(account.cookie).trim() : "";

  const headers = {
    "X-DeepAI-Code-Theos": "8",
    "X-DeepAI-Code-Instance": INSTANCE_ID,
    "X-DeepAI-Code-Machine": getMachineHash(),
    ...extraHeaders,
  };

  if (apiKey) {
    headers["api-key"] = apiKey;
  }
  if (cookie) {
    headers["Cookie"] = cookie;
  }

  return headers;
}

export class DeepAIError extends Error {
  constructor(message, status = 502, code = "deepai_error", details = null) {
    super(message);
    this.name = "DeepAIError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isRetryableError(err) {
  if (!err) return false;
  if (err instanceof DeepAIError) return err.status >= 500;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  const code = String(err.code || err.cause?.code || "").toUpperCase();
  return ["ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH"].includes(code);
}

function isWin() {
  return process.platform === "win32";
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function parsePsJson(stdout, label) {
  const text = String(stdout || "").trim().replace(/^\uFEFF/, "");
  if (!text) throw new Error(`${label} PowerShell response was empty`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} PowerShell response was not JSON: ${text.slice(0, 300)}`);
  }
}

async function requestViaPowerShell(url, { method = "GET", headers = {}, body = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const timeoutSec = Math.max(5, Math.ceil(timeoutMs / 1000));
  const headerEntries = Object.entries(headers)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `$headers[${psQuote(k)}] = ${psQuote(String(v))}`);

  const scriptParts = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$headers = @{}",
    ...headerEntries,
  ];

  let invokeCmd = `$resp = Invoke-WebRequest -UseBasicParsing -Uri ${psQuote(url)} -Method ${psQuote(method)} -Headers $headers -TimeoutSec ${timeoutSec}`;
  if (body !== null && body !== undefined) {
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    scriptParts.push(`$body = ${psQuote(bodyStr)}`);
    invokeCmd += " -ContentType 'application/json' -Body $body";
  }

  scriptParts.push(
    "try {",
    `  ${invokeCmd}`,
    "  $status = [int]$resp.StatusCode",
    "  $content = [string]$resp.Content",
    "} catch [System.Net.WebException] {",
    "  $errResp = $_.Exception.Response",
    "  if ($null -eq $errResp) { throw }",
    "  $status = [int]$errResp.StatusCode",
    "  $reader = New-Object System.IO.StreamReader($errResp.GetResponseStream())",
    "  $content = $reader.ReadToEnd()",
    "  $reader.Close()",
    "}",
    "$obj = [ordered]@{ status = $status; body = $content }",
    "[Console]::Out.Write(($obj | ConvertTo-Json -Compress -Depth 8))",
  );

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", scriptParts.join("; ")],
      { windowsHide: true, timeout: timeoutMs + 5000, maxBuffer: 2 * 1024 * 1024 },
    );
    const parsed = parsePsJson(stdout, `${method} ${url}`);
    const text = typeof parsed.body === "string" ? parsed.body : JSON.stringify(parsed.body ?? "");
    return { status: Number(parsed.status) || 0, text, headers: new Map() };
  } catch (err) {
    const detail = err.killed ? `timeout after ${timeoutMs}ms` : err.stderr || err.message || String(err);
    throw new Error(`PowerShell fetch failed: ${String(detail).slice(0, 400)}`);
  }
}

async function readBodyLimited(res) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        throw new DeepAIError(`Response too large from DeepAI (>${MAX_BODY_BYTES} bytes)`, 502, "response_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
  }
  text += decoder.decode();
  return text;
}

async function requestViaFetch(
  url,
  { method = "GET", headers = {}, body = null, signal = null, timeoutMs = REQUEST_TIMEOUT_MS, fetchImpl = fetch } = {},
) {
  const deadline = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  const reqHeaders = { ...headers };
  let reqBody = undefined;
  if (body !== null && body !== undefined) {
    if (!reqHeaders["Content-Type"] && !reqHeaders["content-type"]) {
      reqHeaders["Content-Type"] = "application/json";
    }
    reqBody = typeof body === "string" ? body : JSON.stringify(body);
  }

  const res = await fetchImpl(url, {
    method,
    headers: reqHeaders,
    body: reqBody,
    signal: deadline,
    redirect: "error",
  });
  const text = await readBodyLimited(res);
  return { status: res.status, text, headers: res.headers };
}

async function requestJsonRaw(url, opts = {}) {
  const useFetchOnly = opts.fetchImpl && opts.fetchImpl !== fetch;
  const attempts = useFetchOnly
    ? [() => requestViaFetch(url, opts)]
    : isWin()
      ? [() => requestViaFetch(url, opts), () => requestViaPowerShell(url, opts)]
      : [() => requestViaFetch(url, opts)];

  let lastErr;
  for (let i = 0; i < attempts.length; i++) {
    try {
      return await attempts[i]();
    } catch (err) {
      lastErr = err;
      if (i < attempts.length - 1 && isRetryableError(err)) {
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export async function exchangeCode(codeOrOpts, maybeOpts = {}) {
  let code;
  let codeVerifier;
  let signal;
  let fetchImpl = fetch;

  if (codeOrOpts && typeof codeOrOpts === "object") {
    ({ code, codeVerifier, signal, fetchImpl = fetch } = codeOrOpts);
  } else {
    code = codeOrOpts;
    ({ codeVerifier, signal, fetchImpl = fetch } = maybeOpts || {});
  }

  if (typeof code !== "string" || !code.trim()) {
    throw new DeepAIError("Código de autorização ausente.", 400, "missing_code");
  }
  if (typeof codeVerifier !== "string" || !codeVerifier.trim()) {
    throw new DeepAIError("Verificador de login ausente. Gere um novo link de login.", 400, "missing_code_verifier");
  }

  const url = `${DEEPAI_ORIGIN}/deepai_code/desktop_auth/exchange/`;
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_EXCHANGE_RETRIES; attempt++) {
    try {
      const { status, text } = await requestJsonRaw(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { code: code.trim(), code_verifier: codeVerifier.trim() },
        signal,
        fetchImpl,
      });

      if (status === 400 || status === 401) {
        throw new DeepAIError(
          "Esse link de login expirou ou já foi usado. Gere um novo link.",
          401,
          "invalid_exchange_code",
        );
      }
      if (status === 429) {
        throw new DeepAIError(
          "O DeepAI está limitando logins agora. Aguarde alguns segundos e tente de novo.",
          429,
          "rate_limited",
        );
      }
      if (status >= 500) {
        throw new DeepAIError(
          "O DeepAI não conseguiu concluir o login agora. Tente de novo em instantes.",
          502,
          "exchange_server_error",
          { upstreamStatus: status },
        );
      }
      if (status < 200 || status >= 300) {
        throw new DeepAIError(
          "O DeepAI não concluiu o login. Gere um novo link e tente de novo.",
          401,
          "exchange_failed",
          { upstreamStatus: status },
        );
      }

      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        throw new DeepAIError(
          "DeepAI returned an invalid sign-in response. Please start sign-in again.",
          502,
          "invalid_exchange_response",
        );
      }

      const apiKey =
        (typeof data?.api_key === "string" && data.api_key.trim()) ||
        (typeof data?.apiKey === "string" && data.apiKey.trim()) ||
        (typeof data?.access_token === "string" && data.access_token.trim()) ||
        "";

      if (!apiKey) {
        throw new DeepAIError(
          "DeepAI returned an invalid sign-in response (missing api_key).",
          502,
          "missing_api_key",
          data,
        );
      }

      const username =
        (typeof data?.username === "string" && data.username.trim()) ||
        (typeof data?.user?.login === "string" && data.user.login.trim()) ||
        (typeof data?.user?.username === "string" && data.user.username.trim()) ||
        "";

      const isPro = Boolean(
        data?.is_pro === true ||
          data?.isPro === true ||
          data?.isProSubscription === true ||
          data?.user?.is_pro === true,
      );

      // connect_token is optional and only present for some accounts. Accept it
      // only when it matches the shape the desktop client expects.
      const rawConnectToken = typeof data?.connect_token === "string" ? data.connect_token.trim() : "";
      const connectToken = /^dc_[A-Za-z0-9_-]{43}$/.test(rawConnectToken) ? rawConnectToken : null;
      const connectExpiresAt =
        connectToken && typeof data?.connect_expires_at === "string" ? data.connect_expires_at : null;

      return {
        apiKey,
        accessToken: apiKey,
        refreshToken: typeof data?.refresh_token === "string" ? data.refresh_token : null,
        username: username || null,
        isPro,
        connectToken,
        connectExpiresAt,
        raw: data,
      };
    } catch (error) {
      lastError = error;
      const retryable =
        isRetryableError(error) || (error instanceof DeepAIError && error.code === "exchange_server_error");
      if (!retryable || attempt >= MAX_EXCHANGE_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }

  throw lastError;
}

export async function verifyAccount(account, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const apiKey = account?.apiKey || account?.tokens?.accessToken || "";
  const cookie = account?.cookie || "";
  if (!apiKey && !cookie) {
    return {
      ok: false,
      valid: false,
      isAuthenticated: false,
      isPro: false,
      status: 400,
      error: "Conta não possui API key ou cookie configurado.",
    };
  }

  const headers = buildDeepAIHeaders(account);
  try {
    const { status, text } = await requestJsonRaw(`${DEEPAI_ORIGIN}/get_usage_summary`, {
      method: "GET",
      headers,
      timeoutMs,
      fetchImpl,
    });

    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (status === 401 || status === 403 || data?.is_authenticated === false) {
      return {
        ok: false,
        valid: false,
        isAuthenticated: false,
        isPro: false,
        status,
        error: data?.error || "Chave ou sessão inválida/expirada.",
      };
    }

    if (status >= 200 && status < 300) {
      let theos = null;
      try {
        const theosRes = await requestJsonRaw(`${DEEPAI_MODEL_BASE}/theos`, {
          method: "GET",
          headers,
          timeoutMs,
          fetchImpl,
        });
        if (theosRes.status >= 200 && theosRes.status < 300 && theosRes.text) {
          theos = JSON.parse(theosRes.text);
        }
      } catch {
        // optional enrichment
      }

      return {
        ok: true,
        valid: true,
        isAuthenticated: Boolean(data?.is_authenticated ?? true),
        isPro: Boolean(data?.is_pro),
        status,
        theos,
        error: null,
      };
    }

    return {
      ok: false,
      valid: false,
      isAuthenticated: false,
      isPro: false,
      status,
      error: data?.error || data?.detail || `Falha ao verificar conta (HTTP ${status})`,
    };
  } catch (err) {
    return {
      ok: false,
      valid: false,
      isAuthenticated: false,
      isPro: false,
      status: 502,
      error: err?.message || "Erro de conexão ao verificar conta DeepAI",
    };
  }
}
