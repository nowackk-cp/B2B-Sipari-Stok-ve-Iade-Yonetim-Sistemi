import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCreditNote,
  issueCreditNoteForReturn,
  listCreditNotes,
} from '../src/lib/credit-notes-client';
import { setAccessToken } from '../src/lib/auth-client';

function mockFetch(body: BodyInit | null, init: ResponseInit) {
  const fn = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      new Response(body, init),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

const okJson = (body: unknown, status = 200) =>
  mockFetch(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => setAccessToken('tok-123'));
afterEach(() => {
  vi.unstubAllGlobals();
  setAccessToken(null);
});

describe('credit-notes-client', () => {
  it('lists via apiFetch with credentials:"include", bearer token and status filter', async () => {
    const fn = okJson({ data: [], pageInfo: { nextCursor: null, hasNextPage: false } });

    await listCreditNotes({ status: 'ISSUED', cursor: 'cur-1' });

    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/credit-notes?cursor=cur-1&status=ISSUED');
    expect(init).toMatchObject({ credentials: 'include' });
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
  });

  it('gets one credit note by id with the bearer token', async () => {
    const fn = okJson({ id: 'cn-1' });

    await getCreditNote('cn-1');

    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/credit-notes/cn-1');
    expect(init).toMatchObject({ credentials: 'include' });
  });

  it('issues a credit note via POST returns/:id/credit-note with the Idempotency-Key header and no body', async () => {
    const fn = okJson({ id: 'cn-1', creditNoteNo: 'CRN-2026-000001' }, 201);

    await issueCreditNoteForReturn('ret-1', 'idem-cn-1');

    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/returns/ret-1/credit-note');
    expect(init?.method).toBe('POST');
    expect(init).toMatchObject({ credentials: 'include' });
    const headers = init?.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('idem-cn-1');
    expect(headers.authorization).toBe('Bearer tok-123');
    // No client body — totals/number are server-resolved from the return.
    expect(init?.body).toBeUndefined();
  });
});
