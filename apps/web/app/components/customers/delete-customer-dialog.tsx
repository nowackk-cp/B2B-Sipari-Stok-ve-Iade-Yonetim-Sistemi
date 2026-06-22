'use client';

import { useState } from 'react';
import type { CustomerView } from '@b2b/contracts';
import { deleteCustomer, problemMessages } from '../../../src/lib/customers-client';
import { Modal } from '../modal';

/**
 * Confirmation dialog for a (soft) customer delete. The backend keeps the row and
 * its audit trail; the UI only confirms intent, then refreshes the list. Errors
 * are shown inline rather than dismissing the dialog.
 */
export function DeleteCustomerDialog({
  customer,
  onClose,
  onDeleted,
}: {
  customer: CustomerView;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  async function onConfirm() {
    setErrors([]);
    setSubmitting(true);
    try {
      await deleteCustomer(customer.id);
      onDeleted();
      onClose();
    } catch (err) {
      setErrors(problemMessages(err));
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Delete customer" onClose={onClose} testId="customer-delete-dialog">
      <p>
        Delete <strong>{customer.name}</strong> (<code>{customer.code}</code>)? This soft-deletes
        the customer; its code becomes reusable.
      </p>

      {errors.length > 0 ? (
        <ul className="form-error-list" role="alert" data-testid="customer-delete-error">
          {errors.map((msg, i) => (
            <li key={i}>{msg}</li>
          ))}
        </ul>
      ) : null}

      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button button-danger"
          onClick={onConfirm}
          disabled={submitting}
          data-testid="confirm-delete"
        >
          {submitting ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </Modal>
  );
}
