# Module Boundaries

> Modüler monolit. Modüller tek deploy birimidir ama **derleme zamanı sınırları** vardır. Amaç: ileride servise ayrılabilecek temiz kesimler.

## 1. İlkeler

1. **Public interface only:** Bir modül başka bir modülü yalnızca onun *service interface*'i üzerinden çağırır. Repository ve Prisma model erişimi modüle özeldir.
2. **No shared tables across owners:** Her tabloyu **tek** modül sahiplenir (writer). Diğerleri yalnızca okuma için sahip modülün servisini çağırır.
3. **No circular dependencies:** Modül grafiği DAG olmalıdır. Döngü gerekiyorsa domain event ile gevşetilir.
4. **Domain logic in `packages/domain`:** Çapraz modül kuralları (örn. sipariş onayında stok rezervasyonu) orkestrasyon service'inde, saf kurallar domain'de.
5. **Events for decoupling (yalnız non-authoritative yan etkiler):** Modüller arası **bildirim/email/metrics/read-model projeksiyonu** için in-process event / `outbox_events` (`OrderApprovedEvent` → notification, email). **Business audit BU yolla yazılmaz.** Senkron tutarlılık gereken yerde doğrudan service çağrısı.
   - ⚠️ **Business audit event-consumer ile yazılmaz.** Business audit, domain mutasyonu ile **aynı PostgreSQL transaction içinde** yazılır (bkz. §3.4, [ADR-007](../decisions/ADR-007-audit-in-transaction.md)). Outbox event business audit'in yerine geçmez; outbox yalnız dış etkiler ve async projeksiyon içindir.

## 2. Modül Haritası ve Sahiplik

| # | Modül | Sahip olduğu ana tablolar | Bağımlı olduğu modüller (service) |
|---|-------|---------------------------|-----------------------------------|
| M1 | **identity** | users, refresh_tokens, password_reset_tokens | — |
| M2 | **authorization** | roles, permissions, role_permissions, user_roles | identity |
| M3 | **scope** | user_warehouse_scopes | identity, warehouses |
| M4 | **catalog** | products, categories | — |
| M5 | **warehouses** | warehouses | — |
| M6 | **inventory** | stock_balances, stock_ledger, stock_reservations | catalog, warehouses |
| M7 | **transfers** | stock_transfers, stock_transfer_items | inventory, warehouses |
| M8 | **customers** | customers, customer_addresses | — |
| M9 | **orders** | orders, order_items, order_status_history | customers, catalog, inventory (reservation API), warehouses |
| M10 | **returns** | returns, return_items | orders, inventory, customers |
| M11 | **billing** | invoices, invoice_items, quotes, quote_items, payments | orders, customers, catalog |
| M12 | **files** | files | (storage adapter) |
| M13 | **documents** (PDF) | — (files üretir) | billing, orders, files |
| M14 | **imports** | import_jobs, import_job_errors | catalog, customers, inventory, files |
| M15 | **exports** | export_jobs | (read-only tüm modüller), files |
| M16 | **notifications** | notifications | identity |
| M17 | **email** | email_messages | (template) |
| M18 | **audit** | audit_logs | (tüm modüller **aynı tx içinde** yazar; A-07) |
| M19 | **dashboard** | — (aggregate read) | orders, inventory, billing |
| M20 | **system** | job_logs, command_idempotency, outbox_events, effect_receipts | — |

## 3. Kritik Çapraz-Modül Akışları

### 3.1 Sipariş Onayı (orders → inventory)
`orders` modülü stok rezervasyonunu **doğrudan tablo yazarak değil**, `InventoryService.reserve(tx, items)` çağırarak yapar. Bu çağrı:
- Aynı `$transaction` içinde çalışır (tx parametre olarak geçirilir).
- İlgili `stock_balances` satırlarını kilitler, `reserved` artırır, `stock_reservations` yazar.
- Yetersizse `InsufficientStockError` fırlatır → tüm transaction rollback → sipariş APPROVED olmaz.

> **Kural:** Transaction'ı *başlatan* modül service'idir (burada orders). Çağrılan modül servisleri tx'i **parametre olarak** alır, kendi transaction'ını açmaz. Bu, "transaction sınırı service katmanında ve tek" ilkesini korur.

### 3.2 Sevkiyat (orders → inventory)
`OrderService.ship()` → `$transaction`: durum SHIPPED, `InventoryService.consumeReservation(tx, ...)` (on_hand−, reserved−, ledger SHIPMENT yaz).

### 3.3 İade (returns → inventory)
`ReturnService.receive()` → resellable kalemler için `InventoryService.receiveReturn(tx, ...)` (on_hand+, ledger RETURN_IN).

### 3.4 Yan Etkiler (event-driven) ve Audit Ayrımı (A-07)

- **Business audit event-driven DEĞİLDİR.** `order status changes, inventory movements, stock adjustments, transfer transitions, return transitions, invoice issue/void, price override, user role changes, permission changes, protected role operations` için audit kaydı, mutasyonu yapan service tarafından **aynı DB transaction içinde explicit** yazılır. Domain transaction rollback olursa audit de rollback. Audit modülü bu yazım için ortak yardımcı (transaction-aware audit writer) sağlar; **outbox/event consumer ile audit yazılmaz**.
- **Non-authoritative yan etkiler** (`notifications`, `email`, metrics) event/outbox üzerinden worker'da gerçekleşir: `OrderApproved`, `InvoiceIssued`, `LowStock` olayları ana transaction içinde `outbox_events` satırı olarak yazılır, dispatcher çeker (bkz. ARCHITECTURE §6). Bu yan etkiler effect-receipt idempotency ile korunur.

## 4. Bağımlılık Yönü (DAG Özeti)

```
identity → (root)
authorization → identity
scope → identity, warehouses
catalog, warehouses, customers → (root)
inventory → catalog, warehouses
transfers → inventory, warehouses
orders → customers, catalog, inventory, warehouses
returns → orders, inventory
billing → orders, customers, catalog
documents → billing, orders, files
imports/exports → (data modules), files
audit ← herkes (mutasyonu yapan service, AYNI TX içinde audit writer'ı çağırır — event consumer DEĞİL)
notifications, email → herkes (event/outbox consumer; non-authoritative yan etki)
dashboard → orders, inventory, billing (read)
```
Döngü yok. **`audit` bir event consumer değildir:** mutasyonu yapan service, audit writer'ı aynı transaction içinde senkron çağırır (ters bağımlılık yaratmaz çünkü writer ince, framework-bağımsız bir yardımcıdır). `notifications/email` ise outbox/event consumer'dır (async, non-authoritative).

## 5. Yasaklar (Boundary Violations)

- ❌ Bir modülün başka modülün Prisma modeline doğrudan `prisma.otherTable` ile erişmesi.
- ❌ Controller içinde iş kuralı.
- ❌ React component içinde iş kuralı / doğrudan DB / doğrudan SQL.
- ❌ Çağrılan modül servisinin yeni transaction açması (tx üst akıştan geçer).
- ❌ Immutable tabloya (ledger/audit/order_status_history) UPDATE/DELETE.
- ✅ Lint/CI ile boundary enforcement (örn. `eslint-plugin-boundaries` veya path kısıtı).
