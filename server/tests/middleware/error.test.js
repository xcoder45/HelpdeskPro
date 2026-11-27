import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../../src/middleware/error.js';

function responseMock() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis()
  };
}

describe('error handler database mappings', () => {
  it.each(['22007', '22008'])('maps invalid database date code %s to a client error', (code) => {
    const response = responseMock();
    const error = Object.assign(new Error('date/time field value out of range'), { code });

    errorHandler(error, {}, response, vi.fn());

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'A request parameter has an invalid format'
      }
    });
  });

  it.each([
    ['23505', 409, 'DUPLICATE_VALUE'],
    ['23503', 409, 'INVALID_REFERENCE'],
    ['23514', 422, 'INVALID_VALUE'],
    ['22P02', 400, 'INVALID_INPUT']
  ])('maps database code %s to %s %s without leaking details', (code, status, errorCode) => {
    const response = responseMock();
    const error = Object.assign(new Error('secret sql statement'), { code });

    errorHandler(error, {}, response, vi.fn());

    expect(response.status).toHaveBeenCalledWith(status);
    const body = response.json.mock.calls[0][0];
    expect(body.error.code).toBe(errorCode);
    expect(JSON.stringify(body)).not.toContain('secret sql statement');
  });

  it('maps an oversized upload to 413', () => {
    const response = responseMock();
    const error = Object.assign(new Error('upload too big'), {
      name: 'MulterError',
      code: 'LIMIT_FILE_SIZE'
    });

    errorHandler(error, {}, response, vi.fn());

    expect(response.status).toHaveBeenCalledWith(413);
    expect(response.json.mock.calls[0][0].error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('returns a generic 500 for unexpected errors', () => {
    const response = responseMock();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    errorHandler(new Error('connection string with password'), {}, response, vi.fn());

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json.mock.calls[0][0]).toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' }
    });
    consoleSpy.mockRestore();
  });
});
