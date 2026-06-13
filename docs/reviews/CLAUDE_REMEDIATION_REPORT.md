# Claude Remediation Report

> Codex'in dört inceleme belgesindeki ([CODEX_ARCHITECTURE_REVIEW](CODEX_ARCHITECTURE_REVIEW.md), [THREAT_MODEL](THREAT_MODEL.md), [MISSING_TEST_CASES](MISSING_TEST_CASES.md), [IMPLEMENTATION_PLAN_REVIEW](IMPLEMENTATION_PLAN_REVIEW.md)) her bulgusunun kapanış kaydı. **Bu aşamada kod yazılmadı; yalnız mimari/iş kuralı/güvenlik/test/plan belgeleri güncellendi.** Review dosyaları değiştirilmedi.
>
> Durum etiketleri: ✅ Kapatıldı (belge) · 🟡 Kısmen (belge tamam, kod uygulamasında doğrulanacak) · ⛔ Açık.
> "Eklenen test" = test **stratejisi/kabul kriteri** olarak eklenen; gerçek test kodu ilgili TASK'ta yazılacak.
>
> **⚠️ Gate güncellemesi (ARCHITECTURE_GATE_REVIEW → REJECTED):** A-02/T-01 (privilege escalation) ilk turda PARTIALLY_CLOSED kaldı çünkü SECURITY_MODEL §3 ve DATABASE_DESIGN §3'te **ADMIN'e implicit global warehouse scope** veren eski ifadeler kalmıştı. Bu çelişki [CLAUDE_GATE_FIX_REPORT.md](CLAUDE_GATE_FIX_REPORT.md) ile **kapatıldı**: hiçbir rol implicit global scope vermez (ADMIN dahil); global erişim yalnız protected `warehouse:scope:all` (yalnız SYSTEM_ADMIN). Ayrıca MODULE_BOUNDARIES audit event-consumer izi temizlendi ve `effect_receipts` crash-state modeli güçlendirildi. Bu rapordaki A-02/A-07/A-08 kayıtları o güncellemelerle birlikte okunmalıdır.

---

## A. CODEX_ARCHITECTURE_REVIEW

### A-01 Boşluksuz invoice_no vs sequence
- **Severity:** BLOCKER · **Karar:** Kabul edildi · **Durum:** ✅
- **Yapılan değişiklik:** `sequence` tamamen terk edildi; transaction içinde `SELECT ... FOR UPDATE` ile kilitlenen `invoice_series(company_id, series_code, fiscal_year, prefix, next_number, version)` sayaç tablosu tasarlandı. Numara yalnız ISSUED'da, issue tx içinde atanır; rollback → sayaç da rollback (gapless). `UNIQUE(company_id, series_id, fiscal_year, invoice_number)`. Numaralı fatura silinmez, iptal=VOID.
- **Değiştirilen belgeler:** DATABASE_DESIGN §11, INVOICE_RULES §3/§8, PROJECT_SPEC (FIN-3, A15), **yeni ADR-006**, IMPLEMENTATION_PLAN TASK-025a, CLAUDE/AGENTS.
- **Eklenen test:** TST §11.3 + TASK-025a concurrency: rollback-after-allocation no-gap, parallel issue unique/monotonic, retry-same-invoice no second number (INVC-6/7).
- **Kalan risk:** Yüksek issue hacminde sayaç satırı kilit darboğazı (seri/yıl bölme ile azaltılır). Kod uygulaması doğrulanmalı.

### A-02 ADMIN privilege escalation
- **Severity:** BLOCKER · **Karar:** Kabul edildi · **Durum:** ✅ (belge) / 🟡 (kod)
- **Yapılan değişiklik:** `SYSTEM_ADMIN` (protected, privilege_level=100) vs `ADMIN` (50) ayrımı. `roles.is_protected/privilege_level`, `permissions.is_protected` veri modeline eklendi. **Grant ceiling**: cannot-grant-above-self, privilege_level kontrolü, protected permission/rol yalnız SYSTEM_ADMIN, self-escalation deny, scope ceiling. `warehouse:scope:all`/`role:manage:protected`/`audit:read:all`/`system:read` protected işaretlendi; seed'de ADMIN'de yok.
- **Değiştirilen belgeler:** SECURITY_MODEL §2a/2b, PERMISSION_MATRIX (protected işaretleri + §4 Grant Ceiling + matris revize), DATABASE_DESIGN §2, PROJECT_SPEC (roller, A16), IMPLEMENTATION_PLAN TASK-010a, CLAUDE/AGENTS.
- **Eklenen test:** TST §11.1 + TASK-010a: ADMIN privileged create/assign/self-assign/global-scope → 403; SYSTEM_ADMIN → başarılı+audit.
- **Kalan risk:** Karar fonksiyonunun her uçta uygulanması kodda doğrulanmalı (route coverage testi TST-02 ile).

### A-03 Transfer warehouse scope yetersiz
- **Severity:** HIGH · **Karar:** Kabul edildi · **Durum:** ✅
- **Yapılan değişiklik:** Kesin scope matrisi: create/approve/dispatch=source, **receive=destination**, read/list=source∨dest, cancel=source, global=`warehouse:scope:all`. Hedef stok yalnız destination-scope receive ile artar. Row-level scope ilkesi.
- **Değiştirilen belgeler:** SECURITY_MODEL §3a, INVENTORY_RULES §6a, PERMISSION_MATRIX (transfer:approve/cancel), IMPLEMENTATION_PLAN TASK-019, CLAUDE/AGENTS.
- **Eklenen test:** TST §11.2 + TASK-019: source-only/dest-only/both/none kombinasyonları 403/200; liste sızdırmaz.
- **Kalan risk:** Yok (belge düzeyinde kapandı).

### A-04 Order-level lock açık değil
- **Severity:** HIGH · **Karar:** Kabul edildi · **Durum:** ✅
- **Yapılan değişiklik:** Her durum geçişinde order/aggregate row lock + `UPDATE ... WHERE id=? AND status=?expected` (affected=0→409) + `command_idempotency` tablosu. Kesin kilit sırası order→order_items→stock_balances (`warehouse_id,product_id`).
- **Değiştirilen belgeler:** ORDER_RULES §1a, DATABASE_DESIGN §9/§18/§19, ARCHITECTURE §5, ADR-003, IMPLEMENTATION_PLAN TASK-020a, CLAUDE/AGENTS.
- **Eklenen test:** TST §4a + TASK-020a: iki paralel approve/ship farklı key → tek transition/reservation/SHIPMENT/audit (ORD-8).
- **Kalan risk:** Yok (belge).

### A-05 Ledger idempotency opsiyonel/hatalı
- **Severity:** HIGH · **Karar:** Kabul edildi · **Durum:** ✅
- **Yapılan değişiklik:** `stock_ledger.idempotency_key NOT NULL UNIQUE`, **satır seviyesi** deterministik anahtarlar (`ORDER_SHIPMENT:{o}:{i}`, `TRANSFER_OUT/IN:{t}:{i}`, `RETURN_IN:{r}:{i}`, `IMPORT:{j}:{row}`). Eski hatalı `(reference_type,reference_id,change_type)` unique terk edildi.
- **Değiştirilen belgeler:** DATABASE_DESIGN §6, INVENTORY_RULES §3a, ADR-002, IMPLEMENTATION_PLAN TASK-016a, CLAUDE/AGENTS.
- **Eklenen test:** TST §4b + TASK-016a: çok kalemli shipment OK; retry → ledger/on_hand değişmez (STK-6).
- **Kalan risk:** Yok (belge).

### A-06 Fiyat override manipülasyona açık
- **Severity:** HIGH · **Karar:** Kabul edildi · **Durum:** ✅
- **Yapılan değişiklik:** Fiyat server `products.list_price`'tan; client `unitPrice`/totals reddedilir. Override yalnız `order:price:override` + zorunlu reason + `order_price_overrides` (original/overridden/discount/actor/approval) + business audit; eşik üstü indirim approval.
- **Değiştirilen belgeler:** ORDER_RULES §2a/§8/§9, API_CONVENTIONS §7, DATABASE_DESIGN §9 (order_price_overrides), PERMISSION_MATRIX, PROJECT_SPEC (FIN-4, A14), IMPLEMENTATION_PLAN TASK-020b, CLAUDE/AGENTS.
- **Eklenen test:** TST §11.4 + TASK-020b: yetkisiz override 403/422; yetkili reason+audit (ORD-9).
- **Kalan risk:** İndirim eşik değeri (örn. %20) iş tarafından netleştirilmeli (varsayım girildi).

### A-07 Audit yazım yolu çelişkili
- **Severity:** HIGH · **Karar:** Kabul edildi · **Durum:** ✅
- **Yapılan değişiklik:** Tek kural: business audit mutasyonla **aynı DB transaction içinde explicit**; event/outbox audit için kullanılmaz. Operational/security log tx dışı. Audit module ortak transaction-aware writer sağlar.
- **Değiştirilen belgeler:** DATABASE_DESIGN §15, MODULE_BOUNDARIES §3.4, ARCHITECTURE §6/§8, OBSERVABILITY §1, **yeni ADR-007**, IMPLEMENTATION_PLAN TASK-010b/032, CLAUDE/AGENTS.
- **Eklenen test:** TST §11.5 + TASK-010b: business-failure→no-audit; audit-failure→no-mutation (TST-10).
- **Kalan risk:** Yok (belge).

### A-08 Worker/job idempotency veri modeli zayıf
- **Severity:** HIGH · **Karar:** Kabul edildi · **Durum:** ✅
- **Yapılan değişiklik:** `outbox_events` (tüm alanlar + `UNIQUE(deduplication_key)` + claim/lease `FOR UPDATE SKIP LOCKED`) ve `effect_receipts(effect_type, idempotency_key UNIQUE)`; `email_messages.idempotency_key`, `notifications(user_id,dedup_key)`. At-least-once varsayımı; dış çağrı öncesi receipt. job_logs yalnız gözlem.
- **Değiştirilen belgeler:** DATABASE_DESIGN §14, ARCHITECTURE §6, ERROR_HANDLING §6, **yeni ADR-008**, IMPLEMENTATION_PLAN TASK-026a/026b, CLAUDE/AGENTS.
- **Eklenen test:** TST §4b/§11 + TASK-026b: side-effect→crash→redelivery → final çıktı tam 1 (TST-06).
- **Kalan risk:** Sağlayıcı idempotent key desteği (email) entegrasyonda doğrulanmalı.

### A-09 Excel import yarım kalma/tekrar belirsiz
- **Severity:** HIGH · **Karar:** Kabul edildi · **Durum:** ✅
- **Yapılan değişiklik:** `import_jobs` durum makinesi (8 durum) + `file_checksum_sha256` duplicate policy; `import_rows` staging (row_hash, idempotency_key, status, warehouse_id); validate/apply ayrı faz; crash resume (`VALID && !APPLIED`); stok importu ledger `IMPORT:{job}:{row}` key; row-level scope.
- **Değiştirilen belgeler:** DATABASE_DESIGN §0 (enum) /§13, PROJECT_SPEC A17, IMPLEMENTATION_PLAN TASK-030/030b, CLAUDE/AGENTS.
- **Eklenen test:** TST §11.6 + TASK-030/030b: aynı dosya no-op; crash retry no duplicate; out-of-scope row deterministik (TST-05).
- **Kalan risk:** ALL_OR_NOTHING vs ROW_LEVEL politikası iş tarafından seçilmeli (varsayılan ALL_OR_NOTHING).

### A-10 Soft delete: actor identity/email reuse
- **Severity:** MEDIUM · **Karar:** Kabul edildi · **Durum:** ✅
- **Yapılan değişiklik:** `audit_logs`'a actor snapshot (`actor_email`, `actor_name`, `actor_roles_snapshot`); role/permission değişiklikleri append-only audit (aynı tx). Email reuse yasak değil ama snapshot ile tarihsel doğruluk korunur.
- **Değiştirilen belgeler:** DATABASE_DESIGN §2/§15, ADR-007.
- **Eklenen test:** TASK-010b audit testleri (actor snapshot present).
- **Kalan risk:** Düşük.

### A-11 İade credit note "opsiyonel"
- **Severity:** MEDIUM · **Karar:** Kabul edildi · **Durum:** ✅
- **Yapılan değişiklik:** Faturalı sipariş iadesinde finansal düzeltme **zorunlu**; varsayılan politika: onay bekleyen credit note taslağı; idempotency `CREDIT_NOTE:{returnId}`.
- **Değiştirilen belgeler:** RETURN_RULES §4/§5, IMPLEMENTATION_PLAN TASK-025c.
- **Eklenen test:** RET-6 + TASK-025c: faturalı iade → tek credit note; tekrar finalize → çift yok.
- **Kalan risk:** Politika seçimi (taslak/otomatik/manuel) iş onayı bekliyor (varsayılan girildi).

### A-12 API ORM/DB sızıntısı
- **Severity:** MEDIUM · **Karar:** Kabul edildi · **Durum:** ✅
- **Yapılan değişiklik:** Public DTO sözleşmesi: ORM entity expose edilmez; internal alan whitelist (`deletedAt`/`version`/hash/`idempotency_key`/stack çıkmaz); command≠read DTO; OpenAPI snapshot lint.
- **Değiştirilen belgeler:** API_CONVENTIONS §7a, TEST_STRATEGY §11.9.
- **Eklenen test:** TST §11.9 (TST-12): internal alan spec'e sızarsa CI fail.
- **Kalan risk:** Düşük.

### A-13 stock_balances satırı yokken davranış
- **Severity:** MEDIUM · **Karar:** Kabul edildi · **Durum:** ✅
- **Yapılan değişiklik:** Lazy upsert (`ON CONFLICT (product_id,warehouse_id) DO UPDATE`); satır yokken available=0 → reserve `422 INSUFFICIENT_STOCK`; iki paralel receipt → tek satır+iki ledger.
- **Değiştirilen belgeler:** DATABASE_DESIGN §6, INVENTORY_RULES §3b, ADR-002, IMPLEMENTATION_PLAN TASK-016a.
- **Eklenen test:** STK-7 + TASK-016a.
- **Kalan risk:** Yok.

### A-14 ADR-005 kırık referans
- **Severity:** LOW · **Karar:** Kabul edildi · **Durum:** ✅
- **Yapılan değişiklik:** **ADR-005-money-value-object.md** oluşturuldu (saf bigint Money kararı); PROJECT_SPEC/ARCHITECTURE referansları düzeltildi. CI doc-link check eklendi.
- **Değiştirilen belgeler:** yeni ADR-005, PROJECT_SPEC (FIN-1, A4), ARCHITECTURE §4, TEST_STRATEGY §10, IMPLEMENTATION_PLAN TASK-006.
- **Eklenen test:** TST-14 doc link check.
- **Kalan risk:** Yok.

---

## B. THREAT_MODEL

| ID | Severity | Karar | Durum | Özet kapanış | Birincil belge |
|----|----------|-------|-------|--------------|----------------|
| T-01 | CRITICAL | Kabul | ✅/🟡 | A-02 ile aynı: grant ceiling + protected roles | SECURITY_MODEL §2a/2b, TASK-010a |
| T-02 | HIGH | Kabul | ✅ | Route↔permission matrix drift testi; her mutating route'ta `@RequirePermission` zorunlu | TEST_STRATEGY §11.1, PERMISSION_MATRIX §3 |
| T-03 | HIGH | Kabul | ✅ | Row-level scope (transfer/import); receive=destination | SECURITY_MODEL §3/§3a, INVENTORY_RULES §6a, TASK-030b |
| T-04 | HIGH | Kabul | ✅ | Order row lock + conditional + command idempotency (=A-04) | ORDER_RULES §1a, TASK-020a |
| T-05 | HIGH | Kabul | ✅ | Effect receipt + outbox (=A-08) | ADR-008, TASK-026b |
| T-06 | HIGH | Kabul | ✅ | Import staging + checksum + row idempotency (=A-09) | DATABASE_DESIGN §13, TASK-030b |
| T-07 | HIGH | Kabul | ✅ | Server-side price + override permission (=A-06) | ORDER_RULES §2a, TASK-020b |
| T-08 | MEDIUM | Kabul | ✅ | DRAFT add/approve'da aktif ürün doğrulaması | ORDER_RULES §2, DATABASE_DESIGN §9, ORD-10 |
| T-09 | MEDIUM | Kabul | ✅ | Audit aynı tx (=A-07) | ADR-007 |
| T-10 | MEDIUM | Kabul | ✅ | Public ULID/UUID id + object-level authz zorunlu | SECURITY_MODEL §4, API_CONVENTIONS §7b |

---

## C. MISSING_TEST_CASES

| ID | Severity | Karar | Durum | Nereye eklendi |
|----|----------|-------|-------|----------------|
| TST-01 | CRITICAL | Kabul | ✅ | TEST_STRATEGY §11.1, TASK-010a (privilege ceiling negatif testleri) |
| TST-02 | HIGH | Kabul | ✅ | §11.1 route↔permission drift + per-action negatif scope/permission/stale-JWT |
| TST-03 | HIGH | Kabul | ✅ | §4a order command concurrency |
| TST-04 | HIGH | Kabul | ✅ | §11.2 transfer source/dest scope matrisi |
| TST-05 | HIGH | Kabul | ✅ | §11.6 import replay/crash/out-of-scope row |
| TST-06 | HIGH | Kabul | ✅ | §4b/§11 worker redelivery-after-side-effect |
| TST-07 | HIGH | Kabul | ✅ | §11.3 invoice rollback/gapless/parallel |
| TST-08 | HIGH | Kabul | ✅ | §11.4 price tampering + override |
| TST-09 | MEDIUM | Kabul | ✅ | §11.7 soft-deleted/inactive product lifecycle |
| TST-10 | MEDIUM | Kabul | ✅ | §11.5 audit rollback/failure |
| TST-11 | MEDIUM | Kabul | ✅ | §11.8 payment correction/overpayment, INVOICE_RULES §5 |
| TST-12 | MEDIUM | Kabul | ✅ | §11.9 API public contract leak |
| TST-13 | MEDIUM | Kabul | ✅ | §10 CI gerçek-servis smoke, TASK-006 |
| TST-14 | LOW | Kabul | ✅ | §10 doc/link/ADR check, TASK-006 |

---

## D. IMPLEMENTATION_PLAN_REVIEW

| ID | Severity | Karar | Durum | Kapanış |
|----|----------|-------|-------|---------|
| P-01 | BLOCKER | Kabul | ✅ | TASK-010a (grant ceiling) eklendi; RBAC ile birlikte, ADMIN uçları 010a'sız açılmaz |
| P-02 | BLOCKER | Kabul | ✅ | TASK-025a invoice series; gapless sequence ifadeleri kaldırıldı (ADR-006) |
| P-03 | HIGH | Kabul | ✅ | Bağımlılık `010→013→011`; scope testleri gerçek warehouse ile |
| P-04 | HIGH | Kabul | ✅ | Audit ikiye bölündü: TASK-010b (foundation, erken) + TASK-032 (sorgu) |
| P-05 | HIGH | Kabul | ✅ | TASK-026 bölündü: 026 bootstrap, 026a outbox, 026b effect idempotency |
| P-06 | HIGH | Kabul | ✅ | TASK-030 bölündü: 030 engine/staging, 030a product/customer, 030b stock+recovery |
| P-07 | HIGH | Kabul | ✅ | TASK-025 bölündü: 025 schema/draft, 025a issue/numbering, 025b payments, 025c void/credit |
| P-08 | HIGH | Kabul | ✅ | TASK-019 kabul kriterleri: scope matrix + row-lock + movement key + double-action testleri |
| P-09 | MEDIUM | Kabul | ✅ | TASK-006 executable checklist (service/env/migration/Playwright/OpenAPI/coverage) |
| P-10 | MEDIUM | Kabul | ✅ | TASK-037 bölündü: 037 stock, 037a transfers, 037b returns, 037c invoices/PDF |
| P-11 | MEDIUM | Kabul | ✅ | TASK-020 server-side fiyat + aktif ürün + snapshot; override TASK-020b |
| P-12 | LOW | Kabul | ✅ | TASK-006 doc link check; ADR-005 oluşturuldu |

---

## Reddedilen / Kısmen Kabul Edilen

- **Reddedilen:** Yok. Tüm bulgular kabul edildi.
- **Kısmen (belge tamam, kod doğrulaması bekleyen):** A-02/T-01 (grant ceiling enforcement her uçta), A-08 (sağlayıcı idempotent key), A-06/A-09/A-11'de iş onayı bekleyen parametreler (indirim eşiği, import politikası, credit note politikası) — varsayımlar girildi, iş sahibi onayı önerilir.

## Codex'in Tekrar Denetlemesi Gereken Noktalar
1. `invoice_series` kilit mekanizmasının yüksek eşzamanlılıkta gerçekten gapless + deadlock'suz kaldığı (kod + concurrency testi).
2. Grant ceiling karar fonksiyonunun **tüm** RBAC uçlarında (rol create/update, permission ekleme, atama) uygulandığı; route coverage testinin protected permission'ları kapsadığı.
3. Business audit'in gerçekten her kritik mutasyonla aynı tx'te yazıldığı (interceptor + explicit ayrımı).
4. `effect_receipts`/outbox dispatcher'ın at-least-once altında çift yan etki üretmediği (crash injection).
5. Transfer receive'in **yalnız** destination scope ile mümkün olduğu ve import row-level scope'un transaction içinde uygulandığı.
6. Ledger ve reservation idempotency anahtarlarının üretiminin gerçekten satır-benzersiz olduğu (çok kalemli belgeler).
7. Public DTO sınırının OpenAPI snapshot ile gerçekten internal alan sızıntısını yakaladığı.
