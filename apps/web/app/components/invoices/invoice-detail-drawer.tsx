'use client';

import { useCallback, useEffect, useState } from 'react';
import type { InvoiceView } from '@b2b/contracts';
import { ApiError } from '../../../src/lib/api-fetch';
import { getInvoice } from '../../../src/lib/invoices-client';
import { formatMoney } from '../../../src/lib/money';
import { InvoiceStatusBadge } from './invoice-status-badge';

type DetailState =
  | { status: 'loading' }
  | { status: 'ready'; invoice: InvoiceView }
  | { status: 'error'; message: string };

/** Format a VAT rate in basis points (2000) as a percentage string ("20%"). */
function formatVatRate(basisPoints: number): string {
  return `${basisPoints / 100}%`;
}

/**
 * Right-hand drawer showing one invoice in full: header (number/formatted number,
 * related order, customer, warehouse, status, issuedAt), totals and the frozen
 * line items (product, description, quantity, unit price, tax rate, line net/VAT/
 * total). It re-fetches the invoice on open (the list row is only a summary). No
 * PDF/download — that is a separate task. All money is BigInt-string formatted, so
 * arbitrarily large totals stay exact (rule 3).
 */
export function InvoiceDetailDrawer({
  invoiceId,
  onClose,
}: {
  invoiceId: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<DetailState>({ status: 'loading' });

  const load = useCallback(() => {
    let active = true;
    setState({ status: 'loading' });
    getInvoice(invoiceId)
      .then((invoice) => {
        if (active) setState({ status: 'ready', invoice });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const message =
          err instanceof ApiError
            ? (err.problem?.detail ?? err.message)
            : 'Could not load the invoice. Please try again.';
        setState({ status: 'error', message });
      });
    return () => {
      active = false;
    };
  }, [invoiceId]);

  useEffect(() => load(), [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const invoice = state.status === 'ready' ? state.invoice : null;
  const title = invoice ? `Invoice ${invoice.invoiceNo ?? invoice.id}` : 'Invoice';

  return (
    <div className="drawer-overlay" onClick={onClose} role="presentation">
      <aside
        className="drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-label="invoice detail"
        data-testid="invoice-detail-drawer"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title">{title}</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        {state.status === 'loading' ? (
          <div className="table-state" aria-busy="true" data-testid="invoice-detail-loading">
            Loading invoice…
          </div>
        ) : null}

        {state.status === 'error' ? (
          <div className="state-error" role="alert" data-testid="invoice-detail-error">
            <p>{state.message}</p>
            <button type="button" className="button" onClick={load}>
              Retry
            </button>
          </div>
        ) : null}

        {invoice ? (
          <div className="drawer-body">
            <dl className="detail-grid">
              <div>
                <dt>Invoice no</dt>
                <dd data-testid="detail-invoice-no">{invoice.invoiceNo ?? '—'}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  <InvoiceStatusBadge status={invoice.status} />
                </dd>
              </div>
              <div>
                <dt>Order</dt>
                <dd>{invoice.orderId ? <code>{invoice.orderId}</code> : '—'}</dd>
              </div>
              <div>
                <dt>Customer</dt>
                <dd>
                  <code>{invoice.customerId}</code>
                </dd>
              </div>
              <div>
                <dt>Warehouse</dt>
                <dd>{invoice.warehouseId ? <code>{invoice.warehouseId}</code> : '—'}</dd>
              </div>
              <div>
                <dt>Currency</dt>
                <dd>{invoice.currency}</dd>
              </div>
              <div>
                <dt>Issued</dt>
                <dd>{invoice.issuedAt ? new Date(invoice.issuedAt).toLocaleString() : '—'}</dd>
              </div>
              <div>
                <dt>Total</dt>
                <dd data-testid="invoice-detail-total">
                  {formatMoney(invoice.total.amount, invoice.total.currency)}
                </dd>
              </div>
            </dl>

            <div className="table-wrap">
              <table className="data-table" data-testid="invoice-items-table">
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
                  {invoice.items.map((item, i) => (
                    <tr key={`${item.productId ?? 'line'}-${i}`} data-testid={`invoice-item-${i}`}>
                      <td>{item.productId ? <code>{item.productId}</code> : '—'}</td>
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
                      {formatMoney(invoice.subtotal.amount, invoice.subtotal.currency)}
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={7} className="num">
                      VAT
                    </td>
                    <td className="num">{formatMoney(invoice.vat.amount, invoice.vat.currency)}</td>
                  </tr>
                  <tr>
                    <td colSpan={7} className="num">
                      <strong>Total</strong>
                    </td>
                    <td className="num">
                      <strong>{formatMoney(invoice.total.amount, invoice.total.currency)}</strong>
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
