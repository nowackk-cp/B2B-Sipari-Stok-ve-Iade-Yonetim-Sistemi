'use client';

import { useState } from 'react';
import type { ProductView } from '@b2b/contracts';
import { deleteProduct, problemMessages } from '../../../src/lib/products-client';
import { Modal } from '../modal';

/**
 * Confirmation dialog for a (soft) product delete. The backend keeps the row and
 * its audit trail; the UI only confirms intent, then refreshes the list. Errors
 * are shown inline rather than dismissing the dialog.
 */
export function DeleteProductDialog({
  product,
  onClose,
  onDeleted,
}: {
  product: ProductView;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  async function onConfirm() {
    setErrors([]);
    setSubmitting(true);
    try {
      await deleteProduct(product.id);
      onDeleted();
      onClose();
    } catch (err) {
      setErrors(problemMessages(err));
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Delete product" onClose={onClose} testId="product-delete-dialog">
      <p>
        Delete <strong>{product.name}</strong> (<code>{product.sku}</code>)? This soft-deletes the
        product; its SKU becomes reusable.
      </p>

      {errors.length > 0 ? (
        <ul className="form-error-list" role="alert" data-testid="product-delete-error">
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
