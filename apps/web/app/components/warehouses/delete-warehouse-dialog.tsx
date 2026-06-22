'use client';

import { useState } from 'react';
import type { WarehouseView } from '@b2b/contracts';
import { deleteWarehouse, problemMessages } from '../../../src/lib/warehouses-client';
import { Modal } from '../modal';

/**
 * Confirmation dialog for a (soft) warehouse delete. The backend keeps the row and
 * its audit trail; the UI only confirms intent, then refreshes the list. Errors
 * are shown inline rather than dismissing the dialog.
 */
export function DeleteWarehouseDialog({
  warehouse,
  onClose,
  onDeleted,
}: {
  warehouse: WarehouseView;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  async function onConfirm() {
    setErrors([]);
    setSubmitting(true);
    try {
      await deleteWarehouse(warehouse.id);
      onDeleted();
      onClose();
    } catch (err) {
      setErrors(problemMessages(err));
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Delete warehouse" onClose={onClose} testId="warehouse-delete-dialog">
      <p>
        Delete <strong>{warehouse.name}</strong> (<code>{warehouse.code}</code>)? This soft-deletes
        the warehouse; its code becomes reusable.
      </p>

      {errors.length > 0 ? (
        <ul className="form-error-list" role="alert" data-testid="warehouse-delete-error">
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
