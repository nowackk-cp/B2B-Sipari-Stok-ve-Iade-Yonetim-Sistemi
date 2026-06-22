'use client';

import { type FormEvent, useState } from 'react';
import type { WarehouseView } from '@b2b/contracts';
import {
  createWarehouse,
  problemMessages,
  updateWarehouse,
  type WarehouseWriteInput,
} from '../../../src/lib/warehouses-client';
import { Modal } from '../modal';

type Mode = 'create' | 'edit';

interface FormState {
  code: string;
  name: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  postalCode: string;
  country: string;
  isActive: boolean;
}

function initialState(warehouse?: WarehouseView): FormState {
  return {
    code: warehouse?.code ?? '',
    name: warehouse?.name ?? '',
    addressLine1: warehouse?.addressLine1 ?? '',
    addressLine2: warehouse?.addressLine2 ?? '',
    city: warehouse?.city ?? '',
    postalCode: warehouse?.postalCode ?? '',
    country: warehouse?.country ?? '',
    isActive: warehouse?.isActive ?? true,
  };
}

/** Client-side guardrails before the request (the server re-validates strictly). */
function validate(form: FormState): string[] {
  const errors: string[] = [];
  if (!form.code.trim()) errors.push('Code is required.');
  if (!form.name.trim()) errors.push('Name is required.');
  if (form.country.trim() && !/^[A-Za-z]{2}$/.test(form.country.trim()))
    errors.push('Country must be a 2-letter ISO code (e.g. TR).');
  return errors;
}

/** Trim a free-text field to `null` when empty (optional address columns). */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Build the API payload — `companyId` is NEVER included (server-resolved tenant). */
function toPayload(form: FormState): WarehouseWriteInput {
  return {
    code: form.code.trim(),
    name: form.name.trim(),
    addressLine1: orNull(form.addressLine1),
    addressLine2: orNull(form.addressLine2),
    city: orNull(form.city),
    postalCode: orNull(form.postalCode),
    country: form.country.trim() ? form.country.trim().toUpperCase() : null,
    isActive: form.isActive,
  };
}

/**
 * Create/edit a warehouse. On submit it validates locally, then calls the API and
 * maps RFC 7807 problems (duplicate-code 409, field validation) into a visible
 * error list. A successful save closes the modal and asks the page to refresh.
 */
export function WarehouseFormModal({
  mode,
  warehouse,
  onClose,
  onSaved,
}: {
  mode: Mode;
  warehouse?: WarehouseView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => initialState(warehouse));
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
        await createWarehouse(payload);
      } else if (warehouse) {
        await updateWarehouse(warehouse.id, payload);
      }
      onSaved();
      onClose();
    } catch (err) {
      setErrors(problemMessages(err));
      setSubmitting(false);
    }
  }

  const title = mode === 'create' ? 'New warehouse' : 'Edit warehouse';

  return (
    <Modal title={title} onClose={onClose} testId="warehouse-form-modal">
      <form onSubmit={onSubmit} aria-label="warehouse form" className="form-grid">
        <label className="field">
          <span className="field-label">Code</span>
          <input
            aria-label="code"
            value={form.code}
            onChange={(e) => set('code', e.target.value)}
            maxLength={32}
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
        <label className="field field-wide">
          <span className="field-label">Address line 1 (optional)</span>
          <input
            aria-label="addressLine1"
            value={form.addressLine1}
            onChange={(e) => set('addressLine1', e.target.value)}
            maxLength={255}
          />
        </label>
        <label className="field field-wide">
          <span className="field-label">Address line 2 (optional)</span>
          <input
            aria-label="addressLine2"
            value={form.addressLine2}
            onChange={(e) => set('addressLine2', e.target.value)}
            maxLength={255}
          />
        </label>
        <label className="field">
          <span className="field-label">City (optional)</span>
          <input
            aria-label="city"
            value={form.city}
            onChange={(e) => set('city', e.target.value)}
            maxLength={128}
          />
        </label>
        <label className="field">
          <span className="field-label">Postal code (optional)</span>
          <input
            aria-label="postalCode"
            value={form.postalCode}
            onChange={(e) => set('postalCode', e.target.value)}
            maxLength={32}
          />
        </label>
        <label className="field">
          <span className="field-label">Country (ISO 2-letter, optional)</span>
          <input
            aria-label="country"
            value={form.country}
            onChange={(e) => set('country', e.target.value.toUpperCase())}
            maxLength={2}
          />
        </label>
        <label className="field-check">
          <input
            type="checkbox"
            aria-label="isActive"
            checked={form.isActive}
            onChange={(e) => set('isActive', e.target.checked)}
          />
          <span>Active</span>
        </label>

        {errors.length > 0 ? (
          <ul className="form-error-list" role="alert" data-testid="warehouse-form-error">
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
