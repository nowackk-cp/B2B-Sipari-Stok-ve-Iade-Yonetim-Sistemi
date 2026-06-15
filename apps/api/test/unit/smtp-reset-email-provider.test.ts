import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@b2b/logger';
import type { AppConfigService } from '../../src/common/config/app-config.service';

// Mock the SMTP transport so no real socket is opened. `sendMail` is the seam we
// drive per-test; `createTransport` returns a transport exposing it.
const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn();
  return { sendMail, createTransport: vi.fn(() => ({ sendMail })) };
});
vi.mock('nodemailer', () => ({ createTransport }));

import { SmtpResetEmailProvider } from '../../src/modules/security/adapters/smtp-reset-email-provider';

const TOKEN = 'raw-reset-token-abc.def';
const EMAIL = 'user@test.local';
const KEY = 'password-reset:7';
const LINK_BASE = 'http://localhost:3000/reset-password';

function makeLogger(): Logger & { info: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger & {
    info: ReturnType<typeof vi.fn>;
  };
}

function makeProvider(logger: Logger): SmtpResetEmailProvider {
  const config = {
    mail: {
      host: 'localhost',
      port: 1025,
      secure: false,
      user: undefined,
      password: undefined,
      from: 'B2B Operations <no-reply@b2bops.local>',
    },
    passwordResetLinkBase: LINK_BASE,
  } as unknown as AppConfigService;
  return new SmtpResetEmailProvider(logger, config);
}

describe('SmtpResetEmailProvider', () => {
  beforeEach(() => {
    sendMail.mockReset();
    createTransport.mockClear();
  });

  it('honestly declares no native idempotency (SMTP cannot dedup)', () => {
    expect(makeProvider(makeLogger()).supportsIdempotency).toBe(false);
  });

  it('sends a real email containing the reset URL and returns the relay message id', async () => {
    sendMail.mockResolvedValue({ messageId: '<relay-assigned@b2bops.local>' });
    const provider = makeProvider(makeLogger());

    const result = await provider.send({ email: EMAIL, token: TOKEN, idempotencyKey: KEY });

    expect(result).toEqual({ providerMessageId: '<relay-assigned@b2bops.local>' });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0]![0] as Record<string, string>;
    expect(mail.to).toBe(EMAIL);
    expect(mail.from).toBe('B2B Operations <no-reply@b2bops.local>');
    expect(mail.subject).toMatch(/reset/i);
    // The reset URL (with the in-memory token) is present in both body parts.
    const expectedUrl = `${LINK_BASE}?token=${encodeURIComponent(TOKEN)}`;
    expect(mail.text).toContain(expectedUrl);
    expect(mail.html).toContain(expectedUrl);
    // Stable provider key threaded through as a deterministic Message-ID.
    expect(mail.messageId).toBe('<password-reset-7@password-reset.b2bops.local>');
  });

  it('never returns SUCCEEDED when the relay rejects the message (no fabricated id)', async () => {
    sendMail.mockRejectedValue(new Error('550 mailbox unavailable'));
    const provider = makeProvider(makeLogger());

    await expect(
      provider.send({ email: EMAIL, token: TOKEN, idempotencyKey: KEY }),
    ).rejects.toThrow(/mailbox unavailable/);
  });

  it('never logs the raw token or the reset link', async () => {
    sendMail.mockResolvedValue({ messageId: '<relay@b2bops.local>' });
    const logger = makeLogger();
    const provider = makeProvider(logger);

    await provider.send({ email: EMAIL, token: TOKEN, idempotencyKey: KEY });

    const loggedJson = JSON.stringify([
      ...logger.info.mock.calls,
      ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
    ]);
    expect(loggedJson).not.toContain(TOKEN);
    expect(loggedJson).not.toContain('reset-password?token=');
    // Only the safe correlation fields are logged.
    expect(loggedJson).toContain(KEY);
    expect(loggedJson).toContain('<relay@b2bops.local>');
  });
});
