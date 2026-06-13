# Claude Gate Fix Report

> Codex Architecture Gate Review ([ARCHITECTURE_GATE_REVIEW.md](ARCHITECTURE_GATE_REVIEW.md)) sonucu **REJECTED_BLOCKERS_REMAIN** idi. Bu rapor, gate'in işaret ettiği bir BLOCKER ve iki NON-BLOCKING bulgunun belge düzeyinde kapatılmasını belgeler.
>
> **Kod yazılmadı.** Yalnız mimari/iş kuralı/güvenlik/test/ADR/plan belgeleri güncellendi. Eski Codex review dosyaları ve `ARCHITECTURE_GATE_REVIEW.md` **değiştirilmedi**.

---

## 1. Gate neden REJECTED oldu?

Önceki remediation, invoice-numbering blocker'ını (G-01/G-06) kapatmış ve grant ceiling/protected role altyapısını eklemişti. Ancak gate, **A-02/T-01 privilege-escalation blocker'ının tam kapanmadığını** tespit etti çünkü **iki otoritatif belge hâlâ "ADMIN'in role'den türeyen global warehouse scope'u var" kuralını koruyordu**:

- `SECURITY_MODEL.md` §3: *"Global kapsam: SYSTEM_ADMIN/ADMIN (veya warehouse:scope:all) tüm depolara erişir."*
- `DATABASE_DESIGN.md` §3: *"Boşsa kullanıcının depo kapsamı yok (SYSTEM_ADMIN/ADMIN hariç — global `*`)."*

Bu, güncellenmiş PROJECT_SPEC (A10/A16), PERMISSION_MATRIX ve IMPLEMENTATION_PLAN ile çelişiyordu (global erişim yalnız protected `warehouse:scope:all`, seed'de yalnız SYSTEM_ADMIN). Önceki CRITICAL/BLOCKER privilege-escalation bulgusuna bağlı olduğu için gate **kodlamayı durdurdu**.

Ayrıca iki NON-BLOCKING bulgu vardı:
- **G-14:** MODULE_BOUNDARIES §1/§4'te business audit hâlâ event-consumer/DAG örneklerinde geçiyordu (async audit yorumuna açık).
- **G-17:** `effect_receipts` çift etkiyi engelliyordu ama "receipt insert sonrası, external call öncesi crash" durumunda **etki kaybı (lost effect)** riski bırakıyordu.

---

## 2. Kabul edilen blocker

| Bulgu | Sev | Karar | Durum |
|-------|-----|-------|-------|
| **G-02 / G-03 — ADMIN implicit global warehouse scope çelişkisi** | BLOCKER (privilege escalation) | **Kabul edildi** | ✅ Kapatıldı (belge) |
| G-14 — MODULE_BOUNDARIES audit event-consumer drift | NON-BLOCKING | Kabul edildi | ✅ Kapatıldı |
| G-17 — effect_receipts crash edge case (lost effect) | NON-BLOCKING | Kabul edildi | ✅ Kapatıldı |

> G-01, G-04, G-05, G-06 zaten CLOSED idi; dokunulmadı (yalnız ilgili testler güçlendirildi).

---

## 3. Değiştirilen belgeler

| Belge | Değişiklik özeti |
|-------|------------------|
| `docs/architecture/SECURITY_MODEL.md` | §3 "KESİN KURAL": implicit global scope yok (ADMIN dahil); erişim iki yoldan (`user_warehouse_scopes` / protected `warehouse:scope:all`). §2a tablosuna "global warehouse scope" satırı ve "ADMIN sistem korumalı rol değildir" eklendi. |
| `docs/architecture/DATABASE_DESIGN.md` | §3 `user_warehouses` → **`user_warehouse_scopes`** (user_id, warehouse_id, scope_type, granted_by, created_at) + "boş → erişim yok, rol bypass yok". §2 `permissions.permission_group` + protected grant path/service-layer ceiling/business-audit-same-tx. §0 `effect_status` enum. §14 `effect_receipts` state modeli + `provider_idempotency_key`; outbox `PROCESSED` yalnız effect SUCCEEDED sonrası. §16 eşleme tablosu adı güncellendi. |
| `docs/PERMISSION_MATRIX.md` | §3 enforcement: implicit/rol-temelli global scope YOK; `user_warehouse_scopes` vurgusu; `warehouse.scope.all` dot-notasyon alias notu. |
| `docs/architecture/MODULE_BOUNDARIES.md` | §1.5: events yalnız non-authoritative; "business audit event-consumer ile yazılmaz" uyarısı. §4 DAG: `audit ← herkes (aynı tx writer, event consumer DEĞİL)`; M3 sahiplik `user_warehouse_scopes`. |
| `docs/architecture/ARCHITECTURE.md` | (Önceki turda) §6/§8 business audit aynı-tx; bu turda tutarlılık doğrulandı. |
| `docs/decisions/ADR-007-audit-in-transaction.md` | Dil zaten tutarlı; MODULE_BOUNDARIES ile hizalandı (referanslar). |
| `docs/decisions/ADR-008-outbox-and-idempotency.md` | `effect_receipts` state modeli (PLANNED/IN_PROGRESS/SUCCEEDED/FAILED/UNKNOWN), zorunlu provider key, crash senaryoları, outbox processed yalnız SUCCEEDED sonrası, provider-idempotency-yoksa exactly-once garanti edilemez. |
| `docs/OBSERVABILITY.md` | §5 effect receipt durumları; `UNKNOWN` → kritik alarm + manuel inceleme; §6 alarm tablosuna iki satır. |
| `docs/ERROR_HANDLING.md` | §6 retry: effect state modeli + crash davranışı + provider-yok → UNKNOWN/manuel. |
| `docs/TEST_STRATEGY.md` | §11.1 ADMIN no-implicit-global-scope negatif testleri (6 senaryo + boş-scope G-04); §4c effect crash-state testleri (4 senaryo). |
| `docs/tasks/IMPLEMENTATION_PLAN.md` | TASK-010a (no-implicit-ADMIN-global-scope kabul + testler), TASK-011 (`user_warehouse_scopes`, ADMIN boş-scope erişim yok), TASK-026b (effect state modeli + G-17 testleri), bağımlılık grafiği `010→010a→013→011`. |
| `PROJECT_SPEC.md` | Rol tablosu (SYSTEM_ADMIN global = seed permission, ADMIN implicit scope YOK); A10 `user_warehouse_scopes`. |
| `CLAUDE.md` / `AGENTS.md` | Mutlak kural #9 (effect state modeli), #12 (no implicit global scope), #13 (audit async değil). |
| `docs/reviews/CLAUDE_REMEDIATION_REPORT.md` | Üst nota gate güncellemesi + bu rapora referans. |
| **`docs/reviews/CLAUDE_GATE_FIX_REPORT.md`** | **Yeni — bu rapor.** |

---

## 4. ADMIN implicit global scope çelişkisi nerede düzeltildi?

Tek, kesin kural her belgeye işlendi: **"ADMIN sistem yöneticisi değildir. ADMIN yalnız açık atanmış warehouse scope'ları (`user_warehouse_scopes`) ve sahip olduğu non-protected permission'lar içinde işlem yapabilir. Global warehouse erişimi için protected `warehouse:scope:all` gerekir ve bu yalnız SYSTEM_ADMIN tarafından yönetilir."**

- **SECURITY_MODEL §3** — eski "SYSTEM_ADMIN/ADMIN tüm depolara erişir" satırı kaldırıldı; "iki yol" ve "rol bypass yok" kuralı + ADMIN'in `warehouse:scope:all`'ı atayamadığı eklendi. §2a tablosuna global-scope satırı.
- **DATABASE_DESIGN §3** — eski "SYSTEM_ADMIN/ADMIN hariç global `*`" satırı kaldırıldı; `user_warehouse_scopes` tablosu (istenen kolonlarla) tanımlandı; "boş → erişim yok, ADMIN dahil" netleştirildi. §2'de protected permission grant'ın yalnız SYSTEM_ADMIN path'i + service-layer ceiling + aynı-tx audit.
- **PROJECT_SPEC** — rol tablosu ve A10 güncellendi (SYSTEM_ADMIN global = seed'lenmiş permission, rol bypass değil).
- **PERMISSION_MATRIX §3** — implicit/rol-temelli global scope yok; `warehouse:scope:all` zaten yalnız SYSTEM_ADMIN (matris) + dot-notasyon notu.
- **MODULE_BOUNDARIES** — M3 sahipliği `user_warehouse_scopes`.
- **IMPLEMENTATION_PLAN** — TASK-010a/011 kabul kriterleri + negatif testler; grafik `010→010a→013→011`.
- **CLAUDE.md / AGENTS.md** — mutlak kural olarak.
- **CLAUDE_REMEDIATION_REPORT.md** — gate güncellemesi notu.

Permission adı: kanonik kod **`warehouse:scope:all`** (`<resource>:<action>` konvansiyonu, tüm belgelerde tutarlı); **`warehouse.scope.all`** dot-notasyonu eşdeğer alias olarak belgelendi (PERMISSION_MATRIX §3).

---

## 5. Business audit event-consumer drift nerede düzeltildi?

- **MODULE_BOUNDARIES §1.5** — events ilkesi yeniden yazıldı: yalnız non-authoritative yan etkiler (bildirim/email/metrics/projeksiyon); **"business audit bu yolla yazılmaz"** açık uyarısı.
- **MODULE_BOUNDARIES §4 DAG** — eski `audit ... → herkes (event consumer)` satırı `audit ← herkes (aynı tx writer, event consumer DEĞİL)` olarak değiştirildi; alt açıklama audit'in async olmadığını netleştirdi.
- **ADR-007 / DATABASE_DESIGN §15 / ARCHITECTURE §6** — zaten "aynı transaction" diyordu; dil hizalandı (outbox business audit'in yerine geçmez; outbox yalnız dış etki + async projeksiyon).
- **OBSERVABILITY §1** — business audit (aynı tx, immutable) vs operational/security log (tx dışı, async) ayrımı korunuyor.

Sonuç: tüm belgelerde tek kural — **business audit = domain mutasyonu ile aynı PostgreSQL transaction; async/event/outbox consumer ile yazılmaz.**

---

## 6. effect_receipts crash edge case nasıl düzeltildi?

Önceki tasarım "external call öncesi receipt INSERT ON CONFLICT DO NOTHING → conflict varsa atla" idi; bu, receipt insert ile external call arasında crash olursa **etkiyi atlayabiliyordu (lost effect)**.

Yeni tasarım (DATABASE_DESIGN §14 + ADR-008):
- `effect_receipts` artık **`status effect_status`** taşır: `PLANNED / IN_PROGRESS / SUCCEEDED / FAILED / UNKNOWN`. `(effect_type, effect_key)` unique.
- **`provider_idempotency_key` zorunlu.**
- **Receipt external call yapılmadan önce "başarılı" işaretlenemez.** Worker önce `PLANNED`/`IN_PROGRESS` yazar; dış çağrıyı `provider_idempotency_key` ile yapar; başarı→`SUCCEEDED`, hata→`FAILED`, belirsiz→`UNKNOWN`.
- **Outbox event yalnız ilgili effect `SUCCEEDED` olduktan sonra `processed` sayılır.**
- Crash davranışı:
  - call **öncesi** crash → retry **aynı effect_key** ile (etki kaybı yok),
  - call **sonrası / DB update öncesi** crash → retry **aynı provider_idempotency_key** ile (çift yok),
  - provider idempotency **yoksa** → exactly-once garanti edilemez, `UNKNOWN` + manuel inceleme (açıkça belgelendi).
- OBSERVABILITY: `UNKNOWN` ve uzun `IN_PROGRESS` için alarm. ERROR_HANDLING §6: retry/crash dili güncellendi.

---

## 7. Eklenen / güçlendirilen testler

**Yetki/scope (TEST_STRATEGY §11.1, TASK-010a/011):**
- ADMIN `warehouse:scope:all` atamaya çalışır → **403**
- ADMIN SYSTEM_ADMIN rolünü atamaya çalışır → **403**
- ADMIN sahip olmadığı permission'ı role eklemeye çalışır → **403**
- ADMIN açık scope'u olmayan deponun stoğunu değiştirir → **403** (ledger/balance değişmez)
- `warehouse:scope:all` olmayan ADMIN tüm-depo raporu → **403** / yalnız kapsamı
- ADMIN boş `user_warehouse_scopes` ile erişim → **403** (rol bypass yok — G-04 ek testi)
- SYSTEM_ADMIN `warehouse:scope:all` atar → **200 + business audit (aynı tx, actor snapshot)**

**Effect crash-state (TEST_STRATEGY §4c, TASK-026b):**
- crash after `PLANNED` before external call → retry succeeds, **no lost effect**
- crash after external call before `SUCCEEDED` → retry uses same provider idempotency key, **no duplicate**
- provider without idempotency support → system marks `UNKNOWN` / manual review
- outbox `processed` flag only after effect `SUCCEEDED`

---

## 8. Kalan risk

- **Belge tamam, kod doğrulaması bekleyen (🟡):** Grant ceiling + no-implicit-scope kuralının **her** RBAC/scope ucunda uygulandığı; route-coverage testinin `warehouse:scope:all` dahil protected permission'ları kapsadığı.
- **Operasyonel sınır (kabul edilmiş):** Provider idempotency desteklemeyen dış servislerde exactly-once **garanti edilemez** — `UNKNOWN` + manuel inceleme akışı tasarlandı; sıfır risk değil, kontrollü.
- **İş onayı bekleyen varsayımlar (değişmedi):** price override indirim eşiği, import politikası (ALL_OR_NOTHING vs ROW_LEVEL), iade credit-note politikası.

---

## 9. Codex'in tekrar gate review'de kontrol etmesi gereken noktalar

1. **SECURITY_MODEL §3 ve DATABASE_DESIGN §3'te** artık ADMIN'e role-temelli global scope veren hiçbir ifade kalmadığı; tüm otoritatif belgelerin "global = yalnız protected `warehouse:scope:all`, yalnız SYSTEM_ADMIN" kuralında hizalı olduğu.
2. **`user_warehouse_scopes`** tablosunun (user_id, warehouse_id, scope_type, granted_by, created_at) ve boş-scope→erişim-yok kuralının tutarlı olduğu; eski `user_warehouses` referansının kalmadığı.
3. **Protected permission grant path** — service-layer grant ceiling zorunluluğu + protected değişikliklerin aynı-tx business audit'i.
4. **MODULE_BOUNDARIES §1/§4'te** business audit'in artık event-consumer/DAG'da async olarak yorumlanamadığı.
5. **`effect_receipts` state modeli** — receipt'in SUCCEEDED'sız tamamlanmış sayılmadığı; outbox `processed`'ın yalnız effect SUCCEEDED sonrası olduğu; provider-idempotency-yok → UNKNOWN sınırının açıkça yazıldığı.
6. **Negatif test kapsamı** — §11.1 (scope) ve §4c (effect crash) senaryolarının ilgili TASK kabul kriterlerine bağlandığı.

> **Beklenen gate sonucu:** ADMIN global-scope çelişkisi (tek kalan blocker) kapatıldığından, doküman-gate düzeyinde kodlamaya engel kalmamalıdır. İki NON-BLOCKING bulgu da kapatıldı.
