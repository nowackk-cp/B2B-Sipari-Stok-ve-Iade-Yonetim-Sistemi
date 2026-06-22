'use client';

import { type FormEvent, useState } from 'react';
import type { CustomerView } from '@b2b/contracts';
import {
  createCustomer,
  problemMessages,
  updateCustomer,
  type CustomerWriteInput,
} from '../../../src/lib/customers-client';
import { Modal } from '../modal';

type Mode = 'create' | 'edit';

/** Customer kinds accepted by the backend (CreateCustomerDto). */
const CUSTOMER_TYPES = ['COMPANY', 'INDIVIDUAL'] as const;

interface FormState {
  code: string;
  name: string;
  type: string;
  taxNumber: string;
  email: string;
  phone: string;
}

function initialState(customer?: CustomerView): FormState {
  return {
    code: customer?.code ?? '',
    name: customer?.name ?? '',
    type: customer?.type ?? 'COMPANY',
    taxNumber: customer?.taxNumber ?? '',
    email: customer?.email ?? '',
    phone: customer?.phone ?? '',
  };
}

/** Client-side guardrails before the request (the server re-validates strictly). */
function validate(form: FormState): string[] {
  const errors: string[] = [];
  if (!form.code.trim()) errors.push('Code is required.');
  if (!form.name.trim()) errors.push('Name is required.');
  if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()))
    errors.push('Email must be a valid address.');
  return errors;
}

/** Trim a free-text field to `null` when empty (optional columns). */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Build the API payload — `companyId` is NEVER included (server-resolved tenant). */
function toPayload(form: FormState): CustomerWriteInput {
  return {
    code: form.code.trim(),
    name: form.name.trim(),
    type: form.type,
    taxNumber: orNull(form.taxNumber),
    email: orNull(form.email),
    phone: orNull(form.phone),
  };
}

/**
 * Create/edit a customer. On submit it validates locally, then calls the API and
 * maps RFC 7807 problems (duplicate-code 409, field validation) into a visible
 * error list. A successful save closes the modal and asks the page to refresh.
 */
export function CustomerFormModal({
  mode,
  customer,
  onClose,
  onSaved,
}: {
  mode: Mode;
  customer?: CustomerView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => initialState(customer));
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const localErrors = validate(form);
    if (localErrors.length > 0) {
      setErrors(localErrors);
      return;
    }
    setErrors([]);
    setSubmitting(true);
    try {
      const payload = toPayload(form);
      if (mode === 'create') {
        await createCustomer(payload);
      } else if (customer) {
        await updateCustomer(customer.id, payload);
      }
      onSaved();
      onClose();
    } catch (err) {
      setErrors(problemMessages(err));
      setSubmitting(false);
    }
  }

  const title = mode === 'create' ? 'New customer' : 'Edit customer';

  return (
    <Modal title={title} onClose={onClose} testId="customer-form-modal">
      <form onSubmit={onSubmit} aria-label="customer form" className="form-grid">
        <label className="field">
          <span className="field-label">Code</span>
          <input
            aria-label="code"
            value={form.code}
            onChange={(e) => set('code', e.target.value)}
            maxLength={64}
          />
        </label>
        <label className="field">
          <span className="field-label">Name</span>
          <input
            aria-label="name"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            maxLength={255}
          />
        </label>
        <label className="field">
          <span className="field-label">Type</span>
          <select aria-label="type" value={form.type} onChange={(e) => set('type', e.target.value)}>
            {CUSTOMER_TYPES.map((t) => (
              <option key={t} value={t}>
                {t === 'COMPANY' ? 'Company' : 'Individual'}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Tax number (optional)</span>
          <input
            aria-label="taxNumber"
            value={form.taxNumber}
            onChange={(e) => set('taxNumber', e.target.value)}
            maxLength={64}
          />
        </label>
        <label className="field">
          <span className="field-label">Email (optional)</span>
          <input
            aria-label="email"
            type="email"
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
            maxLength={255}
          />
        </label>
        <label className="field">
          <span className="field-label">Phone (optional)</span>
          <input
            aria-label="phone"
            value={form.phone}
            onChange={(e) => set('phone', e.target.value)}
            maxLength={32}
          />
        </label>

        {errors.length > 0 ? (
          <ul className="form-error-list" role="alert" data-testid="customer-form-error">
            {errors.map((msg, i) => (
              <li key={i}>{msg}</li>
            ))}
          </ul>
        ) : null}

        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={submitting}>
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
