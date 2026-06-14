# Database Design

> PostgreSQL 16 + Prisma. Bu belge tabloları, kolonları, anahtarları, constraint'leri, index'leri, soft-delete kurallarını, immutable tabloları, transaction sınırlarını, concurrency ve audit yaklaşımını tanımlar.
>
> **Konvansiyonlar:**
> - PK: `id BIGINT GENERATED ALWAYS AS IDENTITY` (veya `uuid` — bkz. §11). Bu tasarımda **BIGINT identity** kullanılır (sıralı, index-dostu). Dışa açık referanslarda ayrıca `public_id UUID` (sızıntı önleme) opsiyoneldir.
> - Zaman: `created_at`, `updated_at` → `TIMESTAMPTZ NOT NULL DEFAULT now()`.
> - Soft delete: `deleted_at TIMESTAMPTZ NULL` (yalnızca işaretli tablolarda).
> - Para: `*_amount BIGINT` (minor unit) + `currency CHAR(3)`.
> - Miktar (stok/adet): `BIGINT` (tam sayı; ondalıklı birimler v2).
> - Enum: PostgreSQL native `ENUM` veya `TEXT + CHECK`. Bu tasarımda **native enum**.

---

## 0. Enum Tipleri

```sql
CREATE TYPE user_status        AS ENUM ('ACTIVE','SUSPENDED','INVITED');
CREATE TYPE order_status       AS ENUM ('DRAFT','APPROVED','PREPARING','SHIPPED','CANCELLED');
CREATE TYPE reservation_status AS ENUM ('ACTIVE','RELEASED','CONSUMED');
CREATE TYPE ledger_change_type AS ENUM ('RECEIPT','SHIPMENT','TRANSFER_OUT','TRANSFER_IN','RETURN_IN','ADJUSTMENT');
CREATE TYPE transfer_status    AS ENUM ('DRAFT','IN_TRANSIT','COMPLETED','CANCELLED');
CREATE TYPE return_status      AS ENUM ('DRAFT','APPROVED','RECEIVED','REJECTED','COMPLETED');
CREATE TYPE return_condition   AS ENUM ('RESELLABLE','DAMAGED');
CREATE TYPE invoice_status     AS ENUM ('DRAFT','ISSUED','PAID','VOID');
CREATE TYPE quote_status       AS ENUM ('DRAFT','SENT','ACCEPTED','REJECTED','EXPIRED');
CREATE TYPE document_type      AS ENUM ('INVOICE','CREDIT_NOTE');
CREATE TYPE job_status         AS ENUM ('PENDING','PROCESSING','COMPLETED','FAILED');
CREATE TYPE email_status       AS ENUM ('QUEUED','SENT','FAILED');
CREATE TYPE address_type       AS ENUM ('BILLING','SHIPPING');
CREATE TYPE import_status      AS ENUM ('UPLOADED','VALIDATING','VALIDATED','IMPORTING','COMPLETED','VALIDATION_FAILED','IMPORT_FAILED','CANCELLED');
CREATE TYPE import_row_status  AS ENUM ('PENDING','VALID','INVALID','APPLIED','SKIPPED');
CREATE TYPE outbox_status      AS ENUM ('PENDING','PROCESSING','PROCESSED','FAILED','DEAD');
CREATE TYPE effect_status      AS ENUM ('PLANNED','IN_PROGRESS','SUCCEEDED','FAILED','UNKNOWN');
```

---

## 1. Identity & Auth (modül M1)

### `users`
| Kolon | Tip | Notlar |
|-------|-----|--------|
| id | BIGINT PK identity | |
| email | CITEXT NOT NULL | **UNIQUE** (case-insensitive) |
| password_hash | TEXT NOT NULL | argon2id |
| full_name | TEXT NOT NULL | |
| status | user_status NOT NULL DEFAULT 'INVITED' | |
| last_login_at | TIMESTAMPTZ NULL | |
| created_at / updated_at | TIMESTAMPTZ | |
| deleted_at | TIMESTAMPTZ NULL | **soft delete** |

- **Unique:** `email` (partial: `WHERE deleted_at IS NULL`).
- **Index:** `(status)`.

### `refresh_tokens`
| id PK · user_id FK→users · token_hash TEXT (sha256, plaintext saklanmaz) · expires_at · revoked_at NULL · user_agent · ip INET · created_at |
- **Index:** `(user_id)`, `(token_hash)` UNIQUE.
- Rotating: yeni token üretilince eski `revoked_at` set edilir.

### `password_reset_tokens`
| id PK · user_id FK · token_hash · expires_at · used_at NULL · created_at |
- **Index:** `(token_hash)` UNIQUE.

---

## 2. Authorization (M2)

> Yetki yükseltme koruması (A-02/T-01) için **protected role** ve **protected/privileged permission** kavramları veri modeline gömülüdür. Detay: [SECURITY_MODEL.md §2-2b](SECURITY_MODEL.md).

### `roles`
| Kolon | Tip | Notlar |
|-------|-----|--------|
| id | BIGINT PK | |
| name | TEXT UNIQUE | |
| description | TEXT | |
| is_system | BOOL DEFAULT false | sistem rolü (seed) |
| is_protected | BOOL DEFAULT false | **korumalı rol** — normal rol-yönetim uçlarıyla değiştirilemez/silinemez/atanamaz; yalnızca SYSTEM_ADMIN |
| privilege_level | INT NOT NULL DEFAULT 0 | grant ceiling karşılaştırması (SYSTEM_ADMIN=100, ADMIN=50, diğer<50) |
| created_at / updated_at | | |

- `SYSTEM_ADMIN` rolü `is_system=true AND is_protected=true AND privilege_level=100`. UI'dan silinemez/değiştirilemez.
- `is_protected=true` rol: oluşturma/güncelleme/silme/atama yalnızca `role:manage:protected` permission'ı (yalnız SYSTEM_ADMIN) ile.

### `permissions`
| Kolon | Tip | Notlar |
|-------|-----|--------|
| id | BIGINT PK | |
| code | TEXT UNIQUE | örn. `order:approve` |
| module | TEXT | sahip modül |
| permission_group | TEXT NOT NULL | yetki grubu (örn. `RBAC`, `WAREHOUSE_SCOPE`, `BILLING`, `INVENTORY`) — UI gruplama + protected politikası |
| description | TEXT | |
| is_protected | BOOL DEFAULT false | **protected permission** — yalnız SYSTEM_ADMIN atayabilir/role ekleyebilir (örn. `role:manage:protected`, `user:assign-role`, `warehouse:scope:all`, `system:*`, `audit:read:all`) |
- Seed ile yüklenir (immutable referans veri). Bkz. [PERMISSION_MATRIX.md](../PERMISSION_MATRIX.md).

### `role_permissions` (ve permission grant path)
| role_id FK→roles · permission_id FK→permissions · granted_by FK→users NULL · **PK (role_id, permission_id)** |
- `ON DELETE CASCADE` (role silinince eşleme gider; permission silinmez).
- **Protected permission ataması yalnız SYSTEM_ADMIN transaction path'i üzerinden yapılabilir.** DB constraint tek başına actor bilgisini bilmediği için **service-layer grant ceiling zorunludur** (FK/unique tek başına yetmez).
- **Protected permission değişiklikleri business audit ile aynı transaction içinde** yazılır (`permission.granted`/`permission.revoked`, actor snapshot — A-10/ADR-007).
- **Append-only history:** her ekleme/çıkarma `audit_logs`'a aynı transaction içinde yazılır.

### `user_roles`
| user_id FK→users · role_id FK→roles · **PK (user_id, role_id)** · assigned_at · assigned_by FK→users NULL |
- Rol atama/kaldırma `audit_logs`'a (`role.assigned`/`role.revoked`) aynı transaction içinde yazılır.
- **Grant ceiling (uygulama kuralı, SECURITY_MODEL §2b):** atayan aktör yalnızca **kendi sahip olduğu** permission alt kümesini ve `actor.privilege_level ≥ target.role.privilege_level` koşuluyla atayabilir; protected permission/protected role yalnız SYSTEM_ADMIN.

---

## 3. Scope (M3)

> **KESİN KURAL (gate G-02/G-03):** Depo kapsamı **role'den türetilmez.** ADMIN dahil **hiçbir rol implicit global warehouse scope vermez.** Erişim yalnız iki yoldan: (1) `user_warehouse_scopes` açık atama, (2) protected `warehouse:scope:all` permission'ı. `warehouse:scope:all` seed'de **yalnız SYSTEM_ADMIN'dedir** ve yalnız SYSTEM_ADMIN atayabilir.

### `user_warehouse_scopes`
| Kolon | Tip | Notlar |
|-------|-----|--------|
| user_id | FK→users | |
| warehouse_id | FK→warehouses | |
| scope_type | TEXT NOT NULL DEFAULT 'EXPLICIT' | açık atama türü (ileride 'EXPLICIT' dışı türler için alan) |
| granted_by | FK→users NOT NULL | atamayı yapan aktör (grant ceiling + audit) |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |

- **PK:** `(user_id, warehouse_id)`. **Index:** `(warehouse_id)`.
- **Boş `user_warehouse_scopes` → kullanıcının açık depo kapsamı yok.** Global erişim **yalnız** `warehouse:scope:all` permission'ı ile gelir; rol-temelli `*` bypass **yoktur** (ADMIN dahil).
- Scope atama/kaldırma `warehouse:scope:all` gibi global vermeyi içermez; global yetki yalnız protected permission ile. Her scope atama business audit (aynı tx) üretir.

---

## 4. Catalog (M4)

### `categories`
| id PK · name TEXT NOT NULL · parent_id FK→categories NULL (self) · slug TEXT · created_at · updated_at · deleted_at NULL |
- **Unique:** `slug` (partial `WHERE deleted_at IS NULL`).
- **Index:** `(parent_id)`.
- Hiyerarşi: adjacency list. Döngü engeli uygulama katmanında.

### `products`
| Kolon | Tip | Notlar |
|-------|-----|--------|
| id | BIGINT PK | |
| sku | TEXT NOT NULL | **UNIQUE** (partial, aktif) |
| name | TEXT NOT NULL | |
| category_id | FK→categories NULL | `ON DELETE SET NULL` |
| barcode | TEXT NULL | index |
| unit | TEXT NOT NULL DEFAULT 'EACH' | EACH/KG/... |
| list_price_amount | BIGINT NOT NULL DEFAULT 0 | minor unit |
| currency | CHAR(3) NOT NULL DEFAULT 'TRY' | |
| tax_rate_bp | INT NOT NULL DEFAULT 2000 | basis points (%20) |
| is_active | BOOL NOT NULL DEFAULT true | |
| created_at / updated_at / deleted_at | | **soft delete** |

- **Unique:** `sku` partial; `barcode` index (non-unique, NULL'lar serbest).
- **Index:** `(category_id)`, `(is_active)`, `name` için `pg_trgm` GIN (arama).

---

## 5. Warehouses (M5)

### `warehouses`
| id PK · code TEXT UNIQUE · name · address_line1 · address_line2 NULL · city · postal_code · country CHAR(2) · is_active BOOL · created_at · updated_at · deleted_at NULL |
- **Unique:** `code` (partial, aktif).

---

## 6. Inventory (M6) — Stok çekirdeği

### `stock_balances` (mutable, türetilmiş durum)
| Kolon | Tip | Notlar |
|-------|-----|--------|
| id | BIGINT PK | |
| product_id | FK→products NOT NULL | |
| warehouse_id | FK→warehouses NOT NULL | |
| on_hand | BIGINT NOT NULL DEFAULT 0 | fiziksel mevcut |
| reserved | BIGINT NOT NULL DEFAULT 0 | rezerve |
| version | INT NOT NULL DEFAULT 0 | optimistic kontrol (ops.) |
| updated_at | TIMESTAMPTZ | |

- **Unique:** `(product_id, warehouse_id)` — her ürün-depo için **tek** satır.
- **CHECK:** `on_hand >= 0`, `reserved >= 0`, `reserved <= on_hand`. → **Negatif/aşırı rezervasyonu DB reddeder (INV-1/INV-2).**
- `available` saklanmaz; `on_hand - reserved` olarak hesaplanır (view veya uygulama).
- **Concurrency:** mutasyonlar `SELECT ... FOR UPDATE` ile bu satırı kilitler.
- **Satır oluşturma politikası (A-13):** balance satırı **lazy** oluşur. İlk `RECEIPT`/`ADJUSTMENT` satırı atomik **upsert** ile yaratır: `INSERT ... ON CONFLICT (product_id, warehouse_id) DO UPDATE`. İki paralel receipt → tek balance satırı + iki ledger satırı. `reserve()`/okuma sırasında satır yoksa `available = 0` kabul edilir → yetersizse deterministik `INSUFFICIENT_STOCK (422)`. Upsert conflict retry davranışı uygulamada tanımlı.

### `stock_ledger` (IMMUTABLE, append-only)
| Kolon | Tip | Notlar |
|-------|-----|--------|
| id | BIGINT PK | |
| product_id | FK→products NOT NULL | |
| warehouse_id | FK→warehouses NOT NULL | |
| change_type | ledger_change_type NOT NULL | |
| quantity | BIGINT NOT NULL | **işaretli** (+giriş / −çıkış) |
| balance_after | BIGINT NOT NULL | bu hareketten sonra on_hand (denetim/yeniden hesap) |
| reference_type | TEXT NOT NULL | 'ORDER' / 'TRANSFER' / 'RETURN' / 'ADJUSTMENT' / 'IMPORT' |
| reference_id | BIGINT NULL | ilgili belge id (başlık) |
| reference_line_id | BIGINT NULL | ilgili satır id (order_item/transfer_item/return_item/import_row) |
| idempotency_key | TEXT NOT NULL | **satır-seviyesi** hareket anahtarı (aşağıda) |
| reason | TEXT NULL | manuel ayar açıklaması |
| created_by | FK→users NULL | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |

- **No `updated_at`, no `deleted_at`.** UPDATE/DELETE **yasak** (DB trigger ile engellenir — §10).
- **Index:** `(product_id, warehouse_id, created_at)`, `(reference_type, reference_id)`.
- **İDEMPOTENCY (A-05, ZORUNLU):** `UNIQUE (idempotency_key)`. Anahtar **belge değil satır** seviyesinde ve deterministik üretilir; aynı hareketin retry'ı ikinci ledger satırı yaratamaz (DB unique conflict → no-op). Çok kalemli sevkiyat sorun yaşamaz çünkü her satırın anahtarı farklıdır. Anahtar formatları:
  - `ORDER_RESERVATION:{orderId}:{orderItemId}` *(not: rezervasyon ledger'a yazılmaz; bu anahtar `stock_reservations` idempotency'si içindir — bkz. stock_reservations)*
  - `ORDER_SHIPMENT:{orderId}:{orderItemId}`
  - `TRANSFER_OUT:{transferId}:{transferItemId}`
  - `TRANSFER_IN:{transferId}:{transferItemId}`
  - `RETURN_IN:{returnId}:{returnItemId}`
  - `ADJUSTMENT:{adjustmentId}` / `IMPORT:{importJobId}:{importRowId}`

### `stock_reservations`
| id PK · order_id FK→orders · order_item_id FK→order_items · product_id FK · warehouse_id FK · quantity BIGINT · status reservation_status DEFAULT 'ACTIVE' · idempotency_key TEXT · created_at · released_at NULL · consumed_at NULL |
- **Index:** `(order_id)`, `(product_id, warehouse_id, status)`.
- **Unique:** `(order_id, order_item_id)` — sipariş kalemi başına tek rezervasyon; ek olarak `UNIQUE(idempotency_key)` (`ORDER_RESERVATION:{orderId}:{orderItemId}`) → çift approve retry ikinci rezervasyon yaratamaz (A-04 idempotency emniyet ağı).
- Rezervasyon ledger'a yazılmaz (A7). `stock_balances.reserved` ile tutarlıdır.

---

## 7. Transfers (M7)

### `stock_transfers`
| id PK · transfer_no TEXT UNIQUE · source_warehouse_id FK · dest_warehouse_id FK · status transfer_status · created_by FK · created_at · updated_at · completed_at NULL |
- **CHECK:** `source_warehouse_id <> dest_warehouse_id`.
- **Index:** `(status)`, `(source_warehouse_id)`, `(dest_warehouse_id)`.

### `stock_transfer_items`
| id PK · transfer_id FK→stock_transfers (CASCADE) · product_id FK · quantity BIGINT CHECK > 0 |
- **Unique:** `(transfer_id, product_id)`.

> Akış: `IN_TRANSIT` → kaynakta `TRANSFER_OUT` ledger + on_hand−. `COMPLETED` → hedefte `TRANSFER_IN` ledger + on_hand+. (bkz. INVENTORY_RULES.)

---

## 8. Customers (M8)

### `customers`
| id PK · code TEXT UNIQUE · name · tax_number TEXT NULL · email CITEXT NULL · phone NULL · type TEXT ('INDIVIDUAL'/'COMPANY') · created_at · updated_at · deleted_at NULL |
- **Unique:** `code` (partial). `tax_number` index.

### `customer_addresses`
| id PK · customer_id FK (CASCADE soft via app) · type address_type · line1 · line2 NULL · city · state NULL · postal_code · country CHAR(2) · is_default BOOL · created_at · updated_at · deleted_at NULL |
- **Index:** `(customer_id, type)`.
- **Kural:** her (customer, type) için en fazla bir `is_default=true` (partial unique index `WHERE is_default AND deleted_at IS NULL`).

---

## 9. Orders (M9) — IMMUTABLE kayıt (silinmez)

### `orders`
| Kolon | Tip | Notlar |
|-------|-----|--------|
| id | BIGINT PK | |
| order_no | TEXT NOT NULL | **UNIQUE** (insan-okur, seq) |
| customer_id | FK→customers NOT NULL | |
| warehouse_id | FK→warehouses NOT NULL | kaynak depo (A1) |
| status | order_status NOT NULL DEFAULT 'DRAFT' | |
| currency | CHAR(3) NOT NULL DEFAULT 'TRY' | |
| subtotal_amount | BIGINT NOT NULL DEFAULT 0 | KDV hariç toplam |
| tax_amount | BIGINT NOT NULL DEFAULT 0 | |
| grand_total_amount | BIGINT NOT NULL DEFAULT 0 | subtotal + tax |
| notes | TEXT NULL | |
| created_by | FK→users | |
| approved_by | FK→users NULL | |
| approved_at | TIMESTAMPTZ NULL | |
| shipped_at | TIMESTAMPTZ NULL | |
| cancelled_at | TIMESTAMPTZ NULL | |
| created_at / updated_at | | **deleted_at YOK — silinmez** |

- **Index:** `(customer_id)`, `(status)`, `(warehouse_id, status)`, `(created_at)`.
- `order_no` üretimi: insan-okur referans (sequence/format `ORD-2026-000123`). **Not:** order_no yasal-gapless gereksinimi taşımaz (yalnız fatura taşır); boşluk kabul edilebilir.
- **Concurrency (A-04):** her durum geçişi önce `SELECT ... FOR UPDATE` ile order satırını kilitler **ve** atomik koşullu geçiş kullanır: `UPDATE orders SET status=$new WHERE id=$id AND status=$expected` → affected rows = 0 ise `409 INVALID_STATE` (başka transaction geçişi yapmış). Kilit sırası: **order → order_items → stock_balances** (stock_balances satırları her zaman `ORDER BY warehouse_id, product_id`).

### `order_items`
| id PK · order_id FK (no cascade delete — order silinmez) · product_id FK · product_sku TEXT (snapshot) · product_name TEXT (snapshot) · quantity BIGINT CHECK > 0 · list_price_amount BIGINT (server'dan, snapshot) · unit_price_amount BIGINT (uygulanan) · tax_rate_bp INT · price_overridden BOOL DEFAULT false · line_subtotal_amount BIGINT · line_tax_amount BIGINT · line_total_amount BIGINT · created_at |
- **Snapshot alanları:** sipariş anındaki sku/ad/**list fiyat** server tarafından doldurulur (client'tan fiyat kabul edilmez — A-06). `unit_price_amount` varsayılan `list_price_amount`'a eşittir; yalnızca yetkili override akışında farklılaşır.
- **Price override (A-06):** override yapılırsa `price_overridden=true` ve detay `order_price_overrides` (§11b) + business audit (`order.price.override`).
- **Mutasyon:** yalnızca `DRAFT` durumunda eklenir/değişir/silinir. APPROVED sonrası kalemler **immutable**.
- **Aktif ürün doğrulaması (T-08):** kalem ekleme/güncelleme ve APPROVE anında `product.deleted_at IS NULL AND is_active=true` zorunlu; aksi halde `422 BUSINESS_RULE`, rezervasyon oluşmaz.
- **Unique:** `(order_id, product_id)`.

### `order_status_history` (IMMUTABLE, append-only)
| id PK · order_id FK · from_status order_status NULL · to_status order_status · changed_by FK→users · reason TEXT NULL · created_at |
- UPDATE/DELETE yasak (§10). Durum makinesinin tam izi.

### `order_price_overrides` (A-06, append-only)
| Kolon | Tip | Notlar |
|-------|-----|--------|
| id | BIGINT PK | |
| order_id | FK→orders | |
| order_item_id | FK→order_items | |
| original_price_amount | BIGINT NOT NULL | server list/ürün fiyatı (kaynak) |
| overridden_price_amount | BIGINT NOT NULL | uygulanan fiyat |
| discount_pct_bp | INT NOT NULL | indirim yüzdesi (basis points) |
| reason | TEXT NOT NULL | zorunlu gerekçe |
| requires_approval | BOOL NOT NULL DEFAULT false | indirim eşiğini aşarsa onay gerekir |
| approved_by | FK→users NULL | |
| actor_user_id | FK→users NOT NULL | override'ı yapan |
| created_at | TIMESTAMPTZ | |
- **Permission:** yalnız `order:price:override`. Override işlemi **business audit** (`order.price.override`) üretir, aynı transaction.
- Normal fiyat **asla client'tan** alınmaz; `products.list_price_amount`'tan okunur (A-06/T-07).

### `command_idempotency` (A-04 — komut tekrarı koruması)
| Kolon | Tip | Notlar |
|-------|-----|--------|
| key | TEXT PK | `Idempotency-Key` header değeri |
| command_type | TEXT NOT NULL | örn. 'order.approve', 'order.ship', 'invoice.issue' |
| aggregate_id | BIGINT NOT NULL | hedef agregat (order id vb.) |
| request_hash | TEXT NOT NULL | gövde hash'i |
| status | TEXT NOT NULL | 'IN_PROGRESS' / 'COMPLETED' |
| response | JSONB NULL | tamamlanan yanıt (replay için) |
| created_at / expires_at | | 24h TTL |
- **Unique:** `(command_type, aggregate_id, key)`. Aynı komut + aynı key → kayıtlı yanıt; farklı gövde + aynı key → `409 IDEMPOTENCY_MISMATCH`.
- Bu, farklı key ile gelen paralel state transition'a karşı **order row lock + koşullu geçişle birlikte** ikinci savunma hattıdır (A-04/T-04).

---

## 10. Returns (M10)

### `returns`
| id PK · return_no TEXT UNIQUE · order_id FK→orders · customer_id FK · status return_status DEFAULT 'DRAFT' · reason TEXT · created_by FK · created_at · updated_at · received_at NULL |
- **Kural:** yalnızca `SHIPPED` siparişe iade açılabilir.
- **Index:** `(order_id)`, `(status)`.

### `return_items`
| id PK · return_id FK (CASCADE) · order_item_id FK→order_items · product_id FK · quantity BIGINT CHECK > 0 · condition return_condition · restock BOOL · created_at |
- **Kural:** `quantity ≤` ilgili sipariş kaleminin sevk edilen miktarı eksi önceki iadeler (uygulama doğrular).
- `condition='RESELLABLE' AND restock=true` ise `RETURN_IN` ledger + on_hand+.

---

## 11. Billing (M11) — Faturalar IMMUTABLE (issued sonrası)

> **Fatura numaralandırma kararı (A-01 BLOCKER):** PostgreSQL `sequence` **kullanılmaz** — sequence değerleri rollback ile geri alınmaz ve boşluk üretir. Bunun yerine **transaction içinde kilitlenen sayaç tablosu** `invoice_series` kullanılır. Detay: [ADR-006](../decisions/ADR-006-invoice-numbering.md), [INVOICE_RULES.md](../business-rules/INVOICE_RULES.md).

### `invoice_series` (gapless sayaç — kilitlenir)
| Kolon | Tip | Notlar |
|-------|-----|--------|
| id | BIGINT PK | series_id |
| company_id | BIGINT NOT NULL | çoklu şirket/tüzel kişilik için (v1 tek company; alan modellenir) |
| series_code | TEXT NOT NULL | örn. 'INV', 'CN' (credit note) |
| fiscal_year | INT NOT NULL | mali yıl |
| prefix | TEXT NOT NULL | örn. 'INV-2026-' |
| next_number | BIGINT NOT NULL DEFAULT 1 | sıradaki numara |
| version | INT NOT NULL DEFAULT 0 | optimistic kontrol (opsiyonel) |
| created_at / updated_at | | |

- **Unique:** `(company_id, series_code, fiscal_year)` — yıl/seri başına tek sayaç satırı.
- **Atama mekanizması (issue transaction içinde):**
  1. `SELECT * FROM invoice_series WHERE company_id=$c AND series_code=$s AND fiscal_year=$y FOR UPDATE` (satır kilitlenir).
  2. `invoice_number = next_number`; faturaya yazılır.
  3. `UPDATE invoice_series SET next_number = next_number + 1, version = version + 1`.
  4. invoice `ISSUED`, business audit (`invoice.issued`), gerekiyorsa outbox event — **hepsi aynı transaction**.
  - Transaction rollback olursa `next_number` artışı da rollback olur → **boşluk oluşmaz** (gapless garantisi).

### `invoices`
| id PK · series_id FK→invoice_series NULL · invoice_number BIGINT NULL (issue'da atanır) · invoice_no TEXT NULL (prefix+number, display) · doc_type document_type DEFAULT 'INVOICE' · company_id BIGINT · fiscal_year INT NULL · customer_id FK · order_id FK→orders NULL · status invoice_status DEFAULT 'DRAFT' · currency CHAR(3) · subtotal_amount · tax_amount · grand_total_amount · issued_at NULL · due_date DATE NULL · paid_at NULL · created_by FK · created_at · updated_at |
- **Kural:** `status='DRAFT'` iken düzenlenebilir. `ISSUED` olunca **immutable**; düzeltme `VOID` + yeni belge veya `CREDIT_NOTE`.
- **invoice_number/invoice_no** yalnızca `ISSUED` anında, `invoice_series` kilidi altında atanır (yukarıdaki mekanizma).
- **Unique (A-01):** `UNIQUE (company_id, series_id, fiscal_year, invoice_number)`.
- **Numara almış fatura silinmez;** iptal `VOID` durumu ile tutulur (numara korunur, boşluk açıklanır).
- **deleted_at YOK — silinmez.**
- **Index:** `(customer_id)`, `(status)`, `(order_id)`, `(issued_at)`.

### `invoice_items`
| id PK · invoice_id FK (CASCADE yalnız DRAFT iken app-level) · product_id FK NULL · description TEXT · quantity BIGINT · unit_price_amount · tax_rate_bp · line_subtotal_amount · line_tax_amount · line_total_amount |

### `quotes`
| id PK · quote_no TEXT UNIQUE · customer_id FK · status quote_status DEFAULT 'DRAFT' · currency · subtotal_amount · tax_amount · grand_total_amount · valid_until DATE NULL · created_by FK · created_at · updated_at |
- **Index:** `(customer_id)`, `(status)`.

### `quote_items`
| id PK · quote_id FK (CASCADE) · product_id FK NULL · description · quantity · unit_price_amount · tax_rate_bp · line_total_amount |

### `payments`
| id PK · invoice_id FK→invoices · amount BIGINT CHECK > 0 · currency · method TEXT · paid_at TIMESTAMPTZ · created_by FK · created_at |
- **Append-only** (ödeme silinmez; iptal = ters kayıt). Toplam ödeme = grand_total olunca invoice `PAID`.

---

## 12. Files / Documents (M12, M13)

### `files`
| id PK · storage_key TEXT UNIQUE · bucket TEXT · filename TEXT · content_type TEXT · size_bytes BIGINT · checksum_sha256 TEXT NULL · entity_type TEXT NULL · entity_id BIGINT NULL · uploaded_by FK→users · created_at · deleted_at NULL |
- **soft delete** (metadata). Fiziksel obje silme worker `file.cleanup` job'ı ile (gecikmeli).
- **Index:** `(entity_type, entity_id)`, `(uploaded_by)`.

---

## 13. Imports / Exports (M14, M15)

> **Import dayanıklılığı (A-09/T-06):** staging tablosu + dosya checksum dedup + satır-seviyesi idempotency + durum makinesi + crash recovery + final atomic apply. Sequence-of-events tek transaction değil; **validate** (staging) ve **apply** (atomic) ayrı fazlar.

### `import_jobs`
| Kolon | Tip | Notlar |
|-------|-----|--------|
| id | BIGINT PK | |
| company_id | FK→companies NOT NULL `ON DELETE RESTRICT` | duplicate politikası ve kapsam için tenant |
| type | TEXT | 'PRODUCT'/'CUSTOMER'/'STOCK_ADJUSTMENT' |
| source_file_id | FK→files | |
| file_checksum_sha256 | TEXT NOT NULL | **dosya parmak izi** (replay protection) |
| status | import_status NOT NULL DEFAULT 'UPLOADED' | durum makinesi (aşağıda) |
| apply_policy | TEXT NOT NULL DEFAULT 'ALL_OR_NOTHING' | 'ALL_OR_NOTHING' / 'ROW_LEVEL' |
| total_rows / valid_rows / invalid_rows / applied_rows | INT | |
| result_file_id | FK→files NULL | hata raporu dosyası |
| replay_of_import_id | FK→import_jobs NULL `ON DELETE RESTRICT` | terminal import'un yeniden denemesi bu kayda bağlanır |
| attempt_number | INT NOT NULL DEFAULT 1 | replay denemesi sayacı |
| resumed_from_row | INT NULL | crash sonrası devam edilen satır |
| lease_expires_at | TIMESTAMPTZ NULL | worker lease süresi (sahibi ölürse devralma) |
| heartbeat_at | TIMESTAMPTZ NULL | aktif worker sinyali |
| created_by | FK | |
| created_at / updated_at | | |
- **Duplicate file policy (canonical):** `UNIQUE (company_id, file_checksum_sha256)` **partial**, yalnız aktif durumlar (`UPLOADED, VALIDATING, VALIDATED, IMPORTING`) için → aynı company+checksum ile ikinci aktif yükleme `409 CONFLICT`. Terminal durumlar (`COMPLETED, VALIDATION_FAILED, IMPORT_FAILED, CANCELLED`) hariç; terminal sonrası yeniden deneme `replay_of_import_id` ile bağlı ayrı bir attempt olarak oluşur. Satır tekrarını `import_rows.idempotency_key UNIQUE` engeller.
- **Durum makinesi:** `UPLOADED → VALIDATING → VALIDATED → IMPORTING → COMPLETED`; hata dalları `VALIDATION_FAILED`, `IMPORT_FAILED`; `CANCELLED`. Geçişler idempotent ve crash sonrası resume edilebilir (mevcut duruma göre).
- **Silme:** `prevent_delete()` trigger'ı; child (`import_rows`, `import_job_errors`) FK'leri RESTRICT (cascade yok).

### `import_rows` (staging — satır-seviyesi durum)
| Kolon | Tip | Notlar |
|-------|-----|--------|
| id | BIGINT PK | |
| import_job_id | FK→import_jobs (CASCADE) | |
| row_number | INT NOT NULL | dosyadaki satır |
| row_hash | TEXT NOT NULL | satır içeriği hash'i |
| idempotency_key | TEXT NOT NULL | `IMPORT:{importJobId}:{rowNumber}` |
| raw_data | JSONB NOT NULL | ham satır |
| parsed_data | JSONB NULL | doğrulanmış/normalize |
| status | import_row_status NOT NULL DEFAULT 'PENDING' | PENDING/VALID/INVALID/APPLIED/SKIPPED |
| warehouse_id | BIGINT NULL | stok importunda satır deposu (row-level scope kontrolü — T-03) |
| error_message | TEXT NULL | |
- **Unique:** `(import_job_id, row_number)`, `UNIQUE(idempotency_key)`.
- **Crash recovery:** `IMPORTING` sırasında her satır işlenince `APPLIED` işaretlenir; retry yalnız `VALID && !APPLIED` satırları uygular → çift uygulama olmaz. Stok importu ledger'a `IMPORT:{jobId}:{rowId}` anahtarıyla yazar (ledger UNIQUE(idempotency_key) çift hareketi engeller).
- **Row-level scope (T-03):** her stok satırı `warehouse_id` kullanıcının kapsamında değilse policy'ye göre tüm import rollback (`ALL_OR_NOTHING`) veya satır `INVALID` (`ROW_LEVEL`).

### `import_job_errors`
| id PK · import_job_id FK (CASCADE) · import_row_id FK→import_rows NULL · row_number INT · column TEXT NULL · message TEXT · raw_data JSONB |
- Append-only (immutable hata kaydı).

### `export_jobs`
| id PK · type TEXT · format TEXT ('XLSX'/'CSV') · params JSONB · status job_status · file_id FK→files NULL · created_by FK · created_at · updated_at |

---

## 14. Outbox / Notifications / Email (M16, M17)

> **Transactional outbox + worker effect idempotency (A-08/T-05):** queue **en az bir kez (at-least-once)** teslim eder varsayımı. Domain değişikliği ile outbox insert **aynı transaction**. Worker dış etkiyi ürettikten sonra job yeniden teslim edilirse çift e-posta/PDF/export/bildirim/fatura işlemi **oluşmamalı** → her yan etki için DB-level idempotency (effect receipt) veya idempotent provider key.

### `outbox_events` (transactional outbox)
| Kolon | Tip | Notlar |
|-------|-----|--------|
| id | BIGINT PK | |
| event_type | TEXT NOT NULL | örn. 'invoice.issued', 'order.approved' |
| aggregate_type | TEXT NOT NULL | 'INVOICE'/'ORDER'/... |
| aggregate_id | BIGINT NOT NULL | |
| deduplication_key | TEXT NOT NULL | **UNIQUE** — domain olayının benzersiz anahtarı |
| payload | JSONB NOT NULL | |
| status | outbox_status NOT NULL DEFAULT 'PENDING' | PENDING/PROCESSING/PROCESSED/FAILED/DEAD |
| attempts | INT NOT NULL DEFAULT 0 | |
| available_at | TIMESTAMPTZ NOT NULL DEFAULT now() | backoff için (gelecekte teslim) |
| locked_at | TIMESTAMPTZ NULL | claim/lease (worker kilidi) |
| processed_at | TIMESTAMPTZ NULL | |
| last_error | TEXT NULL | |
| created_at | TIMESTAMPTZ | |
- **Unique:** `UNIQUE (deduplication_key)` → aynı domain olayı iki kez outbox'a yazılamaz.
- **Dispatcher claim:** `UPDATE ... SET status='PROCESSING', locked_at=now() WHERE id IN (SELECT id FROM outbox_events WHERE status='PENDING' AND available_at<=now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT N)` → eşzamanlı worker'lar aynı satırı işlemez.
- **`PROCESSED` koşulu (G-17):** outbox event ancak ilgili **`effect_receipts.status='SUCCEEDED'`** olduktan sonra `PROCESSED` işaretlenir. Effect `PLANNED`/`IN_PROGRESS`/`UNKNOWN` kaldıysa event PENDING'e geri döner (backoff) / `UNKNOWN`'da manuel inceleme.
- **Index:** `(status, available_at)`, `(aggregate_type, aggregate_id)`.

### `effect_receipts` (worker yan-etki idempotency'si — A-08 + gate G-17 crash state modeli)
| Kolon | Tip | Notlar |
|-------|-----|--------|
| id | BIGINT PK | |
| outbox_event_id | FK→outbox_events NOT NULL | etkiyi doğuran outbox olayı; **`ON DELETE RESTRICT`** (cascade yok). Bir event birden çok effect doğurabilir → one-to-many. |
| effect_type | TEXT NOT NULL | 'EMAIL'/'PDF'/'EXPORT'/'NOTIFICATION' |
| effect_key | TEXT NOT NULL | deterministik effect anahtarı (örn. `EMAIL:invoice.issued:{invoiceId}`) |
| provider_idempotency_key | TEXT NOT NULL | dış servise gönderilen idempotency anahtarı (**zorunlu**) |
| status | effect_status NOT NULL DEFAULT 'PLANNED' | PLANNED → IN_PROGRESS → SUCCEEDED/FAILED/UNKNOWN |
| provider_message_id | TEXT NULL | sağlayıcı yanıtı (SUCCEEDED'da set) |
| output_file_id | FK→files NULL `ON DELETE SET NULL` | PDF/export çıktısı |
| attempts | INT NOT NULL DEFAULT 0 | |
| last_error | TEXT NULL | |
| completed_at | TIMESTAMPTZ NULL | SUCCEEDED anında set; CHECK ile zorlanır |
| created_at / updated_at | TIMESTAMPTZ | |
- **Unique:** `UNIQUE (effect_type, effect_key)` (effect dedup) **ve** `UNIQUE (effect_type, provider_idempotency_key)` (provider-çağrı dedup, provider scope = effect_type).
- **CHECK:** `status='SUCCEEDED' ⇒ completed_at IS NOT NULL` ve `status='PLANNED' ⇒ completed_at IS NULL` (crash-state tutarlılığı). Geçersiz `status` zaten enum ile reddedilir.
- **Silme:** transaction kaydı — `prevent_delete()` trigger'ı hard delete'i engeller; `output_file_id` dışındaki referanslar RESTRICT.
- **Crash-safe akış (G-17 — receipt önce "başarılı" işaretlenemez):**
  1. Worker dış çağrıdan **önce** receipt'i `PLANNED`/`IN_PROGRESS` olarak yazar (`INSERT ... ON CONFLICT (effect_type, effect_key) DO NOTHING`; conflict varsa mevcut kaydı `FOR UPDATE` okur).
  2. Dış servis çağrısı **`provider_idempotency_key` ile** yapılır.
  3. Başarı → `status='SUCCEEDED'`, `provider_message_id` set. Hata → `FAILED`. Sonuç belirsiz (timeout vb.) → `UNKNOWN`.
  - **Outbox event yalnız effect `SUCCEEDED` olduktan ve DB'de yazıldıktan sonra `processed` sayılır.**
- **Crash davranışı:**
  - Crash **dış çağrıdan önce** (status `PLANNED`/`IN_PROGRESS`) → retry **aynı `effect_key`** ile devam eder, etki kaybı yok.
  - Crash **dış çağrıdan sonra ama DB update öncesi** → retry **aynı `provider_idempotency_key`** ile tekrar dener; sağlayıcı idempotency'si çift etkiyi önler.
  - **Provider idempotency desteklemeyen dış servis:** exactly-once **garanti edilemez**; status `UNKNOWN` bırakılır ve **manuel inceleme** (alarm) gerekir. Bu sınır açıkça belgelenir.
- Yani: `SUCCEEDED` olmadan effect "tamamlandı" sayılmaz → hem çift hem **kayıp** etki engellenir (provider idempotency varsa).

### `notifications`
| id PK · user_id FK→users · type TEXT · title · body · data JSONB · dedup_key TEXT · read_at NULL · created_at |
- **Index:** `(user_id, read_at)`, `(user_id, created_at)`. **Unique:** `(user_id, dedup_key)` → çift bildirim engellenir.

### `email_messages`
| id PK · to_email TEXT · subject · template TEXT · payload JSONB · idempotency_key TEXT · status email_status DEFAULT 'QUEUED' · provider_message_id TEXT NULL · error TEXT NULL · attempts INT DEFAULT 0 · sent_at NULL · created_at · updated_at |
- **Unique:** `UNIQUE(idempotency_key)`. **Index:** `(status, created_at)`. E-posta gönderimi `effect_receipts` veya bu unique ile tam-bir-kez.

---

## 15. Audit & System (M18, M20)

### `audit_logs` (BUSINESS audit — IMMUTABLE, append-only, **domain transaction içinde**)
| Kolon | Tip | Notlar |
|-------|-----|--------|
| id | BIGINT PK | |
| actor_id | FK→users NULL | |
| actor_email | TEXT NULL | **actor snapshot (A-10)** — email reuse'a karşı |
| actor_name | TEXT NULL | actor snapshot |
| actor_roles_snapshot | JSONB NULL | atama anındaki roller |
| action | TEXT NOT NULL | örn. 'order.approved' |
| entity_type / entity_id | TEXT / BIGINT | |
| before / after | JSONB NULL | domain-specific diff (explicit) |
| ip / user_agent | INET / TEXT NULL | |
| request_id | TEXT NULL | log korelasyonu |
| created_at | TIMESTAMPTZ | |
- **No update/delete** (§10 trigger). **Index:** `(entity_type, entity_id)`, `(actor_id, created_at)`, `(request_id)`.
- **Yazım politikası (A-07 — TEK KURAL):** business audit insert **mutasyonla aynı DB transaction içinde explicit** yapılır. Domain transaction rollback olursa audit de rollback; audit insert hatası business mutasyonu rollback eder. **Event/outbox audit için kullanılmaz** (yalnız bildirim/email/metrics gibi non-authoritative yan etkiler). Aynı-transaction business audit gerektiren işlemler: order status changes, inventory movements, stock adjustments, transfer transitions, return transitions, invoice issue/void, price override, user role changes, permission changes, protected role operations.
- **Email reuse politikası (A-10):** kullanıcı `email` reuse yasak **değil** ancak audit actor snapshot zorunlu olduğundan tarihsel doğruluk korunur (eski kayıt eski actor_email/name'i gösterir).

### `security_logs` / operational log (transaction DIŞI)
- Başarısız yetki denemeleri, başarısız login, rate-limit, başarısız request → operational/security log (Pino + opsiyonel tablo), **transaction dışında** tutulabilir (A-07). Bunlar authoritative business audit değildir.

### `job_logs`
| id PK · queue TEXT · job_id TEXT · name TEXT · status job_status · attempts INT · error TEXT NULL · started_at NULL · finished_at NULL · created_at |
- **Index:** `(queue, status)`, `(job_id)`.

### `idempotency_keys`
| key TEXT PK · request_hash TEXT · response JSONB NULL · status TEXT ('IN_PROGRESS'/'COMPLETED') · created_at · expires_at |
- HTTP idempotency (24h TTL). Worker job idempotency için ayrıca `processed_jobs(job_id PK)` kullanılabilir.

---

## 16. Soft Delete Kuralları (özet)

| Tür | Tablolar | Politika |
|-----|----------|----------|
| **Soft delete** (`deleted_at`) | users, categories, products, warehouses, customers, customer_addresses, files | UPDATE ile `deleted_at` set; sorgular `WHERE deleted_at IS NULL`. Unique constraint'ler **partial** (aktif kayıtlar). |
| **Hard delete YOK / asla silinmez** | orders, order_items, order_status_history, stock_ledger, stock_reservations, invoices, invoice_items, payments, returns, return_items, audit_logs, job_logs | Salt-ekleme veya yalnızca durum geçişi. Fiziksel DELETE engellenir/kullanılmaz. |
| **Eşleme tabloları** | role_permissions, user_roles, user_warehouse_scopes | Hard delete serbest (geçmiş audit'te tutulur). |

---

## 17. Immutable Tablolar ve Enforcement {#10}

**Append-only (UPDATE+DELETE yasak):** `stock_ledger`, `order_status_history`, `transfer_status_history`, `return_status_history`, `invoice_status_history`, `order_price_overrides`, `audit_logs`, `payments`, `import_job_errors`.

**Transaction aggregate parent (hard DELETE yasak, status UPDATE serbest):** `orders`, `stock_transfers`, `returns`, `invoices`, `quotes`, `import_jobs`, `export_jobs`, `outbox_events`, `effect_receipts`, `stock_reservations`, `job_logs`. Ayrıca soft-delete master `users` hard delete edilemez (actor geçmişini korur — `deleted_at` ile pasifleştirilir).

Enforcement (defense in depth):
1. **Uygulama:** repository bu tablolara yalnızca `create` (+ append-only olmayanlarda status `update`) sağlar; `delete` metodu yok.
2. **DB trigger'ları** — iki ayrı fonksiyon, `SET search_path = pg_catalog, public` ile hardened (DBF-007):
```sql
-- Append-only: hem UPDATE hem DELETE bloke.
CREATE OR REPLACE FUNCTION prevent_mutation() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'append_only_violation: table % is append-only (% blocked)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

-- Transaction parent: yalnız DELETE bloke (status UPDATE serbest).
CREATE OR REPLACE FUNCTION prevent_delete() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'delete_forbidden: table % is a transaction/immutable record and cannot be hard-deleted', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;
-- no_mutation_* → append-only tablolar; no_delete_* → transaction parent + users.
```
3. **FK politikası (DBF-003):** transaction parent→child kenarlarında **`ON DELETE CASCADE` kullanılmaz**; tümü `RESTRICT`/`NO ACTION`. Böylece numara almış fatura, payment, status history, ledger, price override hiçbir FK zinciriyle silinemez. Actor FK'leri (orders.created_by vb.) RESTRICT; salt-gözlem actor alanları (audit_logs.actor_id, stock_ledger.created_by) `SET NULL`.
4. **Yetki:** uygulama DB rolüne append-only tablolarda yalnızca `INSERT, SELECT` grant edilir (prod).

> **PK konvansiyonu (DBF-010):** Surrogate PK'ler Prisma `@default(autoincrement())` ile `BIGSERIAL` olarak üretilir. Bu, yasal gapless fatura numarası için **değildir** (o `invoice_series` kilitli sayaç ile; ADR-006). Prisma-yönetimli surrogate anahtarlar için `BIGSERIAL` kabul edilmiştir; `BIGINT GENERATED ALWAYS AS IDENTITY` ile fonksiyonel fark domain doğruluğunu etkilemez.

---

## 18. Transaction Sınırları {#9-transaction-sınırları}

Bir use-case = bir `prisma.$transaction`. Para/stok etkileyen akışlarda transaction zorunlu.

| Use-case | Transaction içinde olanlar | İzolasyon |
|----------|----------------------------|-----------|
| **Sipariş onayı** | order row lock + koşullu geçiş (`WHERE status='DRAFT'`); order_items lock; her kalem için `stock_balances` satır kilidi (`FOR UPDATE`, `warehouse_id,product_id` sırasıyla), `reserved+=`, `stock_reservations` insert (idempotency_key); `order_status_history`; **business audit** | READ COMMITTED + row lock |
| **Sevkiyat (ship)** | order row lock + koşullu geçiş (`WHERE status='PREPARING'`); her rezervasyon: `on_hand-=`, `reserved-=`, `stock_ledger` SHIPMENT (idempotency_key `ORDER_SHIPMENT:{o}:{i}`), reservation=CONSUMED; status_history; business audit | READ COMMITTED + row lock |
| **İptal (cancel)** | order row lock + koşullu geçiş; aktif rezervasyonlar `reserved-=`, reservation=RELEASED; status_history; business audit | row lock |
| **Transfer out (dispatch)** | transfer row lock + koşullu geçiş; kaynak `on_hand-=`, ledger TRANSFER_OUT (key `TRANSFER_OUT:{t}:{i}`); business audit | row lock (kaynak) |
| **Transfer complete (receive)** | transfer row lock + koşullu geçiş; hedef `on_hand+=`, ledger TRANSFER_IN (key `TRANSFER_IN:{t}:{i}`); business audit | row lock (hedef) |
| **İade alımı** | return row lock + koşullu geçiş; resellable kalemler `on_hand+=`, ledger RETURN_IN (key `RETURN_IN:{r}:{i}`); business audit | row lock |
| **Fatura kesimi** | invoice row lock + koşullu geçiş (`WHERE status='DRAFT'`); `invoice_series` satırı `FOR UPDATE`, `invoice_number=next_number`, `next_number+=1`; totals finalize; business audit; (ops.) outbox event | row lock |
| **Stok düzeltme** | `stock_balances` kilidi (yoksa upsert), on_hand ayarla, ledger ADJUSTMENT; business audit | row lock |
| **Rol/permission değişimi** | grant ceiling kontrolü; role_permissions/user_roles mutasyonu; **business audit** (actor snapshot) | — |

Kurallar:
- Transaction'ı **başlatan** üst service'tir; çağrılan modül servisleri `tx`'i parametre alır (yeni tx açmaz).
- Transaction içinde **harici I/O yok** (e-posta/PDF/HTTP). Yan etkiler `outbox_events` satırı olarak aynı tx'te yazılır, worker sonra işler.
- **Business audit aynı transaction içinde** (A-07). Operational/security log transaction dışında olabilir.
- **Kilit sırası (deadlock önleme, A-04):** her zaman **order → order_items → stock_balances**; `stock_balances` satırları **her zaman `ORDER BY warehouse_id, product_id`** artan sırada `FOR UPDATE`. Çok belgeli işlemlerde agregat id sırası.

---

## 19. Concurrency Yaklaşımı

1. **Pessimistic row lock (birincil):** `SELECT * FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 FOR UPDATE`. Eşzamanlı onaylar serileşir; ilk işlem reserved'ı artırır, ikincisi güncel değeri görür, yetersizse reddedilir.
2. **CHECK constraint (emniyet ağı):** Mantık hatası olsa bile `reserved <= on_hand` ihlali transaction'ı patlatır → negatif stok imkânsız (ORD-INV-1).
3. **Order-level lock + koşullu geçiş (A-04):** her sipariş/transfer/fatura durum geçişi önce agregat satırını `FOR UPDATE` kilitler **ve** `UPDATE ... WHERE id=? AND status=?expected` koşullu geçiş kullanır; affected rows = 0 ise `409 INVALID_STATE`. Farklı `Idempotency-Key` ile gelen paralel geçişlerde yalnızca biri başarılı olur.
4. **Optimistic `version` (opsiyonel):** Uzun read-modify-write akışlarında `UPDATE ... WHERE version=$expected`; etkilenen satır 0 ise retry. `invoice_series.version` ve `stock_balances.version`.
5. **Deterministik kilit sırası:** order → order_items → stock_balances (`warehouse_id, product_id`) — deadlock önleme (§18).
6. **Command idempotency (A-04):** kritik POST'larda `command_idempotency` tablosu; aynı komut+key replay kayıtlı yanıtı döner, çift yan etki yok.
7. **Ledger/reservation unique idempotency (A-05):** `stock_ledger.idempotency_key` ve `stock_reservations.idempotency_key` satır-seviyesi unique → tüm yukarıdaki katmanlar başarısız olsa bile fiziksel hareket/rezervasyon **iki kez yazılamaz** (son emniyet ağı).

> Test zorunluluğu: paralel onay senaryosu için concurrency entegrasyon testi (bkz. [TEST_STRATEGY.md](../TEST_STRATEGY.md#concurrency)).

---

## 20. Audit Yaklaşımı

- Her mutasyon use-case'i `audit_logs`'a yazar: `actor_id`, `action`, `entity_type/id`, `before`/`after` (JSONB diff), `request_id`, `ip`, `user_agent`.
- Yazım **aynı transaction içinde** (audit ile veri tutarlı commit/rollback olur).
- `request_id` Pino correlation id ile eşleşir → log ↔ audit izlenebilirliği.
- Audit tablosu immutable (§17). Saklama: süresiz (yasal). Hacim büyürse aylık partition (BRIN index `created_at`).

---

## 21. Index Stratejisi (özet)

- Tüm FK kolonlarına index (Postgres FK'ye otomatik index oluşturmaz).
- Sık filtrelenen `status` kolonlarına index; sık birlikte sorgulanan alanlar composite (`(warehouse_id, status)`).
- Metin arama: `products.name`, `customers.name` için `pg_trgm` GIN.
- Zaman serisi/append tablolar: `(entity, created_at)` ve büyük tablolarda BRIN(`created_at`).
- Partial unique: soft-delete tablolarında `WHERE deleted_at IS NULL`.

## 22. Migration & Seed

- Prisma Migrate; her migration code review'dan geçer, geri alınamaz veri kaybı uyarısı CI'da bloklanır.
- Native enum/trigger/CHECK Prisma'nın doğrudan ifade edemediği kısımlar `prisma migrate` + manuel SQL (`-- @custom`) bloklarıyla.
- **Fatura numarası sequence ile değil `invoice_series` sayaç tablosu ile** (A-01); migration sequence oluşturmaz.
- Seed: permissions (protected işaretli), sistem rolleri (`SYSTEM_ADMIN` protected, `ADMIN`), SYSTEM_ADMIN kullanıcı (env'den), varsayılan depo, varsayılan `invoice_series` satırı (mali yıl). Idempotent (`upsert`).
