# API Conventions

## 1. Versiyon & Taban
- Tüm uçlar `/api/v1` altında. Kırıcı değişiklik → `/api/v2` (paralel yaşar).
- OpenAPI 3.1 Swagger'dan üretilir; `apps/web` client'ı bu spec'ten generate edilir (`packages/api-client`). Elle client yazılmaz.

## 2. Kaynak Adlandırma
- Çoğul, kebab/snake yok → kebab-case path: `/api/v1/stock-transfers`.
- Hiyerarşi: `/api/v1/orders/{orderId}/items`.
- Aksiyon (durum geçişi) RESTful alt-kaynak/POST: `POST /api/v1/orders/{id}/approve`, `/ship`, `/cancel`. (CRUD'a sığmayan iş aksiyonları için açık fiil.)

## 3. HTTP Metotları & Durum Kodları
| Metot | Kullanım | Başarı |
|-------|----------|--------|
| GET | okuma, liste/tekil | 200 |
| POST | oluşturma / aksiyon | 201 (oluşturma) / 200 (aksiyon) |
| PATCH | kısmi güncelleme | 200 |
| PUT | tam değiştirme (nadir) | 200 |
| DELETE | soft delete | 204 |

Hata: `400` (validation), `401` (authn yok), `403` (yetki/scope), `404`, `409` (çakışma/state/concurrency), `422` (iş kuralı ihlali), `429` (rate limit), `500`. Hata gövdesi RFC 7807 — bkz. [ERROR_HANDLING.md](ERROR_HANDLING.md).

## 4. Pagination, Sıralama, Filtreleme
- Liste uçları **zorunlu** sayfalı. Cursor tabanlı tercih: `?limit=20&cursor=<opaque>`. (Basit listelerde `?page=&pageSize=` desteklenebilir.)
- `limit` default 20, max 100.
- Yanıt zarfı:
```json
{ "data": [ ... ], "pageInfo": { "nextCursor": "abc", "hasNextPage": true } }
```
- Sıralama: `?sort=createdAt:desc`. Filtre: alan-bazlı query param whitelisted (`?status=APPROVED`).

## 5. İstek/Yanıt Gövdesi
- JSON, camelCase alan adları (DB snake_case → API camelCase mapping).
- **Para alanları:** `{ "amount": "12345", "currency": "TRY" }` — `amount` minor unit **string** (precision güvenliği).
- Tarihler ISO 8601 UTC (`2026-06-13T10:00:00Z`).
- ID'ler string (büyük bigint JSON precision riski → string serialize).
- Enum'lar UPPER_SNAKE string.

## 6. İdempotency
- Para/stok etkileyen POST'lar (`order approve/ship/cancel`, `invoice issue`, `payment record`, `transfer dispatch/receive`, `return receive`) `Idempotency-Key` header destekler.
- Aynı key + aynı gövde → ilk yanıt tekrar döner (yan etki bir kez). Sunucu 24h saklar (`command_idempotency` tablosu; `command_type`+`aggregate_id`+`key`).
- Farklı gövde + aynı key → `409 IDEMPOTENCY_MISMATCH`.
- **Not (A-04):** idempotency-key yalnız aynı client retry'ını kapsar. Farklı key ile gelen paralel state transition'a karşı asıl koruma **order/aggregate row lock + expected-status koşullu geçiş**tir (bkz. [ORDER_RULES §1a](business-rules/ORDER_RULES.md), [DATABASE_DESIGN §19](architecture/DATABASE_DESIGN.md)).

## 7. Validation
- Sınırda zod/class-validator: tip, zorunluluk, aralık, whitelist (bilinmeyen alan reddedilir — strict).
- **Mass-assignment koruması:** `id`, `status`, `*_amount` (toplamlar), `unitPrice` (yetkili override hariç), `warehouseId` (server bağlamından), `createdAt` client'tan kabul edilmez; server üretir/hesaplar.
- **Fiyat (A-06/T-07):** kalem fiyatı server `products.list_price`'tan okunur. `unitPrice` yalnız `order:price:override` permission'lı **explicit override DTO** ile (zorunlu `reason`) kabul edilir; aksi halde reddedilir/yok sayılır. Totals her zaman server'da yeniden hesaplanır.

## 7a. Public DTO / Contract Sınırları (A-12)
- **ORM entity expose edilmez.** Response DTO'ları Prisma modellerinden türetilmez; ayrı `packages/contracts` view-model'leri kullanılır.
- **Internal alan whitelist:** `deletedAt`, `version`, ham `reserved`/`on_hand` internal sayaçları, `password_hash`/token hash, `job_logs.error`/stack trace, `idempotency_key`, `locked_at` gibi alanlar public contract'a **çıkmaz**.
- **Command DTO ≠ Read DTO:** yazma (command) ve okuma (view) modelleri ayrı; OpenAPI yalnızca **public** contract'tır.
- CI: OpenAPI snapshot lint — snake_case, internal alanlar, secret/hash, stack trace spec'e sızarsa fail (bkz. [TEST_STRATEGY.md](TEST_STRATEGY.md)).

## 7b. Kaynak Kimliği (Public ID, T-10)
- Public API'de tekil kaynak kimliği **ULID/UUID** (`publicId`) kullanılır; sıralı `BIGINT` PK dışarı sızdırılmaz (IDOR yüzeyini küçültür).
- Her tekil/mutating uçta **object-level authorization** (scope/sahiplik) zorunlu; kapsam dışı id → policy gereği `404` (varlık gizleme) veya `403`. Route-coverage testi ile garanti.

## 8. AuthN/AuthZ
- `Authorization: Bearer <access JWT>` (veya web cookie akışı).
- Her korunan uçta permission guard; depoya bağlı uçlarda scope filtresi (bkz. [PERMISSION_MATRIX.md](PERMISSION_MATRIX.md)).

## 9. Correlation
- İstemci `X-Request-Id` gönderebilir; yoksa sunucu üretir. Yanıtta `X-Request-Id` döner; loglar ve audit ile eşleşir.

## 10. Versiyonlama & Deprecation
- Alan ekleme geriye uyumlu (kırıcı değil). Alan kaldırma/anlam değişimi → yeni sürüm.
- Deprecate edilen uç `Deprecation` + `Sunset` header taşır.

## 11. Swagger
- Her DTO ve uç decorate edilir (örnekler dahil). `GET /api/docs` (prod'da yetki arkasında).
- CI, OpenAPI spec'i üretip `packages/api-client`'ı regenerate eder; drift testte yakalanır.

## 12. Örnek Uçlar (özet)
```
POST   /api/v1/auth/login
POST   /api/v1/auth/refresh
POST   /api/v1/auth/logout
GET    /api/v1/products?limit=20&cursor=...
POST   /api/v1/orders
POST   /api/v1/orders/{id}/approve        (Idempotency-Key)
POST   /api/v1/orders/{id}/ship           (Idempotency-Key)
POST   /api/v1/orders/{id}/cancel
GET    /api/v1/stock/balances?warehouseId=...
POST   /api/v1/stock/adjustments          (stock:adjust)
POST   /api/v1/stock-transfers/{id}/dispatch
POST   /api/v1/returns/{id}/receive
POST   /api/v1/invoices/{id}/issue        (Idempotency-Key)
POST   /api/v1/exports                     (async → job)
```
