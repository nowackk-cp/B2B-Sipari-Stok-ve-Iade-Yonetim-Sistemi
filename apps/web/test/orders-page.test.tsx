import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  CustomerListView,
  OrderListView,
  OrderView,
  ProductListView,
  WarehouseListView,
} from '@b2b/contracts';
import OrdersPage from '../app/(app)/orders/page';
import { ApiError } from '../src/lib/api-fetch';
import * as ordersClient from '../src/lib/orders-client';
import * as customersClient from '../src/lib/customers-client';
import * as warehousesClient from '../src/lib/warehouses-client';
import * as productsClient from '../src/lib/products-client';

vi.mock('../src/lib/orders-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/orders-client')>();
  return {
    ...actual, // keep the real problemMessages
    listOrders: vi.fn(),
    getOrder: vi.fn(),
    createOrder: vi.fn(),
    updateOrder: vi.fn(),
    cancelOrder: vi.fn(),
  };
});
vi.mock('../src/lib/customers-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/customers-client')>();
  return { ...actual, listCustomers: vi.fn() };
});
vi.mock('../src/lib/warehouses-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/warehouses-client')>();
  return { ...actual, listWarehouses: vi.fn() };
});
vi.mock('../src/lib/products-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/products-client')>();
  return { ...actual, listProducts: vi.fn() };
});

const listOrders = vi.mocked(ordersClient.listOrders);
const getOrder = vi.mocked(ordersClient.getOrder);
const createOrder = vi.mocked(ordersClient.createOrder);
const updateOrder = vi.mocked(ordersClient.updateOrder);
const cancelOrder = vi.mocked(ordersClient.cancelOrder);
const listCustomers = vi.mocked(customersClient.listCustomers);
const listWarehouses = vi.mocked(warehousesClient.listWarehouses);
const listProducts = vi.mocked(productsClient.listProducts);

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

function orderPage(
  orders: OrderView[],
  hasNextPage = false,
  nextCursor: string | null = null,
): OrderListView {
  return { data: orders, pageInfo: { hasNextPage, nextCursor } };
}

beforeEach(() => {
  vi.clearAllMocks();
  listOrders.mockResolvedValue(orderPage([order()]));
  getOrder.mockResolvedValue(order());
  listCustomers.mockResolvedValue({
    data: [
      {
        id: 'cust-1',
        code: 'CUST-1',
        name: 'Acme',
        type: 'COMPANY',
        taxNumber: null,
        email: null,
        phone: null,
        createdAt: '',
        updatedAt: '',
      },
    ],
    pageInfo: { hasNextPage: false, nextCursor: null },
  } satisfies CustomerListView);
  listWarehouses.mockResolvedValue({
    data: [
      {
        id: 'wh-1',
        code: 'WH-1',
        name: 'Main',
        addressLine1: null,
        addressLine2: null,
        city: null,
        postalCode: null,
        country: null,
        isActive: true,
        createdAt: '',
        updatedAt: '',
      },
    ],
    pageInfo: { hasNextPage: false, nextCursor: null },
  } satisfies WarehouseListView);
  listProducts.mockResolvedValue({
    data: [
      {
        id: 'p1',
        sku: 'SKU-1',
        name: 'Widget',
        description: null,
        barcode: null,
        unit: 'EACH',
        categoryId: null,
        vatRate: 2000,
        listPrice: money('5000'),
        isActive: true,
        criticalStockThreshold: null,
        createdAt: '',
        updatedAt: '',
      },
    ],
    pageInfo: { hasNextPage: false, nextCursor: null },
  } satisfies ProductListView);
});

describe('OrdersPage — list', () => {
  it('shows loading then renders the order rows', async () => {
    render(<OrdersPage />);
    expect(screen.getByTestId('orders-loading')).toBeDefined();

    await screen.findByTestId('orders-table');
    expect(screen.getByText('ORD-0001')).toBeDefined();
  });

  it('renders an empty state when there are no orders', async () => {
    listOrders.mockResolvedValue(orderPage([]));
    render(<OrdersPage />);
    await screen.findByTestId('orders-empty');
  });

  it('shows an error state with a working retry', async () => {
    listOrders.mockRejectedValueOnce(new Error('boom'));
    render(<OrdersPage />);

    await screen.findByTestId('orders-error');
    listOrders.mockResolvedValueOnce(orderPage([order()]));
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByTestId('orders-table');
  });

  it('reflects the status filter in the list query', async () => {
    render(<OrdersPage />);
    await screen.findByTestId('orders-table');

    fireEvent.change(screen.getByLabelText('filter by status'), { target: { value: 'APPROVED' } });

    await waitFor(() =>
      expect(listOrders).toHaveBeenCalledWith(expect.objectContaining({ status: 'APPROVED' })),
    );
  });

  it('paginates with Next/Previous using the cursor', async () => {
    listOrders.mockResolvedValueOnce(orderPage([order()], true, 'cur-2'));
    render(<OrdersPage />);
    await screen.findByTestId('orders-table');

    listOrders.mockResolvedValueOnce(orderPage([order({ id: 'ord-2', orderNo: 'ORD-0002' })]));
    fireEvent.click(screen.getByTestId('page-next'));

    await waitFor(() =>
      expect(listOrders).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'cur-2' })),
    );
    await screen.findByText('ORD-0002');
  });

  it('formats large totals without precision loss', async () => {
    // 90,071,992,547,409.91 — beyond Number.MAX_SAFE_INTEGER in minor units.
    listOrders.mockResolvedValue(orderPage([order({ total: money('9007199254740991') })]));
    render(<OrdersPage />);
    await screen.findByTestId('orders-table');

    const cell = screen.getByTestId('order-total-ord-1');
    expect(cell.textContent).toContain('90.071.992.547.409,91');
  });
});

describe('OrdersPage — detail', () => {
  it('opens the drawer and lists the order line items', async () => {
    render(<OrdersPage />);
    await screen.findByTestId('orders-table');

    fireEvent.click(screen.getByTestId('open-detail-ord-1'));

    await screen.findByTestId('order-detail-drawer');
    expect(getOrder).toHaveBeenCalledWith('ord-1');
    const items = await screen.findByTestId('order-items-table');
    expect(within(items).getByText('Widget')).toBeDefined();
    expect(within(items).getByText('SKU-1')).toBeDefined();
  });
});

describe('OrdersPage — create', () => {
  it('loads customer/warehouse/product options into the form', async () => {
    render(<OrdersPage />);
    await screen.findByTestId('orders-table');

    fireEvent.click(screen.getByTestId('open-create'));
    await screen.findByTestId('order-form-modal');

    await waitFor(() => expect(listCustomers).toHaveBeenCalled());
    expect(listWarehouses).toHaveBeenCalled();
    expect(listProducts).toHaveBeenCalled();

    await waitFor(() =>
      expect((screen.getByLabelText('customer') as HTMLSelectElement).disabled).toBe(false),
    );
    const form = screen.getByTestId('order-form-modal');
    expect(within(form).getByRole('option', { name: /CUST-1/ })).toBeDefined();
    expect(within(form).getByRole('option', { name: /WH-1/ })).toBeDefined();
    expect(within(form).getByRole('option', { name: /SKU-1/ })).toBeDefined();
  });

  it('creates an order and refreshes the list, never sending companyId/price/total', async () => {
    createOrder.mockResolvedValue(order({ id: 'new' }));
    render(<OrdersPage />);
    await screen.findByTestId('orders-table');
    const before = listOrders.mock.calls.length;

    fireEvent.click(screen.getByTestId('open-create'));
    const form = await screen.findByTestId('order-form-modal');
    await waitFor(() =>
      expect((within(form).getByLabelText('customer') as HTMLSelectElement).disabled).toBe(false),
    );

    fireEvent.change(within(form).getByLabelText('customer'), { target: { value: 'cust-1' } });
    fireEvent.change(within(form).getByLabelText('warehouse'), { target: { value: 'wh-1' } });
    fireEvent.change(within(form).getByLabelText('product 1'), { target: { value: 'p1' } });
    fireEvent.change(within(form).getByLabelText('quantity 1'), { target: { value: '4' } });
    fireEvent.click(within(form).getByRole('button', { name: /save/i }));

    await waitFor(() => expect(createOrder).toHaveBeenCalledTimes(1));
    const payload = createOrder.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(payload).not.toHaveProperty('companyId');
    expect(payload).not.toHaveProperty('unitPrice');
    expect(payload).not.toHaveProperty('vatRate');
    expect(payload).not.toHaveProperty('total');
    expect(payload.customerId).toBe('cust-1');
    expect(payload.items).toEqual([{ productId: 'p1', quantity: '4' }]);

    await waitFor(() => expect(screen.queryByTestId('order-form-modal')).toBeNull());
    expect(listOrders.mock.calls.length).toBeGreaterThan(before);
  });

  it('shows client validation errors and does not call the API', async () => {
    render(<OrdersPage />);
    await screen.findByTestId('orders-table');

    fireEvent.click(screen.getByTestId('open-create'));
    const form = await screen.findByTestId('order-form-modal');
    await waitFor(() =>
      expect((within(form).getByLabelText('customer') as HTMLSelectElement).disabled).toBe(false),
    );
    // Nothing selected → submit blocked client-side.
    fireEvent.click(within(form).getByRole('button', { name: /save/i }));

    const error = await screen.findByTestId('order-form-error');
    expect(error.textContent).toMatch(/customer is required/i);
    expect(createOrder).not.toHaveBeenCalled();
  });
});

describe('OrdersPage — edit', () => {
  it('prefills the DRAFT order and updates it, never sending companyId/price/total', async () => {
    updateOrder.mockResolvedValue(order());
    render(<OrdersPage />);
    await screen.findByTestId('orders-table');
    const before = listOrders.mock.calls.length;

    fireEvent.click(screen.getByTestId('edit-ord-1'));
    const form = await screen.findByTestId('order-form-modal');
    await waitFor(() =>
      expect((within(form).getByLabelText('customer') as HTMLSelectElement).disabled).toBe(false),
    );
    expect((within(form).getByLabelText('customer') as HTMLSelectElement).value).toBe('cust-1');
    expect((within(form).getByLabelText('quantity 1') as HTMLInputElement).value).toBe('2');

    fireEvent.change(within(form).getByLabelText('quantity 1'), { target: { value: '7' } });
    fireEvent.click(within(form).getByRole('button', { name: /save/i }));

    await waitFor(() => expect(updateOrder).toHaveBeenCalledTimes(1));
    expect(updateOrder.mock.calls[0]![0]).toBe('ord-1');
    const payload = updateOrder.mock.calls[0]![1] as unknown as Record<string, unknown>;
    expect(payload).not.toHaveProperty('companyId');
    expect(payload).not.toHaveProperty('total');
    expect(payload.items).toEqual([{ productId: 'p1', quantity: '7' }]);
    await waitFor(() => expect(listOrders.mock.calls.length).toBeGreaterThan(before));
  });

  it('disables edit/cancel actions for a non-DRAFT order', async () => {
    listOrders.mockResolvedValue(orderPage([order({ status: 'APPROVED' })]));
    render(<OrdersPage />);
    await screen.findByTestId('orders-table');

    expect((screen.getByTestId('edit-ord-1') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('cancel-ord-1') as HTMLButtonElement).disabled).toBe(true);
  });

  it('hides the draft actions in the detail drawer for a non-DRAFT order', async () => {
    getOrder.mockResolvedValue(order({ status: 'SHIPPED' }));
    render(<OrdersPage />);
    await screen.findByTestId('orders-table');

    fireEvent.click(screen.getByTestId('open-detail-ord-1'));
    await screen.findByTestId('order-detail-drawer');
    await screen.findByTestId('order-items-table');
    expect(screen.queryByTestId('detail-draft-actions')).toBeNull();
  });
});

describe('OrdersPage — cancel', () => {
  it('confirms then cancels and refreshes the list', async () => {
    cancelOrder.mockResolvedValue(order({ status: 'CANCELLED' }));
    render(<OrdersPage />);
    await screen.findByTestId('orders-table');
    const before = listOrders.mock.calls.length;

    fireEvent.click(screen.getByTestId('cancel-ord-1'));
    const dialog = await screen.findByTestId('order-cancel-dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-cancel'));

    await waitFor(() => expect(cancelOrder).toHaveBeenCalledWith('ord-1', null));
    await waitFor(() => expect(listOrders.mock.calls.length).toBeGreaterThan(before));
  });

  it('shows an error and keeps the dialog open when cancel fails', async () => {
    cancelOrder.mockRejectedValue(
      new ApiError(409, 'Conflict', {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        code: 'CONFLICT',
        detail: 'Order is no longer a draft',
      }),
    );
    render(<OrdersPage />);
    await screen.findByTestId('orders-table');

    fireEvent.click(screen.getByTestId('cancel-ord-1'));
    const dialog = await screen.findByTestId('order-cancel-dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-cancel'));

    const error = await screen.findByTestId('order-cancel-error');
    expect(error.textContent).toMatch(/no longer a draft/i);
    expect(screen.getByTestId('order-cancel-dialog')).toBeDefined();
  });
});
