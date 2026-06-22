'use client';

import { type FormEvent, useEffect, useState } from 'react';
import type { CustomerView, OrderView, ProductView, WarehouseView } from '@b2b/contracts';
import { listCustomers } from '../../../src/lib/customers-client';
import { listWarehouses } from '../../../src/lib/warehouses-client';
import { listProducts } from '../../../src/lib/products-client';
import {
  createOrder,
  problemMessages,
  updateOrder,
  type CreateOrderInput,
  type OrderItemInput,
  type UpdateOrderInput,
} from '../../../src/lib/orders-client';
import { Modal } from '../modal';

type Mode = 'create' | 'edit';

/** A single editable line in the form (quantity is a free-text BIGINT string). */
interface LineState {
  productId: string;
  quantity: string;
}

interface FormState {
  customerId: string;
  warehouseId: string;
  note: string;
  lines: LineState[];
}

/** Master-data option lists used to populate the selects. */
interface Options {
  customers: CustomerView[];
  warehouses: WarehouseView[];
  products: ProductView[];
}

/** Generous page size for the selects — the picker is not a full catalog browser. */
const OPTION_PAGE_SIZE = 100;

function initialState(order?: OrderView): FormState {
  return {
    customerId: order?.customerId ?? '',
    warehouseId: order?.warehouseId ?? '',
    note: order?.note ?? '',
    lines: order?.items.map((i) => ({ productId: i.productId, quantity: i.quantity })) ?? [
      { productId: '', quantity: '1' },
    ],
  };
}

/** Client-side guardrails before the request (the server re-validates strictly). */
function validate(form: FormState): string[] {
  const errors: string[] = [];
  if (!form.customerId) errors.push('A customer is required.');
  if (!form.warehouseId) errors.push('A warehouse is required.');
  const lines = form.lines.filter((l) => l.productId || l.quantity.trim());
  if (lines.length === 0) errors.push('At least one order item is required.');

  const seen = new Set<string>();
  for (const line of lines) {
    if (!line.productId) {
      errors.push('Every item needs a product selected.');
      continue;
    }
    if (!/^\d+$/.test(line.quantity.trim()) || BigInt(line.quantity.trim() || '0') <= 0n) {
      errors.push('Quantity must be a positive whole number.');
    }
    if (seen.has(line.productId)) {
      errors.push('The same product cannot be listed twice.');
    }
    seen.add(line.productId);
  }
  return errors;
}

/**
 * Build the API payload. Only customer, warehouse, product+quantity items and the
 * note are sent — NEVER `companyId`, `unitPrice`, `vatRate`, `subtotal` or `total`
 * (those are server-derived; rules 3/12/16).
 */
function toItems(form: FormState): OrderItemInput[] {
  return form.lines
    .filter((l) => l.productId)
    .map((l) => ({ productId: l.productId, quantity: l.quantity.trim() }));
}

/**
 * Create/edit a DRAFT order. On mount it loads the customer/warehouse/product
 * option lists; on submit it validates locally, calls the API, and maps RFC 7807
 * problems into a visible error list. A successful save closes the modal and asks
 * the page to refresh.
 */
export function OrderFormModal({
  mode,
  order,
  onClose,
  onSaved,
}: {
  mode: Mode;
  order?: OrderView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => initialState(order));
  const [options, setOptions] = useState<Options | null>(null);
  const [optionsError, setOptionsError] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    setOptionsError(false);
    Promise.all([
      listCustomers({ limit: OPTION_PAGE_SIZE }),
      listWarehouses({ limit: OPTION_PAGE_SIZE, isActive: 'true' }),
      listProducts({ limit: OPTION_PAGE_SIZE, isActive: 'true' }),
    ])
      .then(([customers, warehouses, products]) => {
        if (!active) return;
        setOptions({
          customers: customers.data,
          warehouses: warehouses.data,
          products: products.data,
        });
      })
      .catch(() => {
        if (active) setOptionsError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }
  function setLine(index: number, patch: Partial<LineState>) {
    setForm((prev) => ({
      ...prev,
      lines: prev.lines.map((l, i) => (i === index ? { ...l, ...patch } : l)),
    }));
  }
  function addLine() {
    setForm((prev) => ({ ...prev, lines: [...prev.lines, { productId: '', quantity: '1' }] }));
  }
  function removeLine(index: number) {
    setForm((prev) => ({
      ...prev,
      lines: prev.lines.length > 1 ? prev.lines.filter((_, i) => i !== index) : prev.lines,
    }));
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
      if (mode === 'create') {
        const payload: CreateOrderInput = {
          customerId: form.customerId,
          warehouseId: form.warehouseId,
          items: toItems(form),
          note: form.note.trim() || null,
        };
        await createOrder(payload);
      } else if (order) {
        const payload: UpdateOrderInput = {
          customerId: form.customerId,
          warehouseId: form.warehouseId,
          items: toItems(form),
          note: form.note.trim() || null,
        };
        await updateOrder(order.id, payload);
      }
      onSaved();
      onClose();
    } catch (err) {
      setErrors(problemMessages(err));
      setSubmitting(false);
    }
  }

  const title = mode === 'create' ? 'New order' : 'Edit order';

  return (
    <Modal title={title} onClose={onClose} testId="order-form-modal">
      {optionsError ? (
        <div className="state-error" role="alert" data-testid="order-options-error">
          <p>Could not load customers, warehouses or products. Please close and try again.</p>
        </div>
      ) : null}

      <form onSubmit={onSubmit} aria-label="order form" className="form-grid">
        <label className="field">
          <span className="field-label">Customer</span>
          <select
            aria-label="customer"
            value={form.customerId}
            onChange={(e) => set('customerId', e.target.value)}
            disabled={!options}
          >
            <option value="">Select a customer…</option>
            {options?.customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} — {c.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field-label">Warehouse</span>
          <select
            aria-label="warehouse"
            value={form.warehouseId}
            onChange={(e) => set('warehouseId', e.target.value)}
            disabled={!options}
          >
            <option value="">Select a warehouse…</option>
            {options?.warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} — {w.name}
              </option>
            ))}
          </select>
        </label>

        <div className="field-wide order-lines">
          <div className="order-lines-head">
            <span className="field-label">Items</span>
            <button
              type="button"
              className="button button-sm"
              onClick={addLine}
              disabled={!options}
              data-testid="add-line"
            >
              Add item
            </button>
          </div>

          {form.lines.map((line, index) => (
            <div className="order-line" key={index} data-testid={`order-line-${index}`}>
              <select
                aria-label={`product ${index + 1}`}
                value={line.productId}
                onChange={(e) => setLine(index, { productId: e.target.value })}
                disabled={!options}
              >
                <option value="">Select a product…</option>
                {options?.products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.sku} — {p.name}
                  </option>
                ))}
              </select>
              <input
                aria-label={`quantity ${index + 1}`}
                className="order-line-qty"
                inputMode="numeric"
                value={line.quantity}
                onChange={(e) => setLine(index, { quantity: e.target.value })}
              />
              <button
                type="button"
                className="button button-sm button-danger"
                onClick={() => removeLine(index)}
                disabled={form.lines.length <= 1}
                aria-label={`remove item ${index + 1}`}
                data-testid={`remove-line-${index}`}
              >
                Remove
              </button>
            </div>
          ))}
          <p className="field-hint">
            Prices, tax and totals are calculated by the server from the product list price.
          </p>
        </div>

        <label className="field field-wide">
          <span className="field-label">Note (optional)</span>
          <textarea
            aria-label="note"
            value={form.note}
            onChange={(e) => set('note', e.target.value)}
            maxLength={1000}
            rows={2}
          />
        </label>

        {errors.length > 0 ? (
          <ul className="form-error-list" role="alert" data-testid="order-form-error">
            {errors.map((msg, i) => (
              <li key={i}>{msg}</li>
            ))}
          </ul>
        ) : null}

        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={submitting || !options}>
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
