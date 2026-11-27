import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SlaStatusBadge,
  StatCard,
  StatusBadge,
  ThemeToggle,
  formatDuration,
  formatTimeRemaining,
  resolveSlaStatus
} from '../ui.jsx';

describe('SLA display helpers', () => {
  it('formats durations and missing values', () => {
    expect(formatDuration(30)).toBe('30 min');
    expect(formatDuration(0)).toBe('0 min');
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration('not-a-number')).toBe('—');
  });

  it('formats remaining time, including a breached rounding edge', () => {
    expect(formatTimeRemaining(120)).toBe('120 min left');
    expect(formatTimeRemaining(0)).toBe('Due now');
    expect(formatTimeRemaining(0, 'breached')).toBe('<1 min overdue');
    expect(formatTimeRemaining(-5)).toBe('5 min overdue');
    expect(formatTimeRemaining(null)).toBe('—');
  });

  it('only treats Met as supported when response evidence exists', () => {
    expect(resolveSlaStatus('met', {
      firstRespondedAt: '2026-11-26T00:30:00.000Z',
      responseMinutes: 30
    })).toBe('met');
    expect(resolveSlaStatus('met', { firstRespondedAt: null, responseMinutes: null })).toBe('unverified');
    expect(resolveSlaStatus('met', { firstRespondedAt: '2026-11-26T00:30:00.000Z' })).toBe('unverified');
    expect(resolveSlaStatus('breached')).toBe('breached');
    expect(resolveSlaStatus(undefined)).toBeNull();
  });

  it('renders resolved status labels instead of trusting unsupported values', () => {
    const { rerender } = render(
      <SlaStatusBadge
        status="met"
        firstRespondedAt="2026-11-26T00:30:00.000Z"
        responseMinutes={30}
      />
    );
    expect(screen.getByText('Met')).toHaveClass('sla-status-met');

    rerender(<SlaStatusBadge status="met" firstRespondedAt={null} responseMinutes={null} />);
    expect(screen.getByText('Unverified')).toHaveClass('sla-status-unverified');

    rerender(<SlaStatusBadge status="unknown-value" />);
    expect(screen.getByText('Unknown')).toHaveClass('sla-status-unknown');
  });

  it('renders an unknown generic status badge instead of crashing', () => {
    render(<StatusBadge status={null} />);
    expect(screen.getByText('unknown')).toHaveClass('badge-unknown');
  });

  it('maps only known ticket statuses to badge classes', () => {
    const { rerender } = render(<StatusBadge status="In Progress" />);
    expect(screen.getByText('In Progress')).toHaveClass('badge-in-progress');

    rerender(<StatusBadge status="nasty injected-class" />);
    const badge = screen.getByText('unknown');
    expect(badge).toHaveClass('badge-unknown');
    expect(badge.className).toBe('badge badge-unknown');
  });
});

describe('theme preference', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('does not present missing statistics as zero', () => {
    const { rerender } = render(<StatCard label="Total" value={undefined} />);
    expect(screen.getByText('—')).toBeInTheDocument();

    rerender(<StatCard label="Total" value={0} />);
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('persists a light/dark preference', () => {
    render(<ThemeToggle />);
    expect(screen.getByRole('button', { name: 'Switch to dark mode' })).toHaveTextContent('Dark mode');

    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }));

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('helpdesk-theme')).toBe('dark');
    expect(screen.getByRole('button', { name: 'Switch to light mode' })).toHaveTextContent('Light mode');
  });
});
