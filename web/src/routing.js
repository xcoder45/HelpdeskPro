import { useEffect, useState } from 'react';

const STAFF_VIEWS = {
  '/staff': 'queue',
  '/staff/sla': 'sla',
  '/staff/analytics': 'analytics',
  '/staff/users': 'users',
  '/staff/categories': 'categories',
  '/staff/audit': 'audit'
};

export const EMPLOYEE_PATHS = {
  dashboard: '/',
  new: '/tickets/new',
  detail: (id) => `/tickets/${id}`
};

export const STAFF_PATHS = {
  queue: '/staff',
  sla: '/staff/sla',
  analytics: '/staff/analytics',
  users: '/staff/users',
  categories: '/staff/categories',
  audit: '/staff/audit',
  detail: (id) => `/staff/tickets/${id}`
};

export const AUTH_PATHS = {
  login: '/login',
  register: '/register',
  reset: '/reset-password',
  verify: '/verify-email',
  unavailable: '/unavailable'
};

export function parseRoute(pathname = window.location.pathname) {
  const normalised = pathname.replace(/\/+$/, '') || '/';
  if (normalised in STAFF_VIEWS) return { area: 'staff', view: STAFF_VIEWS[normalised] };

  const staffDetail = /^\/staff\/tickets\/(\d+)$/.exec(normalised);
  if (staffDetail) return { area: 'staff', view: 'detail', ticketId: Number(staffDetail[1]) };
  if (normalised.startsWith('/staff')) return { area: 'staff', view: 'queue' };

  if (normalised === '/tickets/new') return { area: 'employee', view: 'new' };
  const employeeDetail = /^\/tickets\/(\d+)$/.exec(normalised);
  if (employeeDetail) return { area: 'employee', view: 'detail', ticketId: Number(employeeDetail[1]) };
  if (normalised === AUTH_PATHS.register) return { area: 'auth', view: 'register' };
  if (normalised === AUTH_PATHS.reset) return { area: 'auth', view: 'reset' };
  if (normalised === AUTH_PATHS.verify) return { area: 'auth', view: 'verify' };
  if (normalised === AUTH_PATHS.unavailable) return { area: 'auth', view: 'unavailable' };
  if (normalised === AUTH_PATHS.login) return { area: 'auth', view: 'login' };
  return { area: 'employee', view: 'dashboard' };
}

export function navigateTo(path, { replace = false } = {}) {
  if (window.location.pathname + window.location.search === path) return;
  if (replace) window.history.replaceState({}, '', path);
  else window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
}

export function useRoute() {
  const [location, setLocation] = useState(() => ({
    pathname: window.location.pathname,
    search: window.location.search
  }));

  useEffect(() => {
    const handlePopState = () => setLocation({
      pathname: window.location.pathname,
      search: window.location.search
    });
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  return {
    pathname: location.pathname,
    search: location.search,
    route: parseRoute(location.pathname)
  };
}

export function tokenFromSearch(search = window.location.search) {
  return new URLSearchParams(search).get('token') ?? '';
}
