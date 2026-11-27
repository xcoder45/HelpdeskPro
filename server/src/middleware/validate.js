import { badRequest } from '../utils/errors.js';

function targetKey(source) {
  if (source === 'body') return 'body';
  return `validated${source.charAt(0).toUpperCase()}${source.slice(1)}`;
}

export function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const parsed = schema.safeParse(req[source]);
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || source,
        message: issue.message
      }));
      return next(badRequest('Validation failed', details));
    }

    req[targetKey(source)] = parsed.data;
    return next();
  };
}
