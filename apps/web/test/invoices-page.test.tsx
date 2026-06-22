import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { InvoiceListView, InvoiceView } from '@b2b/contracts';
import InvoicesPage from '../app/(app)/invoices/page';
import { ApiError } from '../src/lib/api-fetch';
import * as invoicesClient from '../src/lib/invoices-client';

vi.mock('../src/lib/invoices-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/invoices-client')>();
  return {
    ...actual, // keep the real problemMessages
    listInvoices: vi.fn(),
    getInvoice: vi.fn(),
  };
});

const listInvoices = vi.mocked(invoicesClient.listInvoices);
const getInvoice = vi.mocked(invoicesClient.getInvoice);

const money = (amount: string, currency = 'TRY') => ({ amount, currency });

function invoice(over: Partial<InvoiceView> = {}): InvoiceView {
  return {
    id: 'inv-1',
    invoiceNo: 'INV-2026-000001',
    invoiceNumber: '1',
    seriesCode: 'INV',
    fiscalYear: 2026,
    status: 'ISSUED',
    orderId: 'ord-1',
    customerId: 'cust-1',
    warehouseId: 'wh-1',
    currency: 'TRY',
    subtotal: money('10000'),
    vat: money('2000'),
    total: money('12000'),
    items: [
      {
        productId: 'p1',
        description: 'Widget',
        quantity: '2',
        unitPrice: money('5000'),
        vatRate: 2000,
        lineSubtotal: money('10000'),
        lineVat: money('2000'),
        lineTotal: money('12000'),
      },
    ],
    issuedAt: '2026-01-02T00:00:00.000Z',
    createdAt: '2026-01-02T00:00:00.000Z',
    ...over,
  };
}

function invoicePage(
  invoices: InvoiceView[],
  hasNextPage = false,
  nextCursor: string | null = null,
): InvoiceListView {
  return { data: invoices, pageInfo: { hasNextPage, nextCursor } };
}

beforeEach(() => {
  vi.clearAllMocks();
  listInvoices.mockResolvedValue(invoicePage([invoice()]));
  getInvoice.mockResolvedValue(invoice());
});

describe('InvoicesPage — list', () => {
  it('shows loading then renders the invoice rows', async () => {
    render(<InvoicesPage />);
    expect(screen.getByTestId('invoices-loading')).toBeDefined();

    await screen.findByTestId('invoices-table');
    expect(screen.getByText('INV-2026-000001')).toBeDefined();
  });

  it('renders an empty state when there are no invoices', async () => {
    listInvoices.mockResolvedValue(invoicePage([]));
    render(<InvoicesPage />);
    await screen.findByTestId('invoices-empty');
  });

  it('shows an error state with a working retry', async () => {
    listInvoices.mockRejectedValueOnce(new Error('boom'));
    render(<InvoicesPage />);

    await screen.findByTestId('invoices-error');
    listInvoices.mockResolvedValueOnce(invoicePage([invoice()]));
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByTestId('invoices-table');
  });

  it('reflects the status filter in the list query', async () => {
    render(<InvoicesPage />);
    await screen.findByTestId('invoices-table');

    fireEvent.change(screen.getByLabelText('filter by status'), { target: { value: 'ISSUED' } });

    await waitFor(() =>
      expect(listInvoices).toHaveBeenCalledWith(expect.objectContaining({ status: 'ISSUED' })),
    );
  });

  it('paginates with Next/Previous using the cursor', async () => {
    listInvoices.mockResolvedValueOnce(invoicePage([invoice()], true, 'cur-2'));
    render(<InvoicesPage />);
    await screen.findByTestId('invoices-table');

    listInvoices.mockResolvedValueOnce(
      invoicePage([invoice({ id: 'inv-2', invoiceNo: 'INV-2026-000002' })]),
    );
    fireEvent.click(screen.getByTestId('page-next'));

    await waitFor(() =>
      expect(listInvoices).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'cur-2' })),
    );
    await screen.findByText('INV-2026-000002');
  });

  it('formats large totals without precision loss', async () => {
    // 90,071,992,547,409.91 — beyond Number.MAX_SAFE_INTEGER in minor units.
    listInvoices.mockResolvedValue(invoicePage([invoice({ total: money('9007199254740991') })]));
    render(<InvoicesPage />);
    await screen.findByTestId('invoices-table');

    const cell = screen.getByTestId('invoice-total-inv-1');
    expect(cell.textContent).toContain('90.071.992.547.409,91');
  });
});

describe('InvoicesPage — detail', () => {
  it('opens the drawer and lists the invoice line items', async () => {
    render(<InvoicesPage />);
    await screen.findByTestId('invoices-table');

    fireEvent.click(screen.getByTestId('open-detail-inv-1'));

    await screen.findByTestId('invoice-detail-drawer');
    expect(getInvoice).toHaveBeenCalledWith('inv-1');
    const items = await screen.findByTestId('invoice-items-table');
    expect(within(items).getByText('Widget')).toBeDefined();
    expect(screen.getByTestId('detail-invoice-no').textContent).toBe('INV-2026-000001');
  });

  it('shows an RFC7807 error in the detail drawer with a working retry', async () => {
    getInvoice.mockRejectedValueOnce(
      new ApiError(404, 'Not Found', {
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        code: 'NOT_FOUND',
        detail: 'Invoice not found',
      }),
    );
    render(<InvoicesPage />);
    await screen.findByTestId('invoices-table');

    fireEvent.click(screen.getByTestId('open-detail-inv-1'));
    const error = await screen.findByTestId('invoice-detail-error');
    expect(error.textContent).toMatch(/invoice not found/i);

    getInvoice.mockResolvedValueOnce(invoice());
    fireEvent.click(within(error).getByRole('button', { name: /retry/i }));
    await screen.findByTestId('invoice-items-table');
  });
});
