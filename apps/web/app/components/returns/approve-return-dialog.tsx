'use client';

import { useState } from 'react';
import type { ReturnView } from '@b2b/contracts';
import { approveReturn, problemMessages } from '../../../src/lib/returns-client';
import { newIdempotencyKey } from '../../../src/lib/idempotency';
import { Modal } from '../modal';

/**
 * Confirmation dialog for approving a DRAFT return. Approval restocks the goods
 * server-side (DRAFT→APPROVED, on_hand+, one RETURN_IN ledger movement) and is
 * full-return — no line DTO is sent. A single `Idempotency-Key` is generated ONCE
 * when the dialog opens (lazy `useState` initializer) and reused across retries, so
 * a transient-failure retry replays the same approval instead of double-restocking
 * (rule 9). Errors are shown inline; a success refreshes the detail/list via
 * {@link onDone}.
 */
export function ApproveReturnDialog({
  ret,
  onClose,
  onDone,
}: {
  ret: ReturnView;
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
      await approveReturn(ret.id, idempotencyKey);
      onDone();
      onClose();
    } catch (err) {
      setErrors(problemMessages(err));
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Approve return" onClose={onClose} testId="return-approve-dialog">
      <p>
        Approve return <strong>{ret.returnNo}</strong>? This restocks the returned goods into the
        order warehouse and cannot be undone.
      </p>

      {errors.length > 0 ? (
        <ul className="form-error-list" role="alert" data-testid="return-approve-error">
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
          data-testid="confirm-approve-return"
        >
          {submitting ? 'Approving…' : 'Approve return'}
        </button>
      </div>
    </Modal>
  );
}
