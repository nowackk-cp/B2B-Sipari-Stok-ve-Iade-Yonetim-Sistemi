import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ProductListView, ProductView } from '@b2b/contracts';
import ProductsPage from '../app/(app)/products/page';
import { ApiError } from '../src/lib/api-fetch';
import * as productsClient from '../src/lib/products-client';
import * as download from '../src/lib/download';

vi.mock('../src/lib/products-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/products-client')>();
  return {
    ...actual, // keep the real problemMessages
    listProducts: vi.fn(),
    createProduct: vi.fn(),
    updateProduct: vi.fn(),
    deleteProduct: vi.fn(),
    importProducts: vi.fn(),
    exportProducts: vi.fn(),
  };
});

vi.mock('../src/lib/download', () => ({ saveBlob: vi.fn() }));

const listProducts = vi.mocked(productsClient.listProducts);
const createProduct = vi.mocked(productsClient.createProduct);
const updateProduct = vi.mocked(productsClient.updateProduct);
const deleteProduct = vi.mocked(productsClient.deleteProduct);
const importProducts = vi.mocked(productsClient.importProducts);
const exportProducts = vi.mocked(productsClient.exportProducts);
const saveBlob = vi.mocked(download.saveBlob);

function product(over: Partial<ProductView> = {}): ProductView {
  return {
    id: 'prod-1',
    sku: 'SKU-1',
    name: 'Widget',
    description: null,
    barcode: null,
    unit: 'EACH',
    categoryId: null,
    vatRate: 2000,
    listPrice: { amount: '123456', currency: 'TRY' },
    isActive: true,
    criticalStockThreshold: '10',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function page(
  products: ProductView[],
  hasNextPage = false,
  nextCursor: string | null = null,
): ProductListView {
  return { data: products, pageInfo: { hasNextPage, nextCursor } };
}

beforeEach(() => {
  vi.clearAllMocks();
  listProducts.mockResolvedValue(page([product()]));
});

describe('ProductsPage — list', () => {
  it('shows loading then renders the product rows', async () => {
    render(<ProductsPage />);
    expect(screen.getByTestId('products-loading')).toBeDefined();

    await screen.findByTestId('products-table');
    expect(screen.getByText('SKU-1')).toBeDefined();
    expect(screen.getByText('Widget')).toBeDefined();
    // Money is formatted precisely (minor-unit string → grouped display).
    expect(screen.getByText(/1\.234,56/)).toBeDefined();
  });

  it('renders an empty state when there are no products', async () => {
    listProducts.mockResolvedValue(page([]));
    render(<ProductsPage />);
    await screen.findByTestId('products-empty');
  });

  it('shows an error state with a working retry', async () => {
    listProducts.mockRejectedValueOnce(new Error('boom'));
    render(<ProductsPage />);

    await screen.findByTestId('products-error');
    listProducts.mockResolvedValueOnce(page([product()]));
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByTestId('products-table');
  });

  it('reflects the search input in the list query', async () => {
    render(<ProductsPage />);
    await screen.findByTestId('products-table');

    fireEvent.change(screen.getByLabelText('search products'), { target: { value: 'wid' } });

    await waitFor(() =>
      expect(listProducts).toHaveBeenCalledWith(expect.objectContaining({ search: 'wid' })),
    );
  });

  it('reflects the isActive filter in the list query', async () => {
    render(<ProductsPage />);
    await screen.findByTestId('products-table');

    fireEvent.change(screen.getByLabelText('filter by status'), { target: { value: 'inactive' } });

    await waitFor(() =>
      expect(listProducts).toHaveBeenCalledWith(expect.objectContaining({ isActive: 'false' })),
    );
  });
});

describe('ProductsPage — create', () => {
  it('creates a product (without companyId) and refreshes the list', async () => {
    createProduct.mockResolvedValue(product({ id: 'new' }));
    render(<ProductsPage />);
    await screen.findByTestId('products-table');
    const before = listProducts.mock.calls.length;

    fireEvent.click(screen.getByTestId('open-create'));
    const form = await screen.findByTestId('product-form-modal');
    fireEvent.change(within(form).getByLabelText('sku'), { target: { value: 'NEW-1' } });
    fireEvent.change(within(form).getByLabelText('name'), { target: { value: 'New widget' } });
    fireEvent.click(within(form).getByRole('button', { name: /save/i }));

    await waitFor(() => expect(createProduct).toHaveBeenCalledTimes(1));
    const payload = createProduct.mock.calls[0]![0];
    expect(payload).not.toHaveProperty('companyId');
    expect(payload.sku).toBe('NEW-1');
    // Modal closed + list refreshed.
    await waitFor(() => expect(screen.queryByTestId('product-form-modal')).toBeNull());
    expect(listProducts.mock.calls.length).toBeGreaterThan(before);
  });

  it('shows client validation errors and does not call the API', async () => {
    render(<ProductsPage />);
    await screen.findByTestId('products-table');

    fireEvent.click(screen.getByTestId('open-create'));
    const form = await screen.findByTestId('product-form-modal');
    // SKU/name empty by default → submit should be blocked client-side.
    fireEvent.click(within(form).getByRole('button', { name: /save/i }));

    const error = await screen.findByTestId('product-form-error');
    expect(error.textContent).toMatch(/sku is required/i);
    expect(createProduct).not.toHaveBeenCalled();
  });

  it('surfaces a server RFC7807 duplicate-SKU error', async () => {
    createProduct.mockRejectedValue(
      new ApiError(409, 'Conflict', {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        code: 'CONFLICT',
        detail: 'A product with SKU "NEW-1" already exists in this company',
      }),
    );
    render(<ProductsPage />);
    await screen.findByTestId('products-table');

    fireEvent.click(screen.getByTestId('open-create'));
    const form = await screen.findByTestId('product-form-modal');
    fireEvent.change(within(form).getByLabelText('sku'), { target: { value: 'NEW-1' } });
    fireEvent.change(within(form).getByLabelText('name'), { target: { value: 'Dup' } });
    fireEvent.click(within(form).getByRole('button', { name: /save/i }));

    const error = await screen.findByTestId('product-form-error');
    expect(error.textContent).toMatch(/already exists/i);
  });
});

describe('ProductsPage — edit', () => {
  it('prefills the form and updates the product, then refreshes', async () => {
    updateProduct.mockResolvedValue(product({ name: 'Renamed' }));
    render(<ProductsPage />);
    await screen.findByTestId('products-table');
    const before = listProducts.mock.calls.length;

    fireEvent.click(screen.getByTestId('edit-prod-1'));
    const form = await screen.findByTestId('product-form-modal');
    expect((within(form).getByLabelText('sku') as HTMLInputElement).value).toBe('SKU-1');

    fireEvent.change(within(form).getByLabelText('name'), { target: { value: 'Renamed' } });
    fireEvent.click(within(form).getByRole('button', { name: /save/i }));

    await waitFor(() => expect(updateProduct).toHaveBeenCalledTimes(1));
    expect(updateProduct.mock.calls[0]![0]).toBe('prod-1');
    expect(updateProduct.mock.calls[0]![1]).toEqual(expect.objectContaining({ name: 'Renamed' }));
    expect(updateProduct.mock.calls[0]![1]).not.toHaveProperty('companyId');
    await waitFor(() => expect(listProducts.mock.calls.length).toBeGreaterThan(before));
  });
});

describe('ProductsPage — delete', () => {
  it('confirms then deletes and refreshes the list', async () => {
    deleteProduct.mockResolvedValue(undefined);
    render(<ProductsPage />);
    await screen.findByTestId('products-table');
    const before = listProducts.mock.calls.length;

    fireEvent.click(screen.getByTestId('delete-prod-1'));
    const dialog = await screen.findByTestId('product-delete-dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-delete'));

    await waitFor(() => expect(deleteProduct).toHaveBeenCalledWith('prod-1'));
    await waitFor(() => expect(listProducts.mock.calls.length).toBeGreaterThan(before));
  });
});

describe('ProductsPage — import', () => {
  it('uploads a CSV, shows the summary and refreshes', async () => {
    importProducts.mockResolvedValue({
      id: 'imp-1',
      status: 'COMPLETED',
      checksum: 'abc',
      totalRows: 5,
      validRows: 5,
      invalidRows: 0,
      appliedRows: 5,
      errors: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    render(<ProductsPage />);
    await screen.findByTestId('products-table');
    const before = listProducts.mock.calls.length;

    fireEvent.click(screen.getByTestId('open-import'));
    const modal = await screen.findByTestId('product-import-modal');
    const file = new File(['sku,name\nA,B'], 'p.csv', { type: 'text/csv' });
    fireEvent.change(within(modal).getByTestId('import-file'), { target: { files: [file] } });
    fireEvent.click(within(modal).getByRole('button', { name: /^import$/i }));

    await screen.findByTestId('import-summary');
    expect(screen.getByTestId('import-applied').textContent).toBe('5');
    expect(screen.getByTestId('import-status').textContent).toBe('COMPLETED');
    expect(screen.getByTestId('import-id').textContent).toContain('imp-1');
    expect(listProducts.mock.calls.length).toBeGreaterThan(before);
  });

  it('shows per-row validation errors from a rejected import', async () => {
    importProducts.mockRejectedValue(
      new ApiError(422, 'Unprocessable', {
        type: 'about:blank',
        title: 'Unprocessable',
        status: 422,
        code: 'BUSINESS_RULE',
        errors: [
          { field: '(request)', message: 'Row 2, column sku: SKU is required' },
          { field: '(request)', message: 'Row 3, column listPriceAmount: must be an integer' },
        ],
      }),
    );
    render(<ProductsPage />);
    await screen.findByTestId('products-table');

    fireEvent.click(screen.getByTestId('open-import'));
    const modal = await screen.findByTestId('product-import-modal');
    const file = new File(['bad'], 'p.csv', { type: 'text/csv' });
    fireEvent.change(within(modal).getByTestId('import-file'), { target: { files: [file] } });
    fireEvent.click(within(modal).getByRole('button', { name: /^import$/i }));

    const error = await screen.findByTestId('import-error');
    expect(error.textContent).toMatch(/Row 2, column sku/i);
    expect(error.textContent).toMatch(/Row 3, column listPriceAmount/i);
  });
});

describe('ProductsPage — export', () => {
  it('downloads the export blob using the server filename', async () => {
    const blob = new Blob(['sku,name'], { type: 'text/csv' });
    exportProducts.mockResolvedValue({ blob, filename: 'products-20260101.csv' });
    render(<ProductsPage />);
    await screen.findByTestId('products-table');

    fireEvent.click(screen.getByTestId('export-button'));

    await waitFor(() => expect(saveBlob).toHaveBeenCalledWith(blob, 'products-20260101.csv'));
  });
});
