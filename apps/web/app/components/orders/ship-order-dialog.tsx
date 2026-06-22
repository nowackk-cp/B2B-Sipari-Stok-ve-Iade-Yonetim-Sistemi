'use client';

import { useState } from 'react';
import type { OrderView } from '@b2b/contracts';
import { problemMessages, shipOrder } from '../../../src/lib/orders-client';
import { newIdempotencyKey } from '../../../src/lib/idempotency';
import { Modal } from '../modal';

/**
 * Confirmation dialog for shipping an APPROVED order. Shipment commits the
 * reserved stock server-side (APPROVED→SHIPPED) and is full-order — no line DTO is
 * sent. A single `Idempotency-Key` is generated ONCE when the dialog opens (lazy
 * `useState` initializer) and reused across retries, so a transient-failure retry
 * replays the same shipment instead of double-committing (rule 9). Errors are
 * shown inline; a success refreshes the detail/list via {@link onDone}.
 */
export function ShipOrderDialog({
  order,
  onClose,
  onDone,
}: {
  order: OrderView;
  onClose: () => void;
  onDone: () => void;
}) {
  // One stable key for the lifetime of this dialog (covers retry-after-error).
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  async function onConfirm() {
    setErrors([]);
    setSubmitting(true);
    try {
      await shipOrder(order.id, idempotencyKey);
      onDone();
      onClose();
    } catch (err) {
      setErrors(problemMessages(err));
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Ship order" onClose={onClose} testId="order-ship-dialog">
      <p>
        Ship order <strong>{order.orderNo}</strong>? This commits the reserved stock and cannot be
        undone — a shipped order can only be returned, not cancelled.
      </p>

      {errors.length > 0 ? (
        <ul className="form-error-list" role="alert" data-testid="order-ship-error">
          {errors.map((msg, i) => (
            <li key={i}>{msg}</li>
          ))}
        </ul>
      ) : null}

      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>
          Not yet
        </button>
        <button
          type="button"
          className="button button-primary"
          onClick={onConfirm}
          disabled={submitting}
          data-testid="confirm-ship"
        >
          {submitting ? 'Shipping…' : 'Ship order'}
        </button>
      </div>
    </Modal>
  );
}
