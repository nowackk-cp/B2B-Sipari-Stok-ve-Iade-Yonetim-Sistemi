import { afterEach, describe, expect, it } from 'vitest';
import { FakeResetEmailProvider } from '../support/fake-reset-email-provider';

describe('FakeResetEmailProvider (test-only)', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('records each send so a test can prove a delivery happened', async () => {
    const provider = new FakeResetEmailProvider();
    const result = await provider.send({
      email: 'user@test.local',
      token: 'raw-token',
      idempotencyKey: 'password-reset:7',
    });

    expect(result.providerMessageId).toMatch(/^fake-reset-/);
    expect(provider.sent).toHaveLength(1);
    expect(provider.last()).toMatchObject({
      email: 'user@test.local',
      token: 'raw-token',
      idempotencyKey: 'password-reset:7',
    });
  });

  it('does not claim native idempotency by default (mirrors the real SMTP provider)', () => {
    expect(new FakeResetEmailProvider().supportsIdempotency).toBe(false);
    expect(new FakeResetEmailProvider({ supportsIdempotency: true }).supportsIdempotency).toBe(
      true,
    );
  });

  it('refuses to be constructed in production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => new FakeResetEmailProvider()).toThrow(/must never be constructed in production/);
  });
});
