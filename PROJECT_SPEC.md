# B2B Operations Suite — Project Specification

> **Status:** Draft v1.0 · **Owner:** Lead Software Architect · **Last updated:** 2026-06-13
> Bu belge tek doğruluk kaynağıdır (single source of truth). Çelişki durumunda kod değil bu belge ve `docs/decisions/` altındaki ADR'ler esas alınır.

---

## 1. Amaç ve Kapsam

B2B Operations Suite; ürün, depo, stok, müşteri, sipariş, iade, fatura ve personel işlemlerinin **tek panelden** yönetildiği kurumsal bir arka ofis (back-office) uygulamasıdır. Hedef kullanıcı, birden fazla deposu olan, B2B satış yapan orta ölçekli bir ticaret/dağıtım şirketidir.

Sistem; **stok doğruluğu, finansal bütünlük ve denetlenebilirlik (auditability)** kavramlarını birinci sınıf gereksinim olarak ele alır. Stok ve para asla "yaklaşık" olamaz.

### 1.1 Kapsam Dahili (In Scope)
1. Identity ve authentication
2. RBAC + permission tabanlı yetkilendirme
3. Kullanıcı ve depo kapsamı (warehouse scoping)
4. Ürün ve kategoriler
5. Depolar
6. Stok bakiyesi ve append-only stok hareketleri (ledger)
7. Depolar arası transfer
8. Müşteriler ve adresler
9. Siparişler ve sipariş kalemleri
10. Sipariş durum makinesi (state machine)
11. Stok rezervasyonu
12. İadeler
13. Faturalar ve teklifler
14. PDF oluşturma
15. Dosya yönetimi (S3/MinIO)
16. Excel import
17. Excel + CSV export
18. Bildirimler (in-app)
19. E-posta (transactional)
20. Audit log (append-only)
21. Dashboard
22. Sistem ve background job logları

### 1.2 Kapsam Harici (Out of Scope — v1)
- Muhasebe entegrasyonu (e-Fatura/GİB entegrasyonu, defter tutma)
- Ödeme tahsilatı/POS entegrasyonu (sadece fatura kaydı tutulur, tahsilat manuel işaretlenir)
- Çoklu para birimi dönüşümü (FX rate). Para birimi alanı modellenir ama dönüşüm yapılmaz; v1 tek para birimi (TRY) varsayar.
- Üretim/montaj (BOM), seri/lot takibi, raf (bin) seviyesi konum yönetimi
- Müşteriye dönük (storefront) e-ticaret arayüzü
- Mobil uygulama
- Gerçek zamanlı WebSocket push (bildirimler v1'de polling ile çekilir)

---

## 2. Aktörler ve Roller

| Rol | Açıklama |
|-----|----------|
| **SYSTEM_ADMIN** | Korumalı sistem rolü. Sistem geneli tam yetki, protected rol/permission yönetimi. Global depo erişimi **seed'lenmiş protected `warehouse:scope:all` permission'ı ile** (rol bypass'ı değil). UI'dan silinemez/değiştirilemez. (Yetki yükseltme koruması: [SECURITY_MODEL §2a](docs/architecture/SECURITY_MODEL.md)) |
| **ADMIN** | İş yönetimi yetkisi, normal kullanıcı/rol işlemleri. **Sistem korumalı rol DEĞİLDİR.** **Grant ceiling** ile sınırlı: kendi yetkisini yükseltemez, protected permission/rol atayamaz, SYSTEM_ADMIN'i değiştiremez. **Implicit global warehouse scope YOK** — yalnız açık `user_warehouse_scopes` ve sahip olduğu non-protected permission'lar içinde çalışır; `warehouse:scope:all`'ı kendine/başkasına atayamaz. |
| **WAREHOUSE_MANAGER** | Kapsamındaki depolarda stok, transfer, sipariş hazırlama. |
| **SALES** | Sipariş/teklif/müşteri oluşturma ve onaylama, fatura kesme. |
| **FINANCE** | Fatura, teklif, ödeme, finansal raporlar. |
| **VIEWER** | Salt-okunur raporlama/dashboard erişimi. |

> Roller sabit değildir; SYSTEM_ADMIN yeni rol tanımlayıp permission atayabilir (grant ceiling dahilinde ADMIN de kısıtlı olarak). Yukarıdakiler **seed (sistem)** rolleridir; `SYSTEM_ADMIN` protected'tır. Detaylı yetki eşlemesi ve grant ceiling için bkz. [PERMISSION_MATRIX.md](docs/PERMISSION_MATRIX.md).

---

## 3. Temel İş Kuralları (Özet)

> Detaylar `docs/business-rules/` altındadır. Burada yalnızca üst seviye değişmezler (invariants) listelenir.

### 3.1 Stok Değişmezleri (Invariants)
- **INV-1:** `available = on_hand − reserved` ve her zaman `available ≥ 0`.
- **INV-2:** `on_hand ≥ 0` ve `reserved ≥ 0` (veritabanı CHECK constraint ile garanti).
- **INV-3:** Tüm fiziksel stok değişimleri append-only `stock_ledger` tablosuna yazılır; ledger asla güncellenmez/silinmez.
- **INV-4:** Stok bakiyesi `stock_balances` tablosunda tutulur ve ledger'ın türevidir (her zaman yeniden hesaplanabilir olmalıdır).
- **INV-5:** Redis hiçbir zaman stok doğruluğunun ana kaynağı değildir; yalnızca cache/kuyruk amaçlıdır. Doğruluk kaynağı PostgreSQL'dir.

### 3.2 Sipariş Durum Makinesi
Durumlar: `DRAFT → APPROVED → PREPARING → SHIPPED` ve herhangi bir noktadan (SHIPPED hariç) `CANCELLED`.

| Geçiş | Stok Etkisi |
|-------|-------------|
| `* → DRAFT` (oluşturma) | Stok etkilenmez. |
| `DRAFT → APPROVED` | Stok **rezerve** edilir (`reserved += qty`). Yetersiz `available` varsa geçiş **tamamen reddedilir** (atomik, kısmi rezervasyon yok). |
| `APPROVED → PREPARING` | Rezervasyon korunur. |
| `PREPARING → SHIPPED` | `on_hand −= qty` ve `reserved −= qty` **birlikte**; ledger'a `SHIPMENT` yazılır. |
| `APPROVED → CANCELLED` veya `PREPARING → CANCELLED` | Rezervasyon serbest bırakılır (`reserved −= qty`). |
| `SHIPPED → CANCELLED` | **Yasak.** İade süreci kullanılır. |
| `DRAFT → CANCELLED` | İzinli, stok etkisi yok. |

- **ORD-INV-1:** Aynı `(product, warehouse)` için eşzamanlı onaylarda stok asla negatife düşmez (bkz. [ADR-003](docs/decisions/ADR-003-order-stock-reservation.md), concurrency stratejisi).

### 3.3 Finansal Değişmezler
- **FIN-1:** Para asla JavaScript `number` ile hesaplanmaz. Kanonik gösterim **tam sayı minor unit (bigint, kuruş)** + ISO 4217 currency code. Bkz. [ADR-005](docs/decisions/ADR-005-money-value-object.md), [ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md#money).
- **FIN-2:** Issued (kesilmiş) fatura ve audit kayıtları immutable'dır; silinmez, değiştirilmez. Düzeltme yeni belge (credit note/void) ile yapılır.
- **FIN-3:** Fatura numarası **boşluksuz (gapless)**, transaction içinde kilitlenen `invoice_series` sayaç tablosu ile üretilir; PostgreSQL `sequence` **kullanılmaz** (rollback boşluk bırakır). Bkz. [ADR-006](docs/decisions/ADR-006-invoice-numbering.md).
- **FIN-4:** Kalem fiyatı **asla client'tan** alınmaz; server `products.list_price`'tan okur. İndirim yalnızca `order:price:override` permission'ı + zorunlu reason + business audit ile.

### 3.4 Denetim ve Silme
- **AUD-1:** `orders`, `stock_ledger`, `invoices`, `audit_logs`, `order_status_history` kayıtları **asla silinmez** (hard delete yok, soft delete yok — gerçekten kalıcı).
- **AUD-2:** Diğer master-data tabloları (products, customers, warehouses…) **soft delete** (`deleted_at`) kullanır; geçmiş referansların bütünlüğü korunur.
- **AUD-3:** Tüm mutasyon işlemleri `audit_logs`'a actor + before/after + request_id ile yazılır.

---

## 4. Fonksiyonel Olmayan Gereksinimler (NFR)

| Kategori | Gereksinim |
|----------|------------|
| **Güvenlik** | UI kısıtlamaları güvenlik sayılmaz. Backend her isteği bağımsız yetkilendirir (permission + warehouse scope). JWT access + rotating refresh token. Parolalar argon2id. |
| **Tutarlılık** | Stok ve finans işlemleri tek DB transaction içinde. Kritik satırlarda row-level lock. |
| **İdempotentlik** | Tüm background job'lar ve para/stok etkileyen kritik POST uçları idempotency key destekler. |
| **Performans** | p95 API yanıtı < 300ms (okuma), < 800ms (yazma) tipik yükte. Liste uçları cursor/offset paginate edilir (default 20, max 100). |
| **Gözlemlenebilirlik** | Pino structured JSON log, her isteğe `request_id` (correlation id). Job ve email outbox durumları kalıcı. |
| **Test** | Vitest (unit + integration), Playwright (e2e). Kritik iş kuralları için concurrency testleri zorunlu. Bkz. [TEST_STRATEGY.md](docs/TEST_STRATEGY.md). |
| **TypeScript** | `strict: true`, `noUncheckedIndexedAccess: true`. Business logic controller/React component içinde olmaz. |
| **API** | REST, `/api/v1` altında versiyonlu. OpenAPI/Swagger üretilir; frontend client OpenAPI'den generate edilir. |
| **Erişilebilirlik** | WCAG 2.1 AA hedeflenir (shadcn/ui temelli). |

---

## 5. Teknoloji Yığını

| Katman | Teknoloji |
|--------|-----------|
| Monorepo | pnpm workspace + Turborepo |
| Web | Next.js (App Router), TypeScript, Tailwind, shadcn/ui |
| API | NestJS REST (`/api/v1`) |
| Worker | NestJS standalone + BullMQ |
| DB | PostgreSQL 16 |
| ORM | Prisma |
| Cache/Queue | Redis 7 + BullMQ |
| Object storage | MinIO (dev) / S3-compatible (prod) |
| Mail | Mailpit (dev) / SMTP veya SES (prod) |
| API docs | Swagger / OpenAPI |
| Test | Vitest, Playwright |
| Infra | Docker Compose (dev), GitHub Actions (CI) |
| Logging | Pino |

---

## 6. Belirlenen Eksik/Çelişkili Gereksinimler ve Varsayımlar

> "Mantıklı varsayımları kendin yap" talimatı gereği aşağıdaki boşluklar varsayımlarla kapatılmıştır. Her biri ileride iş sahibi tarafından doğrulanmalıdır.

| # | Boşluk / Belirsizlik | Varsayım (v1) |
|---|----------------------|---------------|
| A1 | Sipariş hangi depodan karşılanır? | Sipariş **order seviyesinde tek kaynak depoya** bağlanır (`orders.warehouse_id`). Çok depolu fulfilment v2. |
| A2 | Para birimi / çoklu currency | Tek para birimi **TRY**. `currency` alanı modellenir, FX dönüşümü yok. |
| A3 | Vergi/KDV | Kalem bazında `tax_rate` (yüzde, basis points olarak `2000` = %20). KDV dahil/hariç: fiyatlar **KDV hariç** girilir, vergi ayrı hesaplanır. |
| A4 | Para gösterimi | Kanonik: **bigint minor unit (kuruş)**. JS tarafında `Money` value object (saf bigint aritmetiği; bkz. [ADR-005](docs/decisions/ADR-005-money-value-object.md)). DB'de `BIGINT`. |
| A5 | `DELIVERED`/`COMPLETED` sipariş durumu yok mu? | Durum makinesi verilen 5 durumla sınırlı. SHIPPED terminal başarı durumudur; teslim takibi v1 dışı. |
| A6 | İade stoğu geri eklenir mi? | Evet. İade `RECEIVED` ve `resellable` ise `RETURN_IN` ledger kaydı + `on_hand += qty`. Hasarlı iade stoğa girmez. |
| A7 | Rezervasyon ledger'a yazılır mı? | Hayır. Rezervasyon fiziksel hareket değildir; `stock_reservations` + `stock_balances.reserved` ile izlenir. Ledger yalnızca `on_hand` değişimlerini tutar. |
| A8 | Transfer in-transit durumu | Transfer iki adımlıdır: `TRANSFER_OUT` (kaynak `on_hand−`) → in-transit → `TRANSFER_IN` (hedef `on_hand+`). |
| A9 | Teklif → Sipariş/Fatura akışı | Teklif (quote) bağımsız belgedir; kabul edilince sipariş/fatura **kopyalama** ile oluşturulur (otomatik bağ opsiyonel). |
| A10 | Kullanıcı–depo kapsamı zorunlu mu? | `user_warehouse_scopes` boşsa kullanıcı **hiçbir** depoya erişemez (ADMIN dahil; rol-temelli `*` bypass yok). Global kapsam (`*`) yalnız `warehouse:scope:all` (protected) ile gelir; seed'de yalnız SYSTEM_ADMIN'dedir. SYSTEM_ADMIN bu protected permission'ı bir ADMIN'e açıkça atayabilir. |
| A11 | Soft delete kapsamı | Master data soft-delete; transactional/ledger/audit asla silinmez (bkz. §3.4). |
| A12 | Bildirim teslimi | v1 in-app + e-posta. Realtime push yok, frontend polling (30sn). |
| A13 | Idempotency anahtarı | İstemci `Idempotency-Key` header'ı gönderir; sunucu 24 saat saklar. Job'larda `jobId` doğal idempotency anahtarıdır. |
| A14 | Fiyat kaynağı | `products.list_price` server tarafından okunur; client fiyat/totals göndremez (reddedilir). Override yalnız `order:price:override` permission + reason + audit ile; kalem `unit_price`/`list_price` snapshot saklanır, override `order_price_overrides`'a yazılır. (A-06) |
| A15 | Fatura numarası | Boşluksuz (gapless), `invoice_series` kilitli sayaç ile; sequence yok. ISSUED anında atanır. (A-01, [ADR-006](docs/decisions/ADR-006-invoice-numbering.md)) |
| A16 | Yetki tavanı | ADMIN grant ceiling ile sınırlı; protected rol/permission yalnız SYSTEM_ADMIN; self-escalation yasak. (A-02) |
| A17 | Excel import | Staging tablosu + dosya checksum + satır-seviyesi idempotency + durum makinesi; aynı dosya tekrar/worker crash deterministik. (A-09) |
| A18 | Worker yan etkileri | Queue at-least-once; her yan etki için effect receipt / idempotent provider key; çift e-posta/PDF/export/bildirim yok. (A-08) |

---

## 7. İlgili Belgeler

- Mimari: [ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md), [MODULE_BOUNDARIES.md](docs/architecture/MODULE_BOUNDARIES.md), [DATABASE_DESIGN.md](docs/architecture/DATABASE_DESIGN.md), [SECURITY_MODEL.md](docs/architecture/SECURITY_MODEL.md)
- İş kuralları: [ORDER_RULES.md](docs/business-rules/ORDER_RULES.md), [INVENTORY_RULES.md](docs/business-rules/INVENTORY_RULES.md), [RETURN_RULES.md](docs/business-rules/RETURN_RULES.md), [INVOICE_RULES.md](docs/business-rules/INVOICE_RULES.md)
- Konvansiyonlar: [API_CONVENTIONS.md](docs/API_CONVENTIONS.md), [ERROR_HANDLING.md](docs/ERROR_HANDLING.md), [OBSERVABILITY.md](docs/OBSERVABILITY.md), [PERMISSION_MATRIX.md](docs/PERMISSION_MATRIX.md), [TEST_STRATEGY.md](docs/TEST_STRATEGY.md)
- Kararlar: [docs/decisions/](docs/decisions/)
- Plan: [IMPLEMENTATION_PLAN.md](docs/tasks/IMPLEMENTATION_PLAN.md)
