'use client';

import { useCallback, useEffect, useState } from 'react';
import type { OrderView } from '@b2b/contracts';
import { ApiError } from '../../../src/lib/api-fetch';
import { getOrder } from '../../../src/lib/orders-client';
import { formatMoney } from '../../../src/lib/money';
import { OrderStatusBadge } from './order-status-badge';
import { ApproveOrderDialog } from './approve-order-dialog';
import { ShipOrderDialog } from './ship-order-dialog';
import { IssueInvoiceDialog } from './issue-invoice-dialog';

/** An open in-drawer lifecycle dialog, with the order snapshot it acts on. */
type Action = { kind: 'approve' | 'ship' | 'invoice'; order: OrderView } | null;

type DetailState =
  | { status: 'loading' }
  | { status: 'ready'; order: OrderView }
  | { status: 'error'; message: string };

/** Format a VAT rate in basis points (2000) as a percentage string ("20%"). */
function formatVatRate(basisPoints: number): string {
  return `${basisPoints / 100}%`;
}

/**
 * Right-hand drawer showing one order in full: header, customer/warehouse, status,
 * totals and the line items (product, sku, quantity, unit price, tax rate, line
 * total). It re-fetches the order on open (the list row is only a summary).
 *
 * Actions are status-driven, mirroring the backend lifecycle (the server is always
 * the authority — UI hiding is convenience, not security, rule 7):
 *   - DRAFT      → Edit / Cancel (page-routed) + Approve
 *   - APPROVED   → Ship
 *   - SHIPPED    → Issue invoice
 *   - CANCELLED  → no actions
 * Approve/ship/invoice run in IN-DRAWER confirmation dialogs; on success the drawer
 * re-fetches itself (the status badge updates) AND calls {@link onChanged} so the
 * list page reloads too. Edit/cancel keep the existing page-routed flow.
 */
export function OrderDetailDrawer({
  orderId,
  onClose,
  onEdit,
  onCancel,
  onChanged,
}: {
  orderId: string;
  onClose: () => void;
  onEdit: (order: OrderView) => void;
  onCancel: (order: OrderView) => void;
  onChanged: () => void;
}) {
  const [state, setState] = useState<DetailState>({ status: 'loading' });
  // The dialog carries its own order snapshot, so a post-action drawer re-fetch
  // (which briefly nulls `order` while loading) does NOT unmount it — important for
  // the invoice dialog, which stays open to show the allocated number.
  const [action, setAction] = useState<Action>(null);

  const load = useCallback(() => {
    let active = true;
    setState({ status: 'loading' });
    getOrder(orderId)
      .then((order) => {
        if (active) setState({ status: 'ready', order });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const message =
          err instanceof ApiError
            ? (err.problem?.detail ?? err.message)
            : 'Could not load the order. Please try again.';
        setState({ status: 'error', message });
      });
    return () => {
      active = false;
    };
  }, [orderId]);

  useEffect(() => load(), [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const order = state.status === 'ready' ? state.order : null;
  const isDraft = order?.status === 'DRAFT';
  const isApproved = order?.status === 'APPROVED';
  const isShipped = order?.status === 'SHIPPED';

  /** A lifecycle action committed: re-fetch the drawer AND refresh the list. */
  const onLifecycleDone = useCallback(() => {
    load();
    onChanged();
  }, [load, onChanged]);

  return (
    <div className="drawer-overlay" onClick={onClose} role="presentation">
      <aside
        className="drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-label="order detail"
        data-testid="order-detail-drawer"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title">{order ? `Order ${order.orderNo}` : 'Order'}</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        {state.status === 'loading' ? (
          <div className="table-state" aria-busy="true" data-testid="order-detail-loading">
            Loading order…
          </div>
        ) : null}

        {state.status === 'error' ? (
          <div className="state-error" role="alert" data-testid="order-detail-error">
            <p>{state.message}</p>
            <button type="button" className="button" onClick={load}>
              Retry
            </button>
          </div>
        ) : null}

        {order ? (
          <div className="drawer-body">
            <dl className="detail-grid">
              <div>
                <dt>Status</dt>
                <dd>
                  <OrderStatusBadge status={order.status} />
                </dd>
              </div>
              <div>
                <dt>Currency</dt>
                <dd>{order.currency}</dd>
              </div>
              <div>
                <dt>Customer</dt>
                <dd>
                  <code>{order.customerId}</code>
                </dd>
              </div>
              <div>
                <dt>Warehouse</dt>
                <dd>
                  <code>{order.warehouseId}</code>
                </dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{new Date(order.createdAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Total</dt>
                <dd data-testid="detail-total">
                  {formatMoney(order.total.amount, order.total.currency)}
                </dd>
              </div>
            </dl>

            {order.note ? <p className="detail-note">{order.note}</p> : null}

            <div className="table-wrap">
              <table className="data-table" data-testid="order-items-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>SKU</th>
                    <th className="num">Qty</th>
                    <th className="num">Unit price</th>
                    <th className="num">Tax</th>
                    <th className="num">Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {order.items.map((item) => (
                    <tr key={item.productId} data-testid={`order-item-${item.productId}`}>
                      <td>{item.name}</td>
                      <td>
                        <code>{item.sku}</code>
                      </td>
                      <td className="num">{item.quantity}</td>
                      <td className="num">
                        {formatMoney(item.unitPrice.amount, item.unitPrice.currency)}
                      </td>
                      <td className="num">{formatVatRate(item.vatRate)}</td>
                      <td className="num">
                        {formatMoney(item.lineTotal.amount, item.lineTotal.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5} className="num">
                      Subtotal
                    </td>
                    <td className="num">
                      {formatMoney(order.subtotal.amount, order.subtotal.currency)}
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={5} className="num">
                      VAT
                    </td>
                    <td className="num">{formatMoney(order.vat.amount, order.vat.currency)}</td>
                  </tr>
                  <tr>
                    <td colSpan={5} className="num">
                      <strong>Total</strong>
                    </td>
                    <td className="num">
                      <strong>{formatMoney(order.total.amount, order.total.currency)}</strong>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {isDraft ? (
              <div className="modal-actions" data-testid="detail-draft-actions">
                <button
                  type="button"
                  className="button button-danger"
                  onClick={() => onCancel(order)}
                  data-testid="detail-cancel"
                >
                  Cancel order
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => onEdit(order)}
                  data-testid="detail-edit"
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => setAction({ kind: 'approve', order })}
                  data-testid="detail-approve"
                >
                  Approve
                </button>
              </div>
            ) : null}

            {isApproved ? (
              <div className="modal-actions" data-testid="detail-approved-actions">
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => setAction({ kind: 'ship', order })}
                  data-testid="detail-ship"
                >
                  Ship order
                </button>
              </div>
            ) : null}

            {isShipped ? (
              <div className="modal-actions" data-testid="detail-shipped-actions">
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => setAction({ kind: 'invoice', order })}
                  data-testid="detail-issue-invoice"
                >
                  Issue invoice
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {action?.kind === 'approve' ? (
          <ApproveOrderDialog
            order={action.order}
            onClose={() => setAction(null)}
            onDone={onLifecycleDone}
          />
        ) : null}
        {action?.kind === 'ship' ? (
          <ShipOrderDialog
            order={action.order}
            onClose={() => setAction(null)}
            onDone={onLifecycleDone}
          />
        ) : null}
        {action?.kind === 'invoice' ? (
          <IssueInvoiceDialog
            order={action.order}
            onClose={() => setAction(null)}
            onDone={onLifecycleDone}
          />
        ) : null}
      </aside>
    </div>
  );
}
