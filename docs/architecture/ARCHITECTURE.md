# Architecture

> Üst seviye sistem mimarisi. Detaylı sınırlar için [MODULE_BOUNDARIES.md](MODULE_BOUNDARIES.md), veri için [DATABASE_DESIGN.md](DATABASE_DESIGN.md).

## 1. Sistem Görünümü (C4 — Container)

```
                ┌────────────────────────────────────────────┐
                │                 Browser                    │
                │   apps/web (Next.js App Router, SSR/CSR)   │
                └───────────────┬────────────────────────────┘
                                │ HTTPS  (OpenAPI-generated client)
                                ▼
                ┌────────────────────────────────────────────┐
                │            apps/api (NestJS)               │
                │   REST /api/v1  ·  AuthZ  ·  Swagger       │
                │   Modüler monolit (domain modülleri)       │
                └───┬───────────────┬──────────────┬─────────┘
            Prisma  │        BullMQ │ enqueue      │ S3 SDK
                    ▼               ▼              ▼
            ┌──────────────┐  ┌──────────┐  ┌─────────────┐
            │ PostgreSQL   │  │  Redis   │  │ MinIO / S3  │
            │ (source of   │  │ (queue/  │  │ (files,     │
            │  truth)      │  │  cache)  │  │  pdf, xlsx) │
            └──────▲───────┘  └────┬─────┘  └─────────────┘
                   │               │ consume
                   │          ┌────▼────────────────────────┐
                   │  Prisma  │  apps/worker (NestJS+BullMQ)│
                   └──────────┤  PDF, import, export, email │
                              │  notifications, cleanup     │
                              └──────────────┬──────────────┘
                                             │ SMTP
                                             ▼
                                     ┌──────────────┐
                                     │ Mailpit/SMTP │
                                     └──────────────┘
```

- **Frontend asla DB'ye doğrudan bağlanmaz.** Tüm iş işlemleri API üzerinden geçer.
- **Worker ve API aynı domain/servis katmanını** (`packages/domain`) paylaşır; iş kuralları tek yerde tanımlanır, iki process de aynı koddan yararlanır.
- **PostgreSQL tek doğruluk kaynağıdır.** Redis yalnızca kuyruk ve geçici cache.

## 2. Monorepo Yapısı

```
.
├── apps/
│   ├── web/                 # Next.js
│   ├── api/                 # NestJS REST API
│   └── worker/              # NestJS standalone BullMQ worker
├── packages/
│   ├── domain/              # Saf iş kuralları, value objects (Money), state machines
│   ├── db/                  # Prisma schema, migrations, seed, PrismaClient export
│   ├── contracts/           # OpenAPI tipleri + zod şemaları (paylaşılan DTO)
│   ├── api-client/          # OpenAPI'den üretilen TS client (web tüketir)
│   ├── config/              # env şeması (zod), constants
│   ├── logger/              # Pino wrapper + request context
│   └── ui/                  # (ops.) paylaşılan shadcn bileşenleri
├── docs/
├── docker-compose.yml
├── turbo.json
└── pnpm-workspace.yaml
```

### Katman bağımlılık kuralı
```
web → api-client → contracts
api → domain → db
worker → domain → db
domain → (saf, yalnızca db tipleri + value objects; framework bağımsız)
```
- `domain` NestJS/Next.js'e bağımlı olamaz (saf TypeScript). Test edilebilirliği maksimize eder.
- Business logic **yalnızca** `domain` ve API service katmanında bulunur. Controller ince (thin) kalır: validate → authorize → delegate → serialize.

## 3. API Katman Modeli (NestJS)

Her domain modülü şu katmanlardan oluşur:

```
Controller   → HTTP, DTO validation (zod/class-validator), Swagger decorators
   │           Yetki: @RequirePermission(...) guard
   ▼
Service      → İş akışı orkestrasyonu, transaction sınırı (prisma.$transaction)
   │
   ▼
Domain       → packages/domain: saf kurallar (state machine, Money, hesaplama)
   │
   ▼
Repository   → Prisma erişimi (modül içine kapalı)
```

- **Transaction sınırı service katmanındadır.** Bir use-case = bir `$transaction`. Bkz. [DATABASE_DESIGN.md §Transaction Boundaries](DATABASE_DESIGN.md#9-transaction-sınırları).
- Modüller birbirine **yalnızca service interface** üzerinden bağlanır, repository'leri dışarı sızdırmaz (bkz. [MODULE_BOUNDARIES.md](MODULE_BOUNDARIES.md)).

## 4. Money (Para) Stratejisi {#money}

> Karar gerekçesi: [ADR-005](../decisions/ADR-005-money-value-object.md).

- **Kanonik depolama:** `BIGINT` minor unit (TRY için kuruş) + `currency CHAR(3)`.
- **Hesaplama:** `packages/domain` içinde `Money` value object. Dahili olarak **saf `bigint`** minor unit ile çalışır (float kütüphanesi değil); yuvarlama yalnızca tanımlı noktalarda (örn. satır vergisi) **half-up** kuralıyla yapılır.
- **Asla** `number` ile çarpma/bölme yapılmaz. Yüzde (KDV) hesabı basis-points (`2000 = %20`) ile integer aritmetiği üzerinden.
- API'de para alanları `{ amount: string, currency: string }` (amount = minor unit string) olarak serialize edilir; JSON `number` precision riskinden kaçınmak için **string**.

## 5. Eşzamanlılık (Concurrency) Stratejisi

Çok katmanlı savunma:
1. **Pessimistic lock (birincil):** Stok/finans transaction'ında ilgili `stock_balances` satırı `SELECT ... FOR UPDATE` ile kilitlenir; agregat (order/transfer/invoice/invoice_series) satırı da kilitlenir. Eşzamanlı işlemler serileşir.
2. **Order/aggregate row lock + expected-status koşullu geçiş (A-04):** `UPDATE ... WHERE id=? AND status=?expected`; affected rows = 0 → `409 INVALID_STATE`. Farklı idempotency-key'li paralel state transition'lar çiftlenmez.
3. **Command idempotency (A-04):** kritik POST'larda `command_idempotency` tablosu; replay kayıtlı yanıtı döner.
4. **Satır-seviyesi unique idempotency (A-05):** `stock_ledger.idempotency_key`, `stock_reservations.idempotency_key` — fiziksel hareket/rezervasyon iki kez yazılamaz (son emniyet ağı).
5. **DB CHECK constraint:** `on_hand ≥ 0`, `reserved ≥ 0`, `reserved ≤ on_hand`. Mantık hatası olsa bile DB negatif stoğu reddeder.
6. **Deterministik kilit sırası:** order → order_items → stock_balances (`ORDER BY warehouse_id, product_id`).
- Opsiyonel `version` kolonu optimistic kontrol için (`stock_balances`, `invoice_series`).
- Detay: [ADR-003](../decisions/ADR-003-order-stock-reservation.md).

## 6. Asenkron İş / Outbox (A-08/A-07)

- Para/stok etkileyen senkron işlemler **inline transaction** içinde yapılır (job'a ertelenmez).
- **Business audit** mutasyonla **aynı transaction** içinde yazılır — outbox değil (A-07). Outbox yalnız non-authoritative yan etkiler içindir (e-posta, PDF, export, bildirim).
- Yan etkiler **transactional outbox** ile: ana transaction içinde `outbox_events` satırı (`UNIQUE(deduplication_key)`) yazılır, dispatcher claim/lease (`FOR UPDATE SKIP LOCKED`) ile çeker. "DB commit oldu ama mail gitmedi / mail gitti ama DB rollback oldu" tutarsızlığı önlenir.
- **Queue at-least-once varsayımı (A-08):** worker dış etkiyi ürettikten sonra job yeniden teslim edilebilir. Çift e-posta/PDF/export/bildirim/fatura işlemi olmaması için her yan etki **DB-level idempotency** (`effect_receipts(effect_type, idempotency_key UNIQUE)`) veya **idempotent provider key** ile korunur. Dış çağrıdan **önce** `INSERT ... ON CONFLICT DO NOTHING` ile receipt alınır; conflict → etki zaten yapılmış.
- `job_logs` yalnız **gözlem** içindir, idempotency guard değildir.

## 7. Ortamlar

| Ortam | DB | Storage | Mail | Notlar |
|-------|----|---------|----|--------|
| dev | Postgres (compose) | MinIO | Mailpit | `docker-compose up` |
| ci | Postgres (service) | MinIO/mock | mock | GitHub Actions |
| prod | Managed Postgres | S3-compatible | SMTP/SES | migration gate'li deploy |

## 8. Cross-cutting Concerns

| Concern | Çözüm |
|---------|-------|
| Logging | Pino, JSON, `request_id` correlation (AsyncLocalStorage). Bkz. [OBSERVABILITY.md](../OBSERVABILITY.md). |
| Hata | RFC 7807 problem+json. Bkz. [ERROR_HANDLING.md](../ERROR_HANDLING.md). |
| AuthN/Z | JWT + permission guard + warehouse scope + **grant ceiling/protected roles** (A-02). Bkz. [SECURITY_MODEL.md](SECURITY_MODEL.md). |
| Validation | Sınırda zod/class-validator; domain tekrar doğrular (defense in depth). Para/fiyat/status client'tan kabul edilmez. |
| Config | `packages/config` zod-doğrulanmış env; eksik env'de boot başarısız (fail-fast). |
| Audit | **Business audit mutasyonla aynı DB transaction içinde explicit** (A-07); operational/security log transaction dışında. |
