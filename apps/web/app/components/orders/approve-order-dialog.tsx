'use client';

import { useState } from 'react';
import type { OrderView } from '@b2b/contracts';
import { approveOrder, problemMessages } from '../../../src/lib/orders-client';
import { Modal } from '../modal';

/**
 * Confirmation dialog for approving a DRAFT order. Approval atomically reserves
 * stock server-side (DRAFT→APPROVED); a shortfall or a stale product is rejected
 * (409/422) and shown inline rather than dismissing the dialog. No
 * `Idempotency-Key` is needed — the server's expected-status transition is the
 * replay guard. A success refreshes the detail/list via {@link onDone}.
 */
export function ApproveOrderDialog({
  order,
  onClose,
  onDone,
}: {
  order: OrderView;
  onClose: () => void;
  onDone: () => void;
}) {
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  async function onConfirm() {
    setErrors([]);
    setSubmitting(true);
    try {
      await approveOrder(order.id);
      onDone();
      onClose();
    } catch (err) {
      setErrors(problemMessages(err));
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Approve order" onClose={onClose} testId="order-approve-dialog">
      <p>
        Approve order <strong>{order.orderNo}</strong>? This reserves stock for every line. If any
        line is short of available stock the whole approval is rejected and the order stays a draft.
      </p>

      {errors.length > 0 ? (
        <ul className="form-error-list" role="alert" data-testid="order-approve-error">
          {errors.map((msg, i) => (
            <li key={i}>{msg}</li>
          ))}
        </ul>
      ) : null}

      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>
          Keep draft
        </button>
        <button
          type="button"
          className="button button-primary"
          onClick={onConfirm}
          disabled={submitting}
          data-testid="confirm-approve"
        >
          {submitting ? 'Approving…' : 'Approve order'}
        </button>
      </div>
    </Modal>
  );
}
