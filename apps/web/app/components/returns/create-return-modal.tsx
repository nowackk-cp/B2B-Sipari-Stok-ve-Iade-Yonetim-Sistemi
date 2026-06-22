'use client';

import { type FormEvent, useState } from 'react';
import Link from 'next/link';
import type { OrderView, ReturnView } from '@b2b/contracts';
import { createReturn, problemMessages, type CreateReturnItemInput } from '../../../src/lib/returns-client';
import { newIdempotencyKey } from '../../../src/lib/idempotency';
import { Modal } from '../modal';

/** One editable return line, seeded from a shipped order line. */
interface LineState {
  productId: string;
  sku: string;
  name: string;
  /** Order line quantity — the client-side ceiling for the return quantity. */
  shipped: string;
  /** Whether this line is included in the return. */
  include: boolean;
  /** Return quantity (free-text BIGINT string while editing). */
  quantity: string;
  /** Optional per-line reason. */
  reason: string;
}

function initialLines(order: OrderView): LineState[] {
  return order.items.map((i) => ({
    productId: i.productId,
    sku: i.sku,
    name: i.name,
    shipped: i.quantity,
    include: false,
    quantity: i.quantity,
    reason: '',
  }));
}

/**
 * Client-side guardrails before the request (the server re-validates strictly and
 * is the authority — rule 7). At least one line must be included; each included
 * line needs a positive whole quantity that does not exceed the shipped quantity.
 */
function validate(lines: LineState[]): string[] {
  const errors: string[] = [];
  const included = lines.filter((l) => l.include);
  if (included.length === 0) {
    errors.push('Select at least one item to return.');
    return errors;
  }
  for (const line of included) {
    const qty = line.quantity.trim();
    if (!/^\d+$/.test(qty) || BigInt(qty || '0') <= 0n) {
      errors.push(`Quantity for ${line.sku} must be a positive whole number.`);
      continue;
    }
    if (BigInt(qty) > BigInt(line.shipped)) {
      errors.push(`Quantity for ${line.sku} cannot exceed the shipped quantity (${line.shipped}).`);
    }
  }
  return errors;
}

/**
 * Modal for raising a return against a SHIPPED order. The form is built from the
 * order's line items: the user ticks the lines to return, sets a quantity (≤ the
 * shipped quantity, validated client-side) and an optional per-line reason. Only
 * the product, quantity and reason are sent — NEVER `companyId`, the warehouse,
 * price, tax or totals (server-derived; rules 3/12/16). A single `Idempotency-Key`
 * is generated ONCE when the modal opens and reused across retries, so a
 * transient-failure retry replays the same return instead of creating a second one
 * (rule 9). On success the modal stays open to show the new return number and a
 * link into the returns list; {@link onCreated} refreshes the order detail/list.
 */
export function CreateReturnModal({
  order,
  onClose,
  onCreated,
}: {
  order: OrderView;
  onClose: () => void;
  onCreated: () => void;
}) {
  // One stable key for the lifetime of this modal (covers retry-after-error).
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [lines, setLines] = useState<LineState[]>(() => initialLines(order));
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<ReturnView | null>(null);

  function setLine(index: number, patch: Partial<LineState>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const localErrors = validate(lines);
    if (localErrors.length > 0) {
      setErrors(localErrors);
      return;
    }
    setErrors([]);
    setSubmitting(true);
    try {
      const items: CreateReturnItemInput[] = lines
        .filter((l) => l.include)
        .map((l) => ({
          productId: l.productId,
          quantity: l.quantity.trim(),
          reason: l.reason.trim() || null,
        }));
      const ret = await createReturn(
        order.id,
        { items, reason: reason.trim() || null },
        idempotencyKey,
      );
      setCreated(ret);
      onCreated();
    } catch (err) {
      setErrors(problemMessages(err));
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Create return" onClose={onClose} testId="create-return-modal">
      {created ? (
        <div data-testid="create-return-success">
          <p>
            Return <strong data-testid="created-return-no">{created.returnNo}</strong> was raised for
            order <strong>{order.orderNo}</strong>.
          </p>
          <div className="modal-actions">
            <button type="button" className="button" onClick={onClose}>
              Done
            </button>
            <Link
              href="/returns"
              className="button button-primary"
              data-testid="goto-returns"
              onClick={onClose}
            >
              View in returns
            </Link>
          </div>
        </div>
      ) : (
        <form onSubmit={onSubmit} aria-label="return form" className="form-grid">
          <p className="field-hint field-wide">
            Raise a return for order <strong>{order.orderNo}</strong>. Tick the items to return and
            set a quantity — it cannot exceed the shipped quantity. The warehouse and amounts are
            resolved by the server.
          </p>

          <div className="field-wide order-lines">
            {lines.map((line, index) => (
              <div className="order-line" key={line.productId} data-testid={`return-line-${line.productId}`}>
                <label className="return-line-check">
                  <input
                    type="checkbox"
                    aria-label={`include ${line.sku}`}
                    checked={line.include}
                    onChange={(e) => setLine(index, { include: e.target.checked })}
                    data-testid={`return-include-${line.productId}`}
                  />
                  <span>
                    {line.sku} — {line.name} (shipped {line.shipped})
                  </span>
                </label>
                <input
                  aria-label={`return quantity ${line.sku}`}
                  className="order-line-qty"
                  inputMode="numeric"
                  value={line.quantity}
                  onChange={(e) => setLine(index, { quantity: e.target.value })}
                  disabled={!line.include}
                  data-testid={`return-qty-${line.productId}`}
                />
                <input
                  aria-label={`return reason ${line.sku}`}
                  placeholder="Reason (optional)"
                  value={line.reason}
                  onChange={(e) => setLine(index, { reason: e.target.value })}
                  disabled={!line.include}
                  maxLength={1000}
                />
              </div>
            ))}
          </div>

          <label className="field field-wide">
            <span className="field-label">Return reason (optional)</span>
            <textarea
              aria-label="return note"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={1000}
              rows={2}
            />
          </label>

          {errors.length > 0 ? (
            <ul className="form-error-list" role="alert" data-testid="create-return-error">
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
              type="submit"
              className="button button-primary"
              disabled={submitting}
              data-testid="confirm-create-return"
            >
              {submitting ? 'Creating…' : 'Create return'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
