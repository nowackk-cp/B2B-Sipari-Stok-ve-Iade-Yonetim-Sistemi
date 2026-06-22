'use client';

import { useState } from 'react';
import type { OrderView } from '@b2b/contracts';
import { cancelOrder, problemMessages } from '../../../src/lib/orders-client';
import { Modal } from '../modal';

/**
 * Confirmation dialog for cancelling a DRAFT order. A DRAFT cancel has no stock
 * effect (the order was never reserved); the reason is optional. Errors are shown
 * inline rather than dismissing the dialog; a success refreshes the list/detail.
 */
export function CancelOrderDialog({
  order,
  onClose,
  onCancelled,
}: {
  order: OrderView;
  onClose: () => void;
  onCancelled: () => void;
}) {
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  async function onConfirm() {
    setErrors([]);
    setSubmitting(true);
    try {
      await cancelOrder(order.id, reason.trim() || null);
      onCancelled();
      onClose();
    } catch (err) {
      setErrors(problemMessages(err));
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Cancel order" onClose={onClose} testId="order-cancel-dialog">
      <p>
        Cancel order <strong>{order.orderNo}</strong>? A draft cancel has no stock effect and cannot
        be undone.
      </p>

      <label className="field">
        <span className="field-label">Reason (optional)</span>
        <textarea
          aria-label="cancel reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          rows={2}
        />
      </label>

      {errors.length > 0 ? (
        <ul className="form-error-list" role="alert" data-testid="order-cancel-error">
          {errors.map((msg, i) => (
            <li key={i}>{msg}</li>
          ))}
        </ul>
      ) : null}

      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>
          Keep order
        </button>
        <button
          type="button"
          className="button button-danger"
          onClick={onConfirm}
          disabled={submitting}
          data-testid="confirm-cancel"
        >
          {submitting ? 'Cancelling…' : 'Cancel order'}
        </button>
      </div>
    </Modal>
  );
}
