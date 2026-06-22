import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { OrderListView, OrderView, ReturnView } from '@b2b/contracts';
import OrdersPage from '../app/(app)/orders/page';
import { ApiError } from '../src/lib/api-fetch';
import * as ordersClient from '../src/lib/orders-client';
import * as returnsClient from '../src/lib/returns-client';

// next/link needs an app-router context to mount; in a unit test we only care that
// it renders an anchor for the "View in returns" success affordance.
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('../src/lib/orders-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/orders-client')>();
  return { ...actual, listOrders: vi.fn(), getOrder: vi.fn() };
});
vi.mock('../src/lib/returns-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/returns-client')>();
  return { ...actual, createReturn: vi.fn() };
});

const listOrders = vi.mocked(ordersClient.listOrders);
const getOrder = vi.mocked(ordersClient.getOrder);
const createReturn = vi.mocked(returnsClient.createReturn);

const money = (amount: string, currency = 'TRY') => ({ amount, currency });

function order(over: Partial<OrderView> = {}): OrderView {
  return {
    id: 'ord-1',
    orderNo: 'ORD-0001',
    customerId: 'cust-1',
    warehouseId: 'wh-1',
    status: 'SHIPPED',
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
        quantity: '3',
        unitPrice: money('5000'),
        vatRate: 2000,
        lineSubtotal: money('15000'),
        lineVat: money('3000'),
        lineTotal: money('18000'),
      },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    approvedAt: null,
    shippedAt: '2026-01-02T00:00:00.000Z',
    cancelledAt: null,
    ...over,
  };
}

function ret(over: Partial<ReturnView> = {}): ReturnView {
  return {
    id: 'ret-1',
    returnNo: 'RET-20260101-ABCDEF0123',
    status: 'DRAFT',
    orderId: 'ord-1',
    customerId: 'cust-1',
    warehouseId: 'wh-1',
    invoiceId: null,
    reason: null,
    items: [{ productId: 'p1', quantity: '2', reason: null }],
    createdAt: '2026-01-03T00:00:00.000Z',
    approvedAt: null,
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

/** Open the create-return modal for a SHIPPED order. */
async function openCreateReturn(): Promise<void> {
  await openDetail('SHIPPED');
  fireEvent.click(screen.getByTestId('detail-create-return'));
  await screen.findByTestId('create-return-modal');
}

beforeEach(() => {
  vi.clearAllMocks();
  listOrders.mockResolvedValue(orderPage([order()]));
  getOrder.mockResolvedValue(order());
});

describe('Order detail — create return visibility', () => {
  it('shows the create-return action for a SHIPPED order', async () => {
    await openDetail('SHIPPED');
    expect(screen.getByTestId('detail-create-return')).toBeDefined();
  });

  it('hides the create-return action for a non-SHIPPED (DRAFT) order', async () => {
    await openDetail('DRAFT');
    expect(screen.queryByTestId('detail-create-return')).toBeNull();
  });

  it('hides the create-return action for an APPROVED order', async () => {
    await openDetail('APPROVED');
    expect(screen.queryByTestId('detail-create-return')).toBeNull();
  });
});

describe('Order detail — create return form', () => {
  it('builds the form from the order line items', async () => {
    await openCreateReturn();
    const modal = screen.getByTestId('create-return-modal');
    expect(within(modal).getByTestId('return-line-p1')).toBeDefined();
    expect(within(modal).getByText(/SKU-1 — Widget/)).toBeDefined();
  });

  it('requires at least one item to be selected', async () => {
    await openCreateReturn();
    fireEvent.click(screen.getByTestId('confirm-create-return'));
    const error = await screen.findByTestId('create-return-error');
    expect(error.textContent).toMatch(/at least one item/i);
    expect(createReturn).not.toHaveBeenCalled();
  });

  it('rejects a non-positive quantity client-side', async () => {
    await openCreateReturn();
    fireEvent.click(screen.getByTestId('return-include-p1'));
    fireEvent.change(screen.getByTestId('return-qty-p1'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('confirm-create-return'));
    const error = await screen.findByTestId('create-return-error');
    expect(error.textContent).toMatch(/positive whole number/i);
    expect(createReturn).not.toHaveBeenCalled();
  });

  it('rejects a quantity exceeding the shipped quantity client-side', async () => {
    await openCreateReturn();
    fireEvent.click(screen.getByTestId('return-include-p1'));
    fireEvent.change(screen.getByTestId('return-qty-p1'), { target: { value: '99' } });
    fireEvent.click(screen.getByTestId('confirm-create-return'));
    const error = await screen.findByTestId('create-return-error');
    expect(error.textContent).toMatch(/cannot exceed the shipped quantity/i);
    expect(createReturn).not.toHaveBeenCalled();
  });

  it('creates the return (Idempotency-Key, no server-derived fields) and shows the number + refreshes', async () => {
    await openCreateReturn();
    createReturn.mockResolvedValue(ret());
    const ordersBefore = listOrders.mock.calls.length;
    const detailBefore = getOrder.mock.calls.length;

    fireEvent.click(screen.getByTestId('return-include-p1'));
    fireEvent.change(screen.getByTestId('return-qty-p1'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('confirm-create-return'));

    await waitFor(() => expect(createReturn).toHaveBeenCalledTimes(1));
    const [orderId, input, key] = createReturn.mock.calls[0]!;
    expect(orderId).toBe('ord-1');
    expect(input).toEqual({ items: [{ productId: 'p1', quantity: '2', reason: null }], reason: null });
    expect(typeof key).toBe('string');
    expect((key as string).length).toBeGreaterThan(0);
    // No server-derived fields in the payload.
    expect(JSON.stringify(input)).not.toMatch(/companyId|warehouseId|price|subtotal|total|tax|status/i);

    const no = await screen.findByTestId('created-return-no');
    expect(no.textContent).toBe('RET-20260101-ABCDEF0123');
    expect(screen.getByTestId('goto-returns')).toBeDefined();
    await waitFor(() => expect(listOrders.mock.calls.length).toBeGreaterThan(ordersBefore));
    await waitFor(() => expect(getOrder.mock.calls.length).toBeGreaterThan(detailBefore));
  });

  it('shows an RFC7807 error inline when create fails', async () => {
    await openCreateReturn();
    createReturn.mockRejectedValue(
      new ApiError(409, 'Conflict', {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        code: 'CONFLICT',
        detail: 'Return quantity exceeds the returnable quantity',
      }),
    );

    fireEvent.click(screen.getByTestId('return-include-p1'));
    fireEvent.change(screen.getByTestId('return-qty-p1'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('confirm-create-return'));

    const error = await screen.findByTestId('create-return-error');
    expect(error.textContent).toMatch(/returnable quantity/i);
    expect(screen.queryByTestId('create-return-success')).toBeNull();
  });

  it('reuses the SAME Idempotency-Key when a failed create is retried', async () => {
    await openCreateReturn();
    createReturn.mockRejectedValueOnce(
      new ApiError(503, 'Unavailable', {
        type: 'about:blank',
        title: 'Service Unavailable',
        status: 503,
        code: 'INTERNAL',
        detail: 'Try again',
      }),
    );

    fireEvent.click(screen.getByTestId('return-include-p1'));
    fireEvent.change(screen.getByTestId('return-qty-p1'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('confirm-create-return'));
    await screen.findByTestId('create-return-error');

    createReturn.mockResolvedValueOnce(ret());
    fireEvent.click(screen.getByTestId('confirm-create-return'));

    await waitFor(() => expect(createReturn).toHaveBeenCalledTimes(2));
    const firstKey = createReturn.mock.calls[0]![2];
    const secondKey = createReturn.mock.calls[1]![2];
    expect(secondKey).toBe(firstKey);
  });
});
