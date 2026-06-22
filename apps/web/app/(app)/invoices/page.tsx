'use client';

import { useCallback, useEffect, useState } from 'react';
import type { InvoiceView } from '@b2b/contracts';
import { ApiError } from '../../../src/lib/api-fetch';
import { listInvoices } from '../../../src/lib/invoices-client';
import { formatMoney } from '../../../src/lib/money';
import { InvoiceStatusBadge } from '../../components/invoices/invoice-status-badge';
import { InvoiceDetailDrawer } from '../../components/invoices/invoice-detail-drawer';

type StatusFilter = 'all' | 'DRAFT' | 'ISSUED' | 'PAID' | 'VOID';

const STATUS_FILTERS: StatusFilter[] = ['all', 'DRAFT', 'ISSUED', 'PAID', 'VOID'];

type ListState =
  | { status: 'loading' }
  | { status: 'ready'; invoices: InvoiceView[]; hasNextPage: boolean; nextCursor: string | null }
  | { status: 'error'; message: string };

/** Map the UI status filter to the backend `status` query param. */
function statusParam(filter: StatusFilter): string | undefined {
  return filter === 'all' ? undefined : filter;
}

/**
 * Invoices list page. Read-only in this slice: invoices are CREATED from the order
 * detail (Issue invoice) — there is no create/edit/void here. Mirrors the orders
 * page: status filter, cursor pagination, loading/empty/error+retry states, and a
 * row → detail drawer. Money is formatted from BigInt-safe strings (rule 3).
 */
export default function InvoicesPage() {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [prevCursors, setPrevCursors] = useState<Array<string | undefined>>([]);
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [detailId, setDetailId] = useState<string | null>(null);

  const load = useCallback(() => {
    let active = true;
    setState({ status: 'loading' });
    listInvoices({ status: statusParam(filter), cursor })
      .then((page) => {
        if (!active) return;
        setState({
          status: 'ready',
          invoices: page.data,
          hasNextPage: page.pageInfo.hasNextPage,
          nextCursor: page.pageInfo.nextCursor,
        });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const message =
          err instanceof ApiError
            ? (err.problem?.detail ?? err.message)
            : 'Could not load invoices. Please try again.';
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
    <section aria-label="invoices">
      <div className="page-head">
        <h1 className="page-title">Invoices</h1>
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
        <div className="table-state" aria-busy="true" data-testid="invoices-loading">
          Loading invoices…
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="state-error" role="alert" data-testid="invoices-error">
          <p>{state.message}</p>
          <button type="button" className="button" onClick={load}>
            Retry
          </button>
        </div>
      ) : null}

      {state.status === 'ready' && state.invoices.length === 0 ? (
        <div className="table-state" data-testid="invoices-empty">
          No invoices found.
        </div>
      ) : null}

      {state.status === 'ready' && state.invoices.length > 0 ? (
        <>
          <div className="table-wrap">
            <table className="data-table" data-testid="invoices-table">
              <thead>
                <tr>
                  <th>Invoice no</th>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Warehouse</th>
                  <th>Status</th>
                  <th>Currency</th>
                  <th className="num">Total</th>
                  <th>Issued</th>
                  <th aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {state.invoices.map((inv) => (
                  <tr key={inv.id} data-testid={`invoice-row-${inv.id}`}>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => setDetailId(inv.id)}
                        data-testid={`open-detail-${inv.id}`}
                      >
                        {inv.invoiceNo ?? inv.id}
                      </button>
                    </td>
                    <td>{inv.orderId ? <code>{inv.orderId}</code> : '—'}</td>
                    <td>
                      <code>{inv.customerId}</code>
                    </td>
                    <td>{inv.warehouseId ? <code>{inv.warehouseId}</code> : '—'}</td>
                    <td>
                      <InvoiceStatusBadge status={inv.status} />
                    </td>
                    <td>{inv.currency}</td>
                    <td className="num" data-testid={`invoice-total-${inv.id}`}>
                      {formatMoney(inv.total.amount, inv.total.currency)}
                    </td>
                    <td>{inv.issuedAt ? new Date(inv.issuedAt).toLocaleDateString() : '—'}</td>
                    <td className="row-actions">
                      <button
                        type="button"
                        className="button button-sm"
                        onClick={() => setDetailId(inv.id)}
                        data-testid={`view-${inv.id}`}
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
        <InvoiceDetailDrawer invoiceId={detailId} onClose={() => setDetailId(null)} />
      ) : null}
    </section>
  );
}
