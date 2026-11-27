import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App.jsx';
import * as api from '../api.js';
import { navigateTo } from '../routing.js';

vi.mock('../api.js', () => ({
  apiRequest: vi.fn(),
  fetchCsrfToken: vi.fn(),
  setCsrfToken: vi.fn(),
  clearCsrfToken: vi.fn(),
  uploadRequest: vi.fn(),
  downloadRequest: vi.fn()
}));

const employee = {
  id: 3,
  firstName: 'Elena',
  lastName: 'Employee',
  email: 'employee@helpdesk.local',
  role: 'employee'
};

const ticket = {
  id: 42,
  ticketCode: 'HD-000042',
  title: 'Laptop will not boot',
  description: 'The laptop shows a black screen after the overnight update.',
  status: 'New',
  priority: 'High',
  categoryId: 1,
  categoryName: 'Hardware',
  subcategoryId: 5,
  subcategoryName: 'Laptop / Desktop',
  requesterId: 3,
  assigneeId: null,
  assigneeName: null,
  responseDueAt: '2026-11-27T00:00:00.000Z',
  firstRespondedAt: null,
  resolvedAt: null,
  closedAt: null,
  resolutionNotes: null,
  isOverdue: false,
  sla: {
    status: 'pending',
    timeRemainingMinutes: 120,
    responseMinutes: null,
    resolutionMinutes: null
  },
  createdAt: '2026-11-26T00:00:00.000Z',
  updatedAt: '2026-11-26T00:00:00.000Z',
  comments: [],
  history: []
};

const createdTicket = { ...ticket, id: 43, ticketCode: 'HD-000043', title: 'New issue title' };

function mockApi({
  authenticated = true,
  sessionRole = 'employee',
  detailOverrides = {},
  meta = { page: 1, limit: 10, total: 1, totalPages: 1 },
  unauthorizedDetail = false,
  internalNote = false,
  attachments = [],
  registerError = null,
  commentError = null,
  detailFailsAfterMutation = false,
  logoutError = null,
  roleAfterForbidden = null,
  portalForbiddenRole = null,
  queueUnauthorized = false,
  dashboardData = null
} = {}) {
  let attachmentList = [...attachments];
  let mutationOccurred = false;
  let currentRole = sessionRole;
  let portalForbiddenPending = Boolean(portalForbiddenRole);
  let queueUnauthorizedPending = Boolean(queueUnauthorized);
  let dashboardCalls = 0;
  let detail = {
    ...ticket,
    ...detailOverrides,
    comments: internalNote ? [{
      id: 6,
      ticketId: 42,
      authorId: 9,
      authorName: 'Sam Support',
      authorRole: 'agent',
      body: 'Internal note that must never reach the employee.',
      isInternal: true,
      createdAt: '2026-11-26T00:30:00.000Z'
    }] : (detailOverrides.comments ?? [])
  };

  api.apiRequest.mockImplementation(async (path, options = {}) => {
    if (path === '/auth/me') {
      if (!authenticated) throw Object.assign(new Error('Authentication required'), { status: 401 });
      return { data: { user: { ...employee, role: currentRole } } };
    }
    if (path === '/auth/login') {
      return { data: { user: { ...employee, role: sessionRole }, csrfToken: 'rotated-token' } };
    }
    if (path === '/auth/register') {
      if (registerError) throw Object.assign(new Error(registerError), { status: 409 });
      return {
        data: {
          user: {
            ...employee,
            firstName: options.body?.firstName ?? employee.firstName,
            lastName: options.body?.lastName ?? employee.lastName,
            email: options.body?.email ?? employee.email,
            role: 'employee'
          },
          csrfToken: 'registration-token'
        }
      };
    }
    if (path === '/auth/logout') {
      if (logoutError) throw new Error(logoutError);
      return { data: { loggedOut: true } };
    }
    if (path.startsWith('/dashboard/overview')) {
      dashboardCalls += 1;
      if (roleAfterForbidden && dashboardCalls > 1) {
        currentRole = roleAfterForbidden;
        throw Object.assign(new Error('Analytics access denied'), { status: 403 });
      }
      return { data: dashboardData ?? {
        summary: { total: 3, open: 1, resolved: 2, closed: 0, overdue: 0 },
        priority: [{ priority: 'High', total: 3 }],
        category: [{ category: 'Hardware', total: 3 }],
        weeklyTrends: [{ weekStart: '2026-11-23', label: 'Nov 23', created: 3, resolved: 2 }],
        agentWorkload: [{ id: 9, name: 'Sam Support', open: 1, assigned: 2, completed: 1 }],
        averageResolutionTime: { resolvedTickets: 2, averageResolutionMinutes: 45 }
      } };
    }
    if (path.startsWith('/tickets?')) {
      if (queueUnauthorizedPending) {
        queueUnauthorizedPending = false;
        throw Object.assign(new Error('Session expired'), { status: 401 });
      }
      if (portalForbiddenPending) {
        portalForbiddenPending = false;
        currentRole = portalForbiddenRole;
        throw Object.assign(new Error('Portal access changed'), { status: 403 });
      }
      return { data: [ticket], meta };
    }
    if (path === '/tickets/summary') {
      return { data: { total: 1, open: 1, resolved: 0, closed: 0, overdue: 0, unassigned: 1 } };
    }
    if (path === '/tickets/assignees') {
      return { data: { assignees: [{ id: 9, name: 'Sam Support', email: 'agent@helpdesk.local', role: 'agent' }] } };
    }
    if (path === '/categories') {
      return {
        data: [{
          id: 1,
          name: 'Hardware',
          description: '',
          subcategories: [{ id: 5, name: 'Laptop / Desktop' }]
        }]
      };
    }
    if (path === '/tickets') {
      return {
        data: {
          ticket: {
            ...createdTicket,
            title: options.body?.title ?? createdTicket.title,
            comments: [],
            history: []
          }
        }
      };
    }
    if (path === '/tickets/43') return { data: { ticket: { ...createdTicket, comments: [], history: [] } } };
    if (path === '/tickets/42') {
      if (unauthorizedDetail) throw Object.assign(new Error('Authentication required'), { status: 401 });
      if (detailFailsAfterMutation && mutationOccurred) {
        throw Object.assign(new Error('Detail temporarily unavailable'), { status: 500 });
      }
      if (options.method === 'PATCH') {
        detail = {
          ...detail,
          title: options.body?.title ?? detail.title,
          description: options.body?.description ?? detail.description
        };
      }
      return { data: { ticket: detail } };
    }
    if (path === '/tickets/42/cancel') {
      detail = { ...detail, status: 'Closed', resolutionNotes: 'Cancelled by requester' };
      return { data: { ticket: detail } };
    }
    if (path === '/tickets/42/reopen') {
      detail = { ...detail, status: 'New', resolutionNotes: null };
      return { data: { ticket: detail } };
    }
    if (path === '/tickets/42/attachments' || path.startsWith('/tickets/42/attachments?')) {
      return {
        data: attachmentList,
        meta: { page: 1, limit: 10, total: attachmentList.length, totalPages: 1 }
      };
    }
    if (path.startsWith('/tickets/42/attachments/') && options.method === 'DELETE') {
      const attachmentId = Number(path.split('/')[4]);
      attachmentList = attachmentList.filter((item) => item.id !== attachmentId);
      return { data: { deleted: true } };
    }
    if (path === '/tickets/42/comments') {
      if (commentError) throw Object.assign(new Error(commentError), { status: 422 });
      mutationOccurred = true;
      detail = {
        ...detail,
        comments: [...detail.comments, {
          id: 7,
          ticketId: 42,
          authorId: 3,
          authorName: 'Elena Employee',
          authorRole: 'employee',
          body: options.body?.body ?? '',
          isInternal: false,
          createdAt: '2026-11-26T01:00:00.000Z'
        }]
      };
      return { data: { comment: detail.comments[detail.comments.length - 1] } };
    }
    if (path === '/tickets/42/close') {
      detail = { ...detail, status: 'Closed' };
      return { data: { ticket: detail } };
    }
    throw new Error(`Unexpected API path: ${path}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  document.documentElement.dataset.theme = 'light';
  api.fetchCsrfToken.mockResolvedValue('csrf-token');
  api.uploadRequest.mockResolvedValue({ data: { attachment: { id: 99 } } });
  api.downloadRequest.mockResolvedValue({ blob: new Blob(['example']), filename: 'notes.txt' });
  mockApi();
});

describe('employee portal', () => {
  it('shows the sign-in form to unauthenticated visitors', async () => {
    mockApi({ authenticated: false });
    render(<App />);

    expect(await screen.findByRole('heading', { name: /sign in to helpdesk pro/i })).toBeInTheDocument();
  });

  it('lets visitors switch theme before signing in', async () => {
    mockApi({ authenticated: false });
    render(<App />);
    await screen.findByRole('heading', { name: /sign in to helpdesk pro/i });

    fireEvent.click(screen.getByRole('button', { name: /switch to dark mode/i }));

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('helpdesk-theme')).toBe('dark');
  });

  it('renders the dashboard with ticket summary and own tickets', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: /employee portal/i })).toBeInTheDocument();
    expect(await screen.findByText('HD-000042')).toBeInTheDocument();
    expect(screen.getByText('Laptop will not boot')).toBeInTheDocument();
    expect(screen.getByText('Elena Employee')).toBeInTheDocument();
    expect(screen.getByText('Total tickets')).toBeInTheDocument();
  });

  it('loads the ticket that matches a deep-link change', async () => {
    window.history.replaceState({}, '', '/tickets/42');
    render(<App />);
    expect(await screen.findByText('HD-000042')).toBeInTheDocument();

    act(() => navigateTo('/tickets/43'));

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/tickets/43');
    });
    expect(await screen.findByText('HD-000043')).toBeInTheDocument();
    expect(screen.queryByText('HD-000042')).not.toBeInTheDocument();
  });

  it('still lists tickets when category metadata fails', async () => {
    const original = api.apiRequest.getMockImplementation();
    api.apiRequest.mockImplementation(async (path, options) => {
      if (path === '/categories') throw new Error('Catalog temporarily unavailable');
      return original(path, options);
    });

    render(<App />);

    expect(await screen.findByText('HD-000042')).toBeInTheDocument();
    expect(await screen.findByText(/workspace details could not be refreshed/i)).toBeInTheDocument();
  });

  it('shows a session expiry message when the staff workspace hits a 401', async () => {
    mockApi({ sessionRole: 'agent', queueUnauthorized: true });
    render(<App />);

    expect(await screen.findByRole('heading', { name: /sign in to helpdesk pro/i })).toBeInTheDocument();
    expect(await screen.findByText(/your session expired/i)).toBeInTheDocument();
  });

  it('signs in with credentials and opens the portal', async () => {
    mockApi({ authenticated: false });
    render(<App />);

    fireEvent.change(await screen.findByLabelText(/work email/i), {
      target: { value: 'employee@helpdesk.local' }
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'ChangeMe123!' }
    });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByRole('heading', { name: /employee portal/i })).toBeInTheDocument();
    expect(api.apiRequest).toHaveBeenCalledWith('/auth/login', {
      method: 'POST',
      body: { email: 'employee@helpdesk.local', password: 'ChangeMe123!' }
    });
  });

  it('submits a new ticket with the selected category and priority', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: /employee portal/i });

    fireEvent.click(screen.getByRole('button', { name: /new ticket/i }));
    fireEvent.change(await screen.findByLabelText('Short title'), {
      target: { value: 'New issue title' }
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'A detailed enough description.' }
    });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'Critical' } });
    fireEvent.click(screen.getByRole('button', { name: /submit ticket/i }));

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/tickets', {
        method: 'POST',
        body: expect.objectContaining({
          title: 'New issue title',
          categoryId: 1,
          priority: 'Critical'
        })
      });
    });
    expect(await screen.findByText('HD-000043')).toBeInTheDocument();
  });

  it('reloads an unfiltered queue after submitting a ticket', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: /employee portal/i });

    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'Resolved' } });
    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/tickets?page=1&limit=10&status=Resolved');
    });

    fireEvent.click(screen.getByRole('button', { name: /new ticket/i }));
    fireEvent.change(await screen.findByLabelText('Short title'), { target: { value: 'New issue title' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'A detailed enough description.' } });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: /submit ticket/i }));

    await waitFor(() => {
      const ticketCalls = api.apiRequest.mock.calls.filter(([path]) => path.startsWith('/tickets?'));
      expect(ticketCalls[ticketCalls.length - 1][0]).toBe('/tickets?page=1&limit=10');
    });
    expect(await screen.findByText('HD-000043')).toBeInTheDocument();
  });

  it('passes status, priority and search filters to the server', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: /employee portal/i });

    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'Resolved' } });
    fireEvent.change(screen.getByLabelText('Filter by priority'), { target: { value: 'High' } });
    fireEvent.change(screen.getByLabelText('Search tickets'), { target: { value: 'laptop' } });

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith(
        '/tickets?page=1&limit=10&status=Resolved&priority=High&search=laptop'
      );
    });
  });

  it('loads the next page from the server', async () => {
    mockApi({ meta: { page: 1, limit: 10, total: 25, totalPages: 3 } });
    render(<App />);
    await screen.findByRole('button', { name: /next/i });

    fireEvent.click(screen.getByRole('button', { name: /next/i }));

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/tickets?page=2&limit=10');
    });
  });

  it('keeps ticket detail renderable after confirming a resolution', async () => {
    mockApi({ detailOverrides: { status: 'Resolved' } });
    render(<App />);
    await screen.findByText('HD-000042');

    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    fireEvent.click(await screen.findByRole('button', { name: /confirm resolution/i }));

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/tickets/42/close', {
        method: 'POST',
        body: {}
      });
    });
    expect(await screen.findByRole('heading', { name: 'Laptop will not boot' })).toBeInTheDocument();
    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /confirm resolution/i })).not.toBeInTheDocument();
  });

  it('adds a reply and refreshes the detail view', async () => {
    render(<App />);
    await screen.findByText('HD-000042');

    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    fireEvent.change(await screen.findByLabelText('Add a reply'), {
      target: { value: 'I tried restarting it.' }
    });
    fireEvent.click(screen.getByRole('button', { name: /send reply/i }));

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/tickets/42/comments', {
        method: 'POST',
        body: { body: 'I tried restarting it.' }
      });
    });
    expect(await screen.findByText('I tried restarting it.')).toBeInTheDocument();
  });

  it('keeps the reply text when sending fails', async () => {
    mockApi({ commentError: 'Reply was rejected' });
    render(<App />);
    await screen.findByText('HD-000042');

    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    fireEvent.change(await screen.findByLabelText('Add a reply'), {
      target: { value: 'Please keep this text.' }
    });
    fireEvent.click(screen.getByRole('button', { name: /send reply/i }));

    expect(await screen.findByText('Reply was rejected')).toBeInTheDocument();
    expect(screen.getByLabelText('Add a reply')).toHaveValue('Please keep this text.');
  });

  it('does not claim success or clear reply text when the detail refresh fails', async () => {
    mockApi({ detailFailsAfterMutation: true });
    render(<App />);
    await screen.findByText('HD-000042');

    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    fireEvent.change(await screen.findByLabelText('Add a reply'), {
      target: { value: 'Please keep this text.' }
    });
    fireEvent.click(screen.getByRole('button', { name: /send reply/i }));

    expect(await screen.findByText(/detail temporarily unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText('Reply added.')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Add a reply')).toHaveValue('Please keep this text.');
  });

  it('never renders internal comments in the employee portal', async () => {
    mockApi({ internalNote: true });
    render(<App />);
    await screen.findByText('HD-000042');

    fireEvent.click(screen.getByRole('button', { name: 'View' }));

    expect(await screen.findByRole('heading', { name: 'Laptop will not boot' })).toBeInTheDocument();
    expect(screen.queryByText('Internal note that must never reach the employee.')).not.toBeInTheDocument();
  });

  it('disables the reply button for whitespace-only input', async () => {
    render(<App />);
    await screen.findByText('HD-000042');

    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    fireEvent.change(await screen.findByLabelText('Add a reply'), { target: { value: '   ' } });

    expect(screen.getByRole('button', { name: /send reply/i })).toBeDisabled();
  });

  it('returns to sign-in when an action receives a 401', async () => {
    mockApi({ unauthorizedDetail: true });
    render(<App />);
    await screen.findByText('HD-000042');

    fireEvent.click(screen.getByRole('button', { name: 'View' }));

    expect(await screen.findByRole('heading', { name: /sign in to helpdesk pro/i })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('session expired');
  });

  it('warns when the server cannot complete sign out but still clears local state', async () => {
    mockApi({ logoutError: 'Network unavailable' });
    render(<App />);
    await screen.findByRole('heading', { name: /employee portal/i });

    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));

    expect(await screen.findByRole('heading', { name: /sign in to helpdesk pro/i })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('session may remain active');
    expect(api.clearCsrfToken).toHaveBeenCalled();
  });

  it('keeps a boot failure message visible on the sign-in screen', async () => {
    api.fetchCsrfToken.mockRejectedValueOnce(new Error('Session service unavailable'));
    render(<App />);

    expect(await screen.findByRole('heading', { name: /sign in to helpdesk pro/i })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Session service unavailable');
  });

  it('signs out and clears the portal', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: /employee portal/i });

    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));

    expect(await screen.findByRole('heading', { name: /sign in to helpdesk pro/i })).toBeInTheDocument();
    expect(api.clearCsrfToken).toHaveBeenCalled();
    expect(api.apiRequest).toHaveBeenCalledWith('/auth/logout', {
      method: 'POST',
      body: {}
    });
  });

  it('does not replay a deep link after an explicit sign out', async () => {
    mockApi({ authenticated: false });
    window.history.replaceState({}, '', '/tickets/42');
    render(<App />);

    fireEvent.change(await screen.findByLabelText(/work email/i), {
      target: { value: 'employee@helpdesk.local' }
    });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'ChangeMe123!' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    await screen.findByText('HD-000042');
    expect(window.sessionStorage.getItem('helpdesk:redirect')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    await screen.findByRole('heading', { name: /sign in to helpdesk pro/i });
    expect(window.sessionStorage.getItem('helpdesk:redirect')).toBeNull();
  });

  it('routes staff accounts to the staff workspace', async () => {
    mockApi({ sessionRole: 'agent' });
    render(<App />);

    expect(await screen.findByRole('heading', { name: /ticket queue/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ticket queue/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Users' })).not.toBeInTheDocument();
  });

  it('shows administration tools to administrators', async () => {
    mockApi({ sessionRole: 'admin' });
    render(<App />);

    expect(await screen.findByRole('heading', { name: /ticket queue/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Users' })).toBeInTheDocument();
  });

  it('clears stale privileged views when a 403 reveals a lower role', async () => {
    mockApi({ sessionRole: 'admin', roleAfterForbidden: 'agent' });
    render(<App />);
    await screen.findByRole('heading', { name: /ticket queue/i });
    expect(screen.getByRole('button', { name: 'Users' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Analytics' }));
    expect(await screen.findByRole('heading', { name: 'Analytics' })).toBeInTheDocument();
    expect(screen.getByText('Total incidents')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Ticket queue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Analytics' }));

    expect(await screen.findByRole('heading', { name: /ticket queue/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Users' })).not.toBeInTheDocument();
    expect(screen.queryByText('Total incidents')).not.toBeInTheDocument();
  });

  it('keeps the original 403 reason when the role is unchanged', async () => {
    mockApi({ sessionRole: 'admin', roleAfterForbidden: 'admin' });
    render(<App />);
    await screen.findByRole('heading', { name: /ticket queue/i });

    fireEvent.click(screen.getByRole('button', { name: 'Analytics' }));
    expect(await screen.findByRole('heading', { name: 'Analytics' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ticket queue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Analytics' }));

    expect(await screen.findByText(/Analytics access denied/)).toBeInTheDocument();
  });

  it('refreshes the workspace when a portal 403 reveals a lower role', async () => {
    mockApi({ sessionRole: 'admin', portalForbiddenRole: 'agent' });
    render(<App />);

    await screen.findByRole('heading', { name: /ticket queue/i });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Users' })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Ticket queue' })).toBeInTheDocument();
    expect(screen.getByText('agent')).toBeInTheDocument();
    const meCalls = api.apiRequest.mock.calls.filter(([path]) => path === '/auth/me');
    expect(meCalls.length).toBeGreaterThan(1);
  });

  it('explains a forced sign-out when a 403 reveals an unsupported role', async () => {
    mockApi({ sessionRole: 'admin', roleAfterForbidden: 'guest' });
    render(<App />);
    await screen.findByRole('heading', { name: /ticket queue/i });

    fireEvent.click(screen.getByRole('button', { name: 'Analytics' }));
    await screen.findByRole('heading', { name: 'Analytics' });
    fireEvent.click(screen.getByRole('button', { name: 'Ticket queue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Analytics' }));

    expect(await screen.findByRole('heading', { name: /sign in to helpdesk pro/i })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('no longer has access');
  });

  it('routes an administrator who signs in to the staff workspace', async () => {
    mockApi({ authenticated: false, sessionRole: 'admin' });
    render(<App />);

    fireEvent.change(await screen.findByLabelText(/work email/i), {
      target: { value: 'admin@helpdesk.local' }
    });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'ChangeMe123!' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByRole('heading', { name: /ticket queue/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Users' })).toBeInTheDocument();
  });

  it('shows a clear message for unsupported roles', async () => {
    mockApi({ sessionRole: 'guest' });
    render(<App />);

    expect(await screen.findByRole('heading', { name: /workspace unavailable/i })).toBeInTheDocument();
    expect(screen.getByText(/not available for the guest role/i)).toBeInTheDocument();
  });

  it('registers an employee, adopts the CSRF token and opens the portal', async () => {
    mockApi({ authenticated: false });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /register as an employee/i }));
    expect(await screen.findByRole('heading', { name: /create your employee account/i })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Jamie' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Newcomer' } });
    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'jamie@helpdesk.local' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'ChangeMe123!' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'ChangeMe123!' } });
    fireEvent.click(screen.getByRole('button', { name: /^create account$/i }));

    expect(await screen.findByRole('heading', { name: /employee portal/i })).toBeInTheDocument();
    expect(api.apiRequest).toHaveBeenCalledWith('/auth/register', {
      method: 'POST',
      body: {
        firstName: 'Jamie',
        lastName: 'Newcomer',
        email: 'jamie@helpdesk.local',
        password: 'ChangeMe123!',
        confirmPassword: 'ChangeMe123!'
      }
    });
    expect(api.setCsrfToken).toHaveBeenCalledWith('registration-token');
  });

  it('rejects a registration when the confirmation does not match', async () => {
    mockApi({ authenticated: false });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /register as an employee/i }));
    await screen.findByRole('heading', { name: /create your employee account/i });
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Jamie' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Newcomer' } });
    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'jamie@helpdesk.local' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'ChangeMe123!' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'Different123!' } });
    fireEvent.click(screen.getByRole('button', { name: /^create account$/i }));

    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();
    expect(api.apiRequest).not.toHaveBeenCalledWith('/auth/register', expect.anything());
  });

  it('shows a password mismatch even when a server error is still visible', async () => {
    mockApi({ authenticated: false, registerError: 'Email already in use' });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /register as an employee/i }));
    await screen.findByRole('heading', { name: /create your employee account/i });
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Jamie' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Newcomer' } });
    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'jamie@helpdesk.local' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'ChangeMe123!' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'ChangeMe123!' } });
    fireEvent.click(screen.getByRole('button', { name: /^create account$/i }));

    expect(await screen.findByText('Email already in use')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'Different123!' } });
    fireEvent.click(screen.getByRole('button', { name: /^create account$/i }));

    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();
    expect(screen.queryByText('Email already in use')).not.toBeInTheDocument();
  });

  it('shows the sign-in form after browser back from registration', async () => {
    mockApi({ authenticated: false });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /register as an employee/i }));
    await waitFor(() => expect(window.location.pathname).toBe('/register'));
    expect(await screen.findByRole('heading', { name: /create your employee account/i })).toBeInTheDocument();

    act(() => window.history.back());

    await waitFor(() => expect(window.location.pathname).toBe('/login'));
    expect(await screen.findByRole('heading', { name: /sign in to helpdesk pro/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /create your employee account/i })).not.toBeInTheDocument();
  });

  it('lists and downloads attachments on an employee ticket', async () => {
    mockApi({
      attachments: [
        {
          id: 7,
          ticketId: 42,
          commentId: null,
          uploaderId: 3,
          uploaderName: 'Elena Employee',
          originalName: 'notes.txt',
          mimeType: 'text/plain',
          sizeBytes: 2048,
          createdAt: '2026-11-26T00:30:00.000Z'
        },
        {
          id: 8,
          ticketId: 42,
          commentId: 12,
          uploaderId: 9,
          uploaderName: 'Sam Support',
          originalName: 'internal-only.txt',
          mimeType: 'text/plain',
          sizeBytes: 10,
          isInternal: true,
          createdAt: '2026-11-26T00:31:00.000Z'
        },
        {
          id: 9,
          ticketId: 42,
          commentId: 13,
          uploaderId: 9,
          uploaderName: 'Sam Support',
          originalName: 'public-reply.txt',
          mimeType: 'text/plain',
          sizeBytes: 20,
          isInternal: false,
          createdAt: '2026-11-26T00:32:00.000Z'
        }
      ]
    });
    render(<App />);
    await screen.findByText('HD-000042');

    fireEvent.click(screen.getByRole('button', { name: 'View' }));

    expect(await screen.findByText('notes.txt')).toBeInTheDocument();
    expect(screen.getByText(/2.0 KB/)).toBeInTheDocument();
    expect(screen.getAllByText(/Elena Employee/).length).toBeGreaterThan(0);
    expect(screen.getByText('public-reply.txt')).toBeInTheDocument();
    expect(screen.queryByText('internal-only.txt')).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: /^download /i })[0]);
    await waitFor(() => {
      expect(api.downloadRequest).toHaveBeenCalledWith('/tickets/42/attachments/7/download', 'notes.txt');
    });
    expect(api.apiRequest).toHaveBeenCalledWith('/tickets/42/attachments?page=1&limit=10');
  });

  it('paginates attachments using server metadata', async () => {
    const original = api.apiRequest.getMockImplementation();
    api.apiRequest.mockImplementation(async (path, options) => {
      if (path.startsWith('/tickets/42/attachments?')) {
        const requestedPage = Number(new URLSearchParams(path.split('?')[1]).get('page'));
        return {
          data: [{
            id: requestedPage === 1 ? 7 : 8,
            ticketId: 42,
            commentId: null,
            uploaderId: 3,
            uploaderName: 'Elena Employee',
            originalName: requestedPage === 1 ? 'page-one.txt' : 'page-two.txt',
            mimeType: 'text/plain',
            sizeBytes: 12,
            createdAt: '2026-11-26T00:30:00.000Z'
          }],
          meta: { page: requestedPage, limit: 10, total: 12, totalPages: 2 }
        };
      }
      return original(path, options);
    });

    render(<App />);
    await screen.findByText('HD-000042');
    fireEvent.click(screen.getByRole('button', { name: 'View' }));

    expect(await screen.findByText('page-one.txt')).toBeInTheDocument();
    expect(screen.getByText(/Page 1 of 2 · 12 attachments/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('page-two.txt')).toBeInTheDocument();
  });

  it('uploads an attachment from the employee ticket detail', async () => {
    render(<App />);
    await screen.findByText('HD-000042');
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    await screen.findByRole('heading', { name: 'Attachments' });

    const file = new File(['diagram'], 'diagram.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Add an attachment'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /^upload$/i }));

    await waitFor(() => {
      expect(api.uploadRequest).toHaveBeenCalledWith('/tickets/42/attachments', expect.any(FormData));
    });
    expect((await screen.findAllByText('Attachment uploaded.')).length).toBeGreaterThan(0);
  });

  it('disables attachment uploads on a closed ticket', async () => {
    mockApi({ detailOverrides: { status: 'Closed' } });
    render(<App />);
    await screen.findByText('HD-000042');

    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    await screen.findByRole('heading', { name: 'Attachments' });

    expect(screen.getByLabelText('Add an attachment')).toBeDisabled();
    expect(screen.getByRole('button', { name: /^upload$/i })).toBeDisabled();
  });

  it('lets an employee delete only their own attachment', async () => {
    mockApi({
      attachments: [
        {
          id: 7,
          ticketId: 42,
          commentId: null,
          uploaderId: 3,
          uploaderName: 'Elena Employee',
          originalName: 'mine.txt',
          mimeType: 'text/plain',
          sizeBytes: 12,
          createdAt: '2026-11-26T00:30:00.000Z'
        },
        {
          id: 8,
          ticketId: 42,
          commentId: null,
          uploaderId: 9,
          uploaderName: 'Sam Support',
          originalName: 'theirs.txt',
          mimeType: 'text/plain',
          sizeBytes: 12,
          createdAt: '2026-11-26T00:32:00.000Z'
        }
      ]
    });
    render(<App />);
    await screen.findByText('HD-000042');
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    await screen.findByText('mine.txt');

    expect(screen.getAllByRole('button', { name: /^delete /i })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /^delete /i }));

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/tickets/42/attachments/7', { method: 'DELETE' });
    });
    await waitFor(() => expect(screen.queryByText('mine.txt')).not.toBeInTheDocument());
    expect(screen.getByText('theirs.txt')).toBeInTheDocument();
  });

  it('edits an open ticket from the detail view', async () => {
    render(<App />);
    await screen.findByText('HD-000042');
    fireEvent.click(screen.getByRole('button', { name: 'View' }));

    fireEvent.click(await screen.findByRole('button', { name: /edit ticket/i }));
    fireEvent.change(screen.getByLabelText('Edit title'), { target: { value: 'Updated laptop title' } });
    fireEvent.change(screen.getByLabelText('Edit description'), {
      target: { value: 'A sufficiently detailed updated description.' }
    });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/tickets/42', {
        method: 'PATCH',
        body: {
          title: 'Updated laptop title',
          description: 'A sufficiently detailed updated description.'
        }
      });
    });
    expect(await screen.findByRole('heading', { name: 'Updated laptop title' })).toBeInTheDocument();
  });

  it('cancels an open ticket from the detail view', async () => {
    render(<App />);
    await screen.findByText('HD-000042');
    fireEvent.click(screen.getByRole('button', { name: 'View' }));

    fireEvent.click(await screen.findByRole('button', { name: /cancel ticket/i }));

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/tickets/42/cancel', { method: 'POST', body: {} });
    });
    expect(await screen.findByText('Closed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cancel ticket/i })).not.toBeInTheDocument();
  });

  it('reopens a closed ticket from the detail view', async () => {
    mockApi({ detailOverrides: { status: 'Closed' } });
    render(<App />);
    await screen.findByText('HD-000042');
    fireEvent.click(screen.getByRole('button', { name: 'View' }));

    fireEvent.click(await screen.findByRole('button', { name: /reopen ticket/i }));

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/tickets/42/reopen', { method: 'POST', body: {} });
    });
    expect(await screen.findByText('New')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reopen ticket/i })).not.toBeInTheDocument();
  });

  it('shows SLA status and time remaining on the employee ticket detail', async () => {
    render(<App />);
    await screen.findByText('HD-000042');
    fireEvent.click(screen.getByRole('button', { name: 'View' }));

    const details = (await screen.findByRole('heading', { name: 'Ticket details' })).closest('article');
    expect(within(details).getByText('Pending')).toBeInTheDocument();
    expect(within(details).getByText('120 min left')).toBeInTheDocument();
    expect(within(details).getByText('Response time')).toBeInTheDocument();
    expect(within(details).getByText('Resolution time')).toBeInTheDocument();
  });

  it('shows measured SLA durations and never renders Met without evidence', async () => {
    mockApi({
      detailOverrides: {
        firstRespondedAt: '2026-11-26T00:30:00.000Z',
        resolvedAt: '2026-11-26T01:30:00.000Z',
        sla: {
          status: 'met',
          timeRemainingMinutes: null,
          responseMinutes: 30,
          resolutionMinutes: 90
        }
      }
    });
    render(<App />);
    await screen.findByText('HD-000042');
    fireEvent.click(screen.getByRole('button', { name: 'View' }));

    const details = (await screen.findByRole('heading', { name: 'Ticket details' })).closest('article');
    expect(within(details).getByText('Met')).toBeInTheDocument();
    expect(within(details).getByText('30 min')).toBeInTheDocument();
    expect(within(details).getByText('90 min')).toBeInTheDocument();
  });

  it('downgrades an unsupported Met status to Unverified for employees', async () => {
    mockApi({
      detailOverrides: {
        firstRespondedAt: null,
        sla: {
          status: 'met',
          timeRemainingMinutes: null,
          responseMinutes: null,
          resolutionMinutes: null
        }
      }
    });
    render(<App />);
    await screen.findByText('HD-000042');
    fireEvent.click(screen.getByRole('button', { name: 'View' }));

    const details = (await screen.findByRole('heading', { name: 'Ticket details' })).closest('article');
    expect(within(details).getByText('Unverified')).toBeInTheDocument();
    expect(within(details).queryByText('Met')).not.toBeInTheDocument();
  });
});

describe('global footer', () => {
  const expectedFooter = `© ${new Date().getFullYear()} Helpdesk Pro. All rights reserved. Built by xcoder45.`;

  it('renders on the sign-in screen', async () => {
    mockApi({ authenticated: false });
    render(<App />);

    await screen.findByRole('heading', { name: /sign in to helpdesk pro/i });
    expect(screen.getByRole('contentinfo')).toHaveTextContent(expectedFooter);
  });

  it('does not render on the registration screen', async () => {
    mockApi({ authenticated: false });
    window.history.replaceState({}, '', '/register');
    render(<App />);

    expect(await screen.findByRole('heading', { name: /create your employee account/i })).toBeInTheDocument();
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument();
  });

  it('renders on the employee workspace', async () => {
    render(<App />);

    await screen.findByRole('heading', { name: /employee portal/i });
    expect(screen.getByRole('contentinfo')).toHaveTextContent(expectedFooter);
  });

  it('renders on the staff workspace', async () => {
    mockApi({ sessionRole: 'agent' });
    render(<App />);

    await screen.findByRole('heading', { name: /ticket queue/i });
    expect(screen.getByRole('contentinfo')).toHaveTextContent(expectedFooter);
  });
});
