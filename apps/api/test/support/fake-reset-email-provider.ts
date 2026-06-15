import { randomUUID } from 'node:crypto';
import type {
  ResetEmailProvider,
  SendResetEmailCommand,
  SendResetEmailResult,
} from '../../src/modules/security/ports/reset-email-provider.port';

/** One delivery as recorded by the fake — the only evidence a test may use to
 * assert a "real" delivery actually happened. */
export interface RecordedFakeDelivery {
  email: string;
  token: string;
  idempotencyKey: string;
  providerMessageId: string;
}

/**
 * TEST-ONLY reset email provider.
 *
 * Unlike the deleted logging placeholder, this never masquerades as the real
 * provider: it is not in any production module wiring, its class name says
 * "Fake", and its message ids are visibly synthetic (`fake-reset-*`). It does NOT
 * send email — it records each send in {@link sent} so a test can prove a
 * delivery occurred by inspecting that store, never by trusting a fabricated
 * `SUCCEEDED`.
 *
 * It refuses to be constructed under `NODE_ENV=production`, so it can never be
 * wired into a real deployment by accident.
 *
 * Idempotency: mirrors the real SMTP provider (`false`) — no native dedup is
 * claimed. Override via the constructor for tests that need the retryable path.
 */
export class FakeResetEmailProvider implements ResetEmailProvider {
  readonly supportsIdempotency: boolean;
  readonly sent: RecordedFakeDelivery[] = [];

  constructor(opts: { supportsIdempotency?: boolean } = {}) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FakeResetEmailProvider must never be constructed in production');
    }
    this.supportsIdempotency = opts.supportsIdempotency ?? false;
  }

  async send(command: SendResetEmailCommand): Promise<SendResetEmailResult> {
    const providerMessageId = `fake-reset-${randomUUID()}`;
    this.sent.push({
      email: command.email,
      token: command.token,
      idempotencyKey: command.idempotencyKey,
      providerMessageId,
    });
    return { providerMessageId };
  }

  /** The most recent recorded delivery (throws if nothing was sent). */
  last(): RecordedFakeDelivery {
    const delivery = this.sent.at(-1);
    if (!delivery) throw new Error('no fake reset delivery was recorded');
    return delivery;
  }

  reset(): void {
    this.sent.length = 0;
  }
}
