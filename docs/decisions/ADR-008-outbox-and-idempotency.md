# ADR-008: Transactional Outbox ve Worker Effect Idempotency

- **Durum:** Kabul edildi
- **Tarih:** 2026-06-13
- **İlgili bulgu:** Codex A-08 [HIGH], T-05, P-05, TST-06

## Bağlam
"`jobId` doğal anahtar" ve "`processed_jobs` kullanılabilir" notları at-least-once queue davranışını kapatmaya yetmiyordu. Job dış yan etkiyi (PDF/email/export/bildirim/fatura işlemi) üretip `COMPLETED` yazılmadan process ölürse BullMQ işi **yeniden teslim eder** ve ikinci çıktı oluşur (A-08).

## Karar
**Transactional outbox + her yan etki için DB-level effect idempotency.** Queue **at-least-once** varsayılır; exactly-once **etki seviyesinde** sağlanır.

### `outbox_events` (domain transaction içinde yazılır)
`id, event_type, aggregate_type, aggregate_id, deduplication_key, payload, status, attempts, available_at, locked_at, processed_at, last_error, created_at`. **`UNIQUE(deduplication_key)`** — aynı domain olayı iki kez yazılamaz.
- Domain değişikliği ile outbox insert **aynı transaction** (commit olmadan event yok; rollback'te event de yok).
- Dispatcher claim/lease: `... WHERE status='PENDING' AND available_at<=now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT N` → eşzamanlı worker'lar aynı satırı işlemez.

### `effect_receipts` (worker yan-etki idempotency'si — **state modeli, G-17 güncellemesi**)
`(effect_type, effect_key) UNIQUE`, **`status effect_status` (PLANNED/IN_PROGRESS/SUCCEEDED/FAILED/UNKNOWN)**, **`provider_idempotency_key` (zorunlu)**, `provider_message_id`, `output_file_id`, `attempts`.

> **Önceki tasarımın açığı (Codex G-17):** "dış çağrıdan önce receipt INSERT ON CONFLICT DO NOTHING, conflict → tekrar yapma" yaklaşımı çift etkiyi engelliyordu ama **receipt insert sonrası, external call öncesi crash olursa etkiyi atlayabiliyordu** (lost effect). Çözüm: receipt'in **status alanı** olur ve **external call yapılmadan önce "başarılı" işaretlenemez**.

Crash-safe akış:
1. External call **öncesi** receipt `PLANNED`/`IN_PROGRESS` (effect_key unique; conflict varsa mevcut kayıt `FOR UPDATE` okunur — `SUCCEEDED` değilse tekrar denenir).
2. Dış çağrı **`provider_idempotency_key`** ile yapılır.
3. Başarı → `SUCCEEDED` (+`provider_message_id`); hata → `FAILED`; belirsiz → `UNKNOWN`.
4. **Outbox event yalnız effect `SUCCEEDED` + DB'ye yazıldıktan sonra `processed` sayılır.**

Crash senaryoları:
- Crash **call öncesi** (`PLANNED`/`IN_PROGRESS`) → retry **aynı effect_key** ile devam, **etki kaybı yok**.
- Crash **call sonrası / DB update öncesi** → retry **aynı `provider_idempotency_key`** ile, sağlayıcı çift etkiyi önler.
- **Provider idempotency yoksa** → exactly-once **garanti edilemez**; status `UNKNOWN` + manuel inceleme. Bu sınır açıkça kabul edilir.

- E-posta/PDF/export/bildirim: `effect_key` + `provider_idempotency_key`. E-posta ayrıca `email_messages.idempotency_key UNIQUE`; bildirim `notifications (user_id, dedup_key) UNIQUE`.

### job_logs
Yalnızca **gözlem** (queue, jobId, status, attempts, süre). **İdempotency guard değildir.**

## Gerekçe
- Outbox, "DB commit oldu ama mesaj gitmedi / mesaj gitti ama DB rollback" ikilemini çözer.
- Effect receipt, at-least-once redelivery sonrası çift dış etkisini DB unique ile kesin engeller — `job_logs`'a güvenmez (o yazılmadan crash olabilir).

## Sonuçlar
- (+) Çift email/PDF/export/bildirim/fatura işlemi imkânsız (DB unique + provider key).
- (+) **Kayıp etki de engellenir** (status modeli: SUCCEEDED olmadan tamamlanmış sayılmaz) — provider idempotency mevcutsa.
- (+) SKIP LOCKED ile yatay ölçeklenen birden çok worker güvenli.
- (−) Her yan etki için deterministik effect_key + provider_idempotency_key gerekir (disiplin).
- (−) Provider idempotency desteklemeyen servislerde exactly-once garanti edilemez → `UNKNOWN` + manuel inceleme.
- **Zorunlu testler (TST-06 + G-17):**
  - crash after effect `PLANNED` before external call → retry succeeds, **no lost effect**.
  - crash after external call before `SUCCEEDED` update → retry uses same provider idempotency key, **no duplicate**.
  - provider without idempotency support → system marks `UNKNOWN`/manual review.
  - outbox `processed` flag only after effect `SUCCEEDED`.
