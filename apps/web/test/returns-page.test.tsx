import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CreditNoteView, ReturnListView, ReturnView } from '@b2b/contracts';
import ReturnsPage from '../app/(app)/returns/page';
import { ApiError } from '../src/lib/api-fetch';
import * as returnsClient from '../src/lib/returns-client';
import * as creditNotesClient from '../src/lib/credit-notes-client';

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('../src/lib/returns-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/returns-client')>();
  return { ...actual, listReturns: vi.fn(), getReturn: vi.fn(), approveReturn: vi.fn() };
});
vi.mock('../src/lib/credit-notes-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/credit-notes-client')>();
  return { ...actual, issueCreditNoteForReturn: vi.fn() };
});

const listReturns = vi.mocked(returnsClient.listReturns);
const getReturn = vi.mocked(returnsClient.getReturn);
const approveReturn = vi.mocked(returnsClient.approveReturn);
const issueCreditNoteForReturn = vi.mocked(creditNotesClient.issueCreditNoteForReturn);

const money = (amount: string, currency = 'TRY') => ({ amount, currency });

function ret(over: Partial<ReturnView> = {}): ReturnView {
  return {
    id: 'ret-1',
    returnNo: 'RET-20260101-ABCDEF0123',
    status: 'DRAFT',
    orderId: 'ord-1',
    customerId: 'cust-1',
    warehouseId: 'wh-1',
    invoiceId: 'inv-1',
    reason: null,
    items: [{ productId: 'p1', quantity: '2', reason: 'damaged' }],
    createdAt: '2026-01-03T00:00:00.000Z',
    approvedAt: null,
    ...over,
  };
}

function creditNote(over: Partial<CreditNoteView> = {}): CreditNoteView {
  return {
    id: 'cn-1',
    creditNoteNo: 'CRN-2026-000001',
    creditNoteNumber: '1',
    seriesCode: 'CRN',
    fiscalYear: 2026,
    status: 'ISSUED',
    returnId: 'ret-1',
    orderId: 'ord-1',
    originalInvoiceId: 'inv-1',
    customerId: 'cust-1',
    warehouseId: 'wh-1',
    currency: 'TRY',
    subtotal: money('10000'),
    vat: money('2000'),
    total: money('12000'),
    items: [],
    issuedAt: '2026-01-04T00:00:00.000Z',
    createdAt: '2026-01-04T00:00:00.000Z',
    ...over,
  };
}

function returnPage(
  returns: ReturnView[],
  hasNextPage = false,
  nextCursor: string | null = null,
): ReturnListView {
  return { data: returns, pageInfo: { hasNextPage, nextCursor } };
}

/** Open the detail drawer for the single listed return with the given status. */
async function openDetail(over: Partial<ReturnView> = {}): Promise<void> {
  listReturns.mockResolvedValue(returnPage([ret(over)]));
  getReturn.mockResolvedValue(ret(over));
  render(<ReturnsPage />);
  await screen.findByTestId('returns-table');
  fireEvent.click(screen.getByTestId('open-detail-ret-1'));
  await screen.findByTestId('return-detail-drawer');
  await screen.findByTestId('return-items-table');
}

beforeEach(() => {
  vi.clearAllMocks();
  listReturns.mockResolvedValue(returnPage([ret()]));
  getReturn.mockResolvedValue(ret());
});

describe('ReturnsPage — list', () => {
  it('shows loading then renders the return rows', async () => {
    render(<ReturnsPage />);
    expect(screen.getByTestId('returns-loading')).toBeDefined();
    await screen.findByTestId('returns-table');
    expect(screen.getByText('RET-20260101-ABCDEF0123')).toBeDefined();
  });

  it('renders an empty state when there are no returns', async () => {
    listReturns.mockResolvedValue(returnPage([]));
    render(<ReturnsPage />);
    await screen.findByTestId('returns-empty');
  });

  it('shows an error state with a working retry', async () => {
    listReturns.mockRejectedValueOnce(new Error('boom'));
    render(<ReturnsPage />);
    await screen.findByTestId('returns-error');
    listReturns.mockResolvedValueOnce(returnPage([ret()]));
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByTestId('returns-table');
  });

  it('reflects the status filter in the list query', async () => {
    render(<ReturnsPage />);
    await screen.findByTestId('returns-table');
    fireEvent.change(screen.getByLabelText('filter by status'), { target: { value: 'APPROVED' } });
    await waitFor(() =>
      expect(listReturns).toHaveBeenCalledWith(expect.objectContaining({ status: 'APPROVED' })),
    );
  });

  it('paginates with Next/Previous using the cursor', async () => {
    listReturns.mockResolvedValueOnce(returnPage([ret()], true, 'cur-2'));
    render(<ReturnsPage />);
    await screen.findByTestId('returns-table');

    listReturns.mockResolvedValueOnce(
      returnPage([ret({ id: 'ret-2', returnNo: 'RET-20260101-2222222222' })]),
    );
    fireEvent.click(screen.getByTestId('page-next'));

    await waitFor(() =>
      expect(listReturns).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'cur-2' })),
    );
    await screen.findByText('RET-20260101-2222222222');
  });
});

describe('ReturnsPage — detail', () => {
  it('opens the drawer and lists the return line items', async () => {
    await openDetail();
    const items = screen.getByTestId('return-items-table');
    expect(within(items).getByText('damaged')).toBeDefined();
    expect(getReturn).toHaveBeenCalledWith('ret-1');
  });

  it('shows the approve action for a DRAFT return and not the credit-note action', async () => {
    await openDetail({ status: 'DRAFT' });
    expect(screen.getByTestId('detail-approve-return')).toBeDefined();
    expect(screen.queryByTestId('detail-issue-credit-note')).toBeNull();
  });

  it('shows the credit-note action for an APPROVED return and not the approve action', async () => {
    await openDetail({ status: 'APPROVED', approvedAt: '2026-01-04T00:00:00.000Z' });
    expect(screen.getByTestId('detail-issue-credit-note')).toBeDefined();
    expect(screen.queryByTestId('detail-approve-return')).toBeNull();
  });
});

describe('ReturnsPage — approve', () => {
  it('confirms, approves with an Idempotency-Key, and refreshes detail + list', async () => {
    await openDetail({ status: 'DRAFT' });
    approveReturn.mockResolvedValue(ret({ status: 'APPROVED' }));
    getReturn.mockResolvedValue(ret({ status: 'APPROVED' }));
    const listBefore = listReturns.mock.calls.length;
    const detailBefore = getReturn.mock.calls.length;

    fireEvent.click(screen.getByTestId('detail-approve-return'));
    const dialog = await screen.findByTestId('return-approve-dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-approve-return'));

    await waitFor(() => expect(approveReturn).toHaveBeenCalledTimes(1));
    const [id, key] = approveReturn.mock.calls[0]!;
    expect(id).toBe('ret-1');
    expect(typeof key).toBe('string');
    expect((key as string).length).toBeGreaterThan(0);
    await waitFor(() => expect(listReturns.mock.calls.length).toBeGreaterThan(listBefore));
    await waitFor(() => expect(getReturn.mock.calls.length).toBeGreaterThan(detailBefore));
  });

  it('shows an RFC7807 error inline when approve fails', async () => {
    await openDetail({ status: 'DRAFT' });
    approveReturn.mockRejectedValue(
      new ApiError(422, 'Unprocessable', {
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        code: 'BUSINESS_RULE',
        detail: 'The return warehouse is no longer active',
      }),
    );

    fireEvent.click(screen.getByTestId('detail-approve-return'));
    const dialog = await screen.findByTestId('return-approve-dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-approve-return'));

    const error = await screen.findByTestId('return-approve-error');
    expect(error.textContent).toMatch(/no longer active/i);
  });

  it('reuses the SAME Idempotency-Key when a failed approve is retried', async () => {
    await openDetail({ status: 'DRAFT' });
    approveReturn.mockRejectedValueOnce(
      new ApiError(503, 'Unavailable', {
        type: 'about:blank',
        title: 'Service Unavailable',
        status: 503,
        code: 'INTERNAL',
        detail: 'Try again',
      }),
    );

    fireEvent.click(screen.getByTestId('detail-approve-return'));
    const dialog = await screen.findByTestId('return-approve-dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-approve-return'));
    await screen.findByTestId('return-approve-error');

    approveReturn.mockResolvedValueOnce(ret({ status: 'APPROVED' }));
    fireEvent.click(within(dialog).getByTestId('confirm-approve-return'));

    await waitFor(() => expect(approveReturn).toHaveBeenCalledTimes(2));
    expect(approveReturn.mock.calls[1]![1]).toBe(approveReturn.mock.calls[0]![1]);
  });
});

describe('ReturnsPage — issue credit note', () => {
  it('issues a credit note (Idempotency-Key, no body), shows the number and refreshes', async () => {
    await openDetail({ status: 'APPROVED', approvedAt: '2026-01-04T00:00:00.000Z' });
    issueCreditNoteForReturn.mockResolvedValue(creditNote());
    const listBefore = listReturns.mock.calls.length;

    fireEvent.click(screen.getByTestId('detail-issue-credit-note'));
    const dialog = await screen.findByTestId('return-credit-note-dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-credit-note'));

    await waitFor(() => expect(issueCreditNoteForReturn).toHaveBeenCalledTimes(1));
    const [id, key] = issueCreditNoteForReturn.mock.calls[0]!;
    expect(id).toBe('ret-1');
    expect(typeof key).toBe('string');
    expect((key as string).length).toBeGreaterThan(0);

    const no = await screen.findByTestId('issued-credit-note-no');
    expect(no.textContent).toBe('CRN-2026-000001');
    expect(screen.getByTestId('goto-credit-notes')).toBeDefined();
    await waitFor(() => expect(listReturns.mock.calls.length).toBeGreaterThan(listBefore));
  });

  it('shows the already-credited (409) error inline', async () => {
    await openDetail({ status: 'APPROVED', approvedAt: '2026-01-04T00:00:00.000Z' });
    issueCreditNoteForReturn.mockRejectedValue(
      new ApiError(409, 'Conflict', {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        code: 'CONFLICT',
        detail: 'Return has already been credited',
      }),
    );

    fireEvent.click(screen.getByTestId('detail-issue-credit-note'));
    const dialog = await screen.findByTestId('return-credit-note-dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-credit-note'));

    const error = await screen.findByTestId('return-credit-note-error');
    expect(error.textContent).toMatch(/already been credited/i);
    expect(screen.queryByTestId('return-credit-note-success')).toBeNull();
  });

  it('shows the original-invoice-missing (422) error inline', async () => {
    await openDetail({ status: 'APPROVED', approvedAt: '2026-01-04T00:00:00.000Z' });
    issueCreditNoteForReturn.mockRejectedValue(
      new ApiError(422, 'Unprocessable', {
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        code: 'BUSINESS_RULE',
        detail: 'The return order has no invoice; a credit note cannot be issued',
      }),
    );

    fireEvent.click(screen.getByTestId('detail-issue-credit-note'));
    const dialog = await screen.findByTestId('return-credit-note-dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-credit-note'));

    const error = await screen.findByTestId('return-credit-note-error');
    expect(error.textContent).toMatch(/no invoice/i);
  });

  it('reuses the SAME Idempotency-Key when a failed issue is retried', async () => {
    await openDetail({ status: 'APPROVED', approvedAt: '2026-01-04T00:00:00.000Z' });
    issueCreditNoteForReturn.mockRejectedValueOnce(
      new ApiError(503, 'Unavailable', {
        type: 'about:blank',
        title: 'Service Unavailable',
        status: 503,
        code: 'INTERNAL',
        detail: 'Try again',
      }),
    );

    fireEvent.click(screen.getByTestId('detail-issue-credit-note'));
    const dialog = await screen.findByTestId('return-credit-note-dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-credit-note'));
    await screen.findByTestId('return-credit-note-error');

    issueCreditNoteForReturn.mockResolvedValueOnce(creditNote());
    fireEvent.click(within(dialog).getByTestId('confirm-credit-note'));

    await waitFor(() => expect(issueCreditNoteForReturn).toHaveBeenCalledTimes(2));
    expect(issueCreditNoteForReturn.mock.calls[1]![1]).toBe(
      issueCreditNoteForReturn.mock.calls[0]![1],
    );
  });
});
