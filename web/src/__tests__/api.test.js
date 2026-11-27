import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiRequest,
  clearCsrfToken,
  downloadRequest,
  filenameFromDisposition,
  uploadRequest
} from '../api.js';

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

function clearCsrfCookie() {
  document.cookie = 'csrf_token=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  clearCsrfCookie();
  clearCsrfToken();
});

describe('web API client', () => {
  it('sends the readable CSRF cookie on state-changing requests', async () => {
    document.cookie = 'csrf_token=cookie-token; path=/';
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { ok: true } }));
    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/tickets', { method: 'POST', body: { title: 'Example' } });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tickets',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'x-csrf-token': 'cookie-token'
        }),
        credentials: 'same-origin',
        body: JSON.stringify({ title: 'Example' })
      })
    );
  });

  it('includes validation details in error messages', async () => {
    document.cookie = 'csrf_token=cookie-token; path=/';
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: [{ path: 'password', message: 'must include an uppercase letter' }]
      }
    }, 400));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiRequest('/auth/register', { method: 'POST', body: {} }))
      .rejects.toThrow('Validation failed: password: must include an uppercase letter');
  });

  it('explains gateway failures when the backend proxy is unavailable', async () => {
    document.cookie = 'csrf_token=cookie-token; path=/';
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(null, 502));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiRequest('/auth/register', { method: 'POST', body: {} }))
      .rejects.toThrow(/service is unavailable.*backend is running/i);
  });

  it('adopts the rotated CSRF token returned by login', async () => {
    document.cookie = 'csrf_token=old-token; path=/';
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({ success: true, data: { user: { id: 1 }, csrfToken: 'new-token' } })
    );
    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/auth/login', { method: 'POST', body: {} });
    document.cookie = 'csrf_token=new-token; path=/';

    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { ok: true } }));
    await apiRequest('/tickets', { method: 'POST', body: {} });

    expect(fetchMock.mock.calls[1][1].headers['x-csrf-token']).toBe('new-token');
  });

  it('refreshes the CSRF token once and retries a CSRF rejection', async () => {
    document.cookie = 'csrf_token=stale-token; path=/';
    const fetchMock = vi.fn(async (url, options) => {
      if (url === '/api/auth/csrf') {
        document.cookie = 'csrf_token=fresh-token; path=/';
        return jsonResponse({ success: true, data: { csrfToken: 'fresh-token' } });
      }
      if (options.headers['x-csrf-token'] === 'stale-token') {
        return jsonResponse(
          { success: false, error: { code: 'FORBIDDEN', message: 'Missing or invalid CSRF token' } },
          403
        );
      }
      return jsonResponse({ success: true, data: { ok: true } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/tickets', { method: 'POST', body: {} });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][1].headers['x-csrf-token']).toBe('fresh-token');
  });

  it('rejects a successful response that is not a valid API envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); }
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiRequest('/health')).rejects.toThrow(/unexpected response/i);
  });

  it('maps network failures to a friendly error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(apiRequest('/tickets/summary')).rejects.toThrow(/cannot reach the service/i);
  });

  it('uploads FormData without a JSON content type and with CSRF', async () => {
    document.cookie = 'csrf_token=cookie-token; path=/';
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ success: true, data: { attachment: { id: 7 } } }, 201)
    );
    vi.stubGlobal('fetch', fetchMock);
    const formData = new FormData();
    formData.append('file', new Blob(['hello']), 'notes.txt');

    const response = await uploadRequest('/tickets/42/attachments', formData);

    expect(response.data.attachment).toEqual({ id: 7 });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tickets/42/attachments',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-csrf-token': 'cookie-token' }),
        credentials: 'same-origin',
        body: formData
      })
    );
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Content-Type');
  });

  it('downloads binary data and derives the filename from Content-Disposition', async () => {
    const blob = new Blob(['report']);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => blob,
      headers: {
        get: (name) => (
          name.toLowerCase() === 'content-disposition'
            ? 'attachment; filename="quarterly-report.pdf"'
            : null
        )
      }
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await downloadRequest('/tickets/42/attachments/7/download', 'fallback.pdf');

    expect(result).toEqual({ blob, filename: 'quarterly-report.pdf' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tickets/42/attachments/7/download',
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' })
    );
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });

  it('falls back to the supplied filename when no disposition header is present', async () => {
    const blob = new Blob(['report']);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => blob,
      headers: { get: () => null }
    }));

    const result = await downloadRequest('/tickets/42/attachments/7/download', 'notes.txt');

    expect(result).toEqual({ blob, filename: 'notes.txt' });
  });

  it('strips traversal paths and control characters from download filenames', () => {
    expect(
      filenameFromDisposition('attachment; filename="../../etc/passwd.txt"', 'fallback.txt')
    ).toBe('passwd.txt');
    expect(
      filenameFromDisposition('attachment; filename="..\\windows\\system32\\evil.txt"', 'fallback.txt')
    ).toBe('evil.txt');
    expect(
      filenameFromDisposition('attachment; filename="bad\u0000name.txt"', 'fallback.txt')
    ).toBe('badname.txt');
    expect(filenameFromDisposition('attachment; filename=""', 'fallback.txt')).toBe('fallback.txt');
  });

  it('uses the fallback when an RFC 5987 filename is malformed', () => {
    expect(
      filenameFromDisposition("attachment; filename*=UTF-8''%E0%A4%A", 'fallback.txt')
    ).toBe('fallback.txt');
  });
});
