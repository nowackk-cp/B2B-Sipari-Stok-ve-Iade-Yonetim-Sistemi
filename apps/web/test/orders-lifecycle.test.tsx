import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { InvoiceView, OrderListView, OrderView } from '@b2b/contracts';
import OrdersPage from '../app/(app)/orders/page';
import { ApiError } from '../src/lib/api-fetch';
import * as ordersClient from '../src/lib/orders-client';
import * as invoicesClient from '../src/lib/invoices-client';

// next/link needs an app-router context to mount; in a unit test we only care that
// it renders an anchor for the "View in invoices" success affordance.
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('../src/lib/orders-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/orders-client')>();
  return {
    ...actual, // keep the real problemMessages
    listOrders: vi.fn(),
    getOrder: vi.fn(),
    approveOrder: vi.fn(),
    shipOrder: vi.fn(),
  };
});
vi.mock('../src/lib/invoices-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/invoices-client')>();
  return { ...actual, issueInvoiceForOrder: vi.fn() };
});

const listOrders = vi.mocked(ordersClient.listOrders);
const getOrder = vi.mocked(ordersClient.getOrder);
const approveOrder = vi.mocked(ordersClient.approveOrder);
const shipOrder = vi.mocked(ordersClient.shipOrder);
const issueInvoiceForOrder = vi.mocked(invoicesClient.issueInvoiceForOrder);

const money = (amount: string, currency = 'TRY') => ({ amount, currency });

function order(over: Partial<OrderView> = {}): OrderView {
  return {
    id: 'ord-1',
    orderNo: 'ORD-0001',
    customerId: 'cust-1',
    warehouseId: 'wh-1',
    status: 'DRAFT',
    currency: 'TRY',
    subtotal: money('10000'),
    vat: money('2000'),
    total: money('12000'),
    note: null,
    items: [
      {
        productId: 'p1',
        sku: 'SKU-1',
        name: 'Widget',
        quantity: '2',
        unitPrice: money('5000'),
        vatRate: 2000,
        lineSubtotal: money('10000'),
        lineVat: money('2000'),
        lineTotal: money('12000'),
      },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    approvedAt: null,
    shippedAt: null,
    cancelledAt: null,
    ...over,
  };
}

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
    items: [],
    issuedAt: '2026-01-02T00:00:00.000Z',
    createdAt: '2026-01-02T00:00:00.000Z',
    ...over,
  };
}

function orderPage(orders: OrderView[]): OrderListView {
  return { data: orders, pageInfo: { hasNextPage: false, nextCursor: null } };
}

/** Open the detail drawer for the single listed order with the given status. */
async function openDetail(status: string): Promise<void> {
  listOrders.mockResolvedValue(orderPage([order({ status })]));
  getOrder.mockResolvedValue(order({ status }));
  render(<OrdersPage />);
  await screen.findByTestId('orders-table');
  fireEvent.click(screen.getByTestId('open-detail-ord-1'));
  await screen.findByTestId('order-detail-drawer');
  await screen.findByTestId('order-items-table');
}

beforeEach(() => {
  vi.clearAllMocks();
  listOrders.mockResolvedValue(orderPage([order()]));
  getOrder.mockResolvedValue(order());
});

describe('Order lifecycle actions — visibility by status', () => {
  it('shows the approve action only for a DRAFT order', async () => {
    await openDetail('DRAFT');
    expect(screen.getByTestId('detail-approve')).toBeDefined();
    expect(screen.queryByTestId('detail-ship')).toBeNull();
    expect(screen.queryByTestId('detail-issue-invoice')).toBeNull();
  });

  it('shows the ship action only for an APPROVED order', async () => {
    await openDetail('APPROVED');
    expect(screen.getByTestId('detail-ship')).toBeDefined();
    expect(screen.queryByTestId('detail-approve')).toBeNull();
    expect(screen.queryByTestId('detail-issue-invoice')).toBeNull();
  });

  it('shows the issue-invoice action only for a SHIPPED order', async () => {
    await openDetail('SHIPPED');
    expect(screen.getByTestId('detail-issue-invoice')).toBeDefined();
    expect(screen.queryByTestId('detail-approve')).toBeNull();
    expect(screen.queryByTestId('detail-ship')).toBeNull();
  });

  it('shows NO operation actions for a CANCELLED order', async () => {
    await openDetail('CANCELLED');
    expect(screen.queryByTestId('detail-draft-actions')).toBeNull();
    expect(screen.queryByTestId('detail-approve')).toBeNull();
    expect(screen.queryByTestId('detail-ship')).toBeNull();
    expect(screen.queryByTestId('detail-issue-invoice')).toBeNull();
  });
});

describe('Order lifecycle actions — approve', () => {
  it('confirms, calls approve (id only, no companyId/price/total), and refreshes detail + list', async () => {
    await openDetail('DRAFT');
    approveOrder.mockResolvedValue(order({ status: 'APPROVED' }));
    getOrder.mockResolvedValue(order({ status: 'APPROVED' }));
    const ordersBefore = listOrders.mock.calls.length;
    const detailBefore = getOrder.mock.calls.length;

    fireEvent.click(screen.getByTestId('detail-approve'));
    const dialog = await screen.findByTestId('order-approve-dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-approve'));

    await waitFor(() => expect(approveOrder).toHaveBeenCalledTimes(1));
    // Only the public id is sent — no body object with companyId/price/tax/total.
    expect(approveOrder.mock.calls[0]).toEqual(['ord-1']);
    await waitFor(() =>
      expect(listOrders.mock.calls.length).toBeGreaterThan(ordersBefore),
    );
    await waitFor(() => expect(getOrder.mock.calls.length).toBeGreaterThan(detailBefore));
  });

  it('shows an RFC7807 error inline and keeps the dialog open when approve fails', async () => {
    await openDetail('DRAFT');
    approveOrder.mockRejectedValue(
      new ApiError(409, 'Conflict', {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        code: 'CONFLICT',
        detail: 'Insufficient stock to reserve',
      }),
    );

    fireEvent.click(screen.getByTestId('detail-approve'));
    const dialog = await screen.findByTestId('order-approve-dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-approve'));

    const error = await screen.findByTestId('order-approve-error');
    expect(error.textContent).toMatch(/insufficient stock/i);
    expect(screen.getByTestId('order-approve-dialog')).toBeDefined();
  });
});

describe('Order lifecycle actions — ship', () => {
  it('confirms, ships with an Idempotency-Key, and refreshes detail + list', async () => {
    await openDetail('APPROVED');
    shipOrder.mockResolvedValue(order({ status: 'SHIPPED' }));
    getOrder.mockResolvedValue(order({ status: 'SHIPPED' }));
    const ordersBefore = listOrders.mock.calls.length;

    fireEvent.click(screen.getByTestId('detail-ship'));
    const dialog = await screen.findByTestId('order-ship-dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-ship'));

    await waitFor(() => expect(shipOrder).toHaveBeenCalledTimes(1));
    const [id, key] = shipOrder.mock.calls[0]!;
    expect(id).toBe('ord-1');
    expect(typeof key).toBe('string');
    expect((key as string).length).toBeGreaterThan(0);
    await waitFor(() => expect(listOrders.mock.calls.length).toBeGreaterThan(ordersBefore));
  });

  it('reuses the SAME Idempotency-Key when a failed ship is retried', async () => {
    await openDetail('APPROVED');
    shipOrder.mockRejectedValueOnce(
      new ApiError(503, 'Unavailable', {
        type: 'about:blank',
        title: 'Service Unavailable',
        status: 503,
        code: 'INTERNAL',
        detail: 'Try again',
      }),
    );

    fireEvent.click(screen.getByTestId('detail-ship'));
    const dialog = await screen.findByTestId('order-ship-dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-ship'));
    await screen.findByTestId('order-ship-error');

    shipOrder.mockResolvedValueOnce(order({ status: 'SHIPPED' }));
    fireEvent.click(within(dialog).getByTestId('confirm-ship'));

    await waitFor(() => expect(shipOrder).toHaveBeenCalledTimes(2));
    const firstKey = shipOrder.mock.calls[0]![1];
    const secondKey = shipOrder.mock.calls[1]![1];
    expect(secondKey).toBe(firstKey);
  });

  it('shows an RFC7807 error inline when ship fails', async () => {
    await openDetail('APPROVED');
    shipOrder.mockRejectedValue(
      new ApiError(422, 'Unprocessable', {
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        code: 'BUSINESS_RULE',
        detail: 'The order warehouse is no longer active',
      }),
    );

    fireEvent.click(screen.getByTestId('detail-ship'));
    const dialog = await screen.findByTestId('order-ship-dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-ship'));

    const error = await screen.findByTestId('order-ship-error');
    expect(error.textContent).toMatch(/no longer active/i);
  });
});

describe('Order lifecycle actions — issue invoice', () => {
  it('issues an invoice (Idempotency-Key, no body), shows the number and refreshes', async () => {
    await openDetail('SHIPPED');
    issueInvoiceForOrder.mockResolvedValue(invoice());
    const ordersBefore = listOrders.mock.calls.length;
    const detailBefore = getOrder.mock.calls.length;

    fireEvent.click(screen.getByTestId('detail-issue-invoice'));
    const dialog = await screen.findByTestId('order-invoice-dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-invoice'));

    await waitFor(() => expect(issueInvoiceForOrder).toHaveBeenCalledTimes(1));
    const [id, key] = issueInvoiceForOrder.mock.calls[0]!;
    expect(id).toBe('ord-1');
    expect(typeof key).toBe('string');
    expect((key as string).length).toBeGreaterThan(0);

    const no = await screen.findByTestId('issued-invoice-no');
    expect(no.textContent).toBe('INV-2026-000001');
    expect(screen.getByTestId('goto-invoices')).toBeDefined();
    await waitFor(() => expect(listOrders.mock.calls.length).toBeGreaterThan(ordersBefore));
    await waitFor(() => expect(getOrder.mock.calls.length).toBeGreaterThan(detailBefore));
  });

  it('shows the already-invoiced (409) error inline', async () => {
    await openDetail('SHIPPED');
    issueInvoiceForOrder.mockRejectedValue(
      new ApiError(409, 'Conflict', {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        code: 'CONFLICT',
        detail: 'Order has already been invoiced',
      }),
    );

    fireEvent.click(screen.getByTestId('detail-issue-invoice'));
    const dialog = await screen.findByTestId('order-invoice-dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-invoice'));

    const error = await screen.findByTestId('order-invoice-error');
    expect(error.textContent).toMatch(/already been invoiced/i);
    expect(screen.queryByTestId('order-invoice-success')).toBeNull();
  });
});
