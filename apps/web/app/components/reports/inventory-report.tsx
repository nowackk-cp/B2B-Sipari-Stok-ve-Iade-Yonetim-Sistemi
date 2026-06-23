'use client';

import { useCallback, useEffect, useState } from 'react';
import type { InventoryReportRowView } from '@b2b/contracts';
import { fetchInventoryReport, problemMessages } from '../../../src/lib/reports-client';
import { formatQuantity } from '../../../src/lib/money';
import type { WarehouseOption } from './report-helpers';

type State =
  | { status: 'loading' }
  | {
      status: 'ready';
      rows: InventoryReportRowView[];
      hasNextPage: boolean;
      nextCursor: string | null;
    }
  | { status: 'error'; message: string };

/**
 * Inventory report tab. A cursor-paginated page of product × warehouse balances
 * with the server-computed `available` and low-stock flag (`GET /reports/inventory`).
 * Search / low-stock-only / warehouse are the only filters the contract exposes.
 * Quantities are rendered BigInt-safe (the figures are integer strings that can
 * exceed the JS safe range). Cross-company / scope filtering is resolved on the
 * backend — the frontend sends no tenant claim.
 */
export function InventoryReport({ warehouses }: { warehouses: WarehouseOption[] }) {
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [warehouseId, setWarehouseId] = useState('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [prevCursors, setPrevCursors] = useState<Array<string | undefined>>([]);
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(() => {
    let active = true;
    setState({ status: 'loading' });
    fetchInventoryReport({
      search: appliedSearch || undefined,
      lowStockOnly,
      warehouseId: warehouseId || undefined,
      cursor,
    })
      .then((page) => {
        if (!active) return;
        setState({
          status: 'ready',
          rows: page.data,
          hasNextPage: page.pageInfo.hasNextPage,
          nextCursor: page.pageInfo.nextCursor,
        });
      })
      .catch((err: unknown) => {
        if (active) setState({ status: 'error', message: problemMessages(err)[0]! });
      });
    return () => {
      active = false;
    };
  }, [appliedSearch, lowStockOnly, warehouseId, cursor]);

  useEffect(() => load(), [load]);

  /** Reset to the first page whenever a filter changes (the cursor is positional). */
  function resetAnd(apply: () => void) {
    setPrevCursors([]);
    setCursor(undefined);
    apply();
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

  return (
    <section aria-label="inventory report">
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          resetAnd(() => setAppliedSearch(search.trim()));
        }}
      >
        <input
          className="toolbar-search"
          type="search"
          aria-label="search products"
          placeholder="Search SKU or name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {warehouses.length > 0 ? (
          <label className="toolbar-filter">
            <span className="field-label">Warehouse</span>
            <select
              aria-label="inventory warehouse"
              value={warehouseId}
              onChange={(e) => resetAnd(() => setWarehouseId(e.target.value))}
            >
              <option value="">All</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="toolbar-check">
          <input
            type="checkbox"
            aria-label="low stock only"
            checked={lowStockOnly}
            onChange={(e) => resetAnd(() => setLowStockOnly(e.target.checked))}
          />
          <span>Low stock only</span>
        </label>
        <button type="submit" className="button button-sm">
          Search
        </button>
      </form>

      {state.status === 'loading' ? (
        <div className="table-state" aria-busy="true" data-testid="inventory-loading">
          Loading inventory…
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="state-error" role="alert" data-testid="inventory-error">
          <p>{state.message}</p>
          <button type="button" className="button" onClick={load}>
            Retry
          </button>
        </div>
      ) : null}

      {state.status === 'ready' && state.rows.length === 0 ? (
        <div className="table-state" data-testid="inventory-empty">
          No stock balances found.
        </div>
      ) : null}

      {state.status === 'ready' && state.rows.length > 0 ? (
        <>
          <div className="table-wrap">
            <table className="data-table" data-testid="inventory-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Product</th>
                  <th>Warehouse</th>
                  <th className="num">On hand</th>
                  <th className="num">Reserved</th>
                  <th className="num">Available</th>
                  <th className="num">Critical</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {state.rows.map((r) => (
                  <tr
                    key={`${r.productId}-${r.warehouseId}`}
                    data-testid={`inventory-row-${r.productId}-${r.warehouseId}`}
                  >
                    <td>{r.sku}</td>
                    <td>{r.name}</td>
                    <td>
                      <code>{r.warehouseId}</code>
                    </td>
                    <td
                      className="num"
                      data-testid={`inventory-onhand-${r.productId}-${r.warehouseId}`}
                    >
                      {formatQuantity(r.onHand)}
                    </td>
                    <td className="num">{formatQuantity(r.reserved)}</td>
                    <td
                      className="num"
                      data-testid={`inventory-available-${r.productId}-${r.warehouseId}`}
                    >
                      {formatQuantity(r.available)}
                    </td>
                    <td className="num">{formatQuantity(r.criticalStockThreshold)}</td>
                    <td>
                      {r.isLowStock ? (
                        <span className="badge badge-danger">Low</span>
                      ) : (
                        <span className="badge badge-ok">OK</span>
                      )}
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
              disabled={prevCursors.length === 0}
              data-testid="inventory-page-prev"
            >
              Previous
            </button>
            <button
              type="button"
              className="button button-sm"
              onClick={goNext}
              disabled={!state.hasNextPage}
              data-testid="inventory-page-next"
            >
              Next
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
