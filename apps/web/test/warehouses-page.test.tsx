import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { WarehouseListView, WarehouseView } from '@b2b/contracts';
import WarehousesPage from '../app/(app)/warehouses/page';
import { ApiError } from '../src/lib/api-fetch';
import * as warehousesClient from '../src/lib/warehouses-client';

vi.mock('../src/lib/warehouses-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/warehouses-client')>();
  return {
    ...actual, // keep the real problemMessages
    listWarehouses: vi.fn(),
    createWarehouse: vi.fn(),
    updateWarehouse: vi.fn(),
    deleteWarehouse: vi.fn(),
  };
});

const listWarehouses = vi.mocked(warehousesClient.listWarehouses);
const createWarehouse = vi.mocked(warehousesClient.createWarehouse);
const updateWarehouse = vi.mocked(warehousesClient.updateWarehouse);
const deleteWarehouse = vi.mocked(warehousesClient.deleteWarehouse);

function warehouse(over: Partial<WarehouseView> = {}): WarehouseView {
  return {
    id: 'wh-1',
    code: 'MAIN',
    name: 'Main Warehouse',
    addressLine1: null,
    addressLine2: null,
    city: 'Istanbul',
    postalCode: null,
    country: 'TR',
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function page(
  warehouses: WarehouseView[],
  hasNextPage = false,
  nextCursor: string | null = null,
): WarehouseListView {
  return { data: warehouses, pageInfo: { hasNextPage, nextCursor } };
}

beforeEach(() => {
  vi.clearAllMocks();
  listWarehouses.mockResolvedValue(page([warehouse()]));
});

describe('WarehousesPage — list', () => {
  it('shows loading then renders the warehouse rows', async () => {
    render(<WarehousesPage />);
    expect(screen.getByTestId('warehouses-loading')).toBeDefined();

    await screen.findByTestId('warehouses-table');
    expect(screen.getByText('MAIN')).toBeDefined();
    expect(screen.getByText('Main Warehouse')).toBeDefined();
    expect(screen.getByText('Istanbul')).toBeDefined();
  });

  it('renders an empty state when there are no warehouses', async () => {
    listWarehouses.mockResolvedValue(page([]));
    render(<WarehousesPage />);
    await screen.findByTestId('warehouses-empty');
  });

  it('shows an error state with a working retry', async () => {
    listWarehouses.mockRejectedValueOnce(new Error('boom'));
    render(<WarehousesPage />);

    await screen.findByTestId('warehouses-error');
    listWarehouses.mockResolvedValueOnce(page([warehouse()]));
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByTestId('warehouses-table');
  });

  it('reflects the search input in the list query', async () => {
    render(<WarehousesPage />);
    await screen.findByTestId('warehouses-table');

    fireEvent.change(screen.getByLabelText('search warehouses'), { target: { value: 'mai' } });

    await waitFor(() =>
      expect(listWarehouses).toHaveBeenCalledWith(expect.objectContaining({ search: 'mai' })),
    );
  });

  it('reflects the isActive filter in the list query', async () => {
    render(<WarehousesPage />);
    await screen.findByTestId('warehouses-table');

    fireEvent.change(screen.getByLabelText('filter by status'), { target: { value: 'inactive' } });

    await waitFor(() =>
      expect(listWarehouses).toHaveBeenCalledWith(expect.objectContaining({ isActive: 'false' })),
    );
  });
});

describe('WarehousesPage — create', () => {
  it('creates a warehouse (without companyId) and refreshes the list', async () => {
    createWarehouse.mockResolvedValue(warehouse({ id: 'new' }));
    render(<WarehousesPage />);
    await screen.findByTestId('warehouses-table');
    const before = listWarehouses.mock.calls.length;

    fireEvent.click(screen.getByTestId('open-create'));
    const form = await screen.findByTestId('warehouse-form-modal');
    fireEvent.change(within(form).getByLabelText('code'), { target: { value: 'WH-2' } });
    fireEvent.change(within(form).getByLabelText('name'), { target: { value: 'Second' } });
    fireEvent.click(within(form).getByRole('button', { name: /save/i }));

    await waitFor(() => expect(createWarehouse).toHaveBeenCalledTimes(1));
    const payload = createWarehouse.mock.calls[0]![0];
    expect(payload).not.toHaveProperty('companyId');
    expect(payload.code).toBe('WH-2');
    // Modal closed + list refreshed.
    await waitFor(() => expect(screen.queryByTestId('warehouse-form-modal')).toBeNull());
    expect(listWarehouses.mock.calls.length).toBeGreaterThan(before);
  });

  it('shows client validation errors and does not call the API', async () => {
    render(<WarehousesPage />);
    await screen.findByTestId('warehouses-table');

    fireEvent.click(screen.getByTestId('open-create'));
    const form = await screen.findByTestId('warehouse-form-modal');
    // Code/name empty by default → submit should be blocked client-side.
    fireEvent.click(within(form).getByRole('button', { name: /save/i }));

    const error = await screen.findByTestId('warehouse-form-error');
    expect(error.textContent).toMatch(/code is required/i);
    expect(createWarehouse).not.toHaveBeenCalled();
  });

  it('surfaces a server RFC7807 duplicate-code error', async () => {
    createWarehouse.mockRejectedValue(
      new ApiError(409, 'Conflict', {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        code: 'CONFLICT',
        detail: 'A warehouse with code "MAIN" already exists in this company',
      }),
    );
    render(<WarehousesPage />);
    await screen.findByTestId('warehouses-table');

    fireEvent.click(screen.getByTestId('open-create'));
    const form = await screen.findByTestId('warehouse-form-modal');
    fireEvent.change(within(form).getByLabelText('code'), { target: { value: 'MAIN' } });
    fireEvent.change(within(form).getByLabelText('name'), { target: { value: 'Dup' } });
    fireEvent.click(within(form).getByRole('button', { name: /save/i }));

    const error = await screen.findByTestId('warehouse-form-error');
    expect(error.textContent).toMatch(/already exists/i);
  });
});

describe('WarehousesPage — edit', () => {
  it('prefills the form and updates the warehouse, then refreshes', async () => {
    updateWarehouse.mockResolvedValue(warehouse({ name: 'Renamed' }));
    render(<WarehousesPage />);
    await screen.findByTestId('warehouses-table');
    const before = listWarehouses.mock.calls.length;

    fireEvent.click(screen.getByTestId('edit-wh-1'));
    const form = await screen.findByTestId('warehouse-form-modal');
    expect((within(form).getByLabelText('code') as HTMLInputElement).value).toBe('MAIN');

    fireEvent.change(within(form).getByLabelText('name'), { target: { value: 'Renamed' } });
    fireEvent.click(within(form).getByRole('button', { name: /save/i }));

    await waitFor(() => expect(updateWarehouse).toHaveBeenCalledTimes(1));
    expect(updateWarehouse.mock.calls[0]![0]).toBe('wh-1');
    expect(updateWarehouse.mock.calls[0]![1]).toEqual(expect.objectContaining({ name: 'Renamed' }));
    expect(updateWarehouse.mock.calls[0]![1]).not.toHaveProperty('companyId');
    await waitFor(() => expect(listWarehouses.mock.calls.length).toBeGreaterThan(before));
  });
});

describe('WarehousesPage — delete', () => {
  it('confirms then deletes and refreshes the list', async () => {
    deleteWarehouse.mockResolvedValue(undefined);
    render(<WarehousesPage />);
    await screen.findByTestId('warehouses-table');
    const before = listWarehouses.mock.calls.length;

    fireEvent.click(screen.getByTestId('delete-wh-1'));
    const dialog = await screen.findByTestId('warehouse-delete-dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-delete'));

    await waitFor(() => expect(deleteWarehouse).toHaveBeenCalledWith('wh-1'));
    await waitFor(() => expect(listWarehouses.mock.calls.length).toBeGreaterThan(before));
  });

  it('shows an error and keeps the dialog open when delete fails', async () => {
    deleteWarehouse.mockRejectedValue(
      new ApiError(409, 'Conflict', {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        code: 'CONFLICT',
        detail: 'Warehouse still has stock balances',
      }),
    );
    render(<WarehousesPage />);
    await screen.findByTestId('warehouses-table');

    fireEvent.click(screen.getByTestId('delete-wh-1'));
    const dialog = await screen.findByTestId('warehouse-delete-dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-delete'));

    const error = await screen.findByTestId('warehouse-delete-error');
    expect(error.textContent).toMatch(/still has stock/i);
    expect(screen.getByTestId('warehouse-delete-dialog')).toBeDefined();
  });
});
