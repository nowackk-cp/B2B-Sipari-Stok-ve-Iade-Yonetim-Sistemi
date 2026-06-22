'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { InvoiceView, OrderView } from '@b2b/contracts';
import { issueInvoiceForOrder, problemMessages } from '../../../src/lib/invoices-client';
import { newIdempotencyKey } from '../../../src/lib/idempotency';
import { Modal } from '../modal';

/**
 * Dialog for issuing an invoice for a SHIPPED order. Issue allocates a gapless
 * number and freezes the order's line snapshot server-side; a single
 * `Idempotency-Key` is generated ONCE when the dialog opens and reused across
 * retries, so a transient-failure retry replays the same invoice instead of
 * burning a second number (rules 9, 11). On success the dialog stays open to show
 * the allocated invoice number and a link into the invoices list. An
 * already-invoiced order is a 409 surfaced inline. {@link onDone} refreshes the
 * order detail/list.
 */
export function IssueInvoiceDialog({
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
  const [issued, setIssued] = useState<InvoiceView | null>(null);

  async function onConfirm() {
    setErrors([]);
    setSubmitting(true);
    try {
      const invoice = await issueInvoiceForOrder(order.id, idempotencyKey);
      setIssued(invoice);
      onDone();
    } catch (err) {
      setErrors(problemMessages(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Issue invoice" onClose={onClose} testId="order-invoice-dialog">
      {issued ? (
        <div data-testid="order-invoice-success">
          <p>
            Invoice <strong data-testid="issued-invoice-no">{issued.invoiceNo ?? issued.id}</strong>{' '}
            was issued for order <strong>{order.orderNo}</strong>.
          </p>
          <div className="modal-actions">
            <button type="button" className="button" onClick={onClose}>
              Done
            </button>
            <Link
              href="/invoices"
              className="button button-primary"
              data-testid="goto-invoices"
              onClick={onClose}
            >
              View in invoices
            </Link>
          </div>
        </div>
      ) : (
        <>
          <p>
            Issue an invoice for order <strong>{order.orderNo}</strong>? A gapless invoice number is
            allocated from the company series. An order can be invoiced only once.
          </p>

          {errors.length > 0 ? (
            <ul className="form-error-list" role="alert" data-testid="order-invoice-error">
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
              className="button button-primary"
              onClick={onConfirm}
              disabled={submitting}
              data-testid="confirm-invoice"
            >
              {submitting ? 'Issuing…' : 'Issue invoice'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
