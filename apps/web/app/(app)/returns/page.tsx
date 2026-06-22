'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReturnView } from '@b2b/contracts';
import { ApiError } from '../../../src/lib/api-fetch';
import { listReturns } from '../../../src/lib/returns-client';
import { ReturnStatusBadge } from '../../components/returns/return-status-badge';
import { ReturnDetailDrawer } from '../../components/returns/return-detail-drawer';

type StatusFilter = 'all' | 'DRAFT' | 'APPROVED';

const STATUS_FILTERS: StatusFilter[] = ['all', 'DRAFT', 'APPROVED'];

type ListState =
  | { status: 'loading' }
  | { status: 'ready'; returns: ReturnView[]; hasNextPage: boolean; nextCursor: string | null }
  | { status: 'error'; message: string };

/** Map the UI status filter to the backend `status` query param. */
function statusParam(filter: StatusFilter): string | undefined {
  return filter === 'all' ? undefined : filter;
}

/**
 * Returns list page. Returns are CREATED from the order detail (Create return) and
 * driven (approve / issue credit note) from the return detail drawer — there is no
 * create here. Mirrors the orders/invoices pages: status filter, cursor pagination,
 * loading/empty/error+retry states, and a row → detail drawer.
 */
export default function ReturnsPage() {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [prevCursors, setPrevCursors] = useState<Array<string | undefined>>([]);
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [detailId, setDetailId] = useState<string | null>(null);

  const load = useCallback(() => {
    let active = true;
    setState({ status: 'loading' });
    listReturns({ status: statusParam(filter), cursor })
      .then((page) => {
        if (!active) return;
        setState({
          status: 'ready',
          returns: page.data,
          hasNextPage: page.pageInfo.hasNextPage,
          nextCursor: page.pageInfo.nextCursor,
        });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const message =
          err instanceof ApiError
            ? (err.problem?.detail ?? err.message)
            : 'Could not load returns. Please try again.';
        setState({ status: 'error', message });
      });
    return () => {
      active = false;
    };
  }, [filter, cursor]);

  useEffect(() => load(), [load]);

  /** Reset to the first page whenever the filter changes (the cursor is positional). */
  function onFilterChange(value: StatusFilter) {
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

  const canPrev = prevCursors.length > 0;

  return (
    <section aria-label="returns">
      <div className="page-head">
        <h1 className="page-title">Returns</h1>
      </div>

      <div className="toolbar">
        <label className="toolbar-filter">
          <span className="field-label">Status</span>
          <select
            aria-label="filter by status"
            value={filter}
            onChange={(e) => onFilterChange(e.target.value as StatusFilter)}
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s === 'all' ? 'All' : s}
              </option>
            ))}
          </select>
        </label>
      </div>

      {state.status === 'loading' ? (
        <div className="table-state" aria-busy="true" data-testid="returns-loading">
          Loading returns…
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="state-error" role="alert" data-testid="returns-error">
          <p>{state.message}</p>
          <button type="button" className="button" onClick={load}>
            Retry
          </button>
        </div>
      ) : null}

      {state.status === 'ready' && state.returns.length === 0 ? (
        <div className="table-state" data-testid="returns-empty">
          No returns found.
        </div>
      ) : null}

      {state.status === 'ready' && state.returns.length > 0 ? (
        <>
          <div className="table-wrap">
            <table className="data-table" data-testid="returns-table">
              <thead>
                <tr>
                  <th>Return no</th>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Warehouse</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Approved</th>
                  <th aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {state.returns.map((ret) => (
                  <tr key={ret.id} data-testid={`return-row-${ret.id}`}>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => setDetailId(ret.id)}
                        data-testid={`open-detail-${ret.id}`}
                      >
                        {ret.returnNo}
                      </button>
                    </td>
                    <td>
                      <code>{ret.orderId}</code>
                    </td>
                    <td>
                      <code>{ret.customerId}</code>
                    </td>
                    <td>
                      <code>{ret.warehouseId}</code>
                    </td>
                    <td>
                      <ReturnStatusBadge status={ret.status} />
                    </td>
                    <td>{new Date(ret.createdAt).toLocaleDateString()}</td>
                    <td>{ret.approvedAt ? new Date(ret.approvedAt).toLocaleDateString() : '—'}</td>
                    <td className="row-actions">
                      <button
                        type="button"
                        className="button button-sm"
                        onClick={() => setDetailId(ret.id)}
                        data-testid={`view-${ret.id}`}
                      >
                        View
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

      {detailId ? (
        <ReturnDetailDrawer
          returnId={detailId}
          onClose={() => setDetailId(null)}
          onChanged={load}
        />
      ) : null}
    </section>
  );
}
