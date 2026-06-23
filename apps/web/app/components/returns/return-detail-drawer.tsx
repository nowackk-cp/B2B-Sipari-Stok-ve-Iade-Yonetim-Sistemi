'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReturnView } from '@b2b/contracts';
import { ApiError } from '../../../src/lib/api-fetch';
import { getReturn } from '../../../src/lib/returns-client';
import { ReturnStatusBadge } from './return-status-badge';
import { ApproveReturnDialog } from './approve-return-dialog';
import { IssueCreditNoteDialog } from './issue-credit-note-dialog';

/** An open in-drawer action, with the return snapshot it acts on. */
type Action = { kind: 'approve' | 'credit-note'; ret: ReturnView } | null;

type DetailState =
  | { status: 'loading' }
  | { status: 'ready'; ret: ReturnView }
  | { status: 'error'; message: string };

/**
 * Right-hand drawer showing one return in full: header, related order, customer,
 * warehouse, status, created/approved timestamps and the line items (product,
 * quantity, reason). It re-fetches the return on open (the list row is only a
 * summary).
 *
 * Actions are status-driven, mirroring the backend lifecycle (the server is always
 * the authority — UI hiding is convenience, not security, rule 7):
 *   - DRAFT     → Approve return
 *   - APPROVED  → Issue credit note
 * Both run in IN-DRAWER dialogs carrying their own return snapshot, so a post-action
 * drawer re-fetch (which briefly nulls `ret` while loading) does NOT unmount them —
 * important for the credit-note dialog, which stays open to show the allocated
 * number. On success the drawer re-fetches itself AND calls {@link onChanged} so the
 * list page reloads too.
 */
export function ReturnDetailDrawer({
  returnId,
  onClose,
  onChanged,
}: {
  returnId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [state, setState] = useState<DetailState>({ status: 'loading' });
  const [action, setAction] = useState<Action>(null);

  const load = useCallback(() => {
    let active = true;
    setState({ status: 'loading' });
    getReturn(returnId)
      .then((ret) => {
        if (active) setState({ status: 'ready', ret });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const message =
          err instanceof ApiError
            ? (err.problem?.detail ?? err.message)
            : 'Could not load the return. Please try again.';
        setState({ status: 'error', message });
      });
    return () => {
      active = false;
    };
  }, [returnId]);

  useEffect(() => load(), [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ret = state.status === 'ready' ? state.ret : null;
  const isDraft = ret?.status === 'DRAFT';
  const isApproved = ret?.status === 'APPROVED';

  /** An action committed: re-fetch the drawer AND refresh the list. */
  const onActionDone = useCallback(() => {
    load();
    onChanged();
  }, [load, onChanged]);

  return (
    <div className="drawer-overlay" onClick={onClose} role="presentation">
      <aside
        className="drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-label="return detail"
        data-testid="return-detail-drawer"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title">{ret ? `Return ${ret.returnNo}` : 'Return'}</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        {state.status === 'loading' ? (
          <div className="table-state" aria-busy="true" data-testid="return-detail-loading">
            Loading return…
          </div>
        ) : null}

        {state.status === 'error' ? (
          <div className="state-error" role="alert" data-testid="return-detail-error">
            <p>{state.message}</p>
            <button type="button" className="button" onClick={load}>
              Retry
            </button>
          </div>
        ) : null}

        {ret ? (
          <div className="drawer-body">
            <dl className="detail-grid">
              <div>
                <dt>Status</dt>
                <dd>
                  <ReturnStatusBadge status={ret.status} />
                </dd>
              </div>
              <div>
                <dt>Order</dt>
                <dd>
                  <code>{ret.orderId}</code>
                </dd>
              </div>
              <div>
                <dt>Customer</dt>
                <dd>
                  <code>{ret.customerId}</code>
                </dd>
              </div>
              <div>
                <dt>Warehouse</dt>
                <dd>
                  <code>{ret.warehouseId}</code>
                </dd>
              </div>
              <div>
                <dt>Invoice</dt>
                <dd>{ret.invoiceId ? <code>{ret.invoiceId}</code> : '—'}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{new Date(ret.createdAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Approved</dt>
                <dd data-testid="return-detail-approved-at">
                  {ret.approvedAt ? new Date(ret.approvedAt).toLocaleString() : '—'}
                </dd>
              </div>
            </dl>

            {ret.reason ? <p className="detail-note">{ret.reason}</p> : null}

            <div className="table-wrap">
              <table className="data-table" data-testid="return-items-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="num">Qty</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {ret.items.map((item, i) => (
                    <tr
                      key={`${item.productId}-${i}`}
                      data-testid={`return-item-${item.productId}`}
                    >
                      <td>
                        <code>{item.productId}</code>
                      </td>
                      <td className="num">{item.quantity}</td>
                      <td>{item.reason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {isDraft ? (
              <div className="modal-actions" data-testid="return-draft-actions">
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => setAction({ kind: 'approve', ret })}
                  data-testid="detail-approve-return"
                >
                  Approve return
                </button>
              </div>
            ) : null}

            {isApproved ? (
              <div className="modal-actions" data-testid="return-approved-actions">
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => setAction({ kind: 'credit-note', ret })}
                  data-testid="detail-issue-credit-note"
                >
                  Issue credit note
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {action?.kind === 'approve' ? (
          <ApproveReturnDialog
            ret={action.ret}
            onClose={() => setAction(null)}
            onDone={onActionDone}
          />
        ) : null}
        {action?.kind === 'credit-note' ? (
          <IssueCreditNoteDialog
            ret={action.ret}
            onClose={() => setAction(null)}
            onDone={onActionDone}
          />
        ) : null}
      </aside>
    </div>
  );
}
