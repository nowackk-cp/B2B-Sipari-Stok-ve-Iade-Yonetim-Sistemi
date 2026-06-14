import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs helper, no type declarations needed for tests.
import { ALLOWED_DRIFT_STATEMENTS, findUnexpected } from '../../scripts/drift-eval.mjs';

/**
 * The drift gate's value is entirely in what it refuses to allow. These tests
 * feed it synthetic `prisma migrate diff --script` output and assert that the
 * allowlisted partial-unique residue passes while every real drift category is
 * flagged (DBF-007 — "verify the drift script actually catches changes").
 */
describe('drift gate allowlist', () => {
  it('passes when the diff contains only the allowlisted partial-unique residue', () => {
    const script = ALLOWED_DRIFT_STATEMENTS.map((s: string) => `-- CreateIndex\n${s};`).join(
      '\n\n',
    );
    const { unexpected } = findUnexpected(script);
    expect(unexpected).toHaveLength(0);
  });

  it('catches a missing column (ALTER TABLE ADD COLUMN)', () => {
    const script = `-- AlterTable\nALTER TABLE "orders" ADD COLUMN "extra" TEXT;`;
    const { unexpected } = findUnexpected(script);
    expect(unexpected).toHaveLength(1);
    expect(unexpected[0]).toMatch(/ADD COLUMN/);
  });

  it('catches a missing foreign key (ADD CONSTRAINT … FOREIGN KEY)', () => {
    const script = `-- AddForeignKey
ALTER TABLE "effect_receipts" ADD CONSTRAINT "effect_receipts_outbox_event_id_fkey" FOREIGN KEY ("outbox_event_id") REFERENCES "outbox_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;`;
    const { unexpected } = findUnexpected(script);
    expect(unexpected).toHaveLength(1);
    expect(unexpected[0]).toMatch(/FOREIGN KEY/);
  });

  it('catches a changed onDelete action (DropForeignKey)', () => {
    const script = `-- DropForeignKey\nALTER TABLE "order_status_history" DROP CONSTRAINT "order_status_history_order_id_fkey";`;
    const { unexpected } = findUnexpected(script);
    expect(unexpected).toHaveLength(1);
  });

  it('catches an unexpected index', () => {
    const script = `-- CreateIndex\nCREATE INDEX "orders_notes_idx" ON "orders"("notes");`;
    const { unexpected } = findUnexpected(script);
    expect(unexpected).toHaveLength(1);
    expect(unexpected[0]).toMatch(/orders_notes_idx/);
  });

  it('catches a dropped/renamed allowlisted index (different column)', () => {
    // A real change to one of the soft-delete uniques must NOT be silently
    // accepted just because the index name matches.
    const script = `CREATE UNIQUE INDEX "users_email_key" ON "users"("public_id");`;
    const { unexpected } = findUnexpected(script);
    expect(unexpected).toHaveLength(1);
  });
});
