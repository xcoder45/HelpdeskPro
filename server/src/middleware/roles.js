import { forbidden, unauthorized } from '../utils/errors.js';

export function requireRole(...allowedRoles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!allowedRoles.includes(req.user.role)) {
      return next(forbidden('Your role does not permit this action'));
    }
    return next();
  };
}
