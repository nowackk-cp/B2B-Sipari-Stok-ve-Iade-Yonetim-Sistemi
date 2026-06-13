# CLAUDE.md

Bu dosya, bu repoda çalışan Claude/AI ajanları ve geliştiriciler için operasyonel rehberdir. **Tek doğruluk kaynağı** [PROJECT_SPEC.md](PROJECT_SPEC.md) ve `docs/` altıdır; çelişkide onlar kazanır.

## Proje
B2B Operations Suite — ürün, depo, stok, sipariş, iade, fatura yönetimi için kurumsal arka ofis. Modüler monolit. Detay: [PROJECT_SPEC.md](PROJECT_SPEC.md).

## Mutlak Kurallar (ihlal etme)
1. **Frontend DB'ye doğrudan bağlanmaz.** Tüm iş işlemleri `/api/v1` üzerinden. ([ADR-004](docs/decisions/ADR-004-separate-api.md))
2. **Business logic controller veya React component içinde olmaz.** Yalnız `packages/domain` + API service. ([ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md))
3. **Para asla JS `number` ile hesaplanmaz.** `Money` value object (saf bigint minor unit). API'de para `{amount: string, currency}`. ([ADR-005](docs/decisions/ADR-005-money-value-object.md))
4. **Stok/finans işlemleri tek transaction içinde**, kritik satırda `SELECT ... FOR UPDATE`. ([ADR-003](docs/decisions/ADR-003-order-stock-reservation.md))
5. **Append-only tablolar** (stock_ledger, audit_logs, order_status_history, order_price_overrides, payments) **UPDATE/DELETE edilmez** — DB trigger zaten engeller.
6. **orders, invoices, ledger, audit asla silinmez.** Master data soft-delete (`deleted_at`).
7. **UI kısıtlaması güvenlik değildir.** Backend her isteği permission + warehouse scope ile yetkilendirir. Kodda role-name dallanması yasak; permission kullan. ([SECURITY_MODEL.md](docs/architecture/SECURITY_MODEL.md))
8. **Redis stok doğruluğunun kaynağı değildir.** Doğruluk = PostgreSQL.
9. **Background job'lar idempotent.** Kritik POST'lar `Idempotency-Key` (`command_idempotency`); worker yan etkileri `effect_receipts` **state modeli** (PLANNED→SUCCEEDED) + zorunlu `provider_idempotency_key` ile çift **ve** kayıp etkiyi önler (at-least-once queue). Receipt SUCCEEDED olmadan effect tamamlanmış sayılmaz; provider idempotency yoksa exactly-once garanti edilmez (`UNKNOWN`+manuel). ([ADR-008](docs/decisions/ADR-008-outbox-and-idempotency.md))
10. **TypeScript strict.** `any` kaçınılır; sınırda zod/class-validator doğrulama.
11. **Fatura numarası gapless = `invoice_series` kilitli sayaç**, PostgreSQL `sequence` **yasak**. ([ADR-006](docs/decisions/ADR-006-invoice-numbering.md))
12. **Yetki yükseltme yasak.** `SYSTEM_ADMIN` protected sistem rolü; ADMIN protected rol DEĞİLDİR ve **grant ceiling** ile sınırlı (kendi yetkisini yükseltemez, protected rol/permission atayamaz, sahip olmadığını veremez). **Hiçbir rol implicit global warehouse scope vermez — ADMIN dahil.** Depo erişimi yalnız (1) açık `user_warehouse_scopes` veya (2) protected `warehouse:scope:all` (yalnız SYSTEM_ADMIN atar). ([PERMISSION_MATRIX §3/§4](docs/PERMISSION_MATRIX.md), [SECURITY_MODEL §2a/2b/3](docs/architecture/SECURITY_MODEL.md))
13. **Business audit mutasyonla AYNI transaction içinde** (event/outbox **değil**, async consumer **değil**); operational/security log + read-model projeksiyonu tx dışı/async olabilir. ([ADR-007](docs/decisions/ADR-007-audit-in-transaction.md))
14. **Ledger idempotency satır seviyesinde zorunlu** (`stock_ledger.idempotency_key UNIQUE`); rezervasyon `stock_reservations.idempotency_key`. ([ADR-002](docs/decisions/ADR-002-stock-ledger.md))
15. **Durum geçişlerinde order/aggregate row lock + expected-status koşullu update**; kilit sırası order→order_items→stock_balances (`warehouse_id,product_id`).
16. **Fiyat client'tan alınmaz** (server `list_price`); override yalnız `order:price:override` + reason + audit.
17. **Transfer scope:** create/approve/dispatch=source, **receive=destination**, read=source∨dest. Kaynak personeli hedef stoğu doğrudan artıramaz.

## Stok & Sipariş Değişmezleri (özet)
- `available = on_hand − reserved ≥ 0`; `on_hand,reserved ≥ 0` (DB CHECK).
- Sipariş: `DRAFT→APPROVED(rezerve)→PREPARING→SHIPPED(düş)` / `→CANCELLED(serbest)`. SHIPPED iptal edilemez → iade.
- Onayda yetersiz stok → **tam reddi** (all-or-nothing), sipariş DRAFT kalır.
- Detay: [ORDER_RULES.md](docs/business-rules/ORDER_RULES.md), [INVENTORY_RULES.md](docs/business-rules/INVENTORY_RULES.md).

## Repo Yapısı
```
apps/{web,api,worker}   packages/{domain,db,contracts,api-client,config,logger,ui}   docs/
```
- Modül sahipliği ve sınırlar: [MODULE_BOUNDARIES.md](docs/architecture/MODULE_BOUNDARIES.md). Modüller arası yalnız service interface.
- Çağrılan modül servisi `tx`'i parametre alır; **yeni transaction açmaz**.

## Çalıştırma (dev)
```bash
docker compose up -d            # postgres, redis, minio, mailpit
pnpm install
pnpm --filter @b2b/db migrate   # prisma migrate
pnpm dev                        # turbo: api + worker + web
```
Doğrulama: `pnpm lint && pnpm typecheck && pnpm test`. E2E: `pnpm --filter @b2b/web test:e2e`.

## Geliştirme Akışı
- Önce ilgili `docs/` belgesini oku; sonra [IMPLEMENTATION_PLAN.md](docs/tasks/IMPLEMENTATION_PLAN.md)'daki TASK'ı uygula.
- Bir görev = bir PR. Görevin "Kabul kriterleri" + "Testler" karşılanmadan PR açma.
- Kritik iş kuralları için **concurrency testi** zorunlu ([TEST_STRATEGY.md](docs/TEST_STRATEGY.md)).
- API değişince OpenAPI + `packages/api-client` regenerate (drift testte yakalanır).
- Migration: `prisma migrate`; CHECK/trigger/partial-unique elle SQL ([DATABASE_DESIGN.md](docs/architecture/DATABASE_DESIGN.md)).

## Hata & Gözlem
- Hatalar RFC 7807 problem+json + stabil `code` ([ERROR_HANDLING.md](docs/ERROR_HANDLING.md)).
- Pino JSON log, `requestId` korelasyon, secret redaction ([OBSERVABILITY.md](docs/OBSERVABILITY.md)).

## Yapma
- ❌ Controller/component'te iş kuralı, doğrudan SQL/Prisma sızıntısı; ORM entity'yi API'de expose etme.
- ❌ `number` ile para, client'tan `amount/status/warehouse_id/unitPrice`'ye güven.
- ❌ Append-only tabloya UPDATE/DELETE; immutable fatura/sipariş değiştirme.
- ❌ Transaction içinde harici I/O (mail/PDF) — outbox kullan.
- ❌ Business audit'i event/outbox ile yazma (aynı tx olmalı).
- ❌ Fatura numarası için `sequence`; gapless'ı `invoice_series` ile yap.
- ❌ Yetkiyi yalnız UI'da yapma; role-name ile dallanma; ADMIN'e grant ceiling'i atlatma.
- ❌ Ledger/effect idempotency anahtarı olmadan stok/yan-etki yazma.
