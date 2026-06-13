# Test Strategy

> Test piramidi: çok sayıda hızlı unit, yeterli integration, az ama kritik e2e. Stok/finans değişmezleri için **concurrency testleri zorunludur**.

## 1. Katmanlar ve Araçlar
| Seviye | Araç | Kapsam |
|--------|------|--------|
| Unit | Vitest | `packages/domain` saf kurallar: state machine, Money, hesaplamalar. DB/IO yok, hızlı. |
| Integration | Vitest + gerçek Postgres (Testcontainers/compose) | Service + repository + transaction + constraint davranışı. Redis gerektiğinde gerçek. |
| Contract | Vitest + OpenAPI | Controller ↔ DTO ↔ OpenAPI spec drift kontrolü; generated client tipleri. |
| E2E | Playwright | Web → API → DB kritik kullanıcı akışları. |
| Load/Concurrency | Vitest (paralel) / k6 (ops.) | Eşzamanlı onay, deadlock, lock davranışı. |

## 2. Domain Unit Testleri (zorunlu)
- **Order state machine:** tüm izinli/izinsiz geçişler (whitelist tablosu birebir).
- **Money:** çarpma, vergi yuvarlama (half-up), toplama; number'a düşmeme; precision.
- **Reservation hesabı:** available = on_hand − reserved; sınır durumlar.

## 3. Integration Testleri (zorunlu senaryolar)
- Onay → rezervasyon: available düşer, reserved artar, ledger **yazılmaz**.
- Yetersiz stok → onay reddi, sipariş DRAFT, hiçbir kalem rezerve değil (all-or-nothing rollback).
- Sevk → on_hand & reserved birlikte azalır, ledger SHIPMENT, reservation CONSUMED.
- İptal → rezervasyon RELEASED, reserved geri.
- SHIPPED iptal → reddedilir.
- Transfer out/in → on_hand korunur, iki ledger kaydı.
- İade RECEIVED → resellable on_hand+, RETURN_IN; damaged etkisiz.
- Fatura issue → invoice_no atanır, immutable; tekrar düzenleme reddedilir.
- Append-only trigger: ledger/audit UPDATE/DELETE → DB exception.
- Soft delete: silinmiş ürün listede yok, unique partial doğru çalışır.

## 4. Concurrency Testleri {#concurrency}
**Zorunlu:** `available = N` olan stokta `N+K` paralel onay başlat (Promise.all, ayrı bağlantılar):
- Tam `N` adet başarı, `K` adet `InsufficientStockError`.
- Son durum: `reserved ≤ on_hand`, `available ≥ 0`, asla negatif.
- Çift `Idempotency-Key` ile gönderilen onay tek rezervasyon üretir.
- Deadlock olmamalı (deterministik kilit sırası doğrulaması — çok kalemli paralel onaylar).

### 4a. Order command concurrency (TST-03/A-04) — **zorunlu**
- Aynı DRAFT siparişe **iki paralel approve, farklı idempotency-key** → tek transition, tek reservation seti, tek `order_status_history`, tek audit; diğer istek `409 INVALID_STATE`.
- Aynı PREPARING siparişe **iki paralel ship** → kalem başına tek SHIPMENT ledger, tek consumed reservation.
- Paralel approve + cancel yarışı → tutarlı tek sonuç (ya approved ya cancelled, karışım yok).
- Order/aggregate row lock + expected-status koşullu update affected-rows kontrolü kanıtlanır.

### 4b. Ledger/effect idempotency replay (TST-06/A-05/A-08) — **zorunlu**
- Çok kalemli shipment başarılı; **aynı shipment tekrar** → ledger satır sayısı ve on_hand değişmez (`idempotency_key` unique).
- Transfer dispatch/receive retry → kalem başına tek ledger.

### 4c. Effect receipt crash-state (G-17 — zorunlu)
- **crash after effect PLANNED before external call** → retry **aynı effect_key** ile devam eder; effect tam 1, **kayıp yok**.
- **crash after external call before SUCCEEDED update** → retry **aynı provider_idempotency_key** ile; final email/PDF/export/bildirim **tam 1**, **çift yok**.
- **provider without idempotency support** → sistem effect'i `UNKNOWN` işaretler + manuel-inceleme alarmı (exactly-once garanti edilmez).
- **outbox `processed` flag yalnız effect `SUCCEEDED` sonrası** set edilir; `PLANNED`/`IN_PROGRESS`/`UNKNOWN` kaldıkça event processed sayılmaz.
- `job_logs.attempts` artabilir ama business effect tek kalır.

## 5. İdempotency & Job Testleri
- Aynı `jobId` ile iki kez çalışan worker job tek yan etki üretir (örn. tek e-posta, tek ledger).
- Outbox: transaction rollback olursa e-posta satırı da yazılmaz; commit olursa tam bir kez gönderilir.

## 6. API/Contract
- Her uç için authz testi: permission yok → 403; scope dışı depo → 403.
- OpenAPI spec ↔ generated client drift: CI'da regenerate + diff = 0.
- Validation: bilinmeyen alan reddi, mass-assignment (`amount`/`status` client'tan yok sayılır).

## 7. E2E (Playwright) — kritik akışlar
1. Login → dashboard.
2. Ürün + stok girişi → sipariş oluştur → onayla (stok düşer) → hazırla → sevk et.
3. Yetersiz stokta onay hatası UI'da.
4. İade aç → kabul et → stok geri.
5. Fatura kes → PDF indir.
6. Yetkisiz kullanıcı korumalı sayfa/aksiyona erişemez.

## 8. Test Verisi & İzolasyon
- Her integration test kendi transaction'ında veya temiz şema (truncate) ile çalışır; testler birbirinden bağımsız.
- Testcontainers ile gerçek Postgres (CHECK/trigger/lock davranışı mock'lanamaz — gerçek DB şart).
- Factory/fixtures `packages/db/testing`.

## 9. Kapsam Hedefleri
- `packages/domain`: satır + dal kapsamı ≥ %90 (kritik kurallar %100).
- Service katmanı kritik akışlar: %100 senaryo kapsamı (yukarıdaki listeler).
- CI'da coverage raporu; düşüş PR'ı bloklar.

## 10. CI Entegrasyonu (GitHub Actions)
- `lint → typecheck → unit → integration (Postgres/Redis/MinIO/Mailpit service) → build → e2e (smoke)`.
- Migration kontrolü: `prisma migrate diff` drift = 0.
- Concurrency testleri integration job'ında zorunlu (flaky olmamalı → deterministik).
- **CI gerçek-servis smoke (TST-13):** migrate + Postgres/Redis/MinIO/Mailpit connectivity + worker smoke + Playwright smoke + OpenAPI drift adımları **aynı workflow'da** geçer; explicit service container, env, health-wait script.
- **Doc/link check (TST-14/A-14):** tüm relative markdown linkleri ve ADR referansları doğrulanır; kırık link/anchor/eksik ADR → fail.

## 11. Codex Remediation — Negatif/Güvenlik/Dayanıklılık Testleri (zorunlu)

### 11.1 Yetki & RBAC (TST-01/TST-02 — CRITICAL)
- **Privilege ceiling:** ADMIN'in (a) privileged/protected permission içeren rol oluşturması, (b) mevcut rolüne protected permission eklemesi, (c) kendisine rol/permission ataması, (d) başkasına `warehouse:scope:all` vermesi, (e) SYSTEM_ADMIN rolünü atama/değiştirme/silme → **403**. SYSTEM_ADMIN aynılarını yapabilir → **başarılı + business audit**.
- **Cannot-grant-above-self:** aktör sahip olmadığı permission'ı atayamaz → 403.
- **ADMIN implicit global warehouse scope YOK (gate G-02/G-03 — zorunlu):**
  - `ADMIN warehouse:scope:all atamaya çalışır` → **403** (protected, yalnız SYSTEM_ADMIN).
  - `ADMIN SYSTEM_ADMIN rolünü atamaya çalışır` → **403**.
  - `ADMIN sahip olmadığı permission'ı role eklemeye çalışır` → **403**.
  - `ADMIN açık warehouse scope'u olmayan deponun stokunu değiştirmeye çalışır` → **403**, hiçbir ledger/balance değişimi yok.
  - `warehouse:scope:all olmayan ADMIN tüm-depo raporunu çekmeye çalışır` → **403** / yalnız açık kapsamı döner.
  - `ADMIN, boş user_warehouse_scopes ile herhangi bir depoya erişmeye çalışır` → **403** (rol-temelli `*` bypass yok — G-04 ek testi).
  - `SYSTEM_ADMIN warehouse:scope:all atar` → **200 + business audit (aynı tx, actor snapshot)**.
- **Route ↔ permission matrix drift (TST-02):** route metadata extraction; her mutating route'ta `@RequirePermission` **zorunlu** (eksikse CI fail). Her action için: permission yok / yanlış permission / scope dışı / stale JWT → 403 (UI'da buton gizli olsa da).

### 11.2 Transfer scope (TST-04/A-03)
- source-only / dest-only / both / none scope kombinasyonları için create/approve/dispatch/receive/read/list beklenen 403/200.
- A deposu kullanıcısı B'ye create/dispatch/**receive** → 403, hiçbir ledger/balance değişimi yok. Liste out-of-scope transfer sızdırmaz.

### 11.3 Invoice gapless numbering (TST-07/A-01)
- Numara ayrıldıktan sonra **kontrollü exception** → rollback; bir sonraki başarılı issue **boşluksuz** ardışık numarayı alır (gap yok).
- Paralel issue → benzersiz/monoton; aynı faturayı tekrar issue → ikinci numara üretmez (idempotent).
- `UNIQUE(company_id, series_id, fiscal_year, invoice_number)` ihlali testi.

### 11.4 Price tampering & override (TST-08/A-06)
- Client `unitPrice`/`subtotalAmount`/`taxAmount` gönderir → yok sayılır/reddedilir; server list_price'tan hesaplar.
- Yetkisiz override → 403/422; yetkili override → `order_price_overrides` + reason + business audit; eşik üstü indirim → approval gerekir.

### 11.5 Audit transaction (TST-10/A-07)
- Business mutasyonda bilinçli exception → **audit kaydı kalmaz** (aynı tx rollback).
- Başarılı mutasyon → audit before/after/requestId/actor-snapshot mevcut, aynı commit.
- Audit insert hatası → business mutasyon rollback.

### 11.6 Import replay & crash recovery (TST-05/A-09)
- Aynı dosya (checksum) ikinci upload → no-op/conflict, ikinci veri etkisi yok.
- Worker N satır sonrası crash → retry yalnız `VALID && !APPLIED` satırları uygular; çift ledger yok (veya `ALL_OR_NOTHING` politikasında tüm rollback).
- Out-of-scope warehouse satırı → policy'ye göre deterministik (tüm rollback veya satır INVALID), yan etkisiz.

### 11.7 Soft-deleted/inactive product lifecycle (TST-09/T-08)
- Deleted/inactive ürün DRAFT'a eklenemez; DRAFT'tayken silinirse approve 422, rezervasyon yok; quote→order dönüşümü aktiflik revalidate eder.

### 11.8 Payment correction (TST-11)
- Overpayment reddedilir (veya explicit policy + audit); duplicate payment idempotency çift tutar eklemez; düzeltme onaylı reversal/refund artefaktı üretir.

### 11.9 API contract leak (TST-12/A-12)
- OpenAPI snapshot: snake_case, `deletedAt`, internal `version`, password/token hash, `idempotency_key`, raw stack/job error spec'te bulunursa **CI fail**.

### 11.10 IDOR/public id (T-10)
- Başka depo/customer kapsamındaki tahmin edilebilir id ile GET/PATCH/action → veri sızdırmadan 403/404 (policy).
