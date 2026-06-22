/**
 * Idempotency-Key helper for replay-safe mutations.
 *
 * Stock-committing / number-allocating commands (order ship, invoice issue)
 * REQUIRE a client-generated `Idempotency-Key` header (CLAUDE.md Mutlak Kural #9,
 * ADR-008). A caller generates ONE key per logical action and reuses it across
 * transient-failure retries so a network hiccup replays the same command rather
 * than double-shipping / double-invoicing.
 *
 * The key is an RFC 4122 UUID from the platform `crypto.randomUUID()` when
 * available (all modern browsers + Node ≥ 16), with a Math.random fallback purely
 * so non-secure test/SSR contexts never throw — the server treats the value as an
 * opaque token, so collision resistance, not cryptographic quality, is what
 * matters here.
 */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
