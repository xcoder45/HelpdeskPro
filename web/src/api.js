const API_BASE = String(import.meta.env?.VITE_API_BASE_URL ?? '/api').replace(/\/$/, '');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_COOKIE = 'csrf_token';

let csrfToken = null;

export function setCsrfToken(token) {
  csrfToken = token || null;
}

export function clearCsrfToken() {
  csrfToken = null;
}

function readCsrfCookie() {
  if (typeof document === 'undefined') return null;
  const entry = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CSRF_COOKIE}=`));
  if (!entry) return null;
  const raw = entry.slice(CSRF_COOKIE.length + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function currentCsrfToken() {
  const cookieToken = readCsrfCookie();
  if (csrfToken && (!cookieToken || cookieToken === csrfToken)) return csrfToken;
  return cookieToken || csrfToken;
}

function buildUrl(path) {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE}${suffix}`;
}

function describeError(payload, response) {
  const gatewayFailure = response.status >= 502 && response.status <= 504;
  const fallbackMessage = gatewayFailure
    ? 'The service is unavailable. Make sure the backend is running, then try again.'
    : `Request failed (${response.status})`;
  const message = payload?.error?.message || fallbackMessage;
  const details = Array.isArray(payload?.error?.details) ? payload.error.details : [];
  if (details.length === 0) return new Error(message);

  const explanations = details.map((detail) => (
    detail?.path && detail.path !== 'body'
      ? `${detail.path}: ${detail.message}`
      : detail?.message
  )).filter(Boolean);
  return new Error(explanations.length > 0 ? `${message}: ${explanations.join('; ')}` : message);
}

async function performRequest(path, options = {}, retried = false) {
  const { method = 'GET', body, formData, binary = false } = options;
  const headers = {};
  const normalizedMethod = method.toUpperCase();
  const isSafe = SAFE_METHODS.has(normalizedMethod);

  // JSON headers/body stay exactly as they are for apiRequest callers.
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let activeCsrfToken = null;
  if (!isSafe) {
    activeCsrfToken = currentCsrfToken();
    if (!activeCsrfToken) {
      await fetchCsrfToken();
      activeCsrfToken = currentCsrfToken();
    }
    headers['x-csrf-token'] = activeCsrfToken;
  }

  let response;
  try {
    response = await fetch(buildUrl(path), {
      method: normalizedMethod,
      headers,
      credentials: 'same-origin',
      body: formData !== undefined
        ? formData
        : (body === undefined ? undefined : JSON.stringify(body))
    });
  } catch {
    throw new Error('Cannot reach the service. Please try again.');
  }

  if (binary) {
    let failure = null;
    if (!response.ok) {
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      failure = describeError(payload, response);
      failure.status = response.status;
      failure.code = payload?.error?.code;
    }

    if (failure) {
      // Another tab may have rotated the shared CSRF cookie. Refresh once and retry.
      if (!retried && !isSafe && response.status === 403 && /csrf/i.test(failure.message)) {
        await fetchCsrfToken();
        return performRequest(path, options, true);
      }
      throw failure;
    }

    return { response, blob: await response.blob() };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (payload?.data?.csrfToken) setCsrfToken(payload.data.csrfToken);

  if (!response.ok) {
    const error = describeError(payload, response);
    error.status = response.status;
    error.code = payload?.error?.code;

    // Another tab may have rotated the shared CSRF cookie. Refresh once and retry.
    if (!retried && !isSafe && response.status === 403 && /csrf/i.test(error.message)) {
      await fetchCsrfToken();
      return performRequest(path, options, true);
    }

    throw error;
  }

  if (!payload || payload.success !== true || !('data' in payload)) {
    throw new Error('The service returned an unexpected response.');
  }

  return payload;
}

export function safeDownloadFilename(value, fallbackFilename = 'download') {
  const fallback = String(fallbackFilename || 'download');
  const basename = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .trim();
  return basename ? basename.slice(0, 255) : fallback;
}

export function filenameFromDisposition(header, fallbackFilename) {
  const fallback = safeDownloadFilename(fallbackFilename);
  if (!header) return fallback;

  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (encoded) {
    const raw = encoded[1].trim().replace(/^"|"$/g, '');
    try {
      return safeDownloadFilename(decodeURIComponent(raw), fallback);
    } catch {
      return fallback;
    }
  }

  const plain = /filename\s*=\s*("([^"]*)"|([^;]+))/i.exec(header);
  if (plain) {
    return safeDownloadFilename(plain[2] ?? plain[3] ?? '', fallback);
  }
  return fallback;
}

export async function fetchCsrfToken() {
  const payload = await apiRequest('/auth/csrf');
  const token = payload?.data?.csrfToken;
  if (!token) throw new Error('Could not establish a secure session. Please reload the page.');
  setCsrfToken(token);
  return token;
}

export async function apiRequest(path, options = {}) {
  return performRequest(path, options, false);
}

export async function uploadRequest(path, formData) {
  return performRequest(path, { method: 'POST', formData }, false);
}

export async function downloadRequest(path, fallbackFilename = 'download') {
  const { blob, response } = await performRequest(path, { method: 'GET', binary: true }, false);
  const disposition = response.headers?.get?.('content-disposition')
    ?? response.headers?.['content-disposition'];
  return { blob, filename: filenameFromDisposition(disposition, fallbackFilename) };
}
