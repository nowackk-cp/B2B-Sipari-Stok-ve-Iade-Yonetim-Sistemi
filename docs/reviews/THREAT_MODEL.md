# Threat Model

> Kapsam: B2B Operations Suite dokümantasyonuna göre API, worker, PostgreSQL, Redis/BullMQ, object storage, import/export, frontend ve operasyonel aktörler. Bu model kod incelemesi değil, belgeye dayalı saldırı ve hata senaryosu değerlendirmesidir.

## Sistem Modeli

- **Ana varlıklar:** stok bakiyeleri, stock ledger, siparişler, iadeler, faturalar, ödemeler, fiyat snapshot'ları, kullanıcı/rol/permission/scope verisi, audit log, import dosyaları, generated PDF/export dosyaları.
- **Giriş noktaları:** `/api/v1` REST uçları, auth/login/refresh, order/stock/transfer/return/invoice aksiyon uçları, import upload/job trigger, export trigger, worker queue, file download/upload, admin RBAC yönetimi.
- **Güven sınırları:** Browser -> API, API -> PostgreSQL, API/worker -> Redis/BullMQ, API/worker -> S3/MinIO, API/worker -> SMTP, ADMIN/SUPER_ADMIN işlemleri -> authorization store.
- **Varsayımlar:** DB/Redis/S3 public internete açık değil; kullanıcılar authenticated ama kötü niyetli veya hatalı işlem yapabilir; queue at-least-once teslim eder; frontendde gizlenen kontrol güvenlik sayılmaz.

## Tehdit Bulguları

### T-01 [CRITICAL] RBAC yönetimiyle yetki yükseltme

- **Sorun:** ADMIN'in rol/permission yönetimi için privilege ceiling'i net değil.
- **Oluşabileceği senaryo:** ADMIN, SUPER_ADMIN rolüne dokunmadan aynı güce sahip yeni rol yaratır, kendisine atar ve tüm depolara/stock adjust/audit erişimine ulaşır.
- **Etkilenen belge veya modül:** `docs/PERMISSION_MATRIX.md`, `docs/architecture/SECURITY_MODEL.md`, Authorization module.
- **Önerilen düzeltme:** Privileged permission listesi, self-assignment deny, cannot-grant-above-self ve sadece SUPER_ADMIN tarafından atanabilir permission kuralları eklenmeli.
- **Gerekli test:** ADMIN'in global scope ve privileged permission atama denemeleri 403; SUPER_ADMIN başarılı; tüm denemeler audit'lenmiş olmalı.

### T-02 [HIGH] Frontendde gizli butonun API üzerinden çağrılması

- **Sorun:** Dokümanlar backend permission guard ilkesini doğru koyuyor, ancak her action endpoint için negatif testler task seviyesinde zorunlu değil.
- **Oluşabileceği senaryo:** UI'da `order:ship` butonu gizlenir ama kullanıcı `POST /api/v1/orders/{id}/ship` çağrısını doğrudan gönderir. Endpoint guard/scope unutulduysa sipariş sevk edilir.
- **Etkilenen belge veya modül:** `docs/API_CONVENTIONS.md`, `docs/PERMISSION_MATRIX.md`, Orders/Transfers/Invoices controllers.
- **Önerilen düzeltme:** Controller method'larında permission decorator ve service scope check zorunlu checklist olsun. Generated route listesi ile permission matrix arasında CI coverage testi eklenmeli.
- **Gerekli test:** Her mutating endpoint için permission yok, yanlış permission, scope dışı ve stale JWT varyantları 403 dönmeli; UI'da buton gizli olsa da API çağrısı reddedilmeli.

### T-03 [HIGH] Başka deponun stoklarını değiştirme

- **Sorun:** Scope modeli doğru yönde, fakat transfer ve import gibi çok satırlı/çok depolu işlemler için row-level scope doğrulaması açık değil.
- **Oluşabileceği senaryo:** Depo A çalışanı stock adjustment import dosyasına depo B satırı koyar veya transfer receive ile B stoğunu artırır.
- **Etkilenen belge veya modül:** Scope module, InventoryService, Transfers, Imports, `docs/business-rules/INVENTORY_RULES.md`.
- **Önerilen düzeltme:** Her stok mutasyonu satırında `warehouse_id` scope check transaction içinde yapılmalı. Import row'ları job-level değil row-level authorize edilmeli. Transfer source/dest scope matrisi ayrı yazılmalı.
- **Gerekli test:** A deposu kullanıcısı B deposu için stock receive/adjust/import/transfer yapmaya çalıştığında 403 ve hiçbir ledger/balance değişikliği olmamalı.

### T-04 [HIGH] Aynı siparişin iki kez onaylanması veya sevk edilmesi

- **Sorun:** Idempotency-Key retry'ı kapsar, fakat aynı siparişe farklı key'lerle gelen paralel state transition saldırısı açıkça modellenmemiş.
- **Oluşabileceği senaryo:** Kötü niyetli kullanıcı aynı sipariş için iki `approve` veya `ship` isteğini farklı key'lerle gönderir. Order row lock yoksa status/history/audit veya reservation/ledger çiftlenebilir.
- **Etkilenen belge veya modül:** Orders module, Inventory reservations, `docs/business-rules/ORDER_RULES.md`.
- **Önerilen düzeltme:** Order row lock/conditional transition, active reservation lock ve mandatory movement idempotency key uygulanmalı.
- **Gerekli test:** İki paralel approve/ship farklı key ile koşulduğunda yalnızca tek yan etki oluşmalı; ikinci istek 409 veya idempotent aynı state sonucu dönmeli.

### T-05 [HIGH] Queue başarılı olduğu halde job yeniden teslim edilirse çift yan etki

- **Sorun:** Queue at-least-once davranışı için yan etki seviyesinde unique idempotency modeli tanımlı değil.
- **Oluşabileceği senaryo:** PDF/email/export job'ı dosya/e-posta üretir, process completed yazmadan ölür, BullMQ redelivery yapar ve ikinci çıktı oluşur.
- **Etkilenen belge veya modül:** Worker, Documents, Email, Files, `docs/architecture/ARCHITECTURE.md`, TASK-026/027/031.
- **Önerilen düzeltme:** Her job yan etkisi için deterministic idempotency key ve DB unique constraint kullanın. Dış servis çağrısından önce claim, sonra completed state; crash recovery için lease/attempt modeli yazın.
- **Gerekli test:** Completed mark öncesi crash simülasyonu sonrası redelivery tek dosya/e-posta/outbox sonucu bırakmalı.

### T-06 [HIGH] Aynı Excel dosyasının tekrar yüklenmesi veya importun yarım kalması

- **Sorun:** Import idempotency ve transaction policy soyut bırakılmış.
- **Oluşabileceği senaryo:** Aynı stok adjustment Excel'i iki kez yüklenir; ledger hareketleri iki kez yazılır. Ya da job ortada ölür, retry ilk işlenen satırları tekrar uygular.
- **Etkilenen belge veya modül:** Imports, Inventory, Files, `docs/tasks/IMPLEMENTATION_PLAN.md` TASK-030.
- **Önerilen düzeltme:** File checksum + import type + tenant/user/import key unique; row hash/row number unique; staging ve per-row status modeli; stock ledger reference key'i import row'a bağlanmalı.
- **Gerekli test:** Aynı dosya tekrar upload/run edildiğinde ikinci stok/fiyat/customer etkisi oluşmamalı; crash sonrası retry deterministik devam etmeli veya tüm batch rollback olmalı.

### T-07 [HIGH] Fiyatın frontend tarafından değiştirilmesi

- **Sorun:** Unit price override izin modeli yok.
- **Oluşabileceği senaryo:** Kullanıcı browser devtools ile order item unit price alanını liste fiyatının altına çeker ve server bunu snapshot olarak kabul eder.
- **Etkilenen belge veya modül:** Orders, Quotes, Billing, `PROJECT_SPEC.md` A14.
- **Önerilen düzeltme:** Server-side price calculation varsayılan olmalı; override için ayrı permission, limit, reason ve audit gerekmeli.
- **Gerekli test:** Yetkisiz unit price override 403/422; yetkili override audit ve reason ile başarılı; totals client'tan gönderilse bile server yeniden hesaplamalı.

### T-08 [MEDIUM] Silinmiş ürünün yeni siparişe eklenmesi

- **Sorun:** Onay ön koşulu aktif ürün diyor, ancak DRAFT'a ekleme anı, onay öncesi ürün silinmesi ve import/quote dönüşümü için aynı kuralın uygulanması ayrıca testlenmeli.
- **Oluşabileceği senaryo:** Ürün DRAFT siparişe eklenir, sonra soft delete edilir. Sipariş onaylanırken sadece snapshot'a bakılırsa silinmiş/inaktif ürün rezerve edilir.
- **Etkilenen belge veya modül:** Catalog, Orders, Quotes, Imports.
- **Önerilen düzeltme:** DRAFT item add/update ve APPROVE anında `product.deleted_at IS NULL AND is_active=true` doğrulaması zorunlu olsun. Quote->order kopyalama da güncel aktiflik kontrolünden geçmeli.
- **Gerekli test:** Soft-deleted/inactive ürün DRAFT'a eklenememeli; DRAFT'tayken silinen ürün approve aşamasında 422 ile reddedilmeli ve reservation oluşmamalı.

### T-09 [MEDIUM] Başarısız transaction sonrası audit kaydının yanlış kalması

- **Sorun:** Audit için aynı transaction ve async event tüketimi arasında belgesel çelişki var.
- **Oluşabileceği senaryo:** Stock adjust yetkisiz veya DB CHECK hatasıyla rollback olur, fakat audit event'i kalır; ya da başarılı finansal işlem audit consumer hatasıyla kayıtsız kalır.
- **Etkilenen belge veya modül:** Audit module, Module Boundaries, Database Design.
- **Önerilen düzeltme:** Security/business audit aynı DB transaction içinde yazılmalı; async event modeli audit için kullanılmamalı.
- **Gerekli test:** Hata enjekte edilen transaction sonrası audit yok; başarılı transaction sonrası audit var; audit insert başarısızsa business write rollback.

### T-10 [MEDIUM] IDOR ve sıralı id sızıntısı public id kararı opsiyonel bırakılmış

- **Sorun:** Database design `public_id UUID` için opsiyonel diyor. Sıralı `BIGINT` id'ler API'de kullanılırsa tekil endpointlerde scope guard hatası IDOR'a dönüşür.
- **Oluşabileceği senaryo:** Kullanıcı `/api/v1/orders/12345` id'sini tahmin eder. Scope check unutulan read endpointi başka müşterinin/deponun verisini döner.
- **Etkilenen belge veya modül:** API conventions, Security model, Database Design.
- **Önerilen düzeltme:** Public API id stratejisini kesinleştirin: public UUID/ULID kullanın veya her endpoint için object-level authorization testini route coverage ile zorunlu kılın.
- **Gerekli test:** Başka depo/customer kapsamındaki tahmin edilebilir id ile GET/PATCH/action çağrıları 403/404 policy'ye göre veri sızdırmadan dönmeli.

## Mevcut Kontroller

- UI güvenlik değildir ilkesi belgelerde doğru.
- Permission guard + service-level warehouse scope doğru savunma hattı.
- Mass-assignment ve server-side Money hesaplama prensibi doğru.
- Row lock + DB CHECK negatif stok riskini güçlü şekilde azaltıyor.
- Append-only ledger/audit/status history repudiation riskini azaltıyor; audit yolundaki çelişki giderilmeli.
