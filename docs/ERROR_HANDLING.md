# Error Handling

## 1. Hata Gövdesi — RFC 7807 (problem+json)
Tüm API hataları tutarlı şekilde döner:
```json
{
  "type": "https://errors.b2bops.local/insufficient-stock",
  "title": "Insufficient stock",
  "status": 422,
  "code": "INSUFFICIENT_STOCK",
  "detail": "Available 3 < requested 5 for product SKU-001 at warehouse WH-1",
  "instance": "/api/v1/orders/123/approve",
  "requestId": "01J...",
  "errors": [ { "field": "items[0].quantity", "message": "exceeds available" } ]
}
```
- `code`: makine-okur stabil kod (istemci buna göre dallanır; `title` insan-okur).
- `requestId`: log/audit korelasyonu.
- `errors[]`: validation alan-bazlı detayları (opsiyonel).

## 2. Hata Sınıflandırması (NestJS exception → HTTP)
| Domain/uygulama hatası | HTTP | code |
|------------------------|------|------|
| ValidationError | 400 | VALIDATION_ERROR |
| Unauthenticated | 401 | UNAUTHENTICATED |
| ForbiddenPermission / OutOfScope | 403 | FORBIDDEN |
| NotFound | 404 | NOT_FOUND |
| InvalidStateTransition | 409 | INVALID_STATE |
| ConcurrencyConflict (lock/version) | 409 | CONFLICT |
| IdempotencyKeyMismatch | 409 | IDEMPOTENCY_MISMATCH |
| InsufficientStockError | 422 | INSUFFICIENT_STOCK |
| BusinessRuleViolation | 422 | BUSINESS_RULE |
| PriceOverrideForbidden (yetkisiz/eksik reason) | 403 / 422 | PRICE_OVERRIDE_FORBIDDEN |
| GrantCeilingViolation (yetki yükseltme) | 403 | GRANT_CEILING |
| OverpaymentRejected | 422 | OVERPAYMENT |
| DuplicateImportFile | 409 | DUPLICATE_IMPORT |
| RateLimited | 429 | RATE_LIMITED |
| Unexpected | 500 | INTERNAL |

## 3. Katman Sorumlulukları
- **Domain:** anlamlı, tipli hata sınıfları fırlatır (`InsufficientStockError`, `InvalidStateTransition`). HTTP bilmez.
- **Service:** domain hatasını yakalamaz/yutmaz (gerekmedikçe); transaction otomatik rollback.
- **Global exception filter (Nest):** domain/uygulama hatasını RFC 7807'ye map'ler, `requestId` ekler, loglar.
- **Asla** ham hata/stack trace client'a sızdırılmaz (500'de generic mesaj, detay loglarda).

## 4. Transaction & Rollback
- Use-case transaction'ında herhangi bir exception → tam rollback (kısmi yazım yok).
- DB CHECK ihlali (örn. `reserved ≤ on_hand`) → exception → `409 CONFLICT` veya `422` (bağlama göre map).
- `InsufficientStockError` onay akışında transaction'ı patlatır → sipariş DRAFT kalır.

## 5. Idempotency Etkileşimi
- `Idempotency-Key` çakışması (`IN_PROGRESS`) → 409 (retry-after) ya da kayıtlı yanıtı döndür.
- Job retry: hata fırlatılırsa BullMQ yeniden dener (exponential backoff); idempotent tasarım çift yan etkiyi önler.

## 6. Retry & Backoff
- Worker job'ları: max attempts + exponential backoff + jitter. Kalıcı hata → `FAILED`/`DEAD` (DLQ), `job_logs`'a error, alarm.
- **Outbox dispatcher (A-08):** `outbox_events` claim/lease (`FOR UPDATE SKIP LOCKED`); `attempts++`, `available_at` ile backoff; max sonrası `DEAD`. Queue **at-least-once** → worker yan etkiyi `effect_receipts` **state modeli** ile korur (G-17):
  - Dış çağrıdan **önce** receipt `PLANNED`/`IN_PROGRESS` (effect_key unique). Dış çağrı `provider_idempotency_key` ile. Başarı → `SUCCEEDED`; hata → `FAILED`; belirsiz → `UNKNOWN`.
  - **Receipt SUCCEEDED olmadan effect tamamlanmış sayılmaz** → hem çift hem **kayıp** etki engellenir. Outbox event yalnız effect `SUCCEEDED` sonrası `processed`.
  - Crash call-öncesi → retry aynı effect_key; crash call-sonrası/DB-öncesi → retry aynı provider key.
  - **Provider idempotency yoksa** exactly-once yok → `UNKNOWN` + **manuel inceleme alarmı**.
- E-posta: `email_messages.idempotency_key` unique; max sonrası `FAILED` + bildirim.

## 7. Kullanıcıya Mesaj
- UI `code`'a göre yerelleştirilmiş (TR) mesaj gösterir; `requestId` destek için görünür.
- Validation hataları alan altında gösterilir (`errors[].field`).

## 8. Loglama
- 4xx (beklenen iş hataları): `warn` seviyesinde, PII'siz.
- 5xx (beklenmeyen): `error` + stack + requestId; alarm.
- Güvenlik olayları (403 tekrarları, login fail) ayrıca audit.
