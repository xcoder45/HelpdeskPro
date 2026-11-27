import { env } from '../config/env.js';
import { sendError } from '../utils/apiResponse.js';

export function notFound(_req, res) {
  // Do not echo the request URL: query strings can contain tokens or personal data.
  return sendError(res, 404, 'NOT_FOUND', 'Endpoint not found');
}

function mapDatabaseError(error) {
  switch (error.code) {
    case '23505':
      return { status: 409, code: 'DUPLICATE_VALUE', message: 'A record with these details already exists' };
    case '23503':
      return { status: 409, code: 'INVALID_REFERENCE', message: 'A referenced record does not exist' };
    case '23514':
      return { status: 422, code: 'INVALID_VALUE', message: 'A value violates a database constraint' };
    case '22P02':
    case '22007':
    case '22008':
      return { status: 400, code: 'INVALID_INPUT', message: 'A request parameter has an invalid format' };
    default:
      return null;
  }
}

export function errorHandler(error, req, res, _next) {
  if (error.type === 'entity.parse.failed') {
    return sendError(res, 400, 'INVALID_JSON', 'Request body is not valid JSON');
  }

  if (error.type === 'entity.too.large') {
    return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  }

  if (error.status && error.code && error.name === 'AppError') {
    return sendError(res, error.status, error.code, error.message, error.details);
  }

  if (error.name === 'MulterError') {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'The attached file is too large');
    }
    return sendError(res, 400, 'INVALID_UPLOAD', 'The file upload could not be processed');
  }

  const databaseError = mapDatabaseError(error);
  if (databaseError) {
    return sendError(res, databaseError.status, databaseError.code, databaseError.message);
  }

  if (env.NODE_ENV !== 'production') {
    console.error('[error]', error);
  } else {
    console.error('[error]', { message: error.message, code: error.code });
  }

  return sendError(res, 500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}
