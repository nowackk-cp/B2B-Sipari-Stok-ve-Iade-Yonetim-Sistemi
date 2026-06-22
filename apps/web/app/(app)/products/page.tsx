'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ProductView } from '@b2b/contracts';
import { ApiError } from '../../../src/lib/api-fetch';
import { saveBlob } from '../../../src/lib/download';
import { formatMoney } from '../../../src/lib/money';
import { exportProducts, listProducts, problemMessages } from '../../../src/lib/products-client';
import { ProductFormModal } from '../../components/products/product-form-modal';
import { DeleteProductDialog } from '../../components/products/delete-product-dialog';
import { ImportProductsModal } from '../../components/products/import-products-modal';

type ActiveFilter = 'all' | 'active' | 'inactive';

type ListState =
  | { status: 'loading' }
  | { status: 'ready'; products: ProductView[]; hasNextPage: boolean; nextCursor: string | null }
  | { status: 'error'; message: string };

type Modal =
  | { type: 'create' }
  | { type: 'edit'; product: ProductView }
  | { type: 'delete'; product: ProductView }
  | { type: 'import' }
  | null;

/** Map the tri-state UI filter to the backend `isActive` query param. */
function activeParam(filter: ActiveFilter): string | undefined {
  if (filter === 'active') return 'true';
  if (filter === 'inactive') return 'false';
  return undefined;
}

/** Tax rate is stored in basis points (2000 = 20%); display it as a percentage. */
function formatTaxRate(bp: number): string {
  return `${bp / 100}%`;
}

export default function ProductsPage() {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ActiveFilter>('all');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [prevCursors, setPrevCursors] = useState<Array<string | undefined>>([]);
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [modal, setModal] = useState<Modal>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const load = useCallback(() => {
    let active = true;
    setState({ status: 'loading' });
    listProducts({
      search: search.trim() || undefined,
      isActive: activeParam(filter),
      cursor,
    })
      .then((page) => {
        if (!active) return;
        setState({
          status: 'ready',
          products: page.data,
          hasNextPage: page.pageInfo.hasNextPage,
          nextCursor: page.pageInfo.nextCursor,
        });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const message =
          err instanceof ApiError
            ? (err.problem?.detail ?? err.message)
            : 'Could not load products. Please try again.';
        setState({ status: 'error', message });
      });
    return () => {
      active = false;
    };
  }, [search, filter, cursor]);

  useEffect(() => load(), [load]);

  /** Reset to the first page whenever a filter changes (the cursor is positional). */
  function onSearchChange(value: string) {
    setPrevCursors([]);
    setCursor(undefined);
    setSearch(value);
  }
  function onFilterChange(value: ActiveFilter) {
    setPrevCursors([]);
    setCursor(undefined);
    setFilter(value);
  }

  function goNext() {
    if (state.status !== 'ready' || !state.hasNextPage || !state.nextCursor) return;
    setPrevCursors((prev) => [...prev, cursor]);
    setCursor(state.nextCursor);
  }
  function goPrev() {
    if (prevCursors.length === 0) return;
    const previous = prevCursors[prevCursors.length - 1];
    setPrevCursors((prev) => prev.slice(0, -1));
    setCursor(previous);
  }

  async function onExport() {
    setExporting(true);
    setExportError(null);
    try {
      const { blob, filename } = await exportProducts({
        search: search.trim() || undefined,
        isActive: activeParam(filter),
      });
      saveBlob(blob, filename);
    } catch (err) {
      setExportError(problemMessages(err).join(' '));
    } finally {
      setExporting(false);
    }
  }

  const canPrev = prevCursors.length > 0;

  return (
    <section aria-label="products">
      <div className="page-head">
        <h1 className="page-title">Products</h1>
        <div className="page-actions">
          <button
            type="button"
            className="button"
            onClick={() => setModal({ type: 'import' })}
            data-testid="open-import"
          >
            Import CSV
          </button>
          <button
            type="button"
            className="button"
            onClick={onExport}
            disabled={exporting}
            data-testid="export-button"
          >
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={() => setModal({ type: 'create' })}
            data-testid="open-create"
          >
            New product
          </button>
        </div>
      </div>

      <div className="toolbar">
        <input
          type="search"
          className="toolbar-search"
          placeholder="Search SKU or name…"
          aria-label="search products"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        <label className="toolbar-filter">
          <span className="field-label">Status</span>
          <select
            aria-label="filter by status"
            value={filter}
            onChange={(e) => onFilterChange(e.target.value as ActiveFilter)}
          >
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </label>
      </div>

      {exportError ? (
        <p className="form-error" role="alert" data-testid="export-error">
          {exportError}
        </p>
      ) : null}

      {state.status === 'loading' ? (
        <div className="table-state" aria-busy="true" data-testid="products-loading">
          Loading products…
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="state-error" role="alert" data-testid="products-error">
          <p>{state.message}</p>
          <button type="button" className="button" onClick={load}>
            Retry
          </button>
        </div>
      ) : null}

      {state.status === 'ready' && state.products.length === 0 ? (
        <div className="table-state" data-testid="products-empty">
          No products found.
        </div>
      ) : null}

      {state.status === 'ready' && state.products.length > 0 ? (
        <>
          <div className="table-wrap">
            <table className="data-table" data-testid="products-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Name</th>
                  <th>Currency</th>
                  <th className="num">List price</th>
                  <th className="num">Tax rate</th>
                  <th className="num">Critical stock</th>
                  <th>Status</th>
                  <th aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {state.products.map((p) => (
                  <tr key={p.id} data-testid={`product-row-${p.id}`}>
                    <td>
                      <code>{p.sku}</code>
                    </td>
                    <td>{p.name}</td>
                    <td>{p.listPrice.currency}</td>
                    <td className="num">{formatMoney(p.listPrice.amount, p.listPrice.currency)}</td>
                    <td className="num">{formatTaxRate(p.vatRate)}</td>
                    <td className="num">{p.criticalStockThreshold ?? '—'}</td>
                    <td>
                      <span className={`badge ${p.isActive ? 'badge-ok' : 'badge-muted'}`}>
                        {p.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="row-actions">
                      <button
                        type="button"
                        className="button button-sm"
                        onClick={() => setModal({ type: 'edit', product: p })}
                        data-testid={`edit-${p.id}`}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="button button-sm button-danger"
                        onClick={() => setModal({ type: 'delete', product: p })}
                        data-testid={`delete-${p.id}`}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="pagination">
            <button
              type="button"
              className="button button-sm"
              onClick={goPrev}
              disabled={!canPrev}
              data-testid="page-prev"
            >
              Previous
            </button>
            <button
              type="button"
              className="button button-sm"
              onClick={goNext}
              disabled={!state.hasNextPage}
              data-testid="page-next"
            >
              Next
            </button>
          </div>
        </>
      ) : null}

      {modal?.type === 'create' ? (
        <ProductFormModal mode="create" onClose={() => setModal(null)} onSaved={load} />
      ) : null}
      {modal?.type === 'edit' ? (
        <ProductFormModal
          mode="edit"
          product={modal.product}
          onClose={() => setModal(null)}
          onSaved={load}
        />
      ) : null}
      {modal?.type === 'delete' ? (
        <DeleteProductDialog
          product={modal.product}
          onClose={() => setModal(null)}
          onDeleted={load}
        />
      ) : null}
      {modal?.type === 'import' ? (
        <ImportProductsModal onClose={() => setModal(null)} onImported={load} />
      ) : null}
    </section>
  );
}
