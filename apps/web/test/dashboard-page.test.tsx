import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DashboardSummaryView } from '@b2b/contracts';
import DashboardPage from '../app/(app)/dashboard/page';
import * as dashboardClient from '../src/lib/dashboard-client';

vi.mock('../src/lib/dashboard-client', () => ({
  fetchDashboardSummary: vi.fn(),
}));

const fetchDashboardSummary = vi.mocked(dashboardClient.fetchDashboardSummary);

const SUMMARY: DashboardSummaryView = {
  totalProducts: 42,
  activeProducts: 40,
  totalCustomers: 12,
  lowStockProducts: 3,
  draftOrders: 5,
  approvedOrders: 7,
  shippedOrders: 9,
  issuedInvoices: 11,
  requestedReturns: 1,
  approvedReturns: 2,
  todaySalesAmount: [{ amount: '123456', currency: 'TRY' }],
  monthSalesAmount: [
    { amount: '9900000', currency: 'TRY' },
    { amount: '50000', currency: 'USD' },
  ],
};

beforeEach(() => {
  fetchDashboardSummary.mockReset();
});

describe('DashboardPage', () => {
  it('renders the summary cards on a successful fetch', async () => {
    fetchDashboardSummary.mockResolvedValueOnce(SUMMARY);

    render(<DashboardPage />);

    await waitFor(() => expect(screen.getByTestId('stat-totalProducts').textContent).toBe('42'));
    expect(screen.getByTestId('stat-lowStockProducts').textContent).toBe('3');
    expect(screen.getByTestId('stat-issuedInvoices').textContent).toBe('11');
    // Per-currency money rendering (minor-unit string → grouped display).
    const today = screen.getByTestId('stat-todaySalesAmount').textContent ?? '';
    expect(today).toMatch(/1\.234,56\s*TRY/);
    const month = screen.getByTestId('stat-monthSalesAmount').textContent ?? '';
    expect(month).toMatch(/TRY/);
    expect(month).toMatch(/USD/);
  });

  it('renders zeros without crashing when figures are missing/empty', async () => {
    fetchDashboardSummary.mockResolvedValueOnce({
      ...SUMMARY,
      totalProducts: 0,
      todaySalesAmount: [],
    });

    render(<DashboardPage />);

    await waitFor(() => expect(screen.getByTestId('stat-totalProducts').textContent).toBe('0'));
    expect(screen.getByTestId('stat-todaySalesAmount').textContent).toContain('—');
  });

  it('shows an error state with a retry when the fetch fails', async () => {
    fetchDashboardSummary.mockRejectedValueOnce(new Error('boom'));

    render(<DashboardPage />);

    const error = await screen.findByTestId('dashboard-error');
    expect(error.textContent).toMatch(/could not load the dashboard/i);

    // Retry re-invokes the fetch (this time succeeding).
    fetchDashboardSummary.mockResolvedValueOnce(SUMMARY);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.getByTestId('stat-totalProducts').textContent).toBe('42'));
  });
});
