-- Order draft company scope (Order Draft Foundation) — tenant-isolated order data.
--
-- WHY THIS EXISTS
-- An order is transaction data that belongs to exactly one tenant. Until now the
-- orders/order_items tables had no tenant column, so an order could not be filtered
-- by company and a cross-company customer/warehouse/product could (at the DB layer)
-- be referenced from an order. This migration makes orders company-scoped exactly
-- mirroring the products SKU change (20260616050000), the warehouse code change
-- (20260616060000) and the customer change (20260617130000):
--   • orders + order_items gain a NOT NULL company_id → every order/line belongs
--     to one company.
--   • the customer/warehouse FKs on orders become COMPOSITE (id, company_id) so a
--     cross-company customer/warehouse is physically un-insertable.
--   • order_items' order/product FKs become COMPOSITE (id, company_id) so a line's
--     order AND product are pinned to the same tenant → order.company =
--     product.company is a DB invariant.
--   • every company/customer/warehouse/order/product FK is ON DELETE RESTRICT
--     (never a cascade into orders).
--
-- The money/quantity/tax CHECK constraints already exist from the init migration
-- (orders_amounts_nonneg, order_items_qty_pos, order_items_prices_nonneg,
-- order_items_tax_bp_range, *_currency_iso), so this migration only adds tenancy.
--
-- ADDITIVE: earlier migrations are byte-for-byte untouched. Object names match
-- Prisma's generated conventions so `prisma migrate diff` reports zero new drift.

-- 1. customers composite-unique FK target (id, company_id). Mirrors the
--    products/warehouses targets; `id` is the PK, so this adds no new real
--    constraint — it only enables the orders.(customer_id, company_id) FK.
CREATE UNIQUE INDEX "customers_id_company_id_key" ON "customers"("id", "company_id");

-- 2. orders.company_id — added NULLable first so existing rows can be backfilled
--    before the NOT NULL + FK constraints are enforced.
ALTER TABLE "orders" ADD COLUMN "company_id" BIGINT;

-- 3. Backfill orders into their tenant — FAIL-CLOSED, identical policy to the RBAC
--    (20260616000000), warehouse (20260616040000), product (20260616050000) and
--    customer (20260617130000) tenant backfills: a tenant is only assigned when the
--    mapping is unambiguous (exactly one company). With zero or multiple companies
--    the migration refuses to guess and aborts; it NEVER invents a default company
--    nor picks the lowest/first one. A fresh database (no orders) proceeds trivially.
DO $$
DECLARE
  legacy_orders BIGINT;
  company_count BIGINT;
  target_company_id BIGINT;
BEGIN
  SELECT COUNT(*) INTO legacy_orders FROM orders;
  IF legacy_orders = 0 THEN
    RETURN; -- nothing to backfill; NOT NULL below is trivially satisfied.
  END IF;

  SELECT COUNT(*) INTO company_count FROM companies;
  IF company_count <> 1 THEN
    RAISE EXCEPTION
      'ORDER_TENANT_BACKFILL_AMBIGUOUS: % companies are present but legacy orders '
      'exist; backfill requires exactly one company. Ship an explicit '
      'order-to-company mapping migration before applying this one.',
      company_count;
  END IF;

  SELECT id INTO target_company_id FROM companies;
  UPDATE orders SET company_id = target_company_id WHERE company_id IS NULL;
END $$;

-- 4. Every order now carries a tenant → enforce NOT NULL.
ALTER TABLE "orders" ALTER COLUMN "company_id" SET NOT NULL;

-- 5. order_items.company_id — backfilled from the parent order (the order's tenant
--    is the only correct value), then NOT NULL.
ALTER TABLE "order_items" ADD COLUMN "company_id" BIGINT;
UPDATE "order_items" oi SET "company_id" = o."company_id"
  FROM "orders" o WHERE o."id" = oi."order_id";
ALTER TABLE "order_items" ALTER COLUMN "company_id" SET NOT NULL;

-- 6. Tenant indexes.
CREATE INDEX "orders_company_id_idx" ON "orders"("company_id");
CREATE INDEX "order_items_company_id_idx" ON "order_items"("company_id");

-- 7. orders composite-unique FK target (id, company_id) for the order_items pin.
CREATE UNIQUE INDEX "orders_id_company_id_key" ON "orders"("id", "company_id");

-- 8. orders → companies FK (RESTRICT, never a cascade into orders).
ALTER TABLE "orders" ADD CONSTRAINT "orders_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 9. Replace the single-column customer/warehouse FKs with COMPANY-PINNED composite
--    FKs so a cross-company customer/warehouse cannot be referenced from an order.
ALTER TABLE "orders" DROP CONSTRAINT "orders_customer_id_fkey";
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_company_id_fkey"
  FOREIGN KEY ("customer_id", "company_id") REFERENCES "customers"("id", "company_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" DROP CONSTRAINT "orders_warehouse_id_fkey";
ALTER TABLE "orders" ADD CONSTRAINT "orders_warehouse_id_company_id_fkey"
  FOREIGN KEY ("warehouse_id", "company_id") REFERENCES "warehouses"("id", "company_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 10. Replace order_items' single-column order/product FKs with composite FKs so a
--     line's order AND product are pinned to the line's tenant (order.company =
--     item.company = product.company is a DB invariant).
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_order_id_fkey";
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_company_id_fkey"
  FOREIGN KEY ("order_id", "company_id") REFERENCES "orders"("id", "company_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_product_id_fkey";
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_company_id_fkey"
  FOREIGN KEY ("product_id", "company_id") REFERENCES "products"("id", "company_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
