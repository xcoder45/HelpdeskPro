import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App.jsx';
import AsyncBoundary from '../AsyncBoundary.jsx';
import AttachmentsPanel from '../AttachmentsPanel.jsx';
import SessionsPanel from '../SessionsPanel.jsx';
import StaffApp from '../StaffApp.jsx';
import * as api from '../api.js';
import { navigateTo, parseRoute, tokenFromSearch } from '../routing.js';

vi.mock('../api.js', () => ({
  apiRequest: vi.fn(),
  fetchCsrfToken: vi.fn(),
  setCsrfToken: vi.fn(),
  clearCsrfToken: vi.fn(),
  uploadRequest: vi.fn(),
  downloadRequest: vi.fn()
}));

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/');
  api.fetchCsrfToken.mockResolvedValue('csrf-token');
  api.apiRequest.mockImplementation(async (path, options = {}) => {
    if (path === '/auth/me') throw Object.assign(new Error('Authentication required'), { status: 401 });
    return { data: { accepted: true, reset: true, verified: true, revoked: 1 } };
  });
});

describe('deep-link routing', () => {
  it('recognises staff, employee and lifecycle paths', () => {
    expect(parseRoute('/staff/analytics')).toEqual({ area: 'staff', view: 'analytics' });
    expect(parseRoute('/staff/tickets/42')).toEqual({ area: 'staff', view: 'detail', ticketId: 42 });
    expect(parseRoute('/tickets/new')).toEqual({ area: 'employee', view: 'new' });
    expect(parseRoute('/tickets/42')).toEqual({ area: 'employee', view: 'detail', ticketId: 42 });
    expect(parseRoute('/reset-password')).toEqual({ area: 'auth', view: 'reset' });
    expect(parseRoute('/verify-email')).toEqual({ area: 'auth', view: 'verify' });
  });

  it('pushes browser history and extracts link tokens', () => {
    navigateTo('/reset-password?token=abc123');
    expect(window.location.pathname).toBe('/reset-password');
    expect(tokenFromSearch(window.location.search)).toBe('abc123');
  });
});

describe('authenticated navigation', () => {
  it('returns to the requested deep link after signing in', async () => {
    window.history.replaceState({}, '', '/staff/analytics');
    api.apiRequest.mockImplementation(async (path) => {
      if (path === '/auth/me') throw Object.assign(new Error('Authentication required'), { status: 401 });
      if (path === '/auth/login') {
        return { data: { user: { id: 10, firstName: 'Avery', lastName: 'Admin', role: 'admin' }, csrfToken: 'token' } };
      }
      if (path.startsWith('/dashboard/overview')) {
        return { data: { summary: {}, priority: [], category: [], weeklyTrends: [], agentWorkload: [] } };
      }
      return { data: {} };
    });
    render(<App />);

    fireEvent.change(await screen.findByLabelText('Work email'), {
      target: { value: 'admin@helpdesk.local' }
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'ChangeMe123!' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(window.location.pathname).toBe('/staff/analytics');
    });
    expect(await screen.findByRole('button', { name: 'Analytics' })).toBeInTheDocument();
  });
});

describe('password reset and verification pages', () => {
  it('requests a reset link for an email address', async () => {
    window.history.replaceState({}, '', '/reset-password');
    render(<App />);

    fireEvent.change(await screen.findByLabelText('Work email'), {
      target: { value: 'employee@helpdesk.local' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/auth/password-reset/request', {
        method: 'POST',
        body: { email: 'employee@helpdesk.local' }
      });
    });
    expect(await screen.findByText(/reset link is on its way/i)).toBeInTheDocument();
  });

  it('confirms a new password from a token link', async () => {
    window.history.replaceState({}, '', '/reset-password?token=reset-token');
    render(<App />);

    fireEvent.change(await screen.findByLabelText('New password'), {
      target: { value: 'BrandNewPass123!' }
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'BrandNewPass123!' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/auth/password-reset/confirm', {
        method: 'POST',
        body: {
          token: 'reset-token',
          password: 'BrandNewPass123!',
          confirmPassword: 'BrandNewPass123!'
        }
      });
    });
  });

  it('confirms verification directly from a token link', async () => {
    window.history.replaceState({}, '', '/verify-email?token=verify-token');
    render(<App />);

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/auth/verification/confirm', {
        method: 'POST',
        body: { token: 'verify-token' }
      });
    });
    expect(await screen.findByText(/email verified/i)).toBeInTheDocument();
  });

  it('resends a verification email when no token is present', async () => {
    window.history.replaceState({}, '', '/verify-email');
    render(<App />);

    fireEvent.change(await screen.findByLabelText('Work email'), {
      target: { value: 'vera@example.com' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Resend verification email' }));

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/auth/verification/resend', {
        method: 'POST',
        body: { email: 'vera@example.com' }
      });
    });
  });
});

describe('session management', () => {
  const sessions = [
    {
      id: 1,
      current: true,
      revoked: false,
      ipAddress: '127.0.0.1',
      createdAt: '2026-11-26T10:00:00.000Z'
    },
    {
      id: 2,
      current: false,
      revoked: false,
      ipAddress: '192.168.1.20',
      createdAt: '2026-11-25T10:00:00.000Z'
    }
  ];

  beforeEach(() => {
    api.apiRequest.mockImplementation(async (path, options = {}) => {
      if (path === '/auth/sessions' && !options.method) return { data: { sessions } };
      if (path === '/auth/sessions/2' && options.method === 'DELETE') return { data: { revoked: true } };
      if (path === '/auth/sessions' && options.method === 'DELETE') return { data: { revoked: 1 } };
      if (path === '/auth/me') throw Object.assign(new Error('Authentication required'), { status: 401 });
      return { data: {} };
    });
  });

  it('lists sessions and revokes one selected session', async () => {
    render(<SessionsPanel onClose={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Active sessions' })).toBeInTheDocument();
    expect(screen.getByText('This device')).toBeInTheDocument();
    expect(screen.getByText('192.168.1.20')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/auth/sessions/2', { method: 'DELETE' });
    });
    expect(await screen.findByText(/session has been signed out/i)).toBeInTheDocument();
  });

  it('restores focus to the opener when the sessions dialog closes', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const { unmount } = render(<SessionsPanel onClose={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Active sessions' })).toBeInTheDocument();
    expect(document.activeElement).not.toBe(opener);

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('revokes every other session in one action', async () => {
    render(<SessionsPanel onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign out of other devices' }));
    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/auth/sessions', { method: 'DELETE' });
    });
    expect(await screen.findByText(/1 other session signed out/i)).toBeInTheDocument();
  });
});

describe('phase 10 regression fixes', () => {
  const admin = {
    id: 10,
    firstName: 'Avery',
    lastName: 'Admin',
    email: 'admin@helpdesk.local',
    role: 'admin'
  };
  const employee = {
    id: 3,
    firstName: 'Elena',
    lastName: 'Employee',
    email: 'employee@helpdesk.local',
    role: 'employee'
  };

  it('renders verification links for a signed-in user', async () => {
    window.history.replaceState({}, '', '/verify-email?token=verify-token');
    api.apiRequest.mockImplementation(async (path) => {
      if (path === '/auth/me') return { data: { user: admin } };
      if (path === '/auth/verification/confirm') return { data: { verified: true } };
      if (path.startsWith('/tickets?')) return { data: [], meta: { page: 1, limit: 10, total: 0, totalPages: 1 } };
      if (path === '/tickets/summary') return { data: { total: 0, open: 0, unassigned: 0, resolved: 0, closed: 0, overdue: 0 } };
      if (path === '/tickets/assignees') return { data: { assignees: [] } };
      return { data: {} };
    });

    render(<App />);

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/auth/verification/confirm', {
        method: 'POST',
        body: { token: 'verify-token' }
      });
    });
    await waitFor(() => {
      expect(window.location.pathname).toBe('/staff');
      expect(window.location.search).toBe('');
    });
  });

  it('renders reset links for a signed-in user and revokes the session on success', async () => {
    window.history.replaceState({}, '', '/reset-password?token=reset-token');
    api.apiRequest.mockImplementation(async (path) => {
      if (path === '/auth/me') return { data: { user: admin } };
      if (path === '/auth/password-reset/confirm') return { data: { reset: true } };
      return { data: {} };
    });

    render(<App />);

    fireEvent.change(await screen.findByLabelText('New password'), {
      target: { value: 'BrandNewPass123!' }
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'BrandNewPass123!' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/auth/password-reset/confirm', {
        method: 'POST',
        body: {
          token: 'reset-token',
          password: 'BrandNewPass123!',
          confirmPassword: 'BrandNewPass123!'
        }
      });
    });
    await waitFor(() => {
      expect(window.location.pathname).toBe('/login');
      expect(window.location.search).toBe('');
    });
    expect(await screen.findByRole('heading', { name: /sign in to helpdesk pro/i })).toBeInTheDocument();
  });

  it('does not load admin analytics for an agent deep link', async () => {
    window.history.replaceState({}, '', '/staff/analytics');
    api.apiRequest.mockImplementation(async (path) => {
      if (path.startsWith('/dashboard/overview')) throw new Error('Analytics must not load for agents');
      if (path.startsWith('/tickets?')) return { data: [], meta: { page: 1, limit: 10, total: 0, totalPages: 1 } };
      if (path === '/tickets/summary') return { data: { total: 0, open: 0, unassigned: 0, resolved: 0, closed: 0, overdue: 0 } };
      if (path === '/tickets/assignees') return { data: { assignees: [] } };
      return { data: {} };
    });

    render(<StaffApp user={{ ...admin, role: 'agent' }} onLogout={vi.fn()} loggingOut={false} onUnauthorized={vi.fn()} onForbidden={vi.fn()} />);

    await waitFor(() => expect(window.location.pathname).toBe('/staff'));
    expect(api.apiRequest).not.toHaveBeenCalledWith(
      expect.stringContaining('/dashboard/overview'),
      expect.anything()
    );
  });

  it('does not reopen the sessions dialog after signing out and back in', async () => {
    let authenticated = true;
    api.apiRequest.mockImplementation(async (path, options = {}) => {
      if (path === '/auth/me') {
        if (!authenticated) throw Object.assign(new Error('Authentication required'), { status: 401 });
        return { data: { user: employee } };
      }
      if (path === '/auth/login') {
        authenticated = true;
        return { data: { user: employee, csrfToken: 'token' } };
      }
      if (path === '/auth/logout') {
        authenticated = false;
        return { data: { loggedOut: true } };
      }
      if (path === '/auth/sessions') {
        return {
          data: {
            sessions: [{
              id: 1,
              current: true,
              revoked: false,
              ipAddress: '127.0.0.1',
              createdAt: '2026-11-26T10:00:00.000Z',
              expiresAt: new Date(Date.now() + 3_600_000).toISOString()
            }]
          }
        };
      }
      if (path.startsWith('/tickets?')) return { data: [], meta: { page: 1, limit: 10, total: 0, totalPages: 1 } };
      if (path === '/tickets/summary') return { data: { total: 0, open: 0, unassigned: 0, resolved: 0, closed: 0, overdue: 0 } };
      if (path === '/tickets/assignees') return { data: { assignees: [] } };
      if (path === '/categories') return { data: [] };
      return { data: {} };
    });

    render(<App />);
    await screen.findByRole('heading', { name: /employee portal/i });
    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
    expect(await screen.findByRole('heading', { name: 'Active sessions' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    fireEvent.change(await screen.findByLabelText('Work email'), {
      target: { value: employee.email }
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'ChangeMe123!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await screen.findByRole('heading', { name: /employee portal/i });
    expect(screen.queryByRole('heading', { name: 'Active sessions' })).not.toBeInTheDocument();
  });

  it('labels expired sessions and removes their revoke actions', async () => {
    api.apiRequest.mockImplementation(async (path) => {
      if (path === '/auth/sessions') {
        return {
          data: {
            sessions: [{
              id: 2,
              current: false,
              revoked: false,
              ipAddress: '192.168.1.20',
              createdAt: '2026-11-25T10:00:00.000Z',
              expiresAt: '2026-11-25T11:00:00.000Z'
            }]
          }
        };
      }
      return { data: {} };
    });

    render(<SessionsPanel onClose={vi.fn()} />);

    expect(await screen.findByText(/expired/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out of other devices' })).toBeDisabled();
  });

  it('forwards attachment authorization failures to the global handler', async () => {
    const onApiError = vi.fn();
    api.apiRequest.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));

    render(<AttachmentsPanel ticketId={42} onApiError={onApiError} />);

    await waitFor(() => {
      expect(onApiError).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    });
  });

  it('shows an actionable error when a lazy chunk fails to load', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function BrokenComponent() {
      throw new Error('Chunk load failed');
    }

    try {
      render(<AsyncBoundary><BrokenComponent /></AsyncBoundary>);
      expect(await screen.findByRole('heading', { name: /could not be loaded/i })).toBeInTheDocument();
      expect(screen.getByText(/required code could not be downloaded/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('offers a retry for a failed chunk without a full page reload', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onRetry = vi.fn();
    function BrokenComponent() {
      throw new Error('Chunk load failed');
    }

    try {
      render(<AsyncBoundary onRetry={onRetry}><BrokenComponent /></AsyncBoundary>);
      expect(await screen.findByRole('heading', { name: /could not be loaded/i })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
