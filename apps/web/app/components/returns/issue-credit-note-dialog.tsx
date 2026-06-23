'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { CreditNoteView, ReturnView } from '@b2b/contracts';
import { issueCreditNoteForReturn, problemMessages } from '../../../src/lib/credit-notes-client';
import { newIdempotencyKey } from '../../../src/lib/idempotency';
import { Modal } from '../modal';

/**
 * Dialog for issuing a credit note for an APPROVED return. Issue allocates a
 * gapless number and freezes the return's line snapshot server-side; a single
 * `Idempotency-Key` is generated ONCE when the dialog opens and reused across
 * retries, so a transient-failure retry replays the same credit note instead of
 * burning a second number (rules 9, 11). On success the dialog stays open to show
 * the allocated credit note number and a link into the credit notes list. A
 * duplicate credit note is a 409 and a return whose order has no invoice is a 422 —
 * both surfaced inline. {@link onDone} refreshes the return detail/list.
 */
export function IssueCreditNoteDialog({
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
  const [issued, setIssued] = useState<CreditNoteView | null>(null);

  async function onConfirm() {
    setErrors([]);
    setSubmitting(true);
    try {
      const creditNote = await issueCreditNoteForReturn(ret.id, idempotencyKey);
      setIssued(creditNote);
      onDone();
    } catch (err) {
      setErrors(problemMessages(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Issue credit note" onClose={onClose} testId="return-credit-note-dialog">
      {issued ? (
        <div data-testid="return-credit-note-success">
          <p>
            Credit note <strong data-testid="issued-credit-note-no">{issued.creditNoteNo}</strong>{' '}
            was issued for return <strong>{ret.returnNo}</strong>.
          </p>
          <div className="modal-actions">
            <button type="button" className="button" onClick={onClose}>
              Done
            </button>
            <Link
              href="/credit-notes"
              className="button button-primary"
              data-testid="goto-credit-notes"
              onClick={onClose}
            >
              View in credit notes
            </Link>
          </div>
        </div>
      ) : (
        <>
          <p>
            Issue a credit note for return <strong>{ret.returnNo}</strong>? A gapless credit note
            number is allocated from the company series. A return can be credited only once and its
            order must already have an invoice.
          </p>

          {errors.length > 0 ? (
            <ul className="form-error-list" role="alert" data-testid="return-credit-note-error">
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
              data-testid="confirm-credit-note"
            >
              {submitting ? 'Issuing…' : 'Issue credit note'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
