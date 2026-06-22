'use client';

import { useCallback, useEffect, useState } from 'react';
import type { OrderView } from '@b2b/contracts';
import { ApiError } from '../../../src/lib/api-fetch';
import { listOrders } from '../../../src/lib/orders-client';
import { formatMoney } from '../../../src/lib/money';
import { OrderFormModal } from '../../components/orders/order-form-modal';
import { OrderDetailDrawer } from '../../components/orders/order-detail-drawer';
import { CancelOrderDialog } from '../../components/orders/cancel-order-dialog';
import { OrderStatusBadge } from '../../components/orders/order-status-badge';

type StatusFilter = 'all' | 'DRAFT' | 'APPROVED' | 'SHIPPED' | 'CANCELLED';

const STATUS_FILTERS: StatusFilter[] = ['all', 'DRAFT', 'APPROVED', 'SHIPPED', 'CANCELLED'];

type ListState =
  | { status: 'loading' }
  | { status: 'ready'; orders: OrderView[]; hasNextPage: boolean; nextCursor: string | null }
  | { status: 'error'; message: string };

type Modal =
  | { type: 'create' }
  | { type: 'detail'; orderId: string }
  | { type: 'edit'; order: OrderView }
  | { type: 'cancel'; order: OrderView }
  | null;

/** Map the UI status filter to the backend `status` query param. */
function statusParam(filter: StatusFilter): string | undefined {
  return filter === 'all' ? undefined : filter;
}

export default function OrdersPage() {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [prevCursors, setPrevCursors] = useState<Array<string | undefined>>([]);
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [modal, setModal] = useState<Modal>(null);

  const load = useCallback(() => {
    let active = true;
    setState({ status: 'loading' });
    listOrders({ status: statusParam(filter), cursor })
      .then((page) => {
        if (!active) return;
        setState({
          status: 'ready',
          orders: page.data,
          hasNextPage: page.pageInfo.hasNextPage,
          nextCursor: page.pageInfo.nextCursor,
        });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const message =
          err instanceof ApiError
            ? (err.problem?.detail ?? err.message)
            : 'Could not load orders. Please try again.';
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
    <section aria-label="orders">
      <div className="page-head">
        <h1 className="page-title">Orders</h1>
        <div className="page-actions">
          <button
            type="button"
            className="button button-primary"
            onClick={() => setModal({ type: 'create' })}
            data-testid="open-create"
          >
            New order
          </button>
        </div>
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
        <div className="table-state" aria-busy="true" data-testid="orders-loading">
          Loading orders…
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="state-error" role="alert" data-testid="orders-error">
          <p>{state.message}</p>
          <button type="button" className="button" onClick={load}>
            Retry
          </button>
        </div>
      ) : null}

      {state.status === 'ready' && state.orders.length === 0 ? (
        <div className="table-state" data-testid="orders-empty">
          No orders found.
        </div>
      ) : null}

      {state.status === 'ready' && state.orders.length > 0 ? (
        <>
          <div className="table-wrap">
            <table className="data-table" data-testid="orders-table">
              <thead>
                <tr>
                  <th>Order no</th>
                  <th>Customer</th>
                  <th>Warehouse</th>
                  <th>Status</th>
                  <th>Currency</th>
                  <th className="num">Total</th>
                  <th>Created</th>
                  <th aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {state.orders.map((o) => {
                  const isDraft = o.status === 'DRAFT';
                  return (
                    <tr key={o.id} data-testid={`order-row-${o.id}`}>
                      <td>
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => setModal({ type: 'detail', orderId: o.id })}
                          data-testid={`open-detail-${o.id}`}
                        >
                          {o.orderNo}
                        </button>
                      </td>
                      <td>
                        <code>{o.customerId}</code>
                      </td>
                      <td>
                        <code>{o.warehouseId}</code>
                      </td>
                      <td>
                        <OrderStatusBadge status={o.status} />
                      </td>
                      <td>{o.currency}</td>
                      <td className="num" data-testid={`order-total-${o.id}`}>
                        {formatMoney(o.total.amount, o.total.currency)}
                      </td>
                      <td>{new Date(o.createdAt).toLocaleDateString()}</td>
                      <td className="row-actions">
                        <button
                          type="button"
                          className="button button-sm"
                          onClick={() => setModal({ type: 'edit', order: o })}
                          disabled={!isDraft}
                          data-testid={`edit-${o.id}`}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="button button-sm button-danger"
                          onClick={() => setModal({ type: 'cancel', order: o })}
                          disabled={!isDraft}
                          data-testid={`cancel-${o.id}`}
                        >
                          Cancel
                        </button>
                      </td>
                    </tr>
                  );
                })}
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
        <OrderFormModal mode="create" onClose={() => setModal(null)} onSaved={load} />
      ) : null}
      {modal?.type === 'edit' ? (
        <OrderFormModal
          mode="edit"
          order={modal.order}
          onClose={() => setModal(null)}
          onSaved={load}
        />
      ) : null}
      {modal?.type === 'cancel' ? (
        <CancelOrderDialog order={modal.order} onClose={() => setModal(null)} onCancelled={load} />
      ) : null}
      {modal?.type === 'detail' ? (
        <OrderDetailDrawer
          orderId={modal.orderId}
          onClose={() => setModal(null)}
          onEdit={(order) => setModal({ type: 'edit', order })}
          onCancel={(order) => setModal({ type: 'cancel', order })}
          onChanged={load}
        />
      ) : null}
    </section>
  );
}
