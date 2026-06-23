import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { InventoryReportView, ReturnsReportView, SalesReportView } from '@b2b/contracts';
import ReportsPage from '../app/(app)/reports/page';
import * as reportsClient from '../src/lib/reports-client';
import * as warehousesClient from '../src/lib/warehouses-client';
import { ApiError } from '../src/lib/api-fetch';

// `useSearchParams` drives the initial tab; make it per-test overridable.
let searchParamsValue = new URLSearchParams('');
vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParamsValue,
}));

vi.mock('../src/lib/reports-client', async () => {
  const actual = await vi.importActual<typeof reportsClient>('../src/lib/reports-client');
  return {
    ...actual,
    fetchSalesReport: vi.fn(),
    fetchInventoryReport: vi.fn(),
    fetchReturnsReport: vi.fn(),
  };
});

vi.mock('../src/lib/warehouses-client', () => ({
  listWarehouses: vi.fn(),
}));

const fetchSalesReport = vi.mocked(reportsClient.fetchSalesReport);
const fetchInventoryReport = vi.mocked(reportsClient.fetchInventoryReport);
const fetchReturnsReport = vi.mocked(reportsClient.fetchReturnsReport);
const listWarehouses = vi.mocked(warehousesClient.listWarehouses);

const SALES: SalesReportView = {
  groupBy: 'day',
  dateFrom: '2026-06-01',
  dateTo: '2026-06-30',
  rows: [
    {
      period: '2026-06-10',
      invoiceCount: 3,
      subtotalAmount: '100000',
      vatAmount: '20000',
      totalAmount: '120000',
      currency: 'TRY',
    },
  ],
};

const INVENTORY: InventoryReportView = {
  data: [
    {
      productId: 'p-1',
      sku: 'SKU-1',
      name: 'Widget',
      warehouseId: 'wh-1',
      onHand: '9007199254740993',
      reserved: '1',
      available: '9007199254740992',
      criticalStockThreshold: '10',
      isLowStock: false,
    },
  ],
  pageInfo: { nextCursor: null, hasNextPage: false },
};

const RETURNS: ReturnsReportView = {
  returnCount: 4,
  requestedCount: 1,
  approvedCount: 3,
  totalReturnedQuantity: '123456789012345',
  creditNoteCount: 2,
  creditNoteTotalAmount: [{ amount: '250000', currency: 'TRY' }],
};

beforeEach(() => {
  searchParamsValue = new URLSearchParams('');
  fetchSalesReport.mockReset().mockResolvedValue(SALES);
  fetchInventoryReport.mockReset().mockResolvedValue(INVENTORY);
  fetchReturnsReport.mockReset().mockResolvedValue(RETURNS);
  // Best-effort warehouse list; default to none so the filter stays hidden.
  listWarehouses.mockReset().mockResolvedValue({
    data: [],
    pageInfo: { nextCursor: null, hasNextPage: false },
  });
});

afterEach(() => vi.clearAllMocks());

describe('ReportsPage', () => {
  it('lands on the sales tab, shows the loading state, then renders the sales report', async () => {
    let resolve!: (v: SalesReportView) => void;
    fetchSalesReport.mockReturnValueOnce(new Promise<SalesReportView>((r) => (resolve = r)));

    render(<ReportsPage />);

    expect(screen.getByTestId('sales-loading')).toBeDefined();
    resolve(SALES);

    await waitFor(() => expect(screen.getByTestId('sales-table')).toBeDefined());
    expect(fetchSalesReport).toHaveBeenCalledTimes(1);
    // The minor-unit total is BigInt-safe formatted (1.200,00 TRY).
    const total = screen.getByTestId('sales-row-2026-06-10-TRY').textContent ?? '';
    expect(total).toMatch(/1\.200,00\s*TRY/);
  });

  it('shows the sales empty state when there are no buckets', async () => {
    fetchSalesReport.mockResolvedValueOnce({ ...SALES, rows: [] });
    render(<ReportsPage />);
    await waitFor(() => expect(screen.getByTestId('sales-empty')).toBeDefined());
  });

  it('shows a sales error with a retry that re-fetches', async () => {
    fetchSalesReport.mockRejectedValueOnce(
      new ApiError(500, 'Server Error', {
        type: 'about:blank',
        title: 'Server Error',
        status: 500,
        code: 'INTERNAL',
        detail: 'reports backend exploded',
      }),
    );
    render(<ReportsPage />);

    const error = await screen.findByTestId('sales-error');
    // RFC 7807 `detail` is surfaced verbatim via problemMessages().
    expect(error.textContent).toMatch(/reports backend exploded/i);

    fetchSalesReport.mockResolvedValueOnce(SALES);
    fireEvent.click(within(error).getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.getByTestId('sales-table')).toBeDefined());
  });

  it('re-fetches the sales report with the new range when a date filter changes', async () => {
    render(<ReportsPage />);
    await waitFor(() => expect(screen.getByTestId('sales-table')).toBeDefined());

    fireEvent.change(screen.getByLabelText('sales date from'), {
      target: { value: '2026-01-01' },
    });

    await waitFor(() =>
      expect(fetchSalesReport).toHaveBeenLastCalledWith(
        expect.objectContaining({ dateFrom: '2026-01-01' }),
      ),
    );
    // Sales has no status filter (the contract doesn't expose one).
    expect(screen.queryByLabelText('returns status')).toBeNull();
  });

  it('switches to the inventory tab, calls the inventory endpoint and renders rows BigInt-safe', async () => {
    render(<ReportsPage />);
    await waitFor(() => expect(screen.getByTestId('sales-table')).toBeDefined());

    fireEvent.click(screen.getByTestId('reports-tab-inventory'));

    await waitFor(() => expect(screen.getByTestId('inventory-table')).toBeDefined());
    expect(fetchInventoryReport).toHaveBeenCalledTimes(1);
    // The huge available figure keeps every digit (no Number() rounding to ...992).
    const available = screen.getByTestId('inventory-available-p-1-wh-1').textContent ?? '';
    expect(available.replace(/\D/g, '')).toBe('9007199254740992');
    const onHand = screen.getByTestId('inventory-onhand-p-1-wh-1').textContent ?? '';
    expect(onHand.replace(/\D/g, '')).toBe('9007199254740993');
  });

  it('shows the inventory empty and error states', async () => {
    fetchInventoryReport.mockResolvedValueOnce({
      data: [],
      pageInfo: { nextCursor: null, hasNextPage: false },
    });
    render(<ReportsPage />);
    await waitFor(() => expect(screen.getByTestId('sales-table')).toBeDefined());

    fireEvent.click(screen.getByTestId('reports-tab-inventory'));
    await waitFor(() => expect(screen.getByTestId('inventory-empty')).toBeDefined());

    fetchInventoryReport.mockRejectedValueOnce(new Error('inv-down'));
    // Re-mount the tab to refetch (switch away and back).
    fireEvent.click(screen.getByTestId('reports-tab-sales'));
    fireEvent.click(screen.getByTestId('reports-tab-inventory'));
    await waitFor(() => expect(screen.getByTestId('inventory-error')).toBeDefined());
  });

  it('switches to the returns tab, calls the returns endpoint and shows BigInt-safe money/qty', async () => {
    render(<ReportsPage />);
    await waitFor(() => expect(screen.getByTestId('sales-table')).toBeDefined());

    fireEvent.click(screen.getByTestId('reports-tab-returns'));

    await waitFor(() => expect(screen.getByTestId('returns-report-cards')).toBeDefined());
    expect(fetchReturnsReport).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('returns-report-total').textContent).toBe('4');
    const qty = screen.getByTestId('returns-report-quantity').textContent ?? '';
    expect(qty.replace(/\D/g, '')).toBe('123456789012345');
    const cnTotal = screen.getByTestId('returns-report-cn-total').textContent ?? '';
    expect(cnTotal).toMatch(/2\.500,00\s*TRY/);
  });

  it('shows the returns empty and error states', async () => {
    fetchReturnsReport.mockResolvedValueOnce({ ...RETURNS, returnCount: 0 });
    render(<ReportsPage />);
    await waitFor(() => expect(screen.getByTestId('sales-table')).toBeDefined());

    fireEvent.click(screen.getByTestId('reports-tab-returns'));
    await waitFor(() => expect(screen.getByTestId('returns-report-empty')).toBeDefined());

    fetchReturnsReport.mockRejectedValueOnce(new Error('ret-down'));
    fireEvent.click(screen.getByTestId('reports-tab-sales'));
    fireEvent.click(screen.getByTestId('reports-tab-returns'));
    await waitFor(() => expect(screen.getByTestId('returns-report-error')).toBeDefined());
  });

  it('only fires the active tab’s endpoint when switching tabs', async () => {
    render(<ReportsPage />);
    await waitFor(() => expect(screen.getByTestId('sales-table')).toBeDefined());
    expect(fetchInventoryReport).not.toHaveBeenCalled();
    expect(fetchReturnsReport).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('reports-tab-inventory'));
    await waitFor(() => expect(fetchInventoryReport).toHaveBeenCalledTimes(1));
    expect(fetchReturnsReport).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('reports-tab-returns'));
    await waitFor(() => expect(fetchReturnsReport).toHaveBeenCalledTimes(1));
    // Sales was only fetched once, on the initial landing.
    expect(fetchSalesReport).toHaveBeenCalledTimes(1);
  });

  it('opens the inventory tab directly when deep-linked via ?tab=inventory', async () => {
    searchParamsValue = new URLSearchParams('tab=inventory');
    render(<ReportsPage />);

    await waitFor(() => expect(screen.getByTestId('inventory-table')).toBeDefined());
    expect(fetchInventoryReport).toHaveBeenCalledTimes(1);
    expect(fetchSalesReport).not.toHaveBeenCalled();
  });

  it('follows a same-route ?tab= change (sidebar Inventory link while on /reports)', async () => {
    const { rerender } = render(<ReportsPage />);
    await waitFor(() => expect(screen.getByTestId('sales-table')).toBeDefined());

    // Simulate the App Router updating the query without remounting the page:
    // useSearchParams now reports ?tab=inventory and the page re-renders.
    searchParamsValue = new URLSearchParams('tab=inventory');
    rerender(<ReportsPage />);

    await waitFor(() => expect(screen.getByTestId('inventory-table')).toBeDefined());
    expect(fetchInventoryReport).toHaveBeenCalledTimes(1);
  });
});
