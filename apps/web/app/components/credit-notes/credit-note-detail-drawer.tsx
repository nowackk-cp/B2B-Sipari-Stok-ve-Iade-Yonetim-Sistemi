'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CreditNoteView } from '@b2b/contracts';
import { ApiError } from '../../../src/lib/api-fetch';
import { getCreditNote } from '../../../src/lib/credit-notes-client';
import { formatMoney } from '../../../src/lib/money';
import { CreditNoteStatusBadge } from './credit-note-status-badge';

type DetailState =
  | { status: 'loading' }
  | { status: 'ready'; creditNote: CreditNoteView }
  | { status: 'error'; message: string };

/** Format a VAT rate in basis points (2000) as a percentage string ("20%"). */
function formatVatRate(basisPoints: number): string {
  return `${basisPoints / 100}%`;
}

/**
 * Right-hand drawer showing one credit note in full: header (number/formatted
 * number, related return, related order, original invoice, customer, warehouse,
 * status, issuedAt), totals and the frozen line items (product, description,
 * quantity, unit price, tax rate, line net/VAT/total). It re-fetches the credit
 * note on open (the list row is only a summary). No PDF/download — that is a
 * separate task. All money is BigInt-string formatted, so arbitrarily large totals
 * stay exact (rule 3).
 */
export function CreditNoteDetailDrawer({
  creditNoteId,
  onClose,
}: {
  creditNoteId: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<DetailState>({ status: 'loading' });

  const load = useCallback(() => {
    let active = true;
    setState({ status: 'loading' });
    getCreditNote(creditNoteId)
      .then((creditNote) => {
        if (active) setState({ status: 'ready', creditNote });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const message =
          err instanceof ApiError
            ? (err.problem?.detail ?? err.message)
            : 'Could not load the credit note. Please try again.';
        setState({ status: 'error', message });
      });
    return () => {
      active = false;
    };
  }, [creditNoteId]);

  useEffect(() => load(), [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const creditNote = state.status === 'ready' ? state.creditNote : null;
  const title = creditNote ? `Credit note ${creditNote.creditNoteNo}` : 'Credit note';

  return (
    <div className="drawer-overlay" onClick={onClose} role="presentation">
      <aside
        className="drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-label="credit note detail"
        data-testid="credit-note-detail-drawer"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title">{title}</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        {state.status === 'loading' ? (
          <div className="table-state" aria-busy="true" data-testid="credit-note-detail-loading">
            Loading credit note…
          </div>
        ) : null}

        {state.status === 'error' ? (
          <div className="state-error" role="alert" data-testid="credit-note-detail-error">
            <p>{state.message}</p>
            <button type="button" className="button" onClick={load}>
              Retry
            </button>
          </div>
        ) : null}

        {creditNote ? (
          <div className="drawer-body">
            <dl className="detail-grid">
              <div>
                <dt>Credit note no</dt>
                <dd data-testid="detail-credit-note-no">{creditNote.creditNoteNo}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  <CreditNoteStatusBadge status={creditNote.status} />
                </dd>
              </div>
              <div>
                <dt>Return</dt>
                <dd>
                  <code>{creditNote.returnId}</code>
                </dd>
              </div>
              <div>
                <dt>Order</dt>
                <dd>
                  <code>{creditNote.orderId}</code>
                </dd>
              </div>
              <div>
                <dt>Original invoice</dt>
                <dd>
                  <code>{creditNote.originalInvoiceId}</code>
                </dd>
              </div>
              <div>
                <dt>Customer</dt>
                <dd>
                  <code>{creditNote.customerId}</code>
                </dd>
              </div>
              <div>
                <dt>Warehouse</dt>
                <dd>
                  <code>{creditNote.warehouseId}</code>
                </dd>
              </div>
              <div>
                <dt>Currency</dt>
                <dd>{creditNote.currency}</dd>
              </div>
              <div>
                <dt>Issued</dt>
                <dd>{new Date(creditNote.issuedAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Total</dt>
                <dd data-testid="credit-note-detail-total">
                  {formatMoney(creditNote.total.amount, creditNote.total.currency)}
                </dd>
              </div>
            </dl>

            <div className="table-wrap">
              <table className="data-table" data-testid="credit-note-items-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Description</th>
                    <th className="num">Qty</th>
                    <th className="num">Unit price</th>
                    <th className="num">Tax</th>
                    <th className="num">Line net</th>
                    <th className="num">Line VAT</th>
                    <th className="num">Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {creditNote.items.map((item, i) => (
                    <tr key={`${item.productId}-${i}`} data-testid={`credit-note-item-${i}`}>
                      <td>
                        <code>{item.productId}</code>
                      </td>
                      <td>{item.description}</td>
                      <td className="num">{item.quantity}</td>
                      <td className="num">
                        {formatMoney(item.unitPrice.amount, item.unitPrice.currency)}
                      </td>
                      <td className="num">{formatVatRate(item.vatRate)}</td>
                      <td className="num">
                        {formatMoney(item.lineSubtotal.amount, item.lineSubtotal.currency)}
                      </td>
                      <td className="num">
                        {formatMoney(item.lineVat.amount, item.lineVat.currency)}
                      </td>
                      <td className="num">
                        {formatMoney(item.lineTotal.amount, item.lineTotal.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={7} className="num">
                      Subtotal
                    </td>
                    <td className="num">
                      {formatMoney(creditNote.subtotal.amount, creditNote.subtotal.currency)}
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={7} className="num">
                      VAT
                    </td>
                    <td className="num">
                      {formatMoney(creditNote.vat.amount, creditNote.vat.currency)}
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={7} className="num">
                      <strong>Total</strong>
                    </td>
                    <td className="num">
                      <strong>
                        {formatMoney(creditNote.total.amount, creditNote.total.currency)}
                      </strong>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        ) : null}
      </aside>
    </div>
  );
}
