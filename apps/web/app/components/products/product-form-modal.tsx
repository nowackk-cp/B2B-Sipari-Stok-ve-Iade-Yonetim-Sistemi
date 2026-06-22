'use client';

import { type FormEvent, useState } from 'react';
import type { ProductView } from '@b2b/contracts';
import {
  createProduct,
  problemMessages,
  updateProduct,
  type ProductWriteInput,
} from '../../../src/lib/products-client';
import { Modal } from '../modal';

type Mode = 'create' | 'edit';

interface FormState {
  sku: string;
  name: string;
  description: string;
  currency: string;
  listPriceAmount: string;
  /** VAT rate in basis points, as text (2000 = 20%). */
  vatRate: string;
  criticalStockThreshold: string;
  isActive: boolean;
}

function initialState(product?: ProductView): FormState {
  return {
    sku: product?.sku ?? '',
    name: product?.name ?? '',
    description: product?.description ?? '',
    currency: product?.listPrice.currency ?? 'TRY',
    listPriceAmount: product?.listPrice.amount ?? '0',
    vatRate: product ? String(product.vatRate) : '0',
    criticalStockThreshold: product?.criticalStockThreshold ?? '',
    isActive: product?.isActive ?? true,
  };
}

/** Client-side guardrails before the request (the server re-validates strictly). */
function validate(form: FormState): string[] {
  const errors: string[] = [];
  if (!form.sku.trim()) errors.push('SKU is required.');
  if (!form.name.trim()) errors.push('Name is required.');
  if (!/^[A-Za-z]{3}$/.test(form.currency.trim()))
    errors.push('Currency must be a 3-letter ISO code (e.g. TRY).');
  if (!/^\d+$/.test(form.listPriceAmount.trim()))
    errors.push('List price must be a non-negative integer (minor units).');
  const vat = form.vatRate.trim();
  if (!/^\d+$/.test(vat) || Number(vat) > 10000)
    errors.push('Tax rate must be an integer in basis points between 0 and 10000.');
  if (form.criticalStockThreshold.trim() && !/^\d+$/.test(form.criticalStockThreshold.trim()))
    errors.push('Critical stock threshold must be a non-negative integer.');
  return errors;
}

/** Build the API payload — `companyId` is NEVER included (server-resolved tenant). */
function toPayload(form: FormState): ProductWriteInput {
  return {
    sku: form.sku.trim(),
    name: form.name.trim(),
    description: form.description.trim() ? form.description.trim() : null,
    listPrice: {
      amount: form.listPriceAmount.trim(),
      currency: form.currency.trim().toUpperCase(),
    },
    vatRate: Number(form.vatRate.trim()),
    criticalStockThreshold: form.criticalStockThreshold.trim()
      ? form.criticalStockThreshold.trim()
      : null,
    isActive: form.isActive,
  };
}

/**
 * Create/edit a product. On submit it validates locally, then calls the API and
 * maps RFC 7807 problems (duplicate-SKU 409, field validation) into a visible
 * error list. A successful save closes the modal and asks the page to refresh.
 */
export function ProductFormModal({
  mode,
  product,
  onClose,
  onSaved,
}: {
  mode: Mode;
  product?: ProductView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => initialState(product));
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
        await createProduct(payload);
      } else if (product) {
        await updateProduct(product.id, payload);
      }
      onSaved();
      onClose();
    } catch (err) {
      setErrors(problemMessages(err));
      setSubmitting(false);
    }
  }

  const title = mode === 'create' ? 'New product' : 'Edit product';

  return (
    <Modal title={title} onClose={onClose} testId="product-form-modal">
      <form onSubmit={onSubmit} aria-label="product form" className="form-grid">
        <label className="field">
          <span className="field-label">SKU</span>
          <input
            aria-label="sku"
            value={form.sku}
            onChange={(e) => set('sku', e.target.value)}
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
        <label className="field field-wide">
          <span className="field-label">Description (optional)</span>
          <textarea
            aria-label="description"
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            maxLength={2000}
            rows={2}
          />
        </label>
        <label className="field">
          <span className="field-label">Currency</span>
          <input
            aria-label="currency"
            value={form.currency}
            onChange={(e) => set('currency', e.target.value.toUpperCase())}
            maxLength={3}
          />
        </label>
        <label className="field">
          <span className="field-label">List price (minor units)</span>
          <input
            aria-label="listPriceAmount"
            inputMode="numeric"
            value={form.listPriceAmount}
            onChange={(e) => set('listPriceAmount', e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Tax rate (basis points)</span>
          <input
            aria-label="vatRate"
            inputMode="numeric"
            value={form.vatRate}
            onChange={(e) => set('vatRate', e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Critical stock threshold (optional)</span>
          <input
            aria-label="criticalStockThreshold"
            inputMode="numeric"
            value={form.criticalStockThreshold}
            onChange={(e) => set('criticalStockThreshold', e.target.value)}
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
          <ul className="form-error-list" role="alert" data-testid="product-form-error">
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
