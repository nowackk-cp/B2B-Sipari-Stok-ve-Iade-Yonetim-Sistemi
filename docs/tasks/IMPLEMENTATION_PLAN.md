# Implementation Plan

> Proje küçük, doğrulanabilir, bağımlılıkları açık görevlere bölünmüştür. Her görev tek PR hedefler. Sıra, bağımlılık grafiğini izler.
>
> **Görev formatı:** Amaç · Düzenlenecek dosyalar · Kabul kriterleri · Testler · Bağımlılıklar · Doğrulama komutları.
> **Genel doğrulama (her görevde geçerli):** `pnpm lint && pnpm typecheck && pnpm test` yeşil olmalı; etkilenen migration `prisma migrate diff` ile drift'siz.

## Faz Özeti
- **Faz 0 — Temel (TASK-001..006):** monorepo, db, config, logger, docker, CI (executable checklist).
- **Faz 1 — Kimlik & Yetki (TASK-007..011 + 010a/010b):** auth, RBAC, **protected roles & grant ceiling (010a)**, **transactional audit foundation (010b)**, scope.
- **Faz 2 — Master Data (TASK-012..015):** catalog, warehouses (scope'tan önce), customers.
- **Faz 3 — Stok Çekirdeği (TASK-016..019 + 016a):** balances, **ledger idempotency (016a)**, reservation, transfer (scope matrix + idempotency).
- **Faz 4 — Sipariş & İade (TASK-020..024 + 020a/020b):** orders, **command concurrency (020a)**, **price override (020b)**, state machine, returns.
- **Faz 5 — Finans (TASK-025..027 + 025a/025b/025c):** invoice schema, **series counter + gapless issue (025a)**, payments, void/credit-note, quotes, PDF.
- **Faz 6 — Yardımcı (TASK-026..033 + 026a/026b + 030a/030b):** worker bootstrap, **outbox dispatcher (026a)**, **effect idempotency (026b)**, files, **import staging+recovery (030/030b)**, export, notifications, email, audit query, dashboard.
- **Faz 7 — Frontend (TASK-034..038 + 037a/b/c):** web shell, auth UI, modül ekranları (bölünmüş), e2e.

> **Codex remediation görevleri (BLOCKER/CRITICAL/HIGH):** 010a (grant ceiling), 010b (tx audit), 016a (ledger idempotency), 019 (transfer scope), 020a (order concurrency), 020b (price override), 025a (invoice series), 026a (outbox), 026b (effect idempotency), 030/030b (import staging+recovery). Bunlar ilgili modül kodlanmadan **önce** tamamlanır.

---

## FAZ 0 — Temel

### TASK-001 — Monorepo iskeleti (pnpm + Turborepo)
- **Amaç:** pnpm workspace + Turborepo + temel tooling kurulumu.
- **Dosyalar:** `pnpm-workspace.yaml`, `turbo.json`, kök `package.json`, `tsconfig.base.json`, `.editorconfig`, `.gitignore`, ESLint/Prettier config, `apps/`, `packages/` boş iskelet.
- **Kabul kriterleri:** `pnpm install` çalışır; `pnpm lint`/`pnpm typecheck`/`pnpm build` boş projelerde geçer; TS `strict: true`, `noUncheckedIndexedAccess: true`; modül boundary lint kuralı tanımlı.
- **Testler:** root smoke (`pnpm -r build` hatasız).
- **Bağımlılık:** —
- **Doğrulama:** `pnpm install && pnpm lint && pnpm typecheck && pnpm build`.

### TASK-002 — Config paketi (env şeması, fail-fast)
- **Amaç:** `packages/config` ile zod-doğrulanmış env.
- **Dosyalar:** `packages/config/src/env.ts`, `index.ts`, `package.json`, `.env.example`.
- **Kabul kriterleri:** Eksik/yanlış env'de boot fail-fast; tüm servisler config'i buradan okur; secret repoda yok.
- **Testler:** Vitest — geçerli env parse olur, eksik env throw eder.
- **Bağımlılık:** TASK-001.
- **Doğrulama:** `pnpm --filter @b2b/config test`.

### TASK-003 — Logger paketi (Pino + request context)
- **Amaç:** `packages/logger` Pino wrapper, redaction, AsyncLocalStorage requestId.
- **Dosyalar:** `packages/logger/src/{logger,context}.ts`, `index.ts`.
- **Kabul kriterleri:** JSON log; `authorization/password/token` redakte; `requestId` context taşınır. Bkz. [OBSERVABILITY.md](../OBSERVABILITY.md).
- **Testler:** Vitest — redaction çalışır; context propagation.
- **Bağımlılık:** TASK-001.
- **Doğrulama:** `pnpm --filter @b2b/logger test`.

### TASK-004 — DB paketi: Prisma şema + çekirdek migration
- **Amaç:** `packages/db` Prisma şeması; enum'lar, identity/authz/scope/catalog/warehouse/customers tabloları; native CHECK/trigger/partial-unique SQL.
- **Dosyalar:** `packages/db/prisma/schema.prisma`, `migrations/`, `src/client.ts`, `seed.ts`, `testing/factories.ts`.
- **Kabul kriterleri:** `prisma migrate dev` çalışır; [DATABASE_DESIGN.md](../architecture/DATABASE_DESIGN.md) §1-5,8 tabloları + enum'lar oluşur; soft-delete partial unique'ler aktif. (Stok/sipariş tabloları sonraki görevlerde.)
- **Testler:** Integration (Testcontainers) — migration uygulanır, partial unique doğru çalışır.
- **Bağımlılık:** TASK-001, TASK-002.
- **Doğrulama:** `pnpm --filter @b2b/db migrate && pnpm --filter @b2b/db test`.

### TASK-005 — Docker Compose (dev altyapı)
- **Amaç:** Postgres, Redis, MinIO, Mailpit dev servisleri.
- **Dosyalar:** `docker-compose.yml`, `.env.example` (bağlantılar), `README` dev bölümü.
- **Kabul kriterleri:** `docker compose up` ile dört servis sağlıklı; healthcheck tanımlı; volume persist.
- **Testler:** manuel/smoke script (`scripts/check-infra`).
- **Bağımlılık:** TASK-001.
- **Doğrulama:** `docker compose up -d && docker compose ps`.

### TASK-006 — CI hattı (GitHub Actions) — *executable checklist (P-09/TST-13/TST-14)*
- **Amaç:** lint → typecheck → unit → integration (Postgres/Redis/MinIO/Mailpit) → build → e2e smoke; OpenAPI drift + doc link check.
- **Dosyalar:** `.github/workflows/ci.yml`, `scripts/wait-for-services.sh`, `scripts/check-docs-links.mjs`.
- **Kabul kriterleri:** Explicit service container'lar (Postgres/Redis/MinIO/Mailpit) + env + health-wait; `prisma migrate deploy`; Redis/MinIO connectivity smoke; worker smoke; Playwright browser install + smoke; OpenAPI drift = 0; **markdown link/ADR referans check** (kırık link/eksik ADR → fail); coverage gate; pnpm cache; başarısızlık PR'ı bloklar.
- **Unit testler:** docs-link checker script kendi unit testi.
- **Integration testler:** ilk CI PR'ında empty-project smoke + migration + Redis + MinIO + Playwright + OpenAPI drift adımları geçer.
- **Concurrency/replay testleri:** —
- **Bağımlılık:** TASK-001..005.
- **Doğrulama:** PR aç → CI yeşil; `node scripts/check-docs-links.mjs`.

---

## FAZ 1 — Kimlik & Yetki

### TASK-007 — API iskeleti (NestJS + Swagger + global filter)
- **Amaç:** `apps/api` NestJS app; `/api/v1` global prefix, Swagger, RFC7807 exception filter, request-id middleware, health uçları.
- **Dosyalar:** `apps/api/src/main.ts`, `app.module.ts`, `common/{exception.filter,request-id.middleware,health}`.
- **Kabul kriterleri:** `GET /health/live|ready` çalışır; Swagger `/api/docs`; hatalar problem+json; Pino entegre. [ERROR_HANDLING.md](../ERROR_HANDLING.md), [API_CONVENTIONS.md](../API_CONVENTIONS.md).
- **Testler:** e2e (supertest) — health, 404 problem+json.
- **Bağımlılık:** TASK-002,003,004.
- **Doğrulama:** `pnpm --filter @b2b/api test:e2e`.

### TASK-008 — Domain paketi: Money + state machine altyapısı
- **Amaç:** `packages/domain` saf değer nesneleri ve yardımcılar: `Money`, vergi hesaplama (half-up), genel `StateMachine` helper.
- **Dosyalar:** `packages/domain/src/money/*`, `state-machine/*`, hata sınıfları.
- **Kabul kriterleri:** Money number kullanmaz (bigint minor unit); vergi yuvarlama half-up; framework bağımsız. [ARCHITECTURE.md §Money](../architecture/ARCHITECTURE.md#money).
- **Testler:** Vitest ≥%90 — çarpma/vergi/precision/yuvarlama sınırları.
- **Bağımlılık:** TASK-001.
- **Doğrulama:** `pnpm --filter @b2b/domain test`.

### TASK-009 — Authentication (login/refresh/logout)
- **Amaç:** identity modülü; argon2id, JWT (RS256) access + rotating refresh, reuse detection.
- **Dosyalar:** `apps/api/src/modules/identity/*`, `packages/db` refresh_tokens repo.
- **Kabul kriterleri:** login/refresh/logout uçları; refresh rotation + reuse → tüm aile revoke; parola hash; rate limit; başarısız login audit. [SECURITY_MODEL.md](../architecture/SECURITY_MODEL.md).
- **Testler:** Integration — login happy/fail, refresh rotation, reuse detection, logout revoke.
- **Bağımlılık:** TASK-004,007.
- **Doğrulama:** `pnpm --filter @b2b/api test`.

### TASK-010 — RBAC & PermissionsGuard
- **Amaç:** authorization modülü; roles/permissions/atama uçları; `@RequirePermission` guard; permission seed.
- **Dosyalar:** `modules/authorization/*`, `common/guards/permissions.guard.ts`, `packages/db/seed.ts` (permissions, sistem rolleri).
- **Kabul kriterleri:** Guard permission yoksa 403; role→permission seed [PERMISSION_MATRIX.md](../PERMISSION_MATRIX.md) ile uyumlu; role-name dallanması yok; kritik aksiyonda taze doğrulama. **`SYSTEM_ADMIN` (protected) + `ADMIN` seed; protected permission'lar işaretli.**
- **Testler:** Integration — permission'lı/permission'sız erişim; rol atama; seed idempotent.
- **Bağımlılık:** TASK-009.
- **Doğrulama:** `pnpm --filter @b2b/api test`.
- **⚠️ TASK-010a tamamlanmadan ADMIN rol-yönetim uçları açılmaz (P-01/A-02).**

### TASK-010a — Protected roles, permissions & Grant Ceiling (A-02/T-01/P-01 BLOCKER/CRITICAL)
- **Amaç:** Yetki yükseltme koruması: SYSTEM_ADMIN vs ADMIN, protected role/permission, grant ceiling, self-escalation deny.
- **Bağımlılıklar:** TASK-010.
- **Dosyalar:** `modules/authorization/grant-ceiling.service.ts`, `roles.service.ts`, `permissions.service.ts`, migration (`roles.is_protected`, `roles.privilege_level`, `permissions.is_protected`), `seed.ts`.
- **Kabul kriterleri:** `roles.is_system/is_protected/privilege_level`, `permissions.is_protected/permission_group` alanları; SYSTEM_ADMIN UI'dan silinemez/değiştirilemez; protected permission/rol yalnız SYSTEM_ADMIN; cannot-grant-above-self; `actor.privilege_level ≥ target`; self-assignment deny; `warehouse:scope:all`/`role:manage:protected`/`audit:read:all`/`system:read` protected; her grant business audit (aynı tx). **ADMIN'in implicit global warehouse scope'u YOK — `warehouse:scope:all` rol-temelli verilmez, yalnız SYSTEM_ADMIN atar; ADMIN bu permission'ı kendine/başkasına atayamaz (gate G-02/G-03).** [SECURITY_MODEL §2a/2b/3](../architecture/SECURITY_MODEL.md), [PERMISSION_MATRIX §4](../PERMISSION_MATRIX.md).
- **Unit testler:** grant-ceiling karar fonksiyonu (subset/level/protected/self/scope).
- **Integration testler:** ADMIN privileged rol create/assign/self-assign/`warehouse:scope:all` verme/SYSTEM_ADMIN atama → 403; SYSTEM_ADMIN `warehouse:scope:all` atar → 200 + audit; seed protected işaretleri; seed'de ADMIN'de `warehouse:scope:all` yok.
- **Concurrency/replay testleri:** —
- **Doğrulama:** `pnpm --filter @b2b/api test -- grant-ceiling`.

### TASK-010b — Transactional Business Audit foundation (A-07/T-09/P-04)
- **Amaç:** Mutasyonla aynı transaction içinde business audit yazan ortak altyapı (writer + immutable tablo + actor snapshot helper). Order/invoice task'larından **önce**.
- **Bağımlılıklar:** TASK-007, TASK-004 (audit_logs tablosu + trigger).
- **Dosyalar:** `modules/audit/audit-writer.service.ts`, `common/audit/*`, migration (audit_logs actor snapshot alanları + append-only trigger).
- **Kabul kriterleri:** `writeAudit(tx, {...})` aynı transaction'da yazar; actor snapshot (`actor_email/name/roles`); before/after explicit; immutable (UPDATE/DELETE trigger). Async/outbox audit **kullanılmaz**. [ADR-007](../decisions/ADR-007-audit-in-transaction.md).
- **Unit testler:** payload/diff builder; actor snapshot.
- **Integration testler:** business-failure→no-audit; audit-failure→no-mutation (rollback); success→audit present; trigger UPDATE/DELETE reddi.
- **Concurrency/replay testleri:** —
- **Doğrulama:** `pnpm --filter @b2b/api test -- audit`.

### TASK-011 — Warehouse scope (veri-seviyesi yetki)
- **Amaç:** scope modülü; `user_warehouse_scopes` yönetimi; scope guard/filter; protected `warehouse:scope:all` global erişim.
- **Dosyalar:** `modules/scope/*`, `common/scope/*`, migration (`user_warehouse_scopes`: user_id, warehouse_id, scope_type, granted_by, created_at).
- **Kabul kriterleri:** Depoya bağlı uçlar kullanıcının **açık** `user_warehouse_scopes` kapsamıyla filtrelenir; kapsam dışı erişim 403; global kapsam **yalnız** `warehouse:scope:all` (protected). **Hiçbir rol implicit global scope vermez — ADMIN dahil.** scope atama business audit (aynı tx) + grant ceiling (kendi kapsamı içinde). **Gerçek warehouse kayıtlarıyla** test (P-03). [SECURITY_MODEL.md §3](../architecture/SECURITY_MODEL.md).
- **Unit testler:** scope predicate builder.
- **Integration testler:** boş `user_warehouse_scopes` → erişim yok (**ADMIN dahil — rol bypass yok, G-04**); atanmış depo → erişim; `warehouse:scope:all` → tüm depolar; `warehouse:scope:all` olmayan ADMIN tüm-depo raporu → 403/yalnız kapsamı.
- **Bağımlılık:** TASK-010, TASK-010a (grant ceiling) **→ TASK-013 (warehouses) önce** (P-03: grafik `010→010a→013→011`).
- **Doğrulama:** `pnpm --filter @b2b/api test -- scope`.

---

## FAZ 2 — Master Data

### TASK-012 — Catalog (ürün + kategori)
- **Amaç:** catalog modülü; ürün/kategori CRUD (soft delete), arama.
- **Dosyalar:** `modules/catalog/*`.
- **Kabul kriterleri:** CRUD + permission; sku partial-unique; soft delete listede gizli; fiyat Money; trgm arama.
- **Testler:** Integration — CRUD, soft delete unique davranışı, yetki.
- **Bağımlılık:** TASK-010.
- **Doğrulama:** `pnpm --filter @b2b/api test`.

### TASK-013 — Warehouses
- **Amaç:** warehouses modülü; depo CRUD.
- **Dosyalar:** `modules/warehouses/*`, migration (eğer TASK-004'te yoksa).
- **Kabul kriterleri:** CRUD + permission; code partial-unique; soft delete.
- **Testler:** Integration — CRUD, yetki.
- **Bağımlılık:** TASK-010.
- **Doğrulama:** `pnpm --filter @b2b/api test`.

### TASK-014 — Customers & adresler
- **Amaç:** customers modülü; müşteri + adres CRUD, default adres kuralı.
- **Dosyalar:** `modules/customers/*`.
- **Kabul kriterleri:** CRUD; (customer,type) başına tek default (partial unique); soft delete; permission.
- **Testler:** Integration — CRUD, default adres invariant.
- **Bağımlılık:** TASK-010.
- **Doğrulama:** `pnpm --filter @b2b/api test`.

### TASK-015 — OpenAPI client üretimi (web foundation)
- **Amaç:** `packages/api-client` OpenAPI'den generate; CI drift kontrolü.
- **Dosyalar:** `packages/api-client/*`, generate script, CI adımı.
- **Kabul kriterleri:** Spec'ten tip-güvenli client üretilir; drift testte yakalanır; web bunu tüketir.
- **Testler:** Contract — generate sonrası diff = 0.
- **Bağımlılık:** TASK-012,013,014.
- **Doğrulama:** `pnpm gen:api-client && git diff --exit-code packages/api-client`.

---

## FAZ 3 — Stok Çekirdeği (en kritik)

### TASK-016 — Stok şeması: balances + ledger + reservations
- **Amaç:** inventory tabloları + CHECK + append-only trigger + **idempotency** migration.
- **Dosyalar:** `packages/db` migration (stock_balances/stock_ledger/stock_reservations), trigger SQL.
- **Kabul kriterleri:** CHECK (`on_hand≥0`,`reserved≥0`,`reserved≤on_hand`); ledger UPDATE/DELETE trigger reddeder; `stock_ledger.idempotency_key NOT NULL UNIQUE`; `stock_reservations.idempotency_key UNIQUE` + `(order_id, order_item_id)` unique; partial/unique index'ler. [DATABASE_DESIGN.md §6,17](../architecture/DATABASE_DESIGN.md).
- **Unit testler:** —
- **Integration testler:** CHECK ihlali reddi, trigger reddi, unique(idempotency_key) çift insert reddi.
- **Bağımlılık:** TASK-004,012,013.
- **Doğrulama:** `pnpm --filter @b2b/db migrate && pnpm --filter @b2b/db test`.

### TASK-016a — Ledger idempotency & balance lazy-upsert (A-05/A-13)
- **Amaç:** Satır-seviyesi movement key üretimi + balance lazy upsert helper'ları.
- **Bağımlılıklar:** TASK-016.
- **Dosyalar:** `packages/domain/inventory/movement-key.ts`, `modules/inventory/ledger.repository.ts`, `balance.repository.ts`.
- **Kabul kriterleri:** Deterministik anahtarlar (`ORDER_SHIPMENT:{o}:{i}`, `TRANSFER_OUT/IN:{t}:{i}`, `RETURN_IN:{r}:{i}`, `IMPORT:{j}:{row}`); ledger insert `ON CONFLICT (idempotency_key) DO NOTHING`; balance `ON CONFLICT (product_id,warehouse_id) DO UPDATE`. [INVENTORY_RULES §3a/3b](../business-rules/INVENTORY_RULES.md), [ADR-002](../decisions/ADR-002-stock-ledger.md).
- **Unit testler:** movement-key üretimi (her referans tipi).
- **Integration testler:** aynı anahtarla ikinci insert no-op; balance satırı yokken upsert oluşturur.
- **Concurrency/replay testleri:** iki paralel receipt → tek balance satırı + iki ledger; aynı shipment retry → on_hand değişmez.
- **Doğrulama:** `pnpm --filter @b2b/api test -- ledger-idempotency`.

### TASK-017 — InventoryService: receipt + adjust + ledger yazımı
- **Amaç:** stok girişi (RECEIPT) ve düzeltme (ADJUSTMENT); ledger + balance senkron, row lock.
- **Dosyalar:** `modules/inventory/*`, `packages/domain` stok kuralları.
- **Kabul kriterleri:** RECEIPT/ADJUSTMENT on_hand günceller + ledger yazar (aynı tx); adjust reason zorunlu; negatif sonuç reddedilir; permission. [INVENTORY_RULES.md](../business-rules/INVENTORY_RULES.md).
- **Testler:** Integration — receipt/adjust, ledger Σ=on_hand, negatif reddi.
- **Bağımlılık:** TASK-016,011.
- **Doğrulama:** `pnpm --filter @b2b/api test`.

### TASK-018 — InventoryService: reserve / release / consume (concurrency)
- **Amaç:** rezervasyon API'si (orders bunu çağıracak): `reserve(tx)`, `release(tx)`, `consumeReservation(tx)`; pessimistic lock + deterministik sıra.
- **Dosyalar:** `modules/inventory/reservation.service.ts`, domain.
- **Kabul kriterleri:** reserve yetersizde `InsufficientStockError` (all-or-nothing); consume on_hand− & reserved− + SHIPMENT ledger; release reserved−; tx parametre alır (yeni tx açmaz). [ADR-003](../decisions/ADR-003-order-stock-reservation.md).
- **Testler:** Integration **+ concurrency**: N+K paralel reserve → tam N başarı, negatif yok, deadlock yok. [TEST_STRATEGY.md §4](../TEST_STRATEGY.md#concurrency).
- **Bağımlılık:** TASK-017.
- **Doğrulama:** `pnpm --filter @b2b/api test -- reservation`.

### TASK-019 — Transfers (depolar arası) + scope matrix + idempotency (A-03/T-03/P-08)
- **Amaç:** transfers modülü; DRAFT→IN_TRANSIT (out)→RECEIVED/COMPLETED (in), iptal; source/dest scope matrisi; row-level lock + movement key.
- **Dosyalar:** `modules/transfers/*`, migration (stock_transfers/items).
- **Kabul kriterleri:** dispatch kaynak on_hand− + TRANSFER_OUT; **receive hedef on_hand+ + TRANSFER_IN**; source≠dest; **scope matrisi**: create/approve/dispatch=source, receive=destination, read/list=source∨dest, cancel=source; her geçiş transfer row lock + koşullu geçiş; movement key unique; toplam on_hand korunur. [SECURITY_MODEL §3a](../architecture/SECURITY_MODEL.md), [INVENTORY_RULES §6/6a](../business-rules/INVENTORY_RULES.md).
- **Unit testler:** transfer state machine; scope karar matrisi.
- **Integration testler:** out/in akışı, on_hand korunumu, iptal telafisi; **source-only/dest-only/both/none** scope kombinasyonları için create/dispatch/receive/read/list 403/200.
- **Concurrency/replay testleri:** paralel dispatch/receive → kalem başına tek ledger; cancelled-in-transit telafisi deterministik.
- **Bağımlılık:** TASK-018, TASK-016a, TASK-010b (audit).
- **Doğrulama:** `pnpm --filter @b2b/api test -- transfers`.

---

## FAZ 4 — Sipariş & İade

### TASK-020 — Sipariş şeması + DRAFT CRUD + toplam hesaplama (server-side fiyat, P-11)
- **Amaç:** orders tabloları (immutable, silinmez); DRAFT sipariş + kalem CRUD; Money toplamları; server-side fiyat.
- **Dosyalar:** migration (orders/order_items/order_status_history), `modules/orders/*`.
- **Kabul kriterleri:** DRAFT'ta kalem CRUD; snapshot (sku/ad/**server list_price**); toplamlar server-side Money; **client `unitPrice`/totals reddedilir**; **aktif ürün doğrulaması** (deleted/inactive eklenemez); order silinmez. [ORDER_RULES.md §1,2,2a,7](../business-rules/ORDER_RULES.md).
- **Unit testler:** toplam/vergi hesabı (Money).
- **Integration testler:** kalem CRUD, toplam, snapshot; client totals yok sayılır; soft-deleted/inactive ürün eklenemez (T-08).
- **Bağımlılık:** TASK-012,014,013,016.
- **Doğrulama:** `pnpm --filter @b2b/api test`.

### TASK-020a — Order command concurrency & idempotency (A-04/T-04/TST-03)
- **Amaç:** Sipariş durum geçişlerinde order row lock + expected-status koşullu geçiş + `command_idempotency` tablosu + kesin kilit sırası.
- **Bağımlılıklar:** TASK-020.
- **Dosyalar:** `modules/orders/order-transition.service.ts`, `common/idempotency/command-idempotency.ts`, migration (`command_idempotency`).
- **Kabul kriterleri:** Her geçiş `SELECT ... FOR UPDATE` + `UPDATE ... WHERE id=? AND status=?expected` (affected=0 → 409); kilit sırası order→order_items→stock_balances (`warehouse_id,product_id`); `command_idempotency` replay; farklı key paralel geçiş çiftlenmez. [ORDER_RULES §1a](../business-rules/ORDER_RULES.md), [DATABASE_DESIGN §19](../architecture/DATABASE_DESIGN.md).
- **Unit testler:** transition guard (expected-status).
- **Integration testler:** geçersiz geçiş 409; command idempotency replay aynı yanıt; farklı gövde+aynı key 409.
- **Concurrency/replay testleri:** **iki paralel approve farklı key → tek transition/reservation/history/audit; iki paralel ship → kalem başına tek SHIPMENT; approve+cancel yarışı tutarlı.**
- **Doğrulama:** `pnpm --filter @b2b/api test -- order-concurrency`.

### TASK-020b — Price override policy (A-06/T-07/TST-08)
- **Amaç:** `order:price:override` permission + override akışı + `order_price_overrides` + audit.
- **Bağımlılıklar:** TASK-020, TASK-010b (audit).
- **Dosyalar:** `modules/orders/price-override.service.ts`, migration (`order_price_overrides`), DTO (override).
- **Kabul kriterleri:** Fiyat server `products.list_price`'tan; override yalnız permission + zorunlu reason; eşik üstü indirim → approval; override `order_price_overrides` + business audit (`order.price.override`); client raw `unitPrice` yetkisiz → 403/422. [ORDER_RULES §2a](../business-rules/ORDER_RULES.md), [PERMISSION_MATRIX](../PERMISSION_MATRIX.md).
- **Unit testler:** indirim yüzdesi/eşik hesabı; approval gerekliliği.
- **Integration testler:** yetkisiz override 403/422; yetkili override reason+audit+override kaydı; client totals yok sayılır.
- **Concurrency/replay testleri:** —
- **Doğrulama:** `pnpm --filter @b2b/api test -- price-override`.

### TASK-021 — Sipariş durum makinesi: approve (rezervasyon)
- **Amaç:** DRAFT→APPROVED; InventoryService.reserve tek tx; status_history + business audit.
- **Dosyalar:** `modules/orders/order-approval.service.ts`, domain state machine entegrasyonu.
- **Kabul kriterleri:** yetersiz stokta tam reddi (DRAFT kalır, rezervasyon yok); izinsiz geçiş reddi (TASK-020a transition); idempotency-key; permission+scope; **approve anında aktif ürün doğrulaması** (T-08); business audit aynı tx. [ORDER_RULES.md §3](../business-rules/ORDER_RULES.md).
- **Unit testler:** approve precondition kontrolleri.
- **Integration testler:** happy; yetersiz stok all-or-nothing; idempotency; DRAFT'ta silinen ürün approve 422 (rezervasyon yok).
- **Concurrency/replay testleri:** paralel approve (TASK-020a ile) → tek rezervasyon.
- **Bağımlılık:** TASK-018,020,020a,010b.
- **Doğrulama:** `pnpm --filter @b2b/api test -- order-approval`.

### TASK-022 — Sipariş durum makinesi: prepare / ship / cancel
- **Amaç:** APPROVED→PREPARING→SHIPPED ve cancel akışları; ship'te consume, cancel'da release.
- **Dosyalar:** `modules/orders/order-fulfillment.service.ts`.
- **Kabul kriterleri:** ship on_hand− & reserved− + SHIPMENT; cancel rezervasyon release; SHIPPED iptal reddi; tüm geçişler whitelist + history. [ORDER_RULES.md §4,5,6](../business-rules/ORDER_RULES.md).
- **Testler:** Integration — ship/cancel etkileri, SHIPPED iptal reddi, izinsiz geçiş.
- **Bağımlılık:** TASK-021.
- **Doğrulama:** `pnpm --filter @b2b/api test`.

### TASK-023 — İade şeması + akış
- **Amaç:** returns modülü; SHIPPED siparişe iade; DRAFT→APPROVED→RECEIVED→COMPLETED.
- **Dosyalar:** migration (returns/return_items), `modules/returns/*`.
- **Kabul kriterleri:** yalnız SHIPPED'e iade; miktar ≤ sevk−önceki iade; RECEIVED'da resellable on_hand+ + RETURN_IN; damaged etkisiz. [RETURN_RULES.md](../business-rules/RETURN_RULES.md).
- **Testler:** Integration — iade akışı, miktar limiti, stok geri, damaged.
- **Bağımlılık:** TASK-022,018.
- **Doğrulama:** `pnpm --filter @b2b/api test`.

### TASK-024 — Reconciliation job (stok tutarlılığı)
- **Amaç:** worker job: `Σ ledger == on_hand` ve `Σ active reservation == reserved` doğrulama + alarm.
- **Dosyalar:** `apps/worker/src/jobs/reconciliation.*`.
- **Kabul kriterleri:** uyumsuzlukta kritik alarm + audit; otomatik düzeltme yok; idempotent. [INVENTORY_RULES.md §8](../business-rules/INVENTORY_RULES.md).
- **Testler:** Integration — uyumsuzluk enjekte → alarm üretilir.
- **Bağımlılık:** TASK-019,022 + TASK-026 worker iskeleti.
- **Doğrulama:** `pnpm --filter @b2b/worker test`.

---

## FAZ 5 — Finans

### TASK-025 — Fatura şeması + DRAFT düzenleme (P-07)
- **Amaç:** billing modülü temeli; invoice/invoice_items tabloları; DRAFT fatura + kalem CRUD; server-side totals.
- **Bağımlılıklar:** TASK-020, TASK-014, TASK-010b.
- **Dosyalar:** migration (invoices/invoice_items), `modules/billing/*`.
- **Kabul kriterleri:** DRAFT'ta düzenlenebilir; totals server-side Money; fatura silinmez; siparişten kalem kopyalama snapshot. [INVOICE_RULES.md §1,4](../business-rules/INVOICE_RULES.md).
- **Unit testler:** totals hesabı.
- **Integration testler:** DRAFT CRUD; client totals reddi.
- **Doğrulama:** `pnpm --filter @b2b/api test -- invoice-draft`.

### TASK-025a — Invoice series counter + issue + gapless numbering (A-01/P-02/TST-07 BLOCKER)
- **Amaç:** `invoice_series` kilitli sayaç + issue (gapless numara atama) + immutability enforcement.
- **Bağımlılıklar:** TASK-025.
- **Dosyalar:** migration (`invoice_series`, invoices numara/unique alanları), `modules/billing/invoice-issue.service.ts`, `seed.ts` (varsayılan seri).
- **Kabul kriterleri:** issue tx içinde invoice row lock + `invoice_series FOR UPDATE` + `next_number` ata + artır; ISSUED **immutable**; `UNIQUE(company_id, series_id, fiscal_year, invoice_number)`; **sequence kullanılmaz**; business audit (`invoice.issued`); idempotent (aynı fatura tekrar issue → ikinci numara yok). [ADR-006](../decisions/ADR-006-invoice-numbering.md), [INVOICE_RULES.md §3](../business-rules/INVOICE_RULES.md).
- **Unit testler:** numara format/prefix.
- **Integration testler:** ISSUED immutability; tekrar düzenleme reddi; unique ihlali.
- **Concurrency/replay testleri:** **numara ayrıldıktan sonra rollback → boşluk yok**; paralel issue → benzersiz/monoton; retry-same-invoice → ikinci numara yok.
- **Doğrulama:** `pnpm --filter @b2b/api test -- invoice-numbering`.

### TASK-025b — Ödemeler (payments) + correction policy (TST-11)
- **Amaç:** payments (append-only); PAID geçişi; overpayment/duplicate/correction politikası.
- **Bağımlılıklar:** TASK-025a.
- **Dosyalar:** migration (payments), `modules/billing/payment.service.ts`.
- **Kabul kriterleri:** Σ ödeme=grand_total→PAID; overpayment reddi (veya explicit policy+audit); duplicate payment idempotency; düzeltme onaylı reversal; payment silinmez. [INVOICE_RULES.md §5](../business-rules/INVOICE_RULES.md).
- **Unit testler:** ödeme toplam/overpayment kararı.
- **Integration testler:** kısmi→PAID; overpayment 422; reversal akışı.
- **Concurrency/replay testleri:** duplicate payment (aynı key) çift tutar eklemez.
- **Doğrulama:** `pnpm --filter @b2b/api test -- payments`.

### TASK-025c — Void + Credit Note (immutability düzeltme yolu)
- **Amaç:** ISSUED→VOID; CREDIT_NOTE üretimi (iade entegrasyonu); idempotency.
- **Bağımlılıklar:** TASK-025a, TASK-023 (returns).
- **Dosyalar:** `modules/billing/void.service.ts`, `credit-note.service.ts`.
- **Kabul kriterleri:** VOID izinli geçişler; düzeltme yalnız VOID/CREDIT_NOTE; credit note idempotency (`CREDIT_NOTE:{returnId}`); business audit. [INVOICE_RULES.md §1,2](../business-rules/INVOICE_RULES.md), [RETURN_RULES §4](../business-rules/RETURN_RULES.md).
- **Unit testler:** void geçiş kuralları.
- **Integration testler:** void sonrası immutability; credit note tutarı; faturalı iade → tek credit note.
- **Concurrency/replay testleri:** aynı return tekrar finalize → çift credit note yok.
- **Doğrulama:** `pnpm --filter @b2b/api test -- credit-note`.

### TASK-026 — Worker bootstrap + BullMQ + job_logs (P-05)
- **Amaç:** `apps/worker` NestJS standalone; BullMQ kuyruk bağlantısı; job_logs; retry/backoff/DLQ politikası.
- **Bağımlılıklar:** TASK-004, TASK-005.
- **Dosyalar:** `apps/worker/src/{main,app.module,queues}`, migration (job_logs).
- **Kabul kriterleri:** worker ayağa kalkar; job_logs (queue/jobId/status/attempts/süre) kalıcı; retry + exponential backoff + jitter; kalıcı hata → DEAD/DLQ + alarm. **job_logs gözlem içindir, idempotency guard değil.**
- **Unit testler:** backoff hesabı.
- **Integration testler:** job çalışır, job_logs durumları; retry/DLQ.
- **Doğrulama:** `pnpm --filter @b2b/worker test -- bootstrap`.

### TASK-026a — Transactional outbox schema + dispatcher (claim/lease) (A-08)
- **Amaç:** `outbox_events` + dispatcher (`FOR UPDATE SKIP LOCKED` claim/lease); domain tx içinde outbox insert.
- **Bağımlılıklar:** TASK-026.
- **Dosyalar:** migration (`outbox_events`), `apps/worker/src/outbox/dispatcher.ts`, `modules/.../outbox-writer.ts`.
- **Kabul kriterleri:** `outbox_events` tüm alanlar + `UNIQUE(deduplication_key)`; domain değişikliği + outbox insert **aynı tx**; dispatcher claim/lease; `available_at` backoff. [ADR-008](../decisions/ADR-008-outbox-and-idempotency.md), [DATABASE_DESIGN §14](../architecture/DATABASE_DESIGN.md).
- **Unit testler:** dedup key üretimi.
- **Integration testler:** tx rollback → outbox satırı yok; commit → tam bir satır; çift dedup reddi.
- **Concurrency/replay testleri:** iki paralel dispatcher aynı satırı işlemez (SKIP LOCKED).
- **Doğrulama:** `pnpm --filter @b2b/worker test -- outbox`.

### TASK-026b — Worker effect idempotency & crash-state harness (A-08/T-05/TST-06 + G-17)
- **Amaç:** `effect_receipts` **state modeli** (PLANNED/IN_PROGRESS/SUCCEEDED/FAILED/UNKNOWN) + zorunlu `provider_idempotency_key` + crash/redelivery harness. Hem çift **hem kayıp** etki engellenir.
- **Bağımlılıklar:** TASK-026a.
- **Dosyalar:** migration (`effect_receipts` + `effect_status` enum), `apps/worker/src/effects/*`, test harness (failure injection).
- **Kabul kriterleri:** dış çağrı **öncesi** receipt `PLANNED`/`IN_PROGRESS` (`(effect_type,effect_key)` unique); dış çağrı `provider_idempotency_key` ile; başarı→`SUCCEEDED`, hata→`FAILED`, belirsiz→`UNKNOWN`; **receipt SUCCEEDED olmadan effect tamamlanmış sayılmaz**; **outbox event yalnız effect SUCCEEDED sonrası processed**; provider idempotency desteklemeyen servis → `UNKNOWN` + manuel inceleme (exactly-once garanti edilmez, açıkça belgeli). [ADR-008](../decisions/ADR-008-outbox-and-idempotency.md), [DATABASE_DESIGN §14](../architecture/DATABASE_DESIGN.md).
- **Unit testler:** effect_key + provider key üretimi; state geçişleri.
- **Integration testler:** receipt mevcut+SUCCEEDED → skip; FAILED → retry.
- **Concurrency/replay testleri (G-17):**
  - crash after `PLANNED` before external call → retry aynı effect_key, **no lost effect**.
  - crash after external call before `SUCCEEDED` → retry aynı provider key, **no duplicate**.
  - provider without idempotency → `UNKNOWN`/manual review.
  - outbox processed yalnız effect SUCCEEDED sonrası.
- **Doğrulama:** `pnpm --filter @b2b/worker test -- effect-idempotency`.

### TASK-027 — Teklifler + PDF üretimi
- **Amaç:** quotes modülü + documents (PDF) worker job; fatura/teklif PDF → files → e-posta outbox.
- **Dosyalar:** `modules/billing/quotes*`, `apps/worker/src/jobs/pdf.*`, `modules/documents/*`.
- **Kabul kriterleri:** quote akışı (send/accept/expire); ACCEPTED→sipariş/fatura kopya; PDF idempotent, files'a kaydedilir; expire job idempotent. [INVOICE_RULES.md §6,7](../business-rules/INVOICE_RULES.md).
- **Testler:** Integration — quote akışı, expire job, PDF üretimi+kayıt.
- **Bağımlılık:** TASK-025,026,028.
- **Doğrulama:** `pnpm --filter @b2b/api test && pnpm --filter @b2b/worker test`.

---

## FAZ 6 — Yardımcı Modüller

### TASK-028 — Dosya yönetimi (S3/MinIO)
- **Amaç:** files modülü; pre-signed upload/download, metadata, soft delete, cleanup job.
- **Dosyalar:** `modules/files/*`, storage adapter, `apps/worker/src/jobs/file-cleanup.*`.
- **Kabul kriterleri:** pre-signed URL; content-type/boyut limiti; private bucket; soft delete + gecikmeli fiziksel silme; permission.
- **Testler:** Integration — upload/download, limit reddi, cleanup.
- **Bağımlılık:** TASK-007,026.
- **Doğrulama:** `pnpm --filter @b2b/api test`.

### TASK-029 — Excel/CSV export (async)
- **Amaç:** exports modülü; async export job → file; scope-aware veri.
- **Dosyalar:** `modules/exports/*`, `apps/worker/src/jobs/export.*`.
- **Kabul kriterleri:** export job kuyruğa girer, file üretir, scope'a saygılı; permission; büyük veri stream.
- **Testler:** Integration — export job → file, scope filtresi.
- **Bağımlılık:** TASK-026,028.
- **Doğrulama:** `pnpm --filter @b2b/worker test`.

### TASK-030 — Import engine: staging + checksum + durum makinesi (A-09/P-06)
- **Amaç:** Ortak parser/staging/error-report altyapısı; dosya checksum dedup; import durum makinesi; crash recovery.
- **Bağımlılıklar:** TASK-028, TASK-026.
- **Dosyalar:** migration (`import_jobs`, `import_rows`, `import_job_errors`), `modules/imports/*`, `apps/worker/src/jobs/import.*`.
- **Kabul kriterleri:** `import_jobs` durum makinesi (UPLOADED→VALIDATING→VALIDATED→IMPORTING→COMPLETED / *_FAILED / CANCELLED); `file_checksum_sha256` duplicate-file policy; `import_rows` staging (row_hash, idempotency_key, status); validate (staging) ve apply (atomic) ayrı fazlar; crash sonrası resume. [DATABASE_DESIGN §13](../architecture/DATABASE_DESIGN.md).
- **Unit testler:** durum makinesi geçişleri; row hash/key.
- **Integration testler:** karışık valid/invalid → staging status + error report; checksum ikinci upload → 409/no-op.
- **Concurrency/replay testleri:** aynı dosya tekrar upload → ikinci etki yok.
- **Doğrulama:** `pnpm --filter @b2b/worker test -- import-engine`.

### TASK-030a — Product/Customer import
- **Amaç:** Ürün/müşteri import (030 altyapısı üzerine).
- **Bağımlılıklar:** TASK-030, TASK-012, TASK-014.
- **Dosyalar:** `modules/imports/product-import.ts`, `customer-import.ts`.
- **Kabul kriterleri:** row-level validation; geçerli satır upsert, hatalı satır rapor; idempotent (row key).
- **Unit testler:** satır validasyonu.
- **Integration testler:** karışık dosya başarı/hata ayrımı; tekrar upload idempotent.
- **Doğrulama:** `pnpm --filter @b2b/worker test -- product-import`.

### TASK-030b — Stock adjustment import (ledger + row idempotency + scope + recovery) (A-09/T-03/T-06)
- **Amaç:** Stok düzeltme/giriş importu; ledger entegrasyonu; satır-seviyesi idempotency; row-level warehouse scope; crash recovery.
- **Bağımlılıklar:** TASK-030, TASK-016a, TASK-017.
- **Dosyalar:** `modules/imports/stock-import.ts`.
- **Kabul kriterleri:** her satır ledger'a `IMPORT:{jobId}:{rowId}` anahtarıyla yazar (unique → çift uygulama yok); **row-level warehouse scope** (kapsam dışı satır → policy: ALL_OR_NOTHING rollback veya satır INVALID); apply_policy seçilebilir; resume yalnız `VALID && !APPLIED`. [INVENTORY_RULES §3a](../business-rules/INVENTORY_RULES.md), [SECURITY_MODEL §3](../architecture/SECURITY_MODEL.md).
- **Unit testler:** scope karar; apply policy.
- **Integration testler:** out-of-scope satır deterministik sonuç; yetkili satır ledger yazar.
- **Concurrency/replay testleri:** **N satır sonrası crash → retry yalnız eksik satırlar; çift ledger yok**; aynı dosya tekrar → ikinci stok etkisi yok.
- **Doğrulama:** `pnpm --filter @b2b/worker test -- stock-import`.

### TASK-031 — Bildirimler + E-posta (outbox)
- **Amaç:** notifications (in-app) + email modülleri; event consumer; Mailpit/SMTP.
- **Dosyalar:** `modules/notifications/*`, `modules/email/*`, `apps/worker/src/jobs/email.*`.
- **Kabul kriterleri:** iş olayları (order.approved, invoice.issued, low-stock) bildirim+mail üretir; outbox tam-bir-kez; retry; in-app okundu işareti.
- **Testler:** Integration — event→notification+email outbox, idempotency, retry.
- **Bağımlılık:** TASK-026.
- **Doğrulama:** `pnpm --filter @b2b/api test && pnpm --filter @b2b/worker test`.

### TASK-032 — Audit sorgu/filtre uçları (foundation TASK-010b'de)
- **Amaç:** Audit **yazımı** TASK-010b'de hazır (aynı tx writer). Bu görev yalnız **sorgu/filtre/genel interceptor metadata** genişletmesidir (P-04).
- **Dosyalar:** `modules/audit/audit-query.controller.ts`, `common/audit/interceptor.ts`.
- **Kabul kriterleri:** entity-bazlı (`entity_type/id`) ve actor-bazlı (`actor_id`) sorgu; `audit:read` (scope) / `audit:read:all` (protected); interceptor genel metadata (actor, request_id, ip) sağlar ama domain before/after explicit kalır.
- **Unit testler:** filtre query builder.
- **Integration testler:** sorgu/filtre; `audit:read:all` olmadan sistem-geneli erişim 403.
- **Concurrency/replay testleri:** —
- **Bağımlılık:** TASK-010b (writer); TASK-021/022/025a audit üretimi bu writer ile (PR kabul şartı: audit integration testi olmadan merge yok).
- **Doğrulama:** `pnpm --filter @b2b/api test -- audit-query`.

### TASK-033 — Dashboard + sistem/job log uçları
- **Amaç:** dashboard aggregate uçları (bekleyen sipariş, düşük stok, ciro), system/job log uçları.
- **Dosyalar:** `modules/dashboard/*`, `modules/system/*`.
- **Kabul kriterleri:** aggregate okuma scope-aware; kısa TTL cache (Redis, yalnız read); `dashboard:read`/`system:read`.
- **Testler:** Integration — aggregate doğruluğu, scope, yetki.
- **Bağımlılık:** TASK-022,025.
- **Doğrulama:** `pnpm --filter @b2b/api test`.

---

## FAZ 7 — Frontend

### TASK-034 — Web shell + auth (Next.js)
- **Amaç:** `apps/web` App Router; login, token akışı (httpOnly refresh cookie), korunan layout, api-client entegrasyonu.
- **Dosyalar:** `apps/web/app/*`, `lib/api.ts`, auth context.
- **Kabul kriterleri:** login/logout; korunan rotalar; api-client kullanımı; **DB'ye doğrudan erişim yok**; iş kuralı component'te yok.
- **Testler:** Playwright — login→dashboard, logout, korumalı rota yönlendirme.
- **Bağımlılık:** TASK-015,009.
- **Doğrulama:** `pnpm --filter @b2b/web test:e2e -- auth`.

### TASK-035 — Catalog/Warehouse/Customer ekranları
- **Amaç:** master data CRUD ekranları (shadcn/ui), permission-aware UI.
- **Dosyalar:** `apps/web/app/(catalog|warehouses|customers)/*`.
- **Kabul kriterleri:** liste/detay/form; pagination; yetkiye göre UI (ama güvenlik backend'de); validation hataları gösterimi.
- **Testler:** Playwright — ürün oluştur/düzenle akışı.
- **Bağımlılık:** TASK-034,012,013,014.
- **Doğrulama:** `pnpm --filter @b2b/web test:e2e`.

### TASK-036 — Sipariş ekranları + durum aksiyonları
- **Amaç:** sipariş oluşturma/onay/hazırla/sevk/iptal UI; stok uyarıları.
- **Dosyalar:** `apps/web/app/orders/*`.
- **Kabul kriterleri:** DRAFT düzenleme; aksiyon butonları permission-aware; yetersiz stok hatası UI'da; Money string gösterimi doğru.
- **Testler:** Playwright — sipariş oluştur→onayla→sevk; yetersiz stok hatası.
- **Bağımlılık:** TASK-035,022.
- **Doğrulama:** `pnpm --filter @b2b/web test:e2e -- orders`.

### TASK-037 — Stok ekranları (bölündü, P-10)
- **Amaç:** stok bakiye + ledger görünümü; scope-aware.
- **Dosyalar:** `apps/web/app/stock/*`.
- **Kabul kriterleri:** bakiye+ledger; scope-aware liste; permission-aware UI; internal alanlar (raw version vb.) gösterilmez.
- **Testler:** Playwright — stok görünümü; permission gizli + direct API 403.
- **Bağımlılık:** TASK-036,017.
- **Doğrulama:** `pnpm --filter @b2b/web test:e2e -- stock`.

### TASK-037a — Transfer UI · TASK-037b — İade UI · TASK-037c — Fatura/PDF UI (P-10)
- **Amaç:** Her biri ayrı PR: transfers UI (source/dest scope), returns UI, invoices + PDF indirme.
- **Dosyalar:** `apps/web/app/(transfers|returns|invoices)/*`.
- **Kabul kriterleri (her ekran):** state-machine'e uygun buton aktif/pasif; permission gizli buton + **direct API 403**; geçersiz aksiyon API'de reddedilir; problem+json `code` yerelleştirilmiş gösterim; Money string doğru.
- **Testler:** Playwright — her ekran için permission-hidden + direct-API-denial; transfer scope; iade akışı; fatura PDF.
- **Bağımlılık:** 037a→TASK-019; 037b→TASK-023; 037c→TASK-025a,027.
- **Doğrulama:** `pnpm --filter @b2b/web test:e2e -- transfers returns invoices`.

### TASK-038 — Dashboard + bildirim UI + e2e tam akış
- **Amaç:** dashboard, bildirim merkezi (polling), uçtan uca smoke.
- **Dosyalar:** `apps/web/app/(dashboard|notifications)/*`, `e2e/full-flow.spec.ts`.
- **Kabul kriterleri:** dashboard metrikleri; bildirim polling; tam akış e2e (ürün→stok→sipariş→sevk→fatura→iade) yeşil.
- **Testler:** Playwright — full-flow.
- **Bağımlılık:** TASK-033,037,031.
- **Doğrulama:** `pnpm --filter @b2b/web test:e2e -- full-flow`.

---

## Bağımlılık Grafiği (özet, revize — P-01/P-03/P-04)
```
001→002,003,004,005,006
004→007; 002,003→007
007,008→009→010→010a            # RBAC sonrası grant ceiling (ADMIN uçları 010a'sız açılmaz)
007,004→010b                     # transactional audit foundation (order/invoice'tan önce)
010→010a→013→011                 # P-03/G-02: grant ceiling + warehouse önce, sonra scope (implicit ADMIN global scope YOK)
010→012,014 ; 012,013,014→015
004,012,013→016→016a→017→018→019 # 016a: ledger idempotency; 019: transfer scope+idempotency
012,014,016→020→020a,020b→021→022→023
010b→(021,022,025a,019,023 audit üretir)
020→025→025a→025b ; 025a,023→025c
004,005→026→026a→026b ; 025a,026a→027
007,026→028→030→030a,030b ; 026a→031(email/notif effect-idempotency)
022,025b→033 ; 019,022,026b→024(reconciliation)
032→audit query (010b writer üstüne)
015,009→034→035→036→037→037a,037b,037c→038
```

## İlk Uygulanacak 10 Görev (öncelik sırası — güvenlik/temel önce)
1. TASK-001 Monorepo iskeleti
2. TASK-002 Config paketi
3. TASK-003 Logger paketi
4. TASK-004 DB şema + çekirdek migration
5. TASK-005 Docker Compose
6. TASK-006 CI hattı (executable checklist + doc link)
7. TASK-007 API iskeleti (RFC7807 + request-id)
8. TASK-008 Domain (Money [ADR-005] + state machine)
9. TASK-009 Authentication
10. TASK-010 RBAC + **TASK-010a Grant Ceiling/Protected Roles** (A-02 BLOCKER — RBAC ile birlikte, ADMIN uçları açılmadan)

> Hemen ardından (kritik altyapı): **TASK-010b** (tx audit), **TASK-016a** (ledger idempotency), **TASK-020a** (order concurrency), **TASK-025a** (invoice series), **TASK-026a/026b** (outbox + effect idempotency).
