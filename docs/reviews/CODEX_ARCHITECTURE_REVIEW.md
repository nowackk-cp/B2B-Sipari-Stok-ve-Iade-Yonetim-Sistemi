# Codex Architecture Review

> Kapsam: `PROJECT_SPEC.md`, `CLAUDE.md`, `AGENTS.md`, `docs/architecture/*`, `docs/business-rules/*`, `docs/PERMISSION_MATRIX.md`, `docs/API_CONVENTIONS.md`, `docs/TEST_STRATEGY.md`, `docs/ERROR_HANDLING.md`, `docs/OBSERVABILITY.md`, `docs/decisions/*`, `docs/tasks/IMPLEMENTATION_PLAN.md`.
>
> Not: Bu dosya yalnızca bağımsız inceleme çıktısıdır. Mevcut Claude/spec/ADR/task dosyaları değiştirilmedi.

## Genel Sonuç

Mimari kararların ana yönü doğru: ayrı API katmanı, modular monolith, PostgreSQL source-of-truth, row-level lock, append-only ledger, server-side Money ve backend AuthZ ilkeleri stok/finans bütünlüğü için sağlam bir temel kuruyor.

Kodlamaya başlanmadan önce iki konu netleştirilmeli: fiscal invoice number üretimi mevcut haliyle uygulanamaz, RBAC yönetimi ise ADMIN rolü üzerinden yetki yükseltmeye açık. Ayrıca audit yazım yolu, worker idempotency, import tekrar/yarım kalma davranışı ve transfer scope kuralları uygulanabilir sözleşme seviyesine indirilmeden kritik modüller kodlanmamalı.

## Bulgular

### A-01 [BLOCKER] Boşluksuz `invoice_no` gereksinimi PostgreSQL `sequence` ile çelişiyor

- **Sorun:** Belgeler `invoice_no` için "boşluksuz, monoton" sıra istiyor ve bunu PostgreSQL `sequence` ile transaction içinde çözeceğini söylüyor. PostgreSQL sequence değerleri transaction rollback ile geri alınmaz; rollback, retry veya failed issue sonrası numara boşluğu oluşabilir.
- **Oluşabileceği senaryo:** `DRAFT -> ISSUED` sırasında `nextval()` ile `INV-2026-000101` alınır, sonra PDF/outbox/audit ya da DB constraint hatası transaction'ı rollback eder. Sonraki başarılı fatura `INV-2026-000102` olur ve `000101` kalıcı olarak boşta kalır.
- **Etkilenen belge veya modül:** `docs/business-rules/INVOICE_RULES.md`, `docs/architecture/DATABASE_DESIGN.md`, `docs/tasks/IMPLEMENTATION_PLAN.md` TASK-025.
- **Önerilen düzeltme:** Ya "boşluksuz" gereksinimini "benzersiz ve monoton, boşluklar void/cancel loguyla açıklanır" şeklinde değiştirin ya da sequence yerine transaction içinde kilitlenen `fiscal_sequences(year, next_no)` tablosu ve yalnızca tüm validasyonlardan sonra increment modeli tanımlayın. Hukuki gereksinim boşluksuz ise rollback sonrası numara tüketmemeyi test edilebilir kabul kriteri yapın.
- **Gerekli test:** `invoice:issue` içinde numara ayrıldıktan sonra kontrollü exception fırlatılan integration testi; rollback sonrası aynı yılın bir sonraki başarılı issue işleminde boşluk oluşmamalı veya boşluk için zorunlu void/audit kaydı oluşmalı.

### A-02 [BLOCKER] ADMIN rol yönetimiyle kendi yetkisini yükseltebilir

- **Sorun:** Permission matrix ADMIN'e `role:manage`, `user:assign-role` ve `warehouse:scope:all` veriyor. Notlarda yalnızca SUPER_ADMIN rolünü/kullanıcısını değiştiremeyeceği söyleniyor; ADMIN'in yeni bir rol oluşturup kritik permission'ları bu role ekleyerek kendisine ataması engellenmiyor.
- **Oluşabileceği senaryo:** Bir ADMIN `role:manage` ile "OpsRoot" rolü oluşturur, `role:manage`, `user:assign-role`, `warehouse:scope:all`, `stock:adjust`, `audit:read` gibi izinleri ekler ve `user:assign-role` ile kendisine atar. Bu, SUPER_ADMIN dışı privilege ceiling'i fiilen kaldırır.
- **Etkilenen belge veya modül:** `docs/PERMISSION_MATRIX.md`, `docs/architecture/SECURITY_MODEL.md`, Authorization/RBAC modülü, TASK-010.
- **Önerilen düzeltme:** Yetki yönetimine privilege ceiling ekleyin. ADMIN sadece kendi izin kümesinin izin verilen alt kümesini ve kendi scope'u içinde atayabilmeli; `role:manage`, `user:assign-role`, `warehouse:scope:all`, `system:*`, geniş `audit:read` gibi privileged permission'lar yalnızca SUPER_ADMIN tarafından atanabilmeli. Self-assignment ve role mutation için explicit deny kuralı yazılmalı.
- **Gerekli test:** ADMIN'in privileged permission içeren rol oluşturması, mevcut rolüne privileged permission eklemesi, kendisine yeni rol ataması ve başka kullanıcıya global scope vermesi 403 dönmeli; SUPER_ADMIN aynı işlemleri yapabilmeli ve audit yazılmalı.

### A-03 [HIGH] Transfer ve iki depolu işlemlerde warehouse scope kuralı yetersiz

- **Sorun:** Security model tekil kaynaklarda `warehouse_id` kontrolünden bahsediyor; transferlerde ise `source_warehouse_id` ve `dest_warehouse_id` var. Hangi aksiyonda hangi deponun scope içinde olması gerektiği açık değil.
- **Oluşabileceği senaryo:** Depo A'ya atanmış WAREHOUSE_MANAGER, API üzerinden `source=A, dest=B` transferi oluşturur veya tamamlar. Hedef depo B scope dışında olduğu halde stok B'ye yazılabilir veya B'den okuma/işlem yapılabilir.
- **Etkilenen belge veya modül:** `docs/architecture/SECURITY_MODEL.md`, `docs/business-rules/INVENTORY_RULES.md`, `docs/tasks/IMPLEMENTATION_PLAN.md` TASK-011 ve TASK-019.
- **Önerilen düzeltme:** Transfer aksiyonları için scope matrisi ekleyin: create iki depo da scope içinde olmalı; dispatch için kaynak depo scope içinde olmalı ve hedef depo en azından görünür/izinli olmalı; receive için hedef depo scope içinde olmalı; read/list kullanıcıya yalnızca kaynak veya hedef depolarından biri scope içindeyse dönmeli, hassas alanlar buna göre filtrelenmeli.
- **Gerekli test:** A deposuna atanmış kullanıcı B deposuna transfer create/dispatch/receive denemelerinde 403 almalı; hem A hem B scope içindeyse akış başarılı olmalı; liste uçları out-of-scope transferleri sızdırmamalı.

### A-04 [HIGH] Aynı siparişe eşzamanlı durum geçişi için order-level lock açık değil

- **Sorun:** Stok satırı lock stratejisi iyi tanımlanmış, ancak `orders` satırının `SELECT ... FOR UPDATE` ile kilitlenmesi veya `UPDATE ... WHERE status = expected` koşullu geçiş modeli açıkça zorunlu değil. Idempotency-Key yalnızca aynı client retry'ını kapsar; farklı key ile aynı sipariş iki kez onaylanabilir/sevk edilebilir.
- **Oluşabileceği senaryo:** Aynı `DRAFT` siparişe iki farklı `approve` isteği aynı anda gelir. İki işlem de eski status'u DRAFT okur. Stok lock sırası çift rezervasyonu kısmen engelleyebilir, fakat status/history/audit ve reservation unique davranışı uygulamaya kalır. Benzer risk `ship` için çift ledger/consume denemesinde vardır.
- **Etkilenen belge veya modül:** `docs/business-rules/ORDER_RULES.md`, `docs/architecture/DATABASE_DESIGN.md`, OrderService approve/ship/cancel, InventoryService reservation.
- **Önerilen düzeltme:** Her durum geçişinde önce order row lock alınmalı ve güncel status transaction içinde yeniden doğrulanmalı. Alternatif olarak atomic conditional update (`WHERE id=? AND status=?`) ve affected-row kontrolü zorunlu olmalı. Reservation/ledger unique constraint'leri idempotency emniyet ağı olarak zorunlu hale getirilmeli.
- **Gerekli test:** Aynı sipariş için iki paralel approve ve iki paralel ship isteği, farklı idempotency key'leriyle çalıştırılmalı; yalnızca bir status geçişi, bir reservation seti, bir SHIPMENT ledger seti ve bir audit/history kaydı oluşmalı.

### A-05 [HIGH] Ledger idempotency constraint'i opsiyonel ve çok kalemli belgeler için hatalı olabilir

- **Sorun:** `stock_ledger` için önerilen `UNIQUE(reference_type, reference_id, change_type)` opsiyonel bırakılmış. Zorunlu yapılmazsa çift job/çift retry fiziksel hareketi iki kez yazabilir. Zorunlu yapılırsa da çok kalemli tek siparişte aynı order id + SHIPMENT change_type birden fazla ürün satırını engelleyebilir.
- **Oluşabileceği senaryo:** Çok ürünlü bir sipariş sevk edildiğinde ikinci ürünün ledger satırı unique'e takılır. Unique uygulanmazsa retry sonrası aynı ürün için ikinci SHIPMENT yazılır ve `on_hand` iki kez düşer.
- **Etkilenen belge veya modül:** `docs/architecture/DATABASE_DESIGN.md`, `docs/decisions/ADR-002-stock-ledger.md`, InventoryService, transfer/return/order shipment akışları.
- **Önerilen düzeltme:** Fiziksel hareket idempotency'sini zorunlu ve satır seviyesinde tanımlayın. Örnek: `movement_key` veya `UNIQUE(reference_type, reference_id, reference_line_id, change_type, product_id, warehouse_id)`. Transfer, shipment, return ve import satırları için deterministic movement key üretin.
- **Gerekli test:** Çok kalemli order shipment başarılı olmalı; aynı shipment tekrar denenince ledger satır sayısı ve `on_hand` değişmemeli; aynı transfer/import satırının retry'ı ikinci hareket oluşturmamalı.

### A-06 [HIGH] Fiyat override politikası finansal manipülasyona açık

- **Sorun:** Spec, ürün liste fiyatının varsayılan olduğunu ve sipariş/teklif kaleminde override edilebileceğini söylüyor. API mass-assignment koruması toplamları reddediyor ama `unit_price` override yetkisi, limitleri, reason/audit zorunluluğu ve kimlerin override yapabileceği belirtilmiyor.
- **Oluşabileceği senaryo:** SALES kullanıcısı frontendde gizli fiyat alanını devtools/API ile değiştirip `unit_price_amount=1` gönderir. Sunucu bu alanı geçerli snapshot kabul ederse ürün maliyetinin çok altında sipariş/fatura oluşturulur.
- **Etkilenen belge veya modül:** `PROJECT_SPEC.md` A14, `docs/API_CONVENTIONS.md`, `docs/business-rules/ORDER_RULES.md`, Billing/Orders DTO'ları.
- **Önerilen düzeltme:** Varsayılan olarak fiyatı server `products.list_price` üzerinden hesaplamalı. Override gerekiyorsa ayrı `price:override` veya `quote:discount` permission, minimum/maksimum indirim politikası, zorunlu reason ve audit eklenmeli. Client'tan gelen totals daima reddedilmeli; `unitPrice` yalnızca yetkili override flow'da kabul edilmeli.
- **Gerekli test:** SALES rolü raw `unitPrice` düşürmeye çalıştığında 403/422 almalı; yetkili kullanıcı reason ile override yaptığında snapshot ve audit doğru oluşmalı; frontendde gizli buton/alan olmadan doğrudan API çağrısı da reddedilmeli.

### A-07 [HIGH] Audit yazım yolu çelişkili: aynı transaction mı, event/outbox mı?

- **Sorun:** Database design her mutasyonun audit kaydını aynı transaction içinde yazacağını söylüyor. Module boundaries ise audit'i event consumer/outbox yan etkileri arasında sayıyor. Bu iki model farklı hata davranışı üretir.
- **Oluşabileceği senaryo:** Mutasyon rollback olur ama transaction dışı audit event'i işlendiği için başarısız işlem audit'te kalır. Tersi yönde, mutasyon commit olur fakat async audit consumer/job başarısız olduğu için audit kaydı hiç yazılmaz.
- **Etkilenen belge veya modül:** `docs/architecture/DATABASE_DESIGN.md`, `docs/architecture/MODULE_BOUNDARIES.md`, `docs/architecture/ARCHITECTURE.md`, Audit module, TASK-032.
- **Önerilen düzeltme:** Kritik business/security audit için tek kural yazın: audit insert mutasyonla aynı DB transaction içinde explicit yapılır. Event/outbox yalnızca bildirim, email, metrics gibi non-authoritative yan etkiler için kullanılmalı. Interceptor genel metadata sağlayabilir ama domain-specific before/after explicit olmalı.
- **Gerekli test:** Mutasyon içinde bilinçli exception ile rollback yapıldığında audit kaydı kalmamalı; başarılı mutasyonda audit kaydı aynı transaction commit'iyle görünmeli; audit insert hatası business transaction'ı rollback etmeli.

### A-08 [HIGH] Worker/job idempotency veri modeli yeterince bağlayıcı değil

- **Sorun:** `jobId doğal anahtar` ifadesi ve `processed_jobs` için "kullanılabilir" notu at-least-once queue davranışını kapatmaya yetmez. Job başarıyla dış yan etki üretip process crash olursa BullMQ aynı işi yeniden teslim edebilir.
- **Oluşabileceği senaryo:** Invoice PDF/email job'ı dosyayı kaydeder veya e-postayı gönderir, ancak `job_logs` COMPLETED yazılmadan process ölür. Queue yeniden teslim eder ve ikinci dosya/e-posta oluşur.
- **Etkilenen belge veya modül:** `docs/architecture/ARCHITECTURE.md`, `docs/architecture/DATABASE_DESIGN.md`, `docs/ERROR_HANDLING.md`, worker/outbox/jobs, TASK-026/027/031.
- **Önerilen düzeltme:** Her yan etki için DB-level idempotency key zorunlu olsun: `outbox_messages(idempotency_key UNIQUE)`, `document_outputs(entity_type, entity_id, version UNIQUE)`, `email_messages(idempotency_key UNIQUE)`, `processed_jobs(job_id PK)` veya claim/lease modeli. Job log gözlem içindir, idempotency guard değildir.
- **Gerekli test:** İş yan etkiyi ürettikten sonra completed mark öncesi crash simüle edilmeli; redelivery sonrası ikinci email/PDF/ledger/import hareketi oluşmamalı.

### A-09 [HIGH] Excel import için yarım kalma ve tekrar yükleme davranışı belirsiz

- **Sorun:** Import job "geçerli satırlar işlenir, hatalı satırlar raporlanır, idempotent" diyor; ancak batch transaction sınırı, staging modeli, dosya checksum dedup'u ve row-level idempotency anahtarı yok.
- **Oluşabileceği senaryo:** 100 satırlık stok importunda ilk 40 satır ledger hareketi yazar, process ölür. Aynı dosya tekrar yüklendiğinde ilk 40 satır ikinci kez uygulanır veya dosya farklı job id ile tekrar çalışır.
- **Etkilenen belge veya modül:** `docs/architecture/DATABASE_DESIGN.md` import tabloları, `docs/tasks/IMPLEMENTATION_PLAN.md` TASK-030, Imports/Inventory/File modules.
- **Önerilen düzeltme:** Import policy seçin ve belgeleyin: all-or-nothing veya row-level commit. Stok importu için staging table, source file checksum, import type, row number ve row hash üzerinden unique idempotency tanımlayın. Ledger reference'ı import job + row key ile bağlayın. Her row scope ve validation transaction içinde yapılmalı.
- **Gerekli test:** Aynı Excel dosyasının tekrar yüklenmesi ikinci veri değişikliği yapmamalı; job 40. satırdan sonra crash edip retry edildiğinde yalnızca eksik satırlar işlenmeli veya tüm import rollback edilmiş olmalı; out-of-scope warehouse satırı tüm import politikasına göre deterministik sonuç vermeli.

### A-10 [MEDIUM] Soft delete genel olarak doğru, ancak güvenlik/audit kimliği için iki boşluk var

- **Sorun:** Master data soft delete yaklaşımı doğru; transactional tablolar soft delete almamış. Ancak `users.email` partial unique ile soft-deleted kullanıcı email'i tekrar kullanılabilir; audit kayıtları sadece `actor_id` tuttuğu için aynı email'in yeni kullanıcıya verilmesi insan denetiminde karışıklık yaratabilir. Ayrıca role/permission mapping hard delete geçmiş yetki durumunu sadece audit'e bağımlı bırakıyor.
- **Oluşabileceği senaryo:** Eski kullanıcı silinir, aynı email ile yeni kullanıcı oluşturulur. Eski audit kayıtları UI'da email ile gösteriliyorsa yanlış kişiye bağlanmış gibi görünebilir. Rol silme/yeniden yaratma sonrası geçmiş permission setini reconstruct etmek zorlaşır.
- **Etkilenen belge veya modül:** `docs/architecture/DATABASE_DESIGN.md`, Identity/AuthZ/Audit modules.
- **Önerilen düzeltme:** Audit log'a actor snapshot (`actor_email`, `actor_name`, `actor_roles_snapshot` veya immutable actor reference) ekleyin. Kullanıcı email reuse politikasını açıkça seçin: yasakla veya snapshot zorunlu yap. Role/user assignment değişiklikleri için ayrıca append-only history veya audit payload standardı tanımlayın.
- **Gerekli test:** Soft-deleted kullanıcı email'i yeniden kullanıldığında eski audit kayıtlarının eski actor snapshot'ı gösterdiği doğrulanmalı; role assignment delete/update işlemleri audit/history olmadan yapılamamalı.

### A-11 [MEDIUM] İade tamamlanınca finansal düzeltme "opsiyonel" bırakılmış

- **Sorun:** Return rules `COMPLETED` iadede credit note üretimini opsiyonel tanımlıyor. Ürün iadesi stok etkisi yaratırken finansal düzeltmenin opsiyonel olması operasyonel olarak stok-finans ayrışmasına neden olabilir.
- **Oluşabileceği senaryo:** SHIPPED ve faturalı sipariş için return RECEIVED/COMPLETED yapılır, stok geri girer ama credit note oluşmaz. Dashboard/stok doğru görünürken finansal bakiye müşteriden halen tam tutarı bekler.
- **Etkilenen belge veya modül:** `docs/business-rules/RETURN_RULES.md`, Billing/Returns modules, TASK-023/025.
- **Önerilen düzeltme:** Faturalı siparişlerde return completion politikasını netleştirin: otomatik credit note, finance approval bekleyen credit note taslağı veya manuel finans görevi. Her durumda audit ve idempotency key zorunlu olmalı.
- **Gerekli test:** Faturalı sipariş iadesi tamamlandığında seçilen politikaya göre tek credit note veya pending finance task oluşmalı; aynı return tekrar finalize edilirse çift credit note oluşmamalı.

### A-12 [MEDIUM] API sözleşmesi ORM/DB ayrıntılarını sızdırmamayı açıkça zorunlu kılmıyor

- **Sorun:** API conventions DB snake_case -> camelCase mapping ve generated client diyor, ancak response DTO'larının Prisma modellerinden türetilmemesi, internal status/job/ledger alanlarının frontend contract'ına taşınmaması gibi sınırlar açık değil.
- **Oluşabileceği senaryo:** Backend doğrudan Prisma entity serialize eder; frontend `deletedAt`, internal `version`, raw `reserved`, `job_logs.error` gibi alanlara bağımlı olur. Sonra DB refactor veya internal enum değişimi frontend kırar.
- **Etkilenen belge veya modül:** `docs/API_CONVENTIONS.md`, `packages/contracts`, API controllers/services.
- **Önerilen düzeltme:** Public DTO/view model sözleşmesi ekleyin: ORM entity expose edilmez, internal fields whitelist ile dışarı çıkar, command DTO ile read DTO ayrılır, OpenAPI sadece public contract'tır.
- **Gerekli test:** OpenAPI snapshot/contract testlerinde snake_case, `deletedAt`, internal `version`, password/token hash, job stack/error detail gibi alanların public spec'e sızmadığı doğrulanmalı.

### A-13 [MEDIUM] `stock_balances` satırı yokken davranış tanımsız

- **Sorun:** Her ürün-depo için tek balance satırı olduğu söyleniyor, ancak satırın ne zaman oluşturulduğu ve olmayan satırda reserve/adjust/receipt davranışı net değil.
- **Oluşabileceği senaryo:** Ürün yeni oluşturulur, depo için balance satırı henüz yoktur. Eşzamanlı iki receipt ilk satırı oluşturmaya çalışır veya reserve işlemi yok satırı "available 0" yerine farklı hata ile patlar.
- **Etkilenen belge veya modül:** `docs/architecture/DATABASE_DESIGN.md`, `docs/business-rules/INVENTORY_RULES.md`, InventoryService.
- **Önerilen düzeltme:** Balance satırı oluşturma politikasını belirtin: ürün-depo kombinasyonu önceden seed edilir, ilk receipt atomic upsert ile oluşturur veya reserve olmayan satırı 0 available kabul edip deterministic hata döner. Concurrent upsert retry davranışı tanımlanmalı.
- **Gerekli test:** Balance satırı olmayan ürün-depo için reserve 422 `INSUFFICIENT_STOCK` dönmeli; iki paralel receipt tek balance satırı ve iki ledger satırıyla sonuçlanmalı.

### A-14 [LOW] FIN-1 `ADR-005` referansı eksik

- **Sorun:** Project spec para stratejisi için `ADR-005` referansı veriyor, ancak `docs/decisions` altında böyle bir ADR yok.
- **Oluşabileceği senaryo:** Geliştirici Money kararının nihai gerekçesini aradığında kırık referans nedeniyle `decimal.js`, `dinero.js` veya pure bigint yaklaşımı arasında farklı yorum yapabilir.
- **Etkilenen belge veya modül:** `PROJECT_SPEC.md`, `docs/architecture/ARCHITECTURE.md`, `packages/domain` Money.
- **Önerilen düzeltme:** Ya ADR-005 oluşturulmalı ya da referans kaldırılıp Architecture Money bölümü tek kaynak yapılmalı.
- **Gerekli test:** Dokümantasyon link check veya markdown link validation CI'da kırık referansı yakalamalı.

## Kabul Edilebilir Mimari Kararlar

- Ayrı NestJS API ve frontendin DB'ye doğrudan bağlanmaması doğru güvenlik sınırı oluşturuyor.
- Modular monolith, stok-sipariş-fatura gibi güçlü transaction ihtiyacı olan bir v1 için mikroservisten daha uygun.
- PostgreSQL source-of-truth, Redis'i cache/queue ile sınırlama ve `SELECT ... FOR UPDATE` + CHECK kombinasyonu stok negatif riskini doğru şekilde azaltıyor.
- Para için bigint minor unit + currency + basis points yaklaşımı precision açısından doğru.
- Append-only ledger/audit/status history ve master data soft delete ayrımı genel olarak doğru.
- OpenAPI generated client yaklaşımı frontend/backend contract drift riskini azaltır; public DTO sınırları eklenirse iyi bir seçimdir.
