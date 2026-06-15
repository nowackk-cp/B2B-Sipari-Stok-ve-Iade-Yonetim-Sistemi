/** DI token for the swappable password-reset email provider. */
export const RESET_EMAIL_PROVIDER = Symbol('RESET_EMAIL_PROVIDER');

/** A single reset-email send. The raw link token lives only in memory here. */
export interface SendResetEmailCommand {
  email: string;
  /** The decrypted bearer token — included in the link, never logged/persisted. */
  token: string;
  /**
   * Stable across every retry for one reset row: `password-reset:{id}`. Handed
   * to the provider so a redelivery after a crash collapses to the same real
   * email instead of producing a duplicate.
   */
  idempotencyKey: string;
}

export interface SendResetEmailResult {
  /** Provider-side id, persisted as `provider_message_id` for audit/dedup. */
  providerMessageId: string;
}

/**
 * Outbound password-reset email provider (the SMTP/API boundary). Decoupled
 * behind a port so the delivery service can stay crash-safe regardless of the
 * concrete transport.
 */
export interface ResetEmailProvider {
  /**
   * Whether the provider deduplicates real sends by `idempotencyKey`.
   *
   * - `true`  → retrying after an ambiguous failure/crash is SAFE (the provider
   *   collapses duplicates), so a failed attempt is marked retryable (`FAILED`).
   * - `false` → exactly-once CANNOT be guaranteed. An ambiguous failure must be
   *   quarantined as `UNKNOWN` for manual review; we never auto-retry (that could
   *   send a second email) and never auto-erase the secret.
   */
  readonly supportsIdempotency: boolean;
  send(command: SendResetEmailCommand): Promise<SendResetEmailResult>;
}
