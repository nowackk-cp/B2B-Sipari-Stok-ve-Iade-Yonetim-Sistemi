'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CreditNoteView } from '@b2b/contracts';
import { ApiError } from '../../../src/lib/api-fetch';
import { listCreditNotes } from '../../../src/lib/credit-notes-client';
import { formatMoney } from '../../../src/lib/money';
import { CreditNoteStatusBadge } from '../../components/credit-notes/credit-note-status-badge';
import { CreditNoteDetailDrawer } from '../../components/credit-notes/credit-note-detail-drawer';

type StatusFilter = 'all' | 'ISSUED' | 'VOID';

const STATUS_FILTERS: StatusFilter[] = ['all', 'ISSUED', 'VOID'];

type ListState =
  | { status: 'loading' }
  | {
      status: 'ready';
      creditNotes: CreditNoteView[];
      hasNextPage: boolean;
      nextCursor: string | null;
    }
  | { status: 'error'; message: string };

/** Map the UI status filter to the backend `status` query param. */
function statusParam(filter: StatusFilter): string | undefined {
  return filter === 'all' ? undefined : filter;
}

/**
 * Credit notes list page. Read-only in this slice: credit notes are CREATED from
 * the return detail (Issue credit note) — there is no create/void here. Mirrors the
 * invoices page: status filter, cursor pagination, loading/empty/error+retry
 * states, and a row → detail drawer. Money is formatted from BigInt-safe strings
 * (rule 3). No PDF/download — that is a separate task.
 */
export default function CreditNotesPage() {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [prevCursors, setPrevCursors] = useState<Array<string | undefined>>([]);
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [detailId, setDetailId] = useState<string | null>(null);

  const load = useCallback(() => {
    let active = true;
    setState({ status: 'loading' });
    listCreditNotes({ status: statusParam(filter), cursor })
      .then((page) => {
        if (!active) return;
        setState({
          status: 'ready',
          creditNotes: page.data,
          hasNextPage: page.pageInfo.hasNextPage,
          nextCursor: page.pageInfo.nextCursor,
        });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const message =
          err instanceof ApiError
            ? (err.problem?.detail ?? err.message)
            : 'Could not load credit notes. Please try again.';
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
    <section aria-label="credit notes">
      <div className="page-head">
        <h1 className="page-title">Credit notes</h1>
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
        <div className="table-state" aria-busy="true" data-testid="credit-notes-loading">
          Loading credit notes…
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="state-error" role="alert" data-testid="credit-notes-error">
          <p>{state.message}</p>
          <button type="button" className="button" onClick={load}>
            Retry
          </button>
        </div>
      ) : null}

      {state.status === 'ready' && state.creditNotes.length === 0 ? (
        <div className="table-state" data-testid="credit-notes-empty">
          No credit notes found.
        </div>
      ) : null}

      {state.status === 'ready' && state.creditNotes.length > 0 ? (
        <>
          <div className="table-wrap">
            <table className="data-table" data-testid="credit-notes-table">
              <thead>
                <tr>
                  <th>Credit note no</th>
                  <th>Return</th>
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
                {state.creditNotes.map((cn) => (
                  <tr key={cn.id} data-testid={`credit-note-row-${cn.id}`}>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => setDetailId(cn.id)}
                        data-testid={`open-detail-${cn.id}`}
                      >
                        {cn.creditNoteNo}
                      </button>
                    </td>
                    <td>
                      <code>{cn.returnId}</code>
                    </td>
                    <td>
                      <code>{cn.orderId}</code>
                    </td>
                    <td>
                      <code>{cn.customerId}</code>
                    </td>
                    <td>
                      <code>{cn.warehouseId}</code>
                    </td>
                    <td>
                      <CreditNoteStatusBadge status={cn.status} />
                    </td>
                    <td>{cn.currency}</td>
                    <td className="num" data-testid={`credit-note-total-${cn.id}`}>
                      {formatMoney(cn.total.amount, cn.total.currency)}
                    </td>
                    <td>{new Date(cn.issuedAt).toLocaleDateString()}</td>
                    <td className="row-actions">
                      <button
                        type="button"
                        className="button button-sm"
                        onClick={() => setDetailId(cn.id)}
                        data-testid={`view-${cn.id}`}
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
        <CreditNoteDetailDrawer creditNoteId={detailId} onClose={() => setDetailId(null)} />
      ) : null}
    </section>
  );
}
