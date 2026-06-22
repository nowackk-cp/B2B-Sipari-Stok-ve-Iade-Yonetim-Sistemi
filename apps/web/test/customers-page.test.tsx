import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CustomerListView, CustomerView } from '@b2b/contracts';
import CustomersPage from '../app/(app)/customers/page';
import { ApiError } from '../src/lib/api-fetch';
import * as customersClient from '../src/lib/customers-client';

vi.mock('../src/lib/customers-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/customers-client')>();
  return {
    ...actual, // keep the real problemMessages
    listCustomers: vi.fn(),
    createCustomer: vi.fn(),
    updateCustomer: vi.fn(),
    deleteCustomer: vi.fn(),
  };
});

const listCustomers = vi.mocked(customersClient.listCustomers);
const createCustomer = vi.mocked(customersClient.createCustomer);
const updateCustomer = vi.mocked(customersClient.updateCustomer);
const deleteCustomer = vi.mocked(customersClient.deleteCustomer);

function customer(over: Partial<CustomerView> = {}): CustomerView {
  return {
    id: 'cust-1',
    code: 'CUST-001',
    name: 'Acme Ltd.',
    type: 'COMPANY',
    taxNumber: '1234567890',
    email: 'billing@acme.example',
    phone: '+90 212 000 0000',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function page(
  customers: CustomerView[],
  hasNextPage = false,
  nextCursor: string | null = null,
): CustomerListView {
  return { data: customers, pageInfo: { hasNextPage, nextCursor } };
}

beforeEach(() => {
  vi.clearAllMocks();
  listCustomers.mockResolvedValue(page([customer()]));
});

describe('CustomersPage — list', () => {
  it('shows loading then renders the customer rows', async () => {
    render(<CustomersPage />);
    expect(screen.getByTestId('customers-loading')).toBeDefined();

    await screen.findByTestId('customers-table');
    expect(screen.getByText('CUST-001')).toBeDefined();
    expect(screen.getByText('Acme Ltd.')).toBeDefined();
    expect(screen.getByText('billing@acme.example')).toBeDefined();
  });

  it('renders an empty state when there are no customers', async () => {
    listCustomers.mockResolvedValue(page([]));
    render(<CustomersPage />);
    await screen.findByTestId('customers-empty');
  });

  it('shows an error state with a working retry', async () => {
    listCustomers.mockRejectedValueOnce(new Error('boom'));
    render(<CustomersPage />);

    await screen.findByTestId('customers-error');
    listCustomers.mockResolvedValueOnce(page([customer()]));
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByTestId('customers-table');
  });

  it('reflects the search input in the list query', async () => {
    render(<CustomersPage />);
    await screen.findByTestId('customers-table');

    fireEvent.change(screen.getByLabelText('search customers'), { target: { value: 'acm' } });

    await waitFor(() =>
      expect(listCustomers).toHaveBeenCalledWith(expect.objectContaining({ search: 'acm' })),
    );
  });

  it('reflects the type filter in the list query', async () => {
    render(<CustomersPage />);
    await screen.findByTestId('customers-table');

    fireEvent.change(screen.getByLabelText('filter by type'), { target: { value: 'INDIVIDUAL' } });

    await waitFor(() =>
      expect(listCustomers).toHaveBeenCalledWith(expect.objectContaining({ type: 'INDIVIDUAL' })),
    );
  });
});

describe('CustomersPage — create', () => {
  it('creates a customer (without companyId) and refreshes the list', async () => {
    createCustomer.mockResolvedValue(customer({ id: 'new' }));
    render(<CustomersPage />);
    await screen.findByTestId('customers-table');
    const before = listCustomers.mock.calls.length;

    fireEvent.click(screen.getByTestId('open-create'));
    const form = await screen.findByTestId('customer-form-modal');
    fireEvent.change(within(form).getByLabelText('code'), { target: { value: 'CUST-2' } });
    fireEvent.change(within(form).getByLabelText('name'), { target: { value: 'Second' } });
    fireEvent.click(within(form).getByRole('button', { name: /save/i }));

    await waitFor(() => expect(createCustomer).toHaveBeenCalledTimes(1));
    const payload = createCustomer.mock.calls[0]![0];
    expect(payload).not.toHaveProperty('companyId');
    expect(payload.code).toBe('CUST-2');
    // Modal closed + list refreshed.
    await waitFor(() => expect(screen.queryByTestId('customer-form-modal')).toBeNull());
    expect(listCustomers.mock.calls.length).toBeGreaterThan(before);
  });

  it('shows client validation errors and does not call the API', async () => {
    render(<CustomersPage />);
    await screen.findByTestId('customers-table');

    fireEvent.click(screen.getByTestId('open-create'));
    const form = await screen.findByTestId('customer-form-modal');
    // Code/name empty by default → submit should be blocked client-side.
    fireEvent.click(within(form).getByRole('button', { name: /save/i }));

    const error = await screen.findByTestId('customer-form-error');
    expect(error.textContent).toMatch(/code is required/i);
    expect(createCustomer).not.toHaveBeenCalled();
  });

  it('surfaces a server RFC7807 duplicate-code error', async () => {
    createCustomer.mockRejectedValue(
      new ApiError(409, 'Conflict', {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        code: 'CONFLICT',
        detail: 'A customer with code "CUST-001" already exists in this company',
      }),
    );
    render(<CustomersPage />);
    await screen.findByTestId('customers-table');

    fireEvent.click(screen.getByTestId('open-create'));
    const form = await screen.findByTestId('customer-form-modal');
    fireEvent.change(within(form).getByLabelText('code'), { target: { value: 'CUST-001' } });
    fireEvent.change(within(form).getByLabelText('name'), { target: { value: 'Dup' } });
    fireEvent.click(within(form).getByRole('button', { name: /save/i }));

    const error = await screen.findByTestId('customer-form-error');
    expect(error.textContent).toMatch(/already exists/i);
  });
});

describe('CustomersPage — edit', () => {
  it('prefills the form and updates the customer, then refreshes', async () => {
    updateCustomer.mockResolvedValue(customer({ name: 'Renamed' }));
    render(<CustomersPage />);
    await screen.findByTestId('customers-table');
    const before = listCustomers.mock.calls.length;

    fireEvent.click(screen.getByTestId('edit-cust-1'));
    const form = await screen.findByTestId('customer-form-modal');
    expect((within(form).getByLabelText('code') as HTMLInputElement).value).toBe('CUST-001');

    fireEvent.change(within(form).getByLabelText('name'), { target: { value: 'Renamed' } });
    fireEvent.click(within(form).getByRole('button', { name: /save/i }));

    await waitFor(() => expect(updateCustomer).toHaveBeenCalledTimes(1));
    expect(updateCustomer.mock.calls[0]![0]).toBe('cust-1');
    expect(updateCustomer.mock.calls[0]![1]).toEqual(expect.objectContaining({ name: 'Renamed' }));
    expect(updateCustomer.mock.calls[0]![1]).not.toHaveProperty('companyId');
    await waitFor(() => expect(listCustomers.mock.calls.length).toBeGreaterThan(before));
  });
});

describe('CustomersPage — delete', () => {
  it('confirms then deletes and refreshes the list', async () => {
    deleteCustomer.mockResolvedValue(undefined);
    render(<CustomersPage />);
    await screen.findByTestId('customers-table');
    const before = listCustomers.mock.calls.length;

    fireEvent.click(screen.getByTestId('delete-cust-1'));
    const dialog = await screen.findByTestId('customer-delete-dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-delete'));

    await waitFor(() => expect(deleteCustomer).toHaveBeenCalledWith('cust-1'));
    await waitFor(() => expect(listCustomers.mock.calls.length).toBeGreaterThan(before));
  });

  it('shows an error and keeps the dialog open when delete fails', async () => {
    deleteCustomer.mockRejectedValue(
      new ApiError(409, 'Conflict', {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        code: 'CONFLICT',
        detail: 'Customer still referenced by open orders',
      }),
    );
    render(<CustomersPage />);
    await screen.findByTestId('customers-table');

    fireEvent.click(screen.getByTestId('delete-cust-1'));
    const dialog = await screen.findByTestId('customer-delete-dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-delete'));

    const error = await screen.findByTestId('customer-delete-error');
    expect(error.textContent).toMatch(/still referenced/i);
    expect(screen.getByTestId('customer-delete-dialog')).toBeDefined();
  });
});
