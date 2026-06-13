# Missing Test Cases

> Bu dosya test stratejisinde bulunan boşlukları listeler. Mevcut `docs/TEST_STRATEGY.md` iyi bir temel içeriyor; aşağıdaki maddeler özellikle negatif yetkilendirme, transaction, concurrency, idempotency ve import dayanıklılığı için eklenmelidir.

## Eksik veya Yetersiz Test Bulguları

### TST-01 [CRITICAL] Role management privilege ceiling testleri eksik

- **Sorun:** ADMIN'in hangi permission'ları atayamayacağı ve kendisine rol atayıp atayamayacağı test planında yok.
- **Oluşabileceği senaryo:** ADMIN yeni role `warehouse:scope:all` ve `role:manage` ekleyip kendisine atar.
- **Etkilenen belge veya modül:** Authorization/RBAC, `docs/PERMISSION_MATRIX.md`, TASK-010.
- **Önerilen düzeltme:** Privileged permission deny list ve self-assignment kuralları için integration test seti ekleyin.
- **Gerekli test:** ADMIN cannot create/assign privileged role; ADMIN cannot mutate own roles; SUPER_ADMIN can; every denied attempt writes security audit.

### TST-02 [HIGH] Her endpoint için negatif permission/scope matrix coverage yok

- **Sorun:** Test strategy "her uç için authz testi" diyor ama bunu route-permission matrix drift testi veya zorunlu task kabul kriteri yapmıyor.
- **Oluşabileceği senaryo:** `POST /orders/{id}/cancel` veya `stock-transfers/{id}/receive` endpointinde decorator unutulur; frontendde gizli buton API'den çalışır.
- **Etkilenen belge veya modül:** API controllers, Permission matrix, TASK-007/010/011 ve tüm module task'ları.
- **Önerilen düzeltme:** Route metadata extraction ile tüm mutating route'larda `@RequirePermission` varlığını test edin. Her action için permission yok ve scope dışı test fixture'ı yazın.
- **Gerekli test:** Route listesi ile permission matrix karşılaştırılır; permission decorator olmayan protected action CI'da fail eder; out-of-scope fixture tüm depo bağlı endpointlerde 403 alır.

### TST-03 [HIGH] Aynı siparişe farklı idempotency key ile paralel approve/ship testleri eksik

- **Sorun:** Concurrency testleri stok yarışına odaklanıyor; aynı order id üzerinde durum geçişi yarışı ayrıca testlenmiyor.
- **Oluşabileceği senaryo:** İki farklı request aynı DRAFT siparişi approve eder veya aynı PREPARING siparişi ship eder.
- **Etkilenen belge veya modül:** Orders, Inventory reservations, stock ledger.
- **Önerilen düzeltme:** Order row lock/conditional update davranışını kanıtlayan concurrency testleri ekleyin.
- **Gerekli test:** Same order, two parallel approve with different keys -> one transition/history/audit/reservation. Same order, two parallel ship -> one SHIPMENT ledger per item and one consumed reservation.

### TST-04 [HIGH] Transfer source/destination scope negatif testleri eksik

- **Sorun:** Transfer iki depo içeriyor; test planında yalnızca genel scope dışı depo 403 ifadesi var.
- **Oluşabileceği senaryo:** Kullanıcı kaynak depoda yetkili ama hedef depoda yetkisizken transfer oluşturur veya receive eder.
- **Etkilenen belge veya modül:** Transfers, Scope module, Inventory.
- **Önerilen düzeltme:** Transfer aksiyonlarına özel source/dest matrix testleri ekleyin.
- **Gerekli test:** source-only, dest-only, both, none scope kombinasyonları için create/dispatch/receive/read/list beklenen 403/200 davranışını doğrulamalı.

### TST-05 [HIGH] Import replay, crash recovery ve row-level authorization testleri eksik

- **Sorun:** Import testleri mixed valid/invalid ve idempotency diyor, ancak aynı dosya tekrar yükleme, crash sonrası retry ve out-of-scope row yok.
- **Oluşabileceği senaryo:** Stok import job'ı yarıda kalır, retry ilk satırları tekrar uygular; veya dosyadaki başka depo satırı işlenir.
- **Etkilenen belge veya modül:** Imports, Files, Inventory, TASK-030.
- **Önerilen düzeltme:** Import engine için staging/row status test fixture'ları ve failure injection ekleyin.
- **Gerekli test:** Same file checksum second upload no-op/conflict; worker crash after N rows then retry no duplicate ledger; row with unauthorized warehouse causes configured all-or-nothing rollback or row error without side effect.

### TST-06 [HIGH] Worker redelivery-after-side-effect testleri eksik

- **Sorun:** Job idempotency testleri "aynı jobId iki kez" seviyesinde; yan etki sonrası crash ve queue redelivery yok.
- **Oluşabileceği senaryo:** Email provider çağrısı başarılı olur, DB completed yazılmadan worker ölür, job tekrar teslim edilir.
- **Etkilenen belge veya modül:** Worker, Email, Documents, Exports, Job logs.
- **Önerilen düzeltme:** Job processor'lara failure injection hook'u ve deterministic idempotency assertions ekleyin.
- **Gerekli test:** Side effect produced -> crash -> redelivery; final DB/S3/email mock count exactly one. Job logs attempts artabilir ama business effect tek kalmalı.

### TST-07 [HIGH] Invoice number rollback/gapless testleri eksik

- **Sorun:** Invoice number için uniqueness testleri yeterli değil; rollback sonrası boşluk/gap davranışı testlenmiyor.
- **Oluşabileceği senaryo:** Issue transaction numara aldıktan sonra fail olur ve bir sonraki başarılı issue numarayı atlar.
- **Etkilenen belge veya modül:** Billing, Database sequence/fiscal sequence.
- **Önerilen düzeltme:** Fiscal numbering gereksinimine göre rollback, retry ve parallel issue testleri ekleyin.
- **Gerekli test:** Parallel issue unique/monotonic; injected rollback sonrası no gap veya mandatory void/gap audit; same invoice issue retry no second number.

### TST-08 [HIGH] Client price tampering ve override permission testleri eksik

- **Sorun:** Money precision testleri var, fakat client'ın unit price veya totals değiştirme saldırısı açıkça testlenmiyor.
- **Oluşabileceği senaryo:** Frontend veya API client raw `unitPrice`, `subtotalAmount`, `taxAmount` gönderir.
- **Etkilenen belge veya modül:** Orders, Quotes, Billing DTO validation.
- **Önerilen düzeltme:** DTO strict validation ve price override authorization testleri ekleyin.
- **Gerekli test:** Unknown amount/status fields rejected; totals ignored/recomputed; unauthorized unit price override rejected; authorized override requires reason and audit.

### TST-09 [MEDIUM] Soft-deleted/inactive product lifecycle testleri eksik

- **Sorun:** Soft delete testleri listeden gizleme ve unique partial ile sınırlı.
- **Oluşabileceği senaryo:** Ürün DRAFT siparişe eklenir, sonra soft delete edilir ve sipariş approve olur.
- **Etkilenen belge veya modül:** Catalog, Orders, Quotes, Imports.
- **Önerilen düzeltme:** Active product precondition testleri DRAFT add/update, approve ve quote conversion aşamalarına eklenmeli.
- **Gerekli test:** Deleted/inactive product cannot be added; if deleted after draft item creation, approve fails with no reservation; quote->order conversion revalidates active product.

### TST-10 [MEDIUM] Audit rollback ve audit failure testleri eksik

- **Sorun:** Audit için mutation -> audit ve immutability testleri var; rollback ve audit insert failure davranışı yok.
- **Oluşabileceği senaryo:** Business transaction başarısız olur ama audit kalır; audit insert fail olur ama business commit olur.
- **Etkilenen belge veya modül:** Audit, all mutating services.
- **Önerilen düzeltme:** Audit'i aynı transaction içinde zorunlu kılan failure injection testleri ekleyin.
- **Gerekli test:** Business failure -> no audit; audit failure -> no business mutation; successful mutation -> audit before/after/requestId present.

### TST-11 [MEDIUM] Payment correction ve overpayment testleri eksik

- **Sorun:** Payment append-only pozitif kayıt modeli yanlış/çok ödeme düzeltmesini nasıl yapacağını testlemiyor.
- **Oluşabileceği senaryo:** Kullanıcı yanlışlıkla fazla ödeme girer; sistem `PAID` yapar ve düzeltme yolu yoktur.
- **Etkilenen belge veya modül:** Billing payments, Invoice rules.
- **Önerilen düzeltme:** Overpayment, partial payment, duplicate payment idempotency ve correction policy testleri eklenmeli.
- **Gerekli test:** Payment sum cannot exceed grand total unless explicit overpayment policy; duplicate payment idempotency no double amount; correction creates approved reversal/refund artifact according to chosen model.

### TST-12 [MEDIUM] API public contract sızıntı testleri eksik

- **Sorun:** OpenAPI drift testi var, fakat internal DB alanlarının public spec'e sızmadığı testlenmiyor.
- **Oluşabileceği senaryo:** Prisma entity doğrudan expose edilir ve frontend `deletedAt`, `version`, internal error stack gibi alanlara bağımlı olur.
- **Etkilenen belge veya modül:** API DTOs, `packages/contracts`, OpenAPI.
- **Önerilen düzeltme:** OpenAPI snapshot lint ekleyin.
- **Gerekli test:** Spec'te snake_case, password/token hash, internal `version`, raw stack trace, non-public job error detail bulunursa CI fail etmeli.

### TST-13 [MEDIUM] Docker/CI gerçek servis smoke testleri eksik

- **Sorun:** CI planı yüksek seviyede; Postgres/Redis/MinIO/Mailpit/Playwright servislerinin gerçek workflow'da ayağa kalktığını kanıtlayan smoke net değil.
- **Oluşabileceği senaryo:** CI unit testleri geçer ama integration job MinIO endpoint/env eksikliği veya Playwright browser kurulumu nedeniyle sürekli kırılır.
- **Etkilenen belge veya modül:** TASK-005, TASK-006, CI workflow.
- **Önerilen düzeltme:** CI için explicit service containers/env/migration/test command listesi ve health wait script eklenmeli.
- **Gerekli test:** GitHub Actions dry-run/PR smoke: migrate, integration with Postgres/Redis/MinIO, worker smoke, Playwright smoke aynı workflow'da geçmeli.

### TST-14 [LOW] Dokümantasyon link ve ADR varlık testleri eksik

- **Sorun:** `ADR-005` gibi kırık referanslar testte yakalanmıyor.
- **Oluşabileceği senaryo:** Geliştirici eksik ADR nedeniyle Money kararını farklı yorumlar.
- **Etkilenen belge veya modül:** Docs CI.
- **Önerilen düzeltme:** Markdown link checker veya basit docs reference test ekleyin.
- **Gerekli test:** Tüm relative Markdown linkleri ve ADR referansları CI'da doğrulanmalı.
