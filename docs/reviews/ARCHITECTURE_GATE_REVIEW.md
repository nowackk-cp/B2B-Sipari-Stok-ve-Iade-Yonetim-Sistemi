# Architecture Gate Review

> Reviewer: Codex, independent Architecture Gate Reviewer  
> Scope: previous Codex review files, `CLAUDE_REMEDIATION_REPORT.md`, and updated architecture, business-rules, security, test, ADR, and implementation-plan documents.  
> Constraint observed: no production code changed; existing Claude/spec/review documents were not modified.

## Gate Result

**REJECTED_BLOCKERS_REMAIN**

The remediation materially improves the architecture and closes the invoice-numbering blocker. However, the ADMIN/SYSTEM_ADMIN remediation is not fully closed because two authoritative documents still preserve the old "ADMIN has global warehouse scope" rule:

- `docs/architecture/SECURITY_MODEL.md` §3 says global scope is for `SYSTEM_ADMIN/ADMIN (or warehouse:scope:all)`.
- `docs/architecture/DATABASE_DESIGN.md` §3 says empty `user_warehouses` means no scope except `SYSTEM_ADMIN/ADMIN`, which get global `*`.

That conflicts with the updated project spec, permission matrix, and implementation plan, where global warehouse access is only via protected `warehouse:scope:all`, seeded only to SYSTEM_ADMIN. Because this is tied to the old CRITICAL/BLOCKER privilege-escalation finding, coding should not start until the contradiction is removed.

## Previous Blocker/Critical Findings

### G-01 [CLOSED] A-01 / P-02: Gapless invoice numbering used PostgreSQL sequence

- **Önceki bulgu:** Gapless `invoice_no` was specified using PostgreSQL `sequence`, which cannot be rollback-safe.
- **Güncel durum:** CLOSED. Sequence-based gapless numbering was explicitly removed and replaced with transactional `invoice_series`.
- **Kanıt olan belge ve bölüm:** `ADR-006` says sequence-based gapless wording was removed and `invoice_series ... FOR UPDATE` is the accepted design. `INVOICE_RULES.md` §3 says PostgreSQL sequence is not used. `DATABASE_DESIGN.md` §11 defines `invoice_series`, `next_number`, and `FOR UPDATE`. `IMPLEMENTATION_PLAN.md` TASK-025a requires no sequence.
- **Eksik kalan nokta:** None at document-gate level.
- **Gerekli düzeltme:** None before implementation.
- **Kodlamaya etkisi:** Billing implementation may proceed after the remaining RBAC/scope blocker is fixed; TASK-025a must implement the documented counter exactly.

### G-02 [PARTIALLY_CLOSED] A-02: ADMIN can escalate privileges through role management

- **Önceki bulgu:** ADMIN could create or assign powerful roles/permissions and effectively become SUPER_ADMIN.
- **Güncel durum:** PARTIALLY_CLOSED. Protected roles, protected permissions, privilege levels, self-assignment deny, cannot-grant-above-self, and scope ceiling are now documented. The blocker remains partially open because warehouse-scope rules still contradict those protections for ADMIN.
- **Kanıt olan belge ve bölüm:** `SECURITY_MODEL.md` §2a/§2b defines SYSTEM_ADMIN vs ADMIN, protected permission/role, self-assignment deny, and service-layer grant ceiling. `PERMISSION_MATRIX.md` §4 defines cannot-grant-above-self and says `warehouse:scope:all` is SYSTEM_ADMIN-only. `DATABASE_DESIGN.md` §2 adds `roles.is_protected`, `roles.privilege_level`, and `permissions.is_protected`. `IMPLEMENTATION_PLAN.md` TASK-010a adds grant-ceiling implementation and tests.
- **Eksik kalan nokta:** `SECURITY_MODEL.md` §3 and `DATABASE_DESIGN.md` §3 still say ADMIN receives global warehouse scope by role. This conflicts with `PROJECT_SPEC.md` A10/A16 and `PERMISSION_MATRIX.md`, where global scope is only `warehouse:scope:all`.
- **Gerekli düzeltme:** Replace all remaining role-based global-scope language with permission-based language: global warehouse access must be granted only by protected `warehouse:scope:all`; ADMIN has no implicit global warehouse scope.
- **Kodlamaya etkisi:** Do not implement RBAC/scope until this is corrected. Otherwise developers can legitimately implement ADMIN as globally scoped from the stale architecture/database text.

### G-03 [PARTIALLY_CLOSED] T-01: RBAC management privilege escalation

- **Önceki bulgu:** ADMIN could escalate by creating/assigning a role with global and privileged permissions.
- **Güncel durum:** PARTIALLY_CLOSED for the same reason as G-02. Role/permission escalation is addressed, but ADMIN global-scope ambiguity remains.
- **Kanıt olan belge ve bölüm:** `PERMISSION_MATRIX.md` marks `role:manage:protected`, `warehouse:scope:all`, `audit:read:all`, and `system:read` as protected, and §4 requires SYSTEM_ADMIN-only protected operations. `TEST_STRATEGY.md` §11.1 defines negative tests for ADMIN assigning SYSTEM_ADMIN, protected permissions, and `warehouse:scope:all`.
- **Eksik kalan nokta:** Scope docs still allow ADMIN global scope without `warehouse:scope:all`.
- **Gerekli düzeltme:** Align `SECURITY_MODEL.md` and `DATABASE_DESIGN.md` with `PERMISSION_MATRIX.md`: ADMIN must be warehouse-scoped unless explicitly granted `warehouse:scope:all` by SYSTEM_ADMIN.
- **Kodlamaya etkisi:** Security-critical implementation should wait. This is still tied to a previous CRITICAL finding.

### G-04 [CLOSED] TST-01: Missing privilege ceiling tests

- **Önceki bulgu:** The test plan did not define negative tests for ADMIN role/permission escalation.
- **Güncel durum:** CLOSED. The tests are now explicitly listed.
- **Kanıt olan belge ve bölüm:** `TEST_STRATEGY.md` §11.1 includes ADMIN attempts to create protected roles, add protected permissions, self-assign, grant `warehouse:scope:all`, and assign/change SYSTEM_ADMIN, all expected 403. `IMPLEMENTATION_PLAN.md` TASK-010a repeats unit and integration tests for the grant-ceiling decision function and protected seed state.
- **Eksik kalan nokta:** None in the test-plan document. The remaining blocker is the contradictory scope rule, not missing tests.
- **Gerekli düzeltme:** After scope wording is fixed, keep the same tests and add an explicit ADMIN-with-empty-`user_warehouses` no-global-access test.
- **Kodlamaya etkisi:** Test plan is sufficient, but implementation must wait for the scope contradiction to be resolved.

### G-05 [CLOSED] P-01: Grant ceiling was not planned before RBAC implementation

- **Önceki bulgu:** The implementation plan would have allowed RBAC endpoints before privilege-ceiling rules were specified.
- **Güncel durum:** CLOSED. TASK-010a is now explicitly required before ADMIN role-management endpoints open.
- **Kanıt olan belge ve bölüm:** `IMPLEMENTATION_PLAN.md` TASK-010 says ADMIN role-management endpoints do not open before TASK-010a. TASK-010a defines `grant-ceiling.service`, protected role/permission migrations, tests, and audit requirements.
- **Eksik kalan nokta:** Plan is correct; source documents still need the ADMIN global-scope wording fix.
- **Gerekli düzeltme:** Keep TASK-010a as a hard dependency and add the explicit no-implicit-ADMIN-global-scope acceptance criterion.
- **Kodlamaya etkisi:** Plan structure is acceptable once the docs contradiction is fixed.

### G-06 [CLOSED] P-02: Fiscal numbering task still used sequence

- **Önceki bulgu:** Billing implementation plan still accepted an impossible sequence-based gapless approach.
- **Güncel durum:** CLOSED.
- **Kanıt olan belge ve bölüm:** `IMPLEMENTATION_PLAN.md` TASK-025a requires invoice row lock, `invoice_series FOR UPDATE`, rollback no-gap, parallel issue unique/monotonic, and retry-same-invoice no second number. `ADR-006` and `INVOICE_RULES.md` §3 align with this.
- **Eksik kalan nokta:** None at document-gate level.
- **Gerekli düzeltme:** None before implementation.
- **Kodlamaya etkisi:** Billing task can proceed after the remaining blocker is resolved.

## Required Verification Matrix

| # | Check | Gate status | Evidence / note |
|---|---|---|---|
| 1 | PostgreSQL sequence-based gapless invoice removed | PASS | `ADR-006`, `INVOICE_RULES.md` §3, `DATABASE_DESIGN.md` §11 say sequence kullanılmaz. |
| 2 | Transactional `invoice_series` counter defined | PASS | `DATABASE_DESIGN.md` §11 and `ADR-006` define `invoice_series` with `FOR UPDATE`. |
| 3 | Invoice number only assigned at ISSUED | PASS | `INVOICE_RULES.md` §3 and `DATABASE_DESIGN.md` invoices table rules. |
| 4 | VOID invoices keep number | PASS | `INVOICE_RULES.md` §3 and `ADR-006` state numbered invoices are not deleted; VOID preserves number. |
| 5 | SYSTEM_ADMIN vs ADMIN closes privilege escalation | PARTIAL | Grant ceiling is strong, but `SECURITY_MODEL.md` §3 and `DATABASE_DESIGN.md` §3 still imply ADMIN global scope. |
| 6 | Actor grant ceiling in DB and service layer | PASS | `SECURITY_MODEL.md` §2b, `DATABASE_DESIGN.md` §2, TASK-010a. |
| 7 | Protected role/permission operations safe | PASS | Protected flags, `role:manage:protected`, and negative tests are defined. |
| 8 | Transfer source/destination scope matrix complete | PASS | `SECURITY_MODEL.md` §3a and `INVENTORY_RULES.md` §6a. |
| 9 | Receive only with destination scope | PASS | `SECURITY_MODEL.md` §3a and `INVENTORY_RULES.md` §6a say receive requires destination scope. |
| 10 | Parallel approve/ship/cancel on same order blocked | PASS | `ORDER_RULES.md` §1a, `DATABASE_DESIGN.md` §18/§19, `TEST_STRATEGY.md` §4a. |
| 11 | Order lock and conditional transition both used | PASS | `ORDER_RULES.md` §1a and TASK-020a require `FOR UPDATE` plus `UPDATE ... WHERE status`. |
| 12 | Stock lock order deterministic | PASS | `ORDER_RULES.md` §1a and `DATABASE_DESIGN.md` §18 require order -> items -> balances ordered by `warehouse_id, product_id`. |
| 13 | Ledger idempotency required and item-level | PASS | `DATABASE_DESIGN.md` §6, `INVENTORY_RULES.md` §3a, `ADR-002`. |
| 14 | Audit in same domain transaction | PARTIAL | Main rule is correct in `ADR-007` and `DATABASE_DESIGN.md` §15, but `MODULE_BOUNDARIES.md` still contains stale event-consumer wording for audit in §1/§4. |
| 15 | Rollback leaves no false business audit | PASS | `ADR-007` and `TEST_STRATEGY.md` §11.5. |
| 16 | Outbox inserted with domain change transaction | PASS | `ARCHITECTURE.md` §6, `DATABASE_DESIGN.md` §14, TASK-026a. |
| 17 | Queue redelivery cannot duplicate external effects | PARTIAL | Duplicate prevention is documented via `effect_receipts`, but the receipt-before-call design lacks a pending/succeeded state and can drop an effect if the worker crashes after receipt insert but before the external call. |
| 18 | Excel import checksum/staging/replay/crash recovery | PASS | `DATABASE_DESIGN.md` §13, TASK-030/TASK-030b, `TEST_STRATEGY.md` §11.6. |
| 19 | Price override permission/reason/limit/audit | PASS | `ORDER_RULES.md` §2a, `API_CONVENTIONS.md` §7, `DATABASE_DESIGN.md` `order_price_overrides`, TASK-020b. |
| 20 | Rules reflected in implementation tasks and tests | PARTIAL | Most are reflected; the ADMIN global-scope contradiction and stale audit event-consumer wording must be fixed before the plan is executable safely. |

## Required Concurrency And Security Tests

| Scenario | Defined? | Evidence / note |
|---|---:|---|
| Same order, two concurrent approve | YES | `TEST_STRATEGY.md` §4a; TASK-020a. |
| Same order, approve vs cancel race | YES | `TEST_STRATEGY.md` §4a; TASK-020a. |
| Same order, two concurrent ship | YES | `TEST_STRATEGY.md` §4a; TASK-020a. |
| Two orders consuming same final stock | YES | `TEST_STRATEGY.md` §4 N+K parallel approval. |
| Same ledger command replay | YES | `TEST_STRATEGY.md` §4b; TASK-016a. |
| Worker redelivery after side effect | YES, with design note | `TEST_STRATEGY.md` §4b and TASK-026b define it; receipt-state model should be strengthened. |
| Invoice issue transaction rollback | YES | `TEST_STRATEGY.md` §11.3; TASK-025a. |
| Two concurrent invoice issue | YES | `TEST_STRATEGY.md` §11.3; TASK-025a. |
| ADMIN tries to assign SYSTEM_ADMIN | YES | `TEST_STRATEGY.md` §11.1; TASK-010a. |
| ADMIN grants permission it does not have | YES | `TEST_STRATEGY.md` §11.1. |
| Source-scope user tries transfer receive | YES | `TEST_STRATEGY.md` §11.2; SECURITY_MODEL §3a. |
| Destination-scope user tries dispatch | YES | Covered by source/dest matrix in `TEST_STRATEGY.md` §11.2 and TASK-019. |
| Same Excel file uploaded again | YES | `TEST_STRATEGY.md` §11.6; TASK-030. |
| Import worker crash and resume | YES | `TEST_STRATEGY.md` §11.6; TASK-030b. |
| Frontend price tampering | YES | `TEST_STRATEGY.md` §11.4; TASK-020b. |
| Audit insert failure rolls back domain tx | YES | `TEST_STRATEGY.md` §11.5; TASK-010b. |

## Blocking Corrections Required Before Implementation

1. **Remove implicit ADMIN global warehouse scope everywhere.**  
   `SECURITY_MODEL.md` §3 and `DATABASE_DESIGN.md` §3 must say global scope is derived only from protected `warehouse:scope:all`; ADMIN has no special global-scope bypass.

2. **Remove stale audit-as-event-consumer language.**  
   `MODULE_BOUNDARIES.md` §1 and §4 still list audit in event-driven examples/DAG. Keep the explicit §3.4 rule and remove or qualify the stale lines so business audit cannot be interpreted as async.

3. **Strengthen effect receipt state model before worker implementation.**  
   To prevent both duplicate and lost side effects, `effect_receipts` should distinguish at least `RESERVED/PROCESSING/SUCCEEDED/FAILED` or use provider-side idempotency as the source of truth. Current docs prevent duplicate after successful side effect, but can skip an effect after crash between receipt insert and external call.

## Final Decision

**REJECTED_BLOCKERS_REMAIN**

Coding may begin only after the ADMIN global-scope contradiction is corrected. The invoice-numbering blocker is closed; the RBAC privilege-escalation blocker is not fully closed because the current document set still contains an authoritative path to interpret ADMIN as globally warehouse-scoped.
