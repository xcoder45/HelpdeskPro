import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StaffApp from '../StaffApp.jsx';
import * as api from '../api.js';

vi.mock('../api.js', () => ({
  apiRequest: vi.fn(),
  fetchCsrfToken: vi.fn(),
  setCsrfToken: vi.fn(),
  clearCsrfToken: vi.fn(),
  uploadRequest: vi.fn(),
  downloadRequest: vi.fn()
}));

const agentUser = {
  id: 9,
  firstName: 'Sam',
  lastName: 'Support',
  email: 'agent@helpdesk.local',
  role: 'agent'
};

const adminUser = {
  id: 10,
  firstName: 'Avery',
  lastName: 'Administrator',
  email: 'admin@helpdesk.local',
  role: 'admin'
};

const baseTicket = {
  id: 42,
  ticketCode: 'HD-000042',
  title: 'Laptop will not boot',
  description: 'The laptop shows a black screen after the overnight update.',
  status: 'New',
  priority: 'High',
  categoryName: 'Hardware',
  subcategoryName: 'Laptop / Desktop',
  requesterId: 3,
  requesterName: 'Elena Employee',
  assigneeId: null,
  assigneeName: null,
  responseDueAt: '2026-11-27T00:00:00.000Z',
  firstRespondedAt: null,
  resolvedAt: null,
  closedAt: null,
  resolutionNotes: null,
  isOverdue: true,
  isDemo: true,
  sla: {
    status: 'breached',
    timeRemainingMinutes: -180,
    responseMinutes: null,
    resolutionMinutes: null
  },
  createdAt: '2026-11-26T00:00:00.000Z',
  updatedAt: '2026-11-26T00:00:00.000Z',
  comments: [],
  history: [{
    id: 1,
    action: 'created',
    fieldName: 'status',
    oldValue: null,
    newValue: 'New',
    actorName: 'Elena Employee',
    createdAt: '2026-11-26T00:00:00.000Z'
  }]
};

function mockApi({
  detailOverrides = {},
  meta = { page: 1, limit: 10, total: 1, totalPages: 1 },
  unauthorizedDetail = false,
  detailFailsAfterMutation = false,
  createUserError = null,
  users = null,
  attachments = [],
  slaRules = [],
  slaReport = null,
  slaReportUnavailable = false,
  slaReportError = null,
  slaReportFailAfter = 0,
  slaError = null,
  ruleUpdateError = null,
  reportGate = null,
  dashboard = null,
  dashboardError = null,
  dashboardGate = null,
  dashboardFailAfter = 0,
  analyticsUnauthorized = false,
  analyticsForbidden = false,
  analyticsForbiddenAfter = 0,
  slaRulesForbidden = false,
  queueForbidden = false,
  auditLogs = [],
  categories = []
} = {}) {
  let detail = { ...baseTicket, ...detailOverrides };
  let attachmentList = [...attachments];
  let rules = [...slaRules];
  let auditEntries = [...auditLogs];
  let categoryList = categories.map((category) => ({ ...category }));
  const report = slaReportUnavailable ? null : slaReport ?? {
    summary: {
      totalTickets: 12,
      responded: 10,
      metResponse: 8,
      breached: 2,
      pendingResponse: 2,
      unverifiedResponse: 1,
      complianceRate: 80,
      averageResponseMinutes: 42.5
    },
    tickets: [{
      ticketCode: 'HD-000042',
      title: 'Laptop will not boot',
      priority: 'High',
      status: 'New',
      requesterName: 'Elena Employee',
      assigneeName: 'Sam Support',
      responseDueAt: '2026-11-27T00:00:00.000Z',
      firstRespondedAt: null,
      responseMinutes: null,
      resolutionMinutes: null,
      timeRemainingMinutes: -180,
      slaStatus: 'breached',
      metResponse: false,
      isOverdue: true
    }]
  };
  let mutationOccurred = false;
  let reportCalls = 0;
  let dashboardCalls = 0;
  let userList = users ?? [{
    id: 3,
    firstName: 'Elena',
    lastName: 'Employee',
    email: 'employee@helpdesk.local',
    role: 'employee',
    isActive: true,
    isDemo: true
  }];

  api.apiRequest.mockImplementation(async (path, options = {}) => {
    if (queueForbidden && (
      path.startsWith('/tickets?') || path === '/tickets/summary' || path === '/tickets/assignees'
    )) {
      throw Object.assign(new Error('Access changed'), { status: 403 });
    }
    if (path.startsWith('/tickets?')) {
      const requestedPage = Number(new URLSearchParams(path.split('?')[1]).get('page') ?? 1);
      return { data: [baseTicket], meta: { ...meta, page: requestedPage } };
    }
    if (path === '/tickets/summary') {
      return {
        data: { total: 1, open: 1, unassigned: 1, resolved: 0, closed: 0, overdue: 1 }
      };
    }
    if (path === '/tickets/assignees') {
      return {
        data: {
          assignees: [
            { id: 9, name: 'Sam Support', email: 'agent@helpdesk.local', role: 'agent' },
            { id: 10, name: 'Avery Administrator', email: 'admin@helpdesk.local', role: 'admin' }
          ]
        }
      };
    }
    if (path === '/tickets/42') {
      if (unauthorizedDetail) throw Object.assign(new Error('Authentication required'), { status: 401 });
      if (detailFailsAfterMutation && mutationOccurred) {
        throw Object.assign(new Error('Detail temporarily unavailable'), { status: 500 });
      }
      return { data: { ticket: detail } };
    }
    if (path === '/tickets/42/assign') {
      mutationOccurred = true;
      detail = {
        ...detail,
        assigneeId: options.body.assigneeId,
        assigneeName: options.body.assigneeId === null ? null : 'Sam Support',
        status: options.body.assigneeId === null ? 'New' : 'Assigned'
      };
      return { data: { ticket: detail } };
    }
    if (path === '/tickets/42/status') {
      mutationOccurred = true;
      detail = {
        ...detail,
        status: options.body.status,
        resolutionNotes: options.body.resolutionNotes ?? null,
        resolvedAt: options.body.status === 'Resolved' ? '2026-11-26T02:00:00.000Z' : null
      };
      return { data: { ticket: detail } };
    }
    if (path === '/tickets/42/priority') {
      mutationOccurred = true;
      detail = { ...detail, priority: options.body.priority };
      return { data: { ticket: detail } };
    }
    if (path === '/tickets/42/comments') {
      mutationOccurred = true;
      const comment = {
        id: detail.comments.length + 7,
        ticketId: 42,
        authorId: 9,
        authorName: 'Sam Support',
        authorRole: 'agent',
        body: options.body.body,
        isInternal: Boolean(options.body.isInternal),
        createdAt: '2026-11-26T01:00:00.000Z'
      };
      detail = { ...detail, comments: [...detail.comments, comment] };
      return { data: { comment } };
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
    if (path.startsWith('/dashboard/overview')) {
      dashboardCalls += 1;
      if (dashboardGate) await dashboardGate;
      if (analyticsUnauthorized) {
        throw Object.assign(new Error('Authentication required'), { status: 401 });
      }
      if (analyticsForbidden) {
        throw Object.assign(new Error('Analytics access denied'), { status: 403 });
      }
      if (analyticsForbiddenAfter && dashboardCalls > analyticsForbiddenAfter) {
        throw Object.assign(new Error('Analytics access denied'), { status: 403 });
      }
      if (dashboardError || (dashboardFailAfter && dashboardCalls > dashboardFailAfter)) {
        throw Object.assign(
          new Error(dashboardError ?? 'Analytics refresh failed'),
          { status: 500 }
        );
      }
      return { data: dashboard ?? {
        summary: { total: 12, open: 4, resolved: 6, closed: 2, overdue: 1 },
        priority: [
          { priority: 'Critical', total: 2 },
          { priority: 'High', total: 4 },
          { priority: 'Medium', total: 4 },
          { priority: 'Low', total: 2 }
        ],
        category: [{ category: 'Hardware', total: 7 }, { category: 'Software', total: 5 }],
        weeklyTrends: [
          { weekStart: '2026-11-16', label: 'Nov 16', created: 3, resolved: 2 },
          { weekStart: '2026-11-23', label: 'Nov 23', created: 4, resolved: 3 }
        ],
        agentWorkload: [
          { id: 9, name: 'Sam Support', open: 3, assigned: 8, completed: 5 }
        ],
        averageResolutionTime: { resolvedTickets: 6, averageResolutionMinutes: 90 }
      } };
    }
    if (path === '/sla/rules') {
      if (slaRulesForbidden) {
        throw Object.assign(new Error('Rules access denied'), { status: 403 });
      }
      if (slaError) throw Object.assign(new Error(slaError), { status: 500 });
      return { data: rules };
    }
    if (path.startsWith('/sla/rules/') && options.method === 'PATCH') {
      if (ruleUpdateError) throw Object.assign(new Error(ruleUpdateError), { status: 400 });
      const id = Number(path.split('/')[3]);
      rules = rules.map((rule) => (rule.id === id ? { ...rule, ...options.body } : rule));
      return { data: { rule: rules.find((rule) => rule.id === id) } };
    }
    if (path.startsWith('/sla/report?')) {
      if (reportGate) await reportGate;
      reportCalls += 1;
      if (slaReportError || (slaReportFailAfter && reportCalls > slaReportFailAfter)) {
        throw Object.assign(
          new Error(slaReportError ?? 'SLA report temporarily unavailable'),
          { status: 500 }
        );
      }
      const params = new URLSearchParams(path.split('?')[1]);
      return {
        data: report,
        meta: { ...meta, page: Number(params.get('page') ?? 1), limit: Number(params.get('limit') ?? 10) }
      };
    }
    if (path.startsWith('/users?')) return { data: userList, meta };
    if (path === '/users' && options.method === 'POST') {
      if (createUserError) {
        throw Object.assign(new Error(createUserError), { status: 409 });
      }
      const created = {
        id: 11,
        firstName: options.body.firstName,
        lastName: options.body.lastName,
        email: options.body.email,
        role: options.body.role,
        isActive: true
      };
      userList = [...userList, created];
      return { data: { user: created } };
    }
    if (path.startsWith('/users/') && options.method === 'PATCH') {
      const id = Number(path.split('/')[2]);
      userList = userList.map((item) => (
        item.id === id ? { ...item, ...options.body } : item
      ));
      return { data: { user: userList.find((item) => item.id === id) } };
    }
    if (path.startsWith('/audit-logs?')) return { data: auditEntries, meta };
    if (path.startsWith('/categories/admin?')) return { data: categoryList, meta };
    if (path === '/categories' && options.method === 'POST') {
      const created = {
        id: 12,
        name: options.body.name,
        description: options.body.description,
        isActive: true,
        subcategories: []
      };
      categoryList = [...categoryList, created];
      return { data: { category: created } };
    }
    if (/^\/categories\/\d+\/subcategories$/.test(path) && options.method === 'POST') {
      const categoryId = Number(path.split('/')[2]);
      const subcategory = { id: 20, name: options.body.name, isActive: true };
      categoryList = categoryList.map((category) => (
        category.id === categoryId
          ? { ...category, subcategories: [...category.subcategories, subcategory] }
          : category
      ));
      return { data: { subcategory } };
    }
    if (/^\/categories\/\d+\/subcategories\/\d+$/.test(path) && options.method === 'PATCH') {
      const categoryId = Number(path.split('/')[2]);
      const subcategoryId = Number(path.split('/')[4]);
      categoryList = categoryList.map((category) => (
        category.id === categoryId
          ? {
            ...category,
            subcategories: category.subcategories.map((item) => (
              item.id === subcategoryId ? { ...item, ...options.body } : item
            ))
          }
          : category
      ));
      return { data: { subcategory: { id: subcategoryId, ...options.body } } };
    }
    if (/^\/categories\/\d+$/.test(path) && options.method === 'PATCH') {
      const categoryId = Number(path.split('/')[2]);
      categoryList = categoryList.map((category) => (
        category.id === categoryId ? { ...category, ...options.body } : category
      ));
      return { data: { category: categoryList.find((category) => category.id === categoryId) } };
    }
    throw new Error(`Unexpected API path: ${path}`);
  });
}

function renderStaff(overrides = {}) {
  const mockOverrides = { ...overrides };
  delete mockOverrides.user;
  if (Object.keys(mockOverrides).length > 0) mockApi(mockOverrides);
  const onLogout = vi.fn();
  const onUnauthorized = vi.fn();
  const onForbidden = vi.fn();
  const user = overrides.user ?? agentUser;
  render(
    <StaffApp
      user={user}
      onLogout={onLogout}
      loggingOut={false}
      onUnauthorized={onUnauthorized}
      onForbidden={onForbidden}
    />
  );
  return { onLogout, onUnauthorized, onForbidden };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.uploadRequest.mockResolvedValue({ data: { attachment: { id: 99 } } });
  api.downloadRequest.mockResolvedValue({ blob: new Blob(['example']), filename: 'notes.txt' });
  mockApi();
});

describe('staff workspace', () => {
  it('renders the queue with requester and assignee context', async () => {
    renderStaff();

    expect(await screen.findByRole('heading', { name: /ticket queue/i })).toBeInTheDocument();
    expect(screen.getByText('HD-000042')).toBeInTheDocument();
    expect(screen.getByText('Elena Employee')).toBeInTheDocument();
    expect(screen.getAllByText('Unassigned').length).toBeGreaterThan(0);
    expect(screen.getByText('Overdue SLA')).toBeInTheDocument();
  });

  it('still lists tickets when summary metadata fails', async () => {
    const original = api.apiRequest.getMockImplementation();
    api.apiRequest.mockImplementation(async (path, options) => {
      if (path === '/tickets/summary') throw new Error('Summary temporarily unavailable');
      return original(path, options);
    });

    renderStaff();

    expect(await screen.findByText('HD-000042')).toBeInTheDocument();
    expect(await screen.findByText(/workspace details could not be refreshed/i)).toBeInTheDocument();
  });

  it('sends queue filters and pagination to the server', async () => {
    mockApi({ meta: { page: 1, limit: 10, total: 25, totalPages: 3 } });
    renderStaff();
    await screen.findByRole('heading', { name: /ticket queue/i });

    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'Resolved' } });
    fireEvent.change(screen.getByLabelText('Filter by priority'), { target: { value: 'Critical' } });
    fireEvent.change(screen.getByLabelText('Filter by assignee'), { target: { value: 'unassigned' } });
    fireEvent.change(screen.getByLabelText('Search tickets'), { target: { value: 'laptop' } });

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith(
        '/tickets?page=1&limit=10&status=Resolved&priority=Critical&assigneeId=unassigned&search=laptop'
      );
    });

    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith(
        '/tickets?page=2&limit=10&status=Resolved&priority=Critical&assigneeId=unassigned&search=laptop'
      );
    });
  });

  it('assigns a ticket from the detail view', async () => {
    renderStaff();
    await screen.findByText('HD-000042');

    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    fireEvent.change(await screen.findByLabelText('Assignee'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: /^assign$/i }));

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/tickets/42/assign', {
        method: 'PATCH',
        body: { assigneeId: 9 }
      });
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Status')).toHaveValue('Assigned');
    });
    expect(await screen.findByText(/assignment updated/i)).toBeInTheDocument();
  });

  it('adds an internal note that is labelled in the staff conversation', async () => {
    renderStaff();
    await screen.findByText('HD-000042');

    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    fireEvent.change(await screen.findByLabelText('Reply'), {
      target: { value: 'Escalated to the hardware vendor.' }
    });
    fireEvent.click(screen.getByLabelText(/internal note/i));
    fireEvent.click(screen.getByRole('button', { name: /send reply/i }));

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/tickets/42/comments', {
        method: 'POST',
        body: { body: 'Escalated to the hardware vendor.', isInternal: true }
      });
    });
    expect(await screen.findByText('Escalated to the hardware vendor.')).toBeInTheDocument();
    expect(screen.getAllByText('Internal note').length).toBeGreaterThan(0);
  });

  it('resolves a ticket with required resolution notes', async () => {
    mockApi({ detailOverrides: { status: 'In Progress', assigneeId: 9, assigneeName: 'Sam Support' } });
    renderStaff();
    await screen.findByText('HD-000042');

    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    fireEvent.change(await screen.findByLabelText('Status'), { target: { value: 'Resolved' } });
    fireEvent.change(await screen.findByLabelText('Resolution notes'), {
      target: { value: 'Replaced the display cable' }
    });
    fireEvent.click(screen.getByRole('button', { name: /update status/i }));

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/tickets/42/status', {
        method: 'PATCH',
        body: { status: 'Resolved', resolutionNotes: 'Replaced the display cable' }
      });
    });
    expect((await screen.findAllByText('Replaced the display cable')).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Status')).toHaveValue('Resolved');
  });

  it('blocks a resolution request when resolution notes are missing', async () => {
    mockApi({ detailOverrides: { status: 'In Progress', assigneeId: 9, assigneeName: 'Sam Support' } });
    renderStaff();
    await screen.findByText('HD-000042');

    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    fireEvent.change(await screen.findByLabelText('Status'), { target: { value: 'Resolved' } });
    fireEvent.click(screen.getByRole('button', { name: /update status/i }));

    expect(await screen.findByText(/resolution notes are required/i)).toBeInTheDocument();
    expect(api.apiRequest).not.toHaveBeenCalledWith('/tickets/42/status', expect.anything());
  });

  it('lets administrators create and manage users', async () => {
    renderStaff({ user: adminUser });
    await screen.findByRole('heading', { name: /ticket queue/i });

    fireEvent.click(screen.getByRole('button', { name: 'Users' }));
    expect(await screen.findByRole('heading', { name: /user management/i })).toBeInTheDocument();
    expect(screen.getByText('employee@helpdesk.local')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Jamie' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Agent' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'jamie@helpdesk.local' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'ChangeMe123!' } });
    fireEvent.click(screen.getByRole('button', { name: /create user/i }));

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/users', {
        method: 'POST',
        body: {
          firstName: 'Jamie',
          lastName: 'Agent',
          email: 'jamie@helpdesk.local',
          password: 'ChangeMe123!',
          role: 'agent'
        }
      });
    });
    expect(await screen.findByText('jamie@helpdesk.local')).toBeInTheDocument();
  });

  it('hands expired sessions back to the parent app', async () => {
    const { onUnauthorized } = renderStaff();
    mockApi({ unauthorizedDetail: true });
    await screen.findByText('HD-000042');

    fireEvent.click(screen.getByRole('button', { name: 'View' }));

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
  });

  it('only offers backend-valid status transitions and disables no-op actions', async () => {
    mockApi({ detailOverrides: { status: 'Pending' } });
    renderStaff();
    await screen.findByText('HD-000042');

    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    const status = await screen.findByLabelText('Status');
    expect(Array.from(status.options).map((option) => option.textContent)).toEqual([
      'Pending (current)',
      'In Progress',
      'Resolved'
    ]);
    expect(screen.getByRole('button', { name: /update status/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^assign$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /update priority/i })).toBeDisabled();
  });

  it('lets staff close a resolved ticket from the status control', async () => {
    mockApi({
      detailOverrides: {
        status: 'Resolved',
        assigneeId: 9,
        assigneeName: 'Sam Support',
        resolutionNotes: 'Display cable replaced'
      }
    });
    renderStaff();
    await screen.findByText('HD-000042');

    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    const status = await screen.findByLabelText('Status');
    expect(Array.from(status.options).map((option) => option.textContent)).toEqual([
      'Resolved (current)',
      'Closed',
      'In Progress',
      'Assigned'
    ]);
  });

  it('unassigns and reprioritises a ticket', async () => {
    renderStaff();
    await screen.findByText('HD-000042');

    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    fireEvent.change(await screen.findByLabelText('Assignee'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: /^assign$/i }));
    await waitFor(() => expect(screen.getByLabelText('Status')).toHaveValue('Assigned'));

    fireEvent.change(screen.getByLabelText('Assignee'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^assign$/i }));
    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/tickets/42/assign', {
        method: 'PATCH',
        body: { assigneeId: null }
      });
    });
    expect(await screen.findByText(/ticket unassigned/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'Critical' } });
    fireEvent.click(screen.getByRole('button', { name: /update priority/i }));
    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/tickets/42/priority', {
        method: 'PATCH',
        body: { priority: 'Critical' }
      });
    });
  });

  it('keeps a refresh failure visible instead of swallowing it behind a queue reload', async () => {
    mockApi({ detailFailsAfterMutation: true });
    renderStaff();
    await screen.findByText('HD-000042');

    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    fireEvent.change(await screen.findByLabelText('Assignee'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: /^assign$/i }));

    expect(await screen.findByText(/detail temporarily unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/assignment updated/i)).not.toBeInTheDocument();
  });

  it('preserves a staff reply draft when the refresh fails after posting', async () => {
    mockApi({ detailFailsAfterMutation: true });
    renderStaff();
    await screen.findByText('HD-000042');

    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    fireEvent.change(await screen.findByLabelText('Reply'), {
      target: { value: 'Please keep this draft.' }
    });
    fireEvent.click(screen.getByRole('button', { name: /send reply/i }));

    expect(await screen.findByText(/detail temporarily unavailable/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Reply')).toHaveValue('Please keep this draft.');
  });

  it('preserves create-user input when the API rejects it', async () => {
    mockApi({ createUserError: 'Email already exists' });
    renderStaff({ user: adminUser });
    await screen.findByRole('heading', { name: /ticket queue/i });

    fireEvent.click(screen.getByRole('button', { name: 'Users' }));
    await screen.findByRole('heading', { name: /user management/i });
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Jamie' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Agent' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'employee@helpdesk.local' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'ChangeMe123!' } });
    fireEvent.click(screen.getByRole('button', { name: /create user/i }));

    expect(await screen.findByText('Email already exists')).toBeInTheDocument();
    expect(screen.getByLabelText('First name')).toHaveValue('Jamie');
    expect(screen.getByLabelText('Last name')).toHaveValue('Agent');
    expect(screen.getByLabelText('Email')).toHaveValue('employee@helpdesk.local');
    expect(screen.getByLabelText('Password')).toHaveValue('ChangeMe123!');
  });

  it('changes user roles and account status', async () => {
    renderStaff({ user: adminUser });
    await screen.findByRole('heading', { name: /ticket queue/i });

    fireEvent.click(screen.getByRole('button', { name: 'Users' }));
    await screen.findByRole('heading', { name: /user management/i });

    fireEvent.change(screen.getByLabelText('Role for employee@helpdesk.local'), { target: { value: 'agent' } });
    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/users/3', {
        method: 'PATCH',
        body: { role: 'agent' }
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/users/3', {
        method: 'PATCH',
        body: { isActive: false }
      });
    });
    expect(await screen.findByText('Disabled')).toBeInTheDocument();
  });

  it('filters and edits users from the administration view', async () => {
    renderStaff({ user: adminUser });
    await screen.findByRole('heading', { name: /ticket queue/i });

    fireEvent.click(screen.getByRole('button', { name: 'Users' }));
    await screen.findByRole('heading', { name: /user management/i });

    fireEvent.change(screen.getByLabelText('Search users'), { target: { value: 'sam' } });
    fireEvent.change(screen.getByLabelText('Filter by role'), { target: { value: 'agent' } });
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'true' } });

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/users?page=1&limit=10&search=sam&role=agent&isActive=true');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Samuel' } });
    fireEvent.click(screen.getByRole('button', { name: /save user/i }));

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/users/3', {
        method: 'PATCH',
        body: {
          firstName: 'Samuel',
          lastName: 'Employee',
          email: 'employee@helpdesk.local',
          role: 'employee'
        }
      });
    });
    expect(await screen.findByText(/user updated/i)).toBeInTheDocument();
  });

  it('shows an audit log and forwards filters to the API', async () => {
    mockApi({
      auditLogs: [{
        id: 1,
        actorId: 10,
        actorName: 'Avery Administrator',
        action: 'ticket.status_changed',
        entityType: 'ticket',
        entityId: 42,
        details: { from: 'New', to: 'Resolved' },
        createdAt: '2026-11-26T00:00:00.000Z'
      }]
    });
    renderStaff({ user: adminUser });
    await screen.findByRole('heading', { name: /ticket queue/i });

    fireEvent.click(screen.getByRole('button', { name: 'Audit' }));

    expect(await screen.findByRole('heading', { name: /audit log/i })).toBeInTheDocument();
    expect(screen.getByText('ticket.status_changed')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'ticket.created' } });
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/audit-logs?page=1&limit=10&action=ticket.created');
    });
  });

  it('manages categories and subcategories from the administration view', async () => {
    renderStaff({ user: adminUser });
    await screen.findByRole('heading', { name: /ticket queue/i });

    fireEvent.click(screen.getByRole('button', { name: 'Categories' }));
    expect(await screen.findByRole('heading', { name: /categories/i })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Networking' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Network equipment' } });
    fireEvent.click(screen.getByRole('button', { name: /create category/i }));

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/categories', {
        method: 'POST',
        body: { name: 'Networking', description: 'Network equipment' }
      });
    });
    expect(await screen.findByText('Networking')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('New subcategory'), { target: { value: 'Router' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/categories/12/subcategories', {
        method: 'POST',
        body: { name: 'Router' }
      });
    });
    expect(await screen.findByText('Router')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Disable' })[0]);
    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/categories/12', {
        method: 'PATCH',
        body: { isActive: false }
      });
    });
  });

  it('labels seeded demo tickets and users', async () => {
    renderStaff({ user: adminUser });
    await screen.findByRole('heading', { name: /ticket queue/i });
    expect(screen.getAllByText('Demo').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Users' }));
    await screen.findByRole('heading', { name: /user management/i });
    expect(screen.getAllByText('Demo').length).toBeGreaterThan(0);
  });

  it('collapses repeated 403 handoffs into one refresh and resolves the banner', async () => {
    const { onForbidden } = renderStaff({ user: adminUser, queueForbidden: true });
    await waitFor(() => expect(onForbidden).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/please refresh or sign in again/i)).toBeInTheDocument();
    expect(screen.queryByText(/refreshing your workspace/i)).not.toBeInTheDocument();
  });

  it('lists and downloads attachments from a staff ticket detail', async () => {
    mockApi({
      attachments: [
        {
          id: 7,
          ticketId: 42,
          commentId: null,
          uploaderId: 3,
          uploaderName: 'Elena Employee',
          originalName: 'requirements.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 4096,
          isInternal: false,
          createdAt: '2026-11-26T00:30:00.000Z'
        },
        {
          id: 8,
          ticketId: 42,
          commentId: 12,
          uploaderId: 9,
          uploaderName: 'Sam Support',
          originalName: 'internal-diagnosis.txt',
          mimeType: 'text/plain',
          sizeBytes: 64,
          isInternal: true,
          createdAt: '2026-11-26T00:31:00.000Z'
        }
      ]
    });
    renderStaff();
    await screen.findByText('HD-000042');

    fireEvent.click(screen.getByRole('button', { name: 'View' }));

    expect(await screen.findByText('requirements.pdf')).toBeInTheDocument();
    expect(screen.getByText('internal-diagnosis.txt')).toBeInTheDocument();
    expect(screen.getByText(/4.0 KB/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /^download /i })[0]);

    await waitFor(() => {
      expect(api.downloadRequest).toHaveBeenCalledWith('/tickets/42/attachments/7/download', 'requirements.pdf');
    });
    expect(api.apiRequest).toHaveBeenCalledWith('/tickets/42/attachments?page=1&limit=10');
  });

  it('lets staff upload an attachment and delete any attachment', async () => {
    mockApi({
      attachments: [{
        id: 7,
        ticketId: 42,
        commentId: null,
        uploaderId: 3,
        uploaderName: 'Elena Employee',
        originalName: 'requirements.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 4096,
        createdAt: '2026-11-26T00:30:00.000Z'
      }]
    });
    renderStaff();
    await screen.findByText('HD-000042');
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    await screen.findByText('requirements.pdf');

    fireEvent.change(screen.getByLabelText('Add an attachment'), {
      target: { files: [new File(['spec'], 'spec.txt', { type: 'text/plain' })] }
    });
    fireEvent.click(screen.getByRole('button', { name: /^upload$/i }));
    await waitFor(() => {
      expect(api.uploadRequest).toHaveBeenCalledWith('/tickets/42/attachments', expect.any(FormData));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /^download /i })).not.toBeDisabled());

    fireEvent.click(screen.getAllByRole('button', { name: /^delete /i })[0]);
    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/tickets/42/attachments/7', { method: 'DELETE' });
    });
  });

  it('disables attachment deletion for staff on a closed ticket', async () => {
    renderStaff({
      detailOverrides: { status: 'Closed' },
      attachments: [{
        id: 7,
        ticketId: 42,
        commentId: null,
        uploaderId: 9,
        uploaderName: 'Sam Support',
        originalName: 'closed-evidence.txt',
        mimeType: 'text/plain',
        sizeBytes: 12,
        createdAt: '2026-11-26T00:30:00.000Z'
      }]
    });
    await screen.findByText('HD-000042');
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    await screen.findByText('closed-evidence.txt');

    expect(screen.getByRole('button', { name: /^delete /i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^upload$/i })).toBeDisabled();
  });

  it('lets administrators edit SLA response targets without disabling the only rule', async () => {
    mockApi({
      slaRules: [
        { id: 1, priority: 'Low', responseMinutes: 240, isActive: true, updatedAt: '2026-11-20T00:00:00.000Z' },
        { id: 2, priority: 'High', responseMinutes: 60, isActive: true, updatedAt: '2026-11-21T00:00:00.000Z' }
      ]
    });
    renderStaff({ user: adminUser });
    fireEvent.click(await screen.findByRole('button', { name: 'SLA' }));

    expect(await screen.findByRole('heading', { name: 'SLA management' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Response rules' })).toBeInTheDocument();

    const highRow = screen.getByLabelText('Response minutes for High').closest('tr');
    expect(within(highRow).getByLabelText('Active')).toBeDisabled();
    expect(within(highRow).getByText('Required — last active rule')).toBeInTheDocument();
    fireEvent.change(within(highRow).getByLabelText('Response minutes for High'), { target: { value: '45' } });
    fireEvent.click(within(highRow).getByRole('button', { name: /save rule/i }));

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/sla/rules/2', {
        method: 'PATCH',
        body: { responseMinutes: 45, isActive: true }
      });
    });
    expect(await screen.findByText('SLA rule updated.')).toBeInTheDocument();
  });

  it('preserves unsaved rule drafts while saving another rule', async () => {
    mockApi({
      slaRules: [
        { id: 1, priority: 'Low', responseMinutes: 240, isActive: true, updatedAt: '2026-11-20T00:00:00.000Z' },
        { id: 2, priority: 'High', responseMinutes: 60, isActive: true, updatedAt: '2026-11-21T00:00:00.000Z' }
      ]
    });
    renderStaff({ user: adminUser });
    fireEvent.click(await screen.findByRole('button', { name: 'SLA' }));
    await screen.findByRole('heading', { name: 'Response rules' });

    const lowInput = screen.getByLabelText('Response minutes for Low');
    const highRow = screen.getByLabelText('Response minutes for High').closest('tr');
    fireEvent.change(lowInput, { target: { value: '180' } });
    fireEvent.change(within(highRow).getByLabelText('Response minutes for High'), { target: { value: '45' } });
    fireEvent.click(within(highRow).getByRole('button', { name: /save rule/i }));

    expect(await screen.findByText('SLA rule updated.')).toBeInTheDocument();
    expect(screen.getByLabelText('Response minutes for Low')).toHaveValue(180);
    expect(screen.getByLabelText('Response minutes for High')).toHaveValue(45);
  });

  it('disables saving an SLA rule when minutes are invalid', async () => {
    mockApi({
      slaRules: [
        { id: 1, priority: 'Low', responseMinutes: 240, isActive: true, updatedAt: '2026-11-20T00:00:00.000Z' }
      ]
    });
    renderStaff({ user: adminUser });
    fireEvent.click(await screen.findByRole('button', { name: 'SLA' }));
    await screen.findByRole('heading', { name: 'Response rules' });

    const row = screen.getByLabelText('Response minutes for Low').closest('tr');
    fireEvent.change(within(row).getByLabelText('Response minutes for Low'), { target: { value: '' } });

    expect(within(row).getByRole('button', { name: /save rule/i })).toBeDisabled();
  });

  it('preserves an SLA rule draft when saving is rejected', async () => {
    mockApi({
      ruleUpdateError: 'SLA rule is already set to those values',
      slaRules: [
        { id: 1, priority: 'Low', responseMinutes: 240, isActive: true, updatedAt: '2026-11-20T00:00:00.000Z' }
      ]
    });
    renderStaff({ user: adminUser });
    fireEvent.click(await screen.findByRole('button', { name: 'SLA' }));
    await screen.findByRole('heading', { name: 'Response rules' });

    const lowInput = screen.getByLabelText('Response minutes for Low');
    fireEvent.change(lowInput, { target: { value: '180' } });
    fireEvent.click(screen.getByRole('button', { name: /save rule/i }));

    expect(await screen.findByText('SLA rule is already set to those values')).toBeInTheDocument();
    expect(screen.getByLabelText('Response minutes for Low')).toHaveValue(180);
  });

  it('keeps the SLA report available when only the rules request fails', async () => {
    mockApi({ slaError: 'Rules are unavailable' });
    renderStaff({ user: adminUser });
    fireEvent.click(await screen.findByRole('button', { name: 'SLA' }));

    expect(await screen.findByText('Rules are unavailable')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Response report' })).toBeInTheDocument();
    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(screen.getByText('HD-000042')).toBeInTheDocument();
    expect(screen.queryByText('SLA report is unavailable.')).not.toBeInTheDocument();
  });

  it('hides the SLA rules editor from agents', async () => {
    renderStaff();
    fireEvent.click(await screen.findByRole('button', { name: 'SLA' }));

    expect(await screen.findByRole('heading', { name: 'Response report' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Response rules' })).not.toBeInTheDocument();
    expect(api.apiRequest).not.toHaveBeenCalledWith('/sla/rules');
  });

  it('shows SLA report loading and applies priority and date filters', async () => {
    let releaseReport;
    const reportGate = new Promise((resolve) => { releaseReport = resolve; });
    mockApi({ reportGate });
    renderStaff();
    fireEvent.click(await screen.findByRole('button', { name: 'SLA' }));

    expect(await screen.findByText('Loading SLA report…')).toBeInTheDocument();
    await act(async () => { releaseReport(); });

    expect(await screen.findByRole('heading', { name: 'Response report' })).toBeInTheDocument();
    expect(await screen.findByText('80%')).toBeInTheDocument();
    expect(screen.getByText('42.5 min')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter by priority'), { target: { value: 'Critical' } });
    fireEvent.change(screen.getByLabelText('Created from'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('Created to'), { target: { value: '2026-01-31' } });

    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith(
        '/sla/report?page=1&limit=10&priority=Critical&from=2026-01-01&to=2026-01-31'
      );
    });
    expect(await screen.findByText('HD-000042')).toBeInTheDocument();
  });

  it('shows SLA status and timing in a ticket detail', async () => {
    renderStaff();
    await screen.findByText('HD-000042');
    fireEvent.click(screen.getByRole('button', { name: 'View' }));

    const slaPanel = (await screen.findByRole('heading', { name: 'SLA' })).closest('article');
    expect(within(slaPanel).getByText('Breached')).toBeInTheDocument();
    expect(within(slaPanel).getByText('180 min overdue')).toBeInTheDocument();
    expect(within(slaPanel).getByText('Response time')).toBeInTheDocument();
    expect(within(slaPanel).getByText('Resolution time')).toBeInTheDocument();
  });

  it('shows measured response and resolution times when the SLA was met', async () => {
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
    renderStaff();
    await screen.findByText('HD-000042');
    fireEvent.click(screen.getByRole('button', { name: 'View' }));

    const slaPanel = (await screen.findByRole('heading', { name: 'SLA' })).closest('article');
    expect(within(slaPanel).getByText('Met')).toBeInTheDocument();
    expect(within(slaPanel).getByText('30 min')).toBeInTheDocument();
    expect(within(slaPanel).getByText('90 min')).toBeInTheDocument();
  });

  it('does not display Met when the SLA status lacks response evidence', async () => {
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
    renderStaff();
    await screen.findByText('HD-000042');
    fireEvent.click(screen.getByRole('button', { name: 'View' }));

    const slaPanel = (await screen.findByRole('heading', { name: 'SLA' })).closest('article');
    expect(within(slaPanel).getByText('Unverified')).toBeInTheDocument();
    expect(within(slaPanel).queryByText('Met')).not.toBeInTheDocument();
  });

  it('filters the SLA report by derived status and shows timing columns', async () => {
    mockApi({
      slaReport: {
        summary: {
          totalTickets: 3,
          responded: 2,
          metResponse: 2,
          breached: 1,
          pendingResponse: 1,
          unverifiedResponse: 0,
          complianceRate: 100,
          averageResponseMinutes: 30
        },
        tickets: [
          {
            ticketCode: 'HD-000042',
            title: 'Laptop will not boot',
            priority: 'High',
            status: 'New',
            requesterName: 'Elena Employee',
            assigneeName: 'Sam Support',
            responseDueAt: '2026-11-27T00:00:00.000Z',
            firstRespondedAt: null,
            responseMinutes: null,
            resolutionMinutes: null,
            timeRemainingMinutes: 0,
            slaStatus: 'breached',
            metResponse: false,
            isOverdue: true
          },
          {
            ticketCode: 'HD-000043',
            title: 'Printer is offline',
            priority: 'Medium',
            status: 'Resolved',
            requesterName: 'Elena Employee',
            assigneeName: 'Sam Support',
            responseDueAt: '2026-11-27T00:00:00.000Z',
            firstRespondedAt: '2026-11-26T00:30:00.000Z',
            responseMinutes: 30,
            resolutionMinutes: 90,
            timeRemainingMinutes: null,
            slaStatus: 'met',
            metResponse: true,
            isOverdue: false
          },
          {
            ticketCode: 'HD-000044',
            title: 'SLA result without evidence',
            priority: 'Low',
            status: 'Resolved',
            requesterName: 'Elena Employee',
            assigneeName: 'Sam Support',
            responseDueAt: '2026-11-27T00:00:00.000Z',
            firstRespondedAt: null,
            responseMinutes: null,
            resolutionMinutes: null,
            timeRemainingMinutes: null,
            slaStatus: 'met',
            metResponse: true,
            isOverdue: false
          }
        ]
      }
    });
    renderStaff();
    fireEvent.click(await screen.findByRole('button', { name: 'SLA' }));
    await screen.findByRole('heading', { name: 'Response report' });

    expect(screen.getByText('Unverified response')).toBeInTheDocument();
    expect(screen.getByText('<1 min overdue')).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('Breached')).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('30 min')).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('90 min')).toBeInTheDocument();

    const unsupportedRow = screen.getByText('HD-000044').closest('tr');
    expect(within(unsupportedRow).getByText('Unverified')).toBeInTheDocument();
    expect(within(unsupportedRow).queryByText('Met')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter by SLA status'), { target: { value: 'breached' } });
    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/sla/report?page=1&limit=10&slaStatus=breached');
    });
  });

  it('does not present empty SLA metrics as measured zeros', async () => {
    mockApi({
      slaReport: {
        summary: {
          totalTickets: 0,
          responded: 0,
          metResponse: 0,
          breached: 0,
          pendingResponse: 0,
          unverifiedResponse: 0,
          complianceRate: 0,
          averageResponseMinutes: 0
        },
        tickets: []
      }
    });
    renderStaff();
    fireEvent.click(await screen.findByRole('button', { name: 'SLA' }));
    await screen.findByRole('heading', { name: 'Response report' });

    const summary = screen.getByLabelText('SLA summary');
    expect(within(summary).getAllByText('—')).toHaveLength(2);
    expect(screen.getByText('No tickets match these SLA filters.')).toBeInTheDocument();
  });

  it('clears stale report rows when a filtered refresh fails', async () => {
    mockApi({ slaReportFailAfter: 1 });
    renderStaff();
    fireEvent.click(await screen.findByRole('button', { name: 'SLA' }));
    expect(await screen.findByText('HD-000042')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter by SLA status'), { target: { value: 'met' } });

    expect(await screen.findByText('SLA report is unavailable.')).toBeInTheDocument();
    expect(screen.queryByText('HD-000042')).not.toBeInTheDocument();
  });

  it('shows an explicit state when the SLA report cannot load', async () => {
    mockApi({ slaReportUnavailable: true });
    renderStaff();
    fireEvent.click(await screen.findByRole('button', { name: 'SLA' }));

    expect(await screen.findByText('SLA report is unavailable.')).toBeInTheDocument();
  });

  it('renders database-backed analytics for administrators', async () => {
    renderStaff({ user: adminUser });
    fireEvent.click(await screen.findByRole('button', { name: 'Analytics' }));

    expect(await screen.findByRole('heading', { name: 'Analytics' })).toBeInTheDocument();
    expect(api.apiRequest).toHaveBeenCalledWith('/dashboard/overview?weeks=8');

    const summary = screen.getByLabelText('Analytics summary');
    expect(within(summary).getByText('Total incidents')).toBeInTheDocument();
    expect(within(summary).getByText('12')).toBeInTheDocument();
    expect(within(summary).getByText('90 min')).toBeInTheDocument();

    expect(within(
      screen.getByRole('table', { name: 'Incident counts by priority' })
    ).getByText('Critical')).toBeInTheDocument();
    expect(within(
      screen.getByRole('table', { name: 'Incident counts by category' })
    ).getByText('Hardware')).toBeInTheDocument();
    expect(within(
      screen.getByRole('table', { name: 'Weekly created and resolved ticket counts' })
    ).getByText('Nov 23')).toBeInTheDocument();
    expect(within(
      screen.getByRole('table', { name: 'Open and completed tickets by agent' })
    ).getByText('Sam Support')).toBeInTheDocument();

    await waitFor(() => {
      expect(document.querySelectorAll('.recharts-wrapper')).toHaveLength(4);
    });
    expect(document.querySelectorAll('.recharts-surface').length).toBeGreaterThanOrEqual(4);
    expect(document.querySelectorAll('.recharts-bar-rectangle').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.recharts-line-curve')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Analytics' })).toHaveAttribute('aria-current', 'page');
  });

  it('hides analytics from non-administrators', async () => {
    renderStaff();
    await screen.findByRole('heading', { name: /ticket queue/i });

    expect(screen.queryByRole('button', { name: 'Analytics' })).not.toBeInTheDocument();
    expect(api.apiRequest).not.toHaveBeenCalledWith('/dashboard/overview?weeks=8');
  });

  it('shows analytics loading and clears it when data arrives', async () => {
    let releaseDashboard;
    const dashboardGate = new Promise((resolve) => { releaseDashboard = resolve; });
    mockApi({ dashboardGate });
    renderStaff({ user: adminUser });
    fireEvent.click(await screen.findByRole('button', { name: 'Analytics' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Loading analytics…');
    expect(document.querySelector('.analytics-panel')).toHaveAttribute('aria-busy', 'true');
    await act(async () => { releaseDashboard(); });

    expect(await screen.findByRole('heading', { name: 'Analytics' })).toBeInTheDocument();
    expect(screen.queryByText('Loading analytics…')).not.toBeInTheDocument();
  });

  it('ignores an in-flight analytics response after leaving the tab', async () => {
    let releaseDashboard;
    const dashboardGate = new Promise((resolve) => { releaseDashboard = resolve; });
    mockApi({ dashboardGate });
    renderStaff({ user: adminUser });
    fireEvent.click(await screen.findByRole('button', { name: 'Analytics' }));
    expect(await screen.findByText('Loading analytics…')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Ticket queue' }));
    await act(async () => { releaseDashboard(); });

    expect(screen.queryByText('Loading analytics…')).not.toBeInTheDocument();
    expect(document.querySelector('.analytics-panel')).toBeNull();
  });

  it('shows an explicit state when analytics cannot load', async () => {
    mockApi({ dashboardError: 'Dashboard data unavailable' });
    renderStaff({ user: adminUser });
    fireEvent.click(await screen.findByRole('button', { name: 'Analytics' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Dashboard data unavailable');
    expect(screen.getByText('Analytics are unavailable.')).toBeInTheDocument();
  });

  it('hands an analytics 401 to the session handler', async () => {
    mockApi({ analyticsUnauthorized: true });
    const { onUnauthorized } = renderStaff({ user: adminUser });
    fireEvent.click(await screen.findByRole('button', { name: 'Analytics' }));

    await waitFor(() => {
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reports an analytics 403 without ending the session', async () => {
    mockApi({ analyticsForbidden: true });
    const { onUnauthorized, onForbidden } = renderStaff({ user: adminUser });
    fireEvent.click(await screen.findByRole('button', { name: 'Analytics' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Your access changed');
    expect(onForbidden).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('clears stale analytics when a later refresh is forbidden', async () => {
    mockApi({ analyticsForbiddenAfter: 1 });
    renderStaff({ user: adminUser });
    fireEvent.click(await screen.findByRole('button', { name: 'Analytics' }));
    expect(await screen.findByText('Total incidents')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Your access changed');
    expect(screen.queryByText('Total incidents')).not.toBeInTheDocument();
  });

  it('keeps the SLA report visible when rules access is denied', async () => {
    mockApi({ slaRulesForbidden: true });
    const { onUnauthorized, onForbidden } = renderStaff({ user: adminUser });
    fireEvent.click(await screen.findByRole('button', { name: 'SLA' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Your access changed');
    expect(await screen.findByRole('heading', { name: 'Response report' })).toBeInTheDocument();
    expect(screen.getByText('HD-000042')).toBeInTheDocument();
    expect(onForbidden).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('clears stale analytics when a refresh fails', async () => {
    mockApi({ dashboardFailAfter: 1 });
    renderStaff({ user: adminUser });
    fireEvent.click(await screen.findByRole('button', { name: 'Analytics' }));
    expect(await screen.findByText('12')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Analytics refresh failed');
    expect(screen.queryByText('12')).not.toBeInTheDocument();
  });

  it('presents empty analytics without inventing chart data', async () => {
    mockApi({
      dashboard: {
        summary: { total: 0, open: 0, resolved: 0, overdue: 0 },
        priority: [
          { priority: 'Critical', total: 0 },
          { priority: 'High', total: 0 },
          { priority: 'Medium', total: 0 },
          { priority: 'Low', total: 0 }
        ],
        category: [{ category: 'Hardware', total: 0 }, { category: 'Software', total: 0 }],
        weeklyTrends: [
          { weekStart: '2026-11-16', label: 'Nov 16', created: 0, resolved: 0 },
          { weekStart: '2026-11-23', label: 'Nov 23', created: 0, resolved: 0 }
        ],
        agentWorkload: [{ id: 9, name: 'Sam Support', open: 0, assigned: 0, completed: 0 }],
        averageResolutionTime: { resolvedTickets: 0, averageResolutionMinutes: 0 }
      }
    });
    renderStaff({ user: adminUser });
    fireEvent.click(await screen.findByRole('button', { name: 'Analytics' }));

    expect(await screen.findByRole('heading', { name: 'Analytics' })).toBeInTheDocument();
    expect(screen.getAllByText('No data available.')).toHaveLength(4);

    const summary = screen.getByLabelText('Analytics summary');
    expect(within(summary).getAllByText('0')).toHaveLength(4);
    expect(within(summary).getByText('—')).toBeInTheDocument();
    expect(within(summary).queryByText('0 min')).not.toBeInTheDocument();
  });

  it('refreshes analytics for the selected trend window', async () => {
    renderStaff({ user: adminUser });
    fireEvent.click(await screen.findByRole('button', { name: 'Analytics' }));
    await screen.findByRole('heading', { name: 'Analytics' });

    fireEvent.change(screen.getByLabelText('Trend window'), { target: { value: '4' } });
    await waitFor(() => {
      expect(api.apiRequest).toHaveBeenCalledWith('/dashboard/overview?weeks=4');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      const calls = api.apiRequest.mock.calls.filter(([path]) => (
        path.startsWith('/dashboard/overview')
      ));
      expect(calls).toHaveLength(3);
      expect(calls[2][0]).toBe('/dashboard/overview?weeks=4');
    });
  });
});
