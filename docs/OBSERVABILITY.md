# Observability

## 1. Logging — Pino (structured JSON)
- Tüm process'ler (api, worker) Pino ile JSON log üretir; tek satır = tek olay.
- Zorunlu alanlar: `time`, `level`, `msg`, `service` (api/worker), `requestId`, `userId?`, `module`, `event`.
- **Correlation:** her HTTP isteğine `requestId` (gelen `X-Request-Id` veya üretilen ULID), `AsyncLocalStorage` ile tüm log/audit'e taşınır. Worker job'larında `jobId` + tetikleyen `requestId` korunur.
- **Redaction (zorunlu):** `authorization`, `password`, `token`, `refreshToken`, `cookie`, kart/banka alanları maskelenir. PII (email/telefon) gerektiğinde maskeli.
- Seviye: `trace/debug` (dev), `info` (iş olayları), `warn` (beklenen hata), `error` (beklenmeyen).
- Log → audit ayrımı (A-07): **business audit** (`audit_logs`) kalıcı/iş-denetim, immutable, **mutasyonla aynı DB transaction**. **operational/security log** (Pino, ops. `security_logs`) teknik/geçici ve **transaction dışında** (başarısız yetki denemesi, başarısız login, rate-limit, başarısız request). İkisi karıştırılmaz.

## 2. İş Olayları (event log)
Önemli iş olayları yapılandırılmış loglanır + (kalıcı gerekiyorsa) audit'e:
`order.approved`, `order.shipped`, `stock.adjusted`, `transfer.dispatched`, `invoice.issued`, `auth.login.failed`, `permission.changed`.

## 3. Metrics
- Uygulama metrikleri (Prometheus formatı, ops.): istek sayısı/süresi (p50/p95/p99), hata oranı, DB pool kullanımı, queue derinliği, job süresi/başarısızlık.
- İş metrikleri: bekleyen sipariş sayısı, düşük stok ürün sayısı, başarısız e-posta sayısı.
- Health uçları: `GET /health/live` (process), `GET /health/ready` (DB+Redis+storage erişimi).

## 4. Tracing (opsiyonel, v1.1)
- OpenTelemetry ile HTTP → service → DB span'leri; `requestId` ↔ trace id bağı. v1'de log korelasyonu yeterli kabul edilir.

## 5. Background Jobs & Queue
- BullMQ job durumları `job_logs`'a kalıcı yazılır (queue, jobId, status, attempts, error, süre). **job_logs yalnız gözlem; idempotency guard değildir.**
- Kuyruk gözlemi: derinlik, gecikme, başarısız job sayısı metrik/alarm.
- Outbox (`outbox_events`) gecikmesi/birikme izlenir; event yalnız ilgili `effect_receipts.status='SUCCEEDED'` sonrası `processed`.
- **Effect receipt durumu (G-17):** `PLANNED/IN_PROGRESS/SUCCEEDED/FAILED/UNKNOWN`. **`UNKNOWN` (provider idempotency yok veya belirsiz sonuç) → kritik alarm + manuel inceleme** (exactly-once garanti edilemeyen durum). Uzun süre `IN_PROGRESS` kalan receipt → stuck-worker alarmı.

## 6. Alarmlar (öneri eşikleri)
| Alarm | Eşik |
|-------|------|
| Stok reconciliation uyumsuzluğu | herhangi bir uyumsuzluk → kritik |
| 5xx oranı | > %1 (5 dk) |
| Job başarısızlık | > %5 veya DLQ büyümesi |
| E-posta outbox FAILED | birikme |
| effect_receipts `UNKNOWN` | herhangi → kritik (manuel inceleme; exactly-once garanti yok) |
| effect_receipts uzun `IN_PROGRESS` | stuck worker eşiği |
| DB CHECK ihlali (stok) | herhangi → kritik (mantık hatası işareti) |
| p95 yazma süresi | > 1s sürekli |

## 7. Denetim İzlenebilirliği
- `requestId` ile: client → API log → audit_logs → (varsa) worker job_logs uçtan uca izlenebilir.
- Audit sorgusu: entity bazlı geçmiş (`entity_type`, `entity_id`) ve actor bazlı (`actor_id`).

## 8. Geliştirme Ortamı
- dev'de Pino pretty (insan-okur) opsiyonel; prod'da ham JSON (log toplayıcıya).
- Mailpit UI ile gönderilen mailler, MinIO console ile dosyalar gözlemlenir.
