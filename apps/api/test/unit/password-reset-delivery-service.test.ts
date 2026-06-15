import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@b2b/logger';
import {
  DELIVERY_LEASE_MS,
  PasswordResetDeliveryService,
} from '../../src/modules/security/password-reset-delivery.service';
import type {
  ClaimedResetDelivery,
  PasswordResetRepository,
} from '../../src/modules/security/password-reset.repository';
import type { PasswordResetDeliveryCipher } from '../../src/modules/security/password-reset-delivery.cipher';
import type { ResetEmailProvider } from '../../src/modules/security/ports/reset-email-provider.port';
import type { Clock } from '../../src/common/time/clock';

const NOW = new Date('2026-06-15T12:00:00.000Z');

const CLAIM_TOKEN = 'claim-token-abc';

/** A claim as the repository would return it (secret left intact). */
function claim(id = 7n): ClaimedResetDelivery {
  return {
    id,
    email: 'user@test.local',
    providerIdempotencyKey: `password-reset:${id}`,
    deliveryClaimToken: CLAIM_TOKEN,
    leaseUntil: new Date(NOW.getTime() + DELIVERY_LEASE_MS),
    sealed: {
      ciphertext: Buffer.from('ct'),
      nonce: Buffer.from('nonce'),
      authTag: Buffer.from('tag'),
    },
  };
}

function build(over: {
  claimResult?: ClaimedResetDelivery | null;
  decrypt?: () => string;
  provider?: ResetEmailProvider;
  /** Row count the finalizers report (0 = this worker lost the claim). */
  finalizerCount?: number;
}) {
  const claimResult = 'claimResult' in over ? over.claimResult : claim();
  const count = over.finalizerCount ?? 1;
  const repo = {
    claimForDelivery: vi.fn(async () => claimResult),
    markDelivered: vi.fn(async () => count),
    markFailed: vi.fn(async () => count),
    markUnknown: vi.fn(async () => count),
  } as unknown as PasswordResetRepository & {
    claimForDelivery: ReturnType<typeof vi.fn>;
    markDelivered: ReturnType<typeof vi.fn>;
    markFailed: ReturnType<typeof vi.fn>;
    markUnknown: ReturnType<typeof vi.fn>;
  };
  const cipher = {
    decrypt: over.decrypt ?? (() => 'raw-reset-token'),
  } as unknown as PasswordResetDeliveryCipher;
  const provider =
    over.provider ??
    ({
      supportsIdempotency: true,
      send: vi.fn(async () => ({ providerMessageId: 'pmid-1' })),
    } as unknown as ResetEmailProvider);
  const clock: Clock = { now: () => NOW };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const service = new PasswordResetDeliveryService(repo, cipher, provider, clock, logger);
  return { service, repo, provider };
}

describe('PasswordResetDeliveryService (lease/crash safety)', () => {
  it('sends then erases the secret with a stable idempotency key on success', async () => {
    const { service, repo, provider } = build({});
    const send = provider.send as ReturnType<typeof vi.fn>;

    const result = await service.deliver(7n);

    expect(result).toMatchObject({ delivered: true, providerMessageId: 'pmid-1' });
    // Lease window is honoured.
    expect(repo.claimForDelivery).toHaveBeenCalledWith(
      7n,
      NOW,
      new Date(NOW.getTime() + DELIVERY_LEASE_MS),
    );
    // Stable provider idempotency key, passed through to the provider.
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'password-reset:7' }),
    );
    // Secret erased ONLY after the provider accepted (markDelivered after send).
    expect(repo.markDelivered).toHaveBeenCalledTimes(1);
    // Finalization is fenced by the claim token from the claim.
    expect(repo.markDelivered).toHaveBeenCalledWith(7n, CLAIM_TOKEN, NOW, 'pmid-1');
    const sendOrder = send.mock.invocationCallOrder[0] ?? 0;
    const markOrder = repo.markDelivered.mock.invocationCallOrder[0] ?? 0;
    expect(sendOrder).toBeLessThan(markOrder);
  });

  it('returns claim_lost (not delivered) when markDelivered updates zero rows', async () => {
    // The provider accepted the email, but a newer worker re-claimed the row, so
    // our fenced markDelivered matches nothing.
    const { service, repo, provider } = build({ finalizerCount: 0 });

    const result = await service.deliver(7n);

    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(repo.markDelivered).toHaveBeenCalledTimes(1);
    // Must NOT claim success, and must not attempt any further mutation.
    expect(result).toEqual({ delivered: false, reason: 'claim_lost' });
    expect(repo.markFailed).not.toHaveBeenCalled();
    expect(repo.markUnknown).not.toHaveBeenCalled();
  });

  it('returns claim_lost when a fenced markFailed updates zero rows', async () => {
    const provider = {
      supportsIdempotency: true,
      send: vi.fn(async () => {
        throw new Error('smtp down');
      }),
    } as unknown as ResetEmailProvider;
    const { service, repo } = build({ provider, finalizerCount: 0 });

    const result = await service.deliver(7n);
    expect(result).toEqual({ delivered: false, reason: 'claim_lost' });
    expect(repo.markFailed).toHaveBeenCalledWith(7n, CLAIM_TOKEN, 'smtp down');
  });

  it('returns not_claimable and never calls the provider when the claim is lost', async () => {
    const { service, repo, provider } = build({ claimResult: null });
    const result = await service.deliver(7n);
    expect(result).toEqual({ delivered: false, reason: 'not_claimable' });
    expect(provider.send).not.toHaveBeenCalled();
    expect(repo.markDelivered).not.toHaveBeenCalled();
  });

  it('marks FAILED (retryable, secret kept) when an idempotent provider throws', async () => {
    const provider = {
      supportsIdempotency: true,
      send: vi.fn(async () => {
        throw new Error('smtp down');
      }),
    } as unknown as ResetEmailProvider;
    const { service, repo } = build({ provider });

    const result = await service.deliver(7n);
    expect(result).toEqual({ delivered: false, reason: 'failed' });
    expect(repo.markFailed).toHaveBeenCalledTimes(1);
    expect(repo.markDelivered).not.toHaveBeenCalled();
    expect(repo.markUnknown).not.toHaveBeenCalled();
  });

  it('quarantines as UNKNOWN when a non-idempotent provider throws', async () => {
    const provider = {
      supportsIdempotency: false,
      send: vi.fn(async () => {
        throw new Error('ambiguous timeout');
      }),
    } as unknown as ResetEmailProvider;
    const { service, repo } = build({ provider });

    const result = await service.deliver(7n);
    expect(result).toEqual({ delivered: false, reason: 'unknown' });
    expect(repo.markUnknown).toHaveBeenCalledTimes(1);
    expect(repo.markFailed).not.toHaveBeenCalled();
    expect(repo.markDelivered).not.toHaveBeenCalled();
  });

  it('quarantines as UNKNOWN and never sends when the secret fails to decrypt', async () => {
    const { service, repo, provider } = build({
      decrypt: () => {
        throw new Error('auth tag mismatch');
      },
    });
    const result = await service.deliver(7n);
    expect(result).toEqual({ delivered: false, reason: 'unknown' });
    expect(provider.send).not.toHaveBeenCalled();
    expect(repo.markUnknown).toHaveBeenCalledTimes(1);
  });
});
