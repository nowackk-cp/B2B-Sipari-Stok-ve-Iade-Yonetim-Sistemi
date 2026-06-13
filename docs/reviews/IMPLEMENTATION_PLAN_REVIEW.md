# Implementation Plan Review

> Kapsam: `docs/tasks/IMPLEMENTATION_PLAN.md` ve bu planın diğer mimari/iş kuralı belgeleriyle uyumu.

## Genel Değerlendirme

Plan bağımlılık grafiğiyle iyi bir başlangıç yapıyor, ancak bazı görevler kabul kriteri seviyesinde fazla geniş veya kritik kararları "idempotent/scope/audit" gibi tek kelimeyle bırakıyor. En riskli durum, bazı görevlerin kendi kabul kriterlerinde audit/scope/idempotency isterken bu altyapıların ya daha sonra gelmesi ya da veri modeli netleşmeden kodlanacak olması.

## Bulgular

### P-01 [BLOCKER] RBAC privilege ceiling TASK-010 öncesinde net değil

- **Sorun:** TASK-010 RBAC ve role management'ı uygulayacak, ancak ADMIN'in hangi izinleri atayamayacağı, self-assignment yasağı ve privileged permission seti belge düzeyinde tanımlı değil.
- **Oluşabileceği senaryo:** TASK-010 mevcut matrix'e göre uygulanırsa ADMIN kendi rolünü yükseltebilen bir yönetim API'siyle teslim edilir.
- **Etkilenen belge veya modül:** TASK-010, `docs/PERMISSION_MATRIX.md`, Authorization module.
- **Önerilen düzeltme:** TASK-010'dan önce ayrı bir mini task veya kabul kriteri ekleyin: privilege ceiling, self-assignment deny, privileged permission deny list, SUPER_ADMIN-only mutations.
- **Gerekli test:** ADMIN privileged role create/assign/self-assign 403; SUPER_ADMIN success; denied attempts audit.

### P-02 [BLOCKER] TASK-025 fiscal numbering kabul kriteri uygulanamaz

- **Sorun:** TASK-025 `invoice_no` için boşluksuz sequence kabul kriteri koyuyor; PostgreSQL sequence rollback'te boşluk bırakır.
- **Oluşabileceği senaryo:** Billing geliştiricisi standard DB sequence kullanır, testler yalnızca uniqueness kontrol ettiği için gap production'da ortaya çıkar.
- **Etkilenen belge veya modül:** TASK-025, Billing, DB migration.
- **Önerilen düzeltme:** TASK-025 başlamadan fiscal numbering ADR/task ekleyin. Gapless gerekiyorsa locked fiscal counter table; gap açıklanabilir kabul ediliyorsa void/gap audit policy.
- **Gerekli test:** Rollback after number allocation, parallel issue, retry same invoice, duplicate idempotency tests.

### P-03 [HIGH] TASK-011 dependency grafiği warehouse bağımlılığıyla çelişiyor

- **Sorun:** TASK-011 açıklaması `(+ TASK-013 warehouses)` diyor, ancak bağımlılık grafiği `009→010→011` ve ayrıca `010→012,013,014` şeklinde. Scope module warehouse tablosu/modülü olmadan tam test edilemez.
- **Oluşabileceği senaryo:** TASK-011 erken uygulanır, gerçek warehouse CRUD ve fixture yokken scope guard mock veya eksik davranışla yazılır; sonra TASK-013 sonrası scope davranışı drift eder.
- **Etkilenen belge veya modül:** TASK-011, TASK-013, dependency graph.
- **Önerilen düzeltme:** Grafiği `010→013→011` veya en azından warehouse schema/fixture önce gelecek şekilde düzeltin. Scope acceptance testleri gerçek warehouse kayıtlarıyla koşmalı.
- **Gerekli test:** Scope module integration tests use real warehouses; empty `user_warehouses` no access; assigned warehouse access; global scope access.

### P-04 [HIGH] TASK-032 audit çok geç geliyor

- **Sorun:** TASK-021, TASK-022 ve TASK-025 kabul kriterlerinde audit var, fakat audit modülü TASK-032'de ve dependency graph'ta bu görevlerden sonra geliyor.
- **Oluşabileceği senaryo:** Order/invoice task'ları "audit sonra entegre edilir" diye merge edilir; kritik mutasyonlar bir süre auditsiz kalır veya farklı servislerde geçici audit kodları oluşur.
- **Etkilenen belge veya modül:** TASK-021, TASK-022, TASK-025, TASK-032.
- **Önerilen düzeltme:** Audit foundation'ı ikiye bölün: erken TASK-012a gibi `audit writer + transaction helper + immutable table` önce gelsin; TASK-032 sadece query UI/filter/interceptor genişletmesi olsun.
- **Gerekli test:** TASK-021/022/025 PR'ları audit integration testleri olmadan kabul edilmemeli.

### P-05 [HIGH] TASK-026 worker/outbox/idempotency tek görev için fazla büyük

- **Sorun:** Worker iskeleti, BullMQ, transactional outbox, retry/backoff, job_logs ve idempotency aynı task'a sıkıştırılmış.
- **Oluşabileceği senaryo:** Temel worker ayağa kalkar ama exactly-once/outbox claim ve redelivery güvenliği yüzeysel kalır; sonraki PDF/email/import job'ları bu zayıf temel üzerine kurulur.
- **Etkilenen belge veya modül:** TASK-026, Worker, Outbox, Job logs.
- **Önerilen düzeltme:** TASK-026'yı bölün: worker bootstrap; outbox schema+claim/lease; job_logs/metrics; idempotency/redelivery harness; retry/DLQ policy.
- **Gerekli test:** Her alt task için ayrı integration test: claim once, concurrent workers same outbox row, crash before/after side effect, retry/backoff, job_logs status.

### P-06 [HIGH] TASK-030 Excel import fazla belirsiz

- **Sorun:** Ürün, müşteri ve stok importu aynı görevde; validation, hata raporu, idempotency ve ledger entegrasyonu birlikte ama policy net değil.
- **Oluşabileceği senaryo:** Basit product import tamamlanır; stock import aynı altyapıyı kullanır ama row-level idempotency/scope/transaction eksik kalır.
- **Etkilenen belge veya modül:** TASK-030, Imports, Inventory, Files.
- **Önerilen düzeltme:** Importu şu parçalara ayırın: common parser/staging/error report; product/customer import; stock adjustment import with ledger/idempotency/scope; retry/resume tests.
- **Gerekli test:** Mixed valid/invalid, duplicate file, crash resume, unauthorized warehouse row, duplicate stock movement.

### P-07 [HIGH] TASK-025 billing kapsamı çok geniş

- **Sorun:** DRAFT invoice, issue, no atama, immutability, payments, void ve credit-note tek task'ta. Bunların her biri finansal invariant taşıyor.
- **Oluşabileceği senaryo:** Invoice issue doğru yazılır ama payments/void/credit-note edge case'leri eksik kalır; veya positive-only payments düzeltme akışı tanımsız kalır.
- **Etkilenen belge veya modül:** TASK-025, Billing.
- **Önerilen düzeltme:** Billing'i bölün: invoice schema + draft editing; issue + fiscal numbering; immutability enforcement; payments; void/credit note; idempotency.
- **Gerekli test:** Her alt PR'da kendi invariants: issued immutable, rollback numbering, payment over/duplicate, void restrictions, credit note idempotency.

### P-08 [HIGH] TASK-019 transfer scope/idempotency kabul kriterleri yetersiz

- **Sorun:** Transfer task'ı source/dest scope matrisi, double dispatch/receive ve multi-item ledger idempotency'yi açıkça istemiyor.
- **Oluşabileceği senaryo:** Transfer dispatch retry iki kez `TRANSFER_OUT` yazar veya depo çalışanı hedef dışı depoya işlem yapar.
- **Etkilenen belge veya modül:** TASK-019, Transfers, Inventory.
- **Önerilen düzeltme:** TASK-019 kabul kriterlerine source/dest scope matrix, row-level lock order, movement key unique ve double action idempotency ekleyin.
- **Gerekli test:** Parallel dispatch/receive no duplicate ledger; source/dest scope combinations; cancelled in-transit compensation deterministic.

### P-09 [MEDIUM] TASK-006 CI gerçek ortam ayrıntıları eksik

- **Sorun:** CI hattı doğru sırayı veriyor, ancak servis container'ları, env, migration, Playwright browser install, MinIO/Mailpit strategy ve cache ayrıntıları yok.
- **Oluşabileceği senaryo:** CI task'ı yazılır ama integration/e2e lokalden farklı çalışır; Testcontainers Docker erişimi veya MinIO env eksikliği nedeniyle kırılır.
- **Etkilenen belge veya modül:** TASK-006, GitHub Actions.
- **Önerilen düzeltme:** CI task'ını executable checklist'e çevirin: exact services, env vars, migration command, pnpm cache, test split, artifacts, OpenAPI drift, coverage gate.
- **Gerekli test:** İlk CI PR'ında empty project smoke, DB migration, Redis connectivity, MinIO connectivity, Playwright smoke ve OpenAPI drift step geçmeli.

### P-10 [MEDIUM] TASK-037 frontend çok geniş

- **Sorun:** Stok, transfer, iade, fatura ve PDF UI tek task'ta toplanmış. Bu alanlar farklı permission, state machine ve edge case'lere sahip.
- **Oluşabileceği senaryo:** UI task'ı çok büyük PR'a dönüşür; permission-aware button visibility testleri ve backend negative error handling eksik kalır.
- **Etkilenen belge veya modül:** TASK-037, Frontend.
- **Önerilen düzeltme:** TASK-037'yi stock ledger view, transfers UI, returns UI, invoices/PDF UI olarak bölün. Her UI task'ı backend error code handling ve direct API denial e2e ile gelmeli.
- **Gerekli test:** Her ekran için permission hidden button + direct API 403, state transition invalid action disabled and API rejected, problem+json localized display.

### P-11 [MEDIUM] TASK-020 fiyat snapshot ve active product rule ayrıntısı eksik

- **Sorun:** TASK-020 snapshot ve totals diyor; price override permission, active/deleted product validation ve server-side price source açık değil.
- **Oluşabileceği senaryo:** DRAFT item client fiyatıyla oluşturulur veya soft-deleted ürün approve aşamasına taşınır.
- **Etkilenen belge veya modül:** TASK-020, Orders, Catalog.
- **Önerilen düzeltme:** TASK-020'ye server-side list price default, override permission yoksa unit price reddi, active product validation ve snapshot audit kriterleri ekleyin.
- **Gerekli test:** Client totals ignored/recomputed; unauthorized unit price rejected; deleted/inactive product add/approve rejected.

### P-12 [LOW] Dokümantasyon/ADR link doğrulaması planlanmamış

- **Sorun:** Plan docs link checker içermiyor; mevcut spec'te eksik ADR referansı var.
- **Oluşabileceği senaryo:** Kırık ADR linkleri ve section anchor'ları geliştiriciyi yanlış kaynağa yönlendirir.
- **Etkilenen belge veya modül:** TASK-006, docs.
- **Önerilen düzeltme:** CI'a markdown link check veya docs consistency smoke ekleyin.
- **Gerekli test:** Missing ADR/link/anchor CI'da fail etmeli.

## Önerilen Plan Revizyon Sırası

1. RBAC privilege ceiling ve fiscal numbering kararlarını plan başlamadan netleştirin.
2. TASK-011 dependency graph'ını warehouse modülüyle uyumlu hale getirin.
3. Audit writer altyapısını order/invoice task'larından önceye çekin.
4. Worker/outbox ve import görevlerini idempotency/crash recovery testleriyle bölün.
5. Billing, transfer ve frontend büyük task'larını daha küçük PR'lara ayırın.
