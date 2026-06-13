# Security Model

> Temel ilke: **UI kısıtlamaları güvenlik değildir.** Backend her isteği bağımsız olarak kimlik (AuthN) ve yetki (AuthZ + kapsam) açısından doğrular.

## 1. Authentication (AuthN)

- **Parola:** argon2id (memory-hard). Plaintext asla saklanmaz/loglanmaz.
- **Token modeli:** kısa ömürlü **access JWT** (~15 dk) + uzun ömürlü **refresh token** (rotating, ~30 gün).
  - Access JWT: `sub` (user id), `roles`, `permissions` (veya `perm_ver` ile cache invalidasyonu), `jti`, `exp`. İmza: asimetrik (RS256) — worker/api doğrular, yalnızca auth servisi imzalar.
  - Refresh: opak, hash'i `refresh_tokens`'ta. Kullanımda rotate edilir (eski revoke). Reuse tespitinde tüm aile revoke (token theft savunması).
- **Taşıma:** Web için refresh **httpOnly + Secure + SameSite=Strict cookie**; access token memory'de (XSS yüzeyini küçültür). Saf API tüketicileri `Authorization: Bearer`.
- **Oturum sonlandırma:** logout refresh'i revoke eder. `password reset` tüm refresh'leri revoke eder.
- **Brute-force:** login uçlarında rate limit + exponential backoff; başarısız denemeler audit'e.

## 2. Authorization (AuthZ) — Role + Permission

İki katman:
1. **Permission tabanlı (birincil):** Her korunan uç bir veya daha çok permission gerektirir, örn. `@RequirePermission('order:approve')`. Permission'lar rollerle kullanıcıya ulaşır (`user_roles → role_permissions → permissions`).
2. **Role:** yalnızca permission gruplama aracıdır. Kodda **role ismine göre dallanma yapılmaz** (`if role==='ADMIN'` ❌); her zaman permission kontrol edilir. (Tek istisna: protected sistem rolü `SYSTEM_ADMIN` wildcard yetkisi.)

- Permission kodu formatı: `<resource>:<action>` (örn. `product:create`, `stock:adjust`, `invoice:issue`).
- Tam liste/eşleme: [PERMISSION_MATRIX.md](../PERMISSION_MATRIX.md).
- **Enforcement noktası:** NestJS Guard (`PermissionsGuard`) controller'dan önce çalışır. Guard JWT permission claim'ini (veya DB'yi) kontrol eder.

### 2a. SYSTEM_ADMIN vs ADMIN (yetki yükseltme koruması — A-02/T-01 BLOCKER/CRITICAL)

| | **SYSTEM_ADMIN** | **ADMIN** |
|---|---|---|
| Rol türü | **Korumalı sistem rolü** (`is_system=true`, `is_protected=true`, `privilege_level=100`) | Normal yönetim rolü (`is_protected=false`, `privilege_level=50`) — **sistem korumalı rol DEĞİLDİR** |
| Silme/değiştirme | UI ve normal rol-yönetim uçlarıyla **silinemez/değiştirilemez** | Normal yönetilebilir |
| Protected permission | **Yönetebilir/atayabilir** (`role:manage:protected`, `user:assign-role`, `warehouse:scope:all`, `system:*`, `audit:read:all`) | **Atayamaz / role ekleyemez** |
| Protected rol | Atayabilir/değiştirebilir | **Atayamaz/değiştiremez** (SYSTEM_ADMIN rolü dahil) |
| Global warehouse scope | `warehouse:scope:all` (seed) | **Yok** — yalnız açık `user_warehouse_scopes`; `warehouse:scope:all`'ı atayamaz/kendine veremez |
| Normal kullanıcı/rol işlemi | Evet | Evet (grant ceiling + kendi yönetebildiği scope dahilinde) |
| Kendi yetkisini yükseltme | — (zaten en üst) | **Yasak** (privilege escalation deny) |
| Audit | Tüm atama/değişiklik **zorunlu business audit (aynı tx)** | Aynı |

### 2b. Grant Ceiling (zorunlu kural)

Permission grant/role atama işlemlerinde aktör için **grant ceiling** uygulanır:
1. **Cannot-grant-above-self:** Aktör yalnızca **kendi sahip olduğu** permission'ların alt kümesini başkasına verebilir. Sahip olmadığı permission'ı atayamaz.
2. **Privilege level:** `actor.max_privilege_level ≥ target_role.privilege_level` olmalı; ADMIN, kendisinden yüksek/eşit privileged rol oluşturamaz/atayamaz.
3. **Protected permission/protected role:** yalnız SYSTEM_ADMIN.
4. **Self-assignment deny:** Aktör kendi kullanıcısına rol/permission ekleyerek privilege yükseltemez (explicit deny).
5. **Scope ceiling:** Aktör yalnız kendi warehouse kapsamı dahilinde scope atayabilir; `warehouse:scope:all` yalnız SYSTEM_ADMIN.
6. Tüm grant denemeleri (başarılı/başarısız) audit/security log üretir; başarılı olanlar business audit (aynı transaction).

> Bu kurallar **service katmanında** (controller'a güvenilmez) ve veri modeli (`roles.is_protected`, `permissions.is_protected`, `privilege_level`) ile birlikte uygulanır. Negatif API testleri zorunludur (bkz. [TEST_STRATEGY.md](../TEST_STRATEGY.md), [PERMISSION_MATRIX.md §Grant Ceiling](../PERMISSION_MATRIX.md)).

## 3. Warehouse Scope (Veri-seviyesi yetki)

Permission "yapabilir mi?" sorusunu, scope "**hangi veride** yapabilir?" sorusunu yanıtlar.

> **KESİN KURAL (gate blocker G-02/G-03):** **Hiçbir role implicit (örtük) global warehouse scope verilmez — ADMIN dahil.** ADMIN sistem yöneticisi değildir; ADMIN yalnız **açık atanmış** warehouse scope'ları ve sahip olduğu **non-protected** permission'lar içinde işlem yapabilir. Global depo erişimi yalnız **protected `warehouse:scope:all`** permission'ı ile gelir ve bu permission **yalnız SYSTEM_ADMIN tarafından** yönetilir/atanır.

Depo erişimi **yalnız iki yoldan** gelir:
1. **`user_warehouse_scopes`** ile kullanıcıya **açık atanmış** depo kapsamı.
2. **protected `warehouse:scope:all`** permission'ı (global). *(Eşdeğer dot-notasyonu: `warehouse.scope.all`.)*

- Depoya bağlı kaynaklar (stok, transfer, depo-kaynaklı sipariş) **scope filtresi** ile sınırlanır:
  - Liste uçları otomatik olarak kullanıcının açık kapsamındaki depolarla filtrelenir.
  - Tekil erişim/aksiyon: kaynağın `warehouse_id`'si kullanıcı kapsamında değilse `403`.
- **Global kapsam:** yalnız `warehouse:scope:all` permission'ına sahip kullanıcılar tüm depolara erişir. Seed'de bu permission **yalnız SYSTEM_ADMIN'dedir**. ADMIN'in **boş `user_warehouse_scopes`'u varsa hiçbir depoya erişemez** (rol-temelli bypass yoktur).
- **ADMIN ≠ SYSTEM_ADMIN:** ADMIN normal kullanıcı/rol işlemlerini grant ceiling sınırında yapar; `warehouse:scope:all`'ı kendisine veya başkasına **atayamaz** (protected). SYSTEM_ADMIN bir ADMIN'e bu permission'ı açıkça atayabilir.
- Scope kontrolü **service katmanında** uygulanır (controller'a güvenilmez), guard + explicit query filtresi birlikte.
- **Row-level scope (T-03):** çok satırlı/çok depolu işlemlerde (transfer, stok import) scope kontrolü **satır seviyesinde ve transaction içinde** yapılır. Import satırlarının her biri job seviyesinde değil `warehouse_id` bazında yetkilendirilir; kapsam dışı satır → policy'ye göre tüm import rollback veya satır reddi.

### 3a. Transfer Scope Matrisi (A-03 — kesinleştirilmiş)

Transferin iki deposu vardır: `source_warehouse_id`, `dest_warehouse_id`. Kaynak deposuna erişimi olan personel **hedef deponun stoğunu doğrudan değiştirememeli**; hedef stok yalnızca **destination scope** sahibi kullanıcı transferi `RECEIVED`/`COMPLETED`'a geçirince artar.

| Aksiyon | Gerekli scope | Permission |
|---------|---------------|-----------|
| **create** | source warehouse scope | `transfer:create` |
| **approve** | source warehouse scope | `transfer:approve` |
| **dispatch** (out, kaynak on_hand−) | source warehouse scope | `transfer:dispatch` |
| **receive** (in, hedef on_hand+) | **destination** warehouse scope | `transfer:receive` |
| **read / list** | source **veya** destination scope (biri yeterli); kapsam dışı transfer listede sızdırılmaz | `transfer:read` |
| **cancel** | duruma göre: DRAFT/approved → source scope; IN_TRANSIT telafisi kaynak on_hand+ olduğundan source scope | `transfer:cancel` |
| **global (her depo)** | — | `warehouse:scope:all` (özel global permission) |

- create/approve/dispatch yalnız **source** scope ister (oluşturan deponun yetkisi). **receive** yalnız **destination** scope ister → kaynak personeli hedef stoğu artıramaz.
- Liste/okuma uçları yalnız kullanıcının source **veya** dest kapsamındaki transferleri döndürür; out-of-scope alanlar filtrelenir.

## 4. Defense in Depth

| Katman | Önlem |
|--------|-------|
| Network | Yalnızca API public; DB/Redis/MinIO private. TLS her yerde. |
| Input | Sınırda zod/class-validator; tip + aralık + whitelist. Domain tekrar doğrular. |
| AuthZ | Guard (permission) + service (scope) + DB (FK/CHECK). |
| SQL | Yalnızca Prisma parametreli sorgular; raw SQL gerekiyorsa parametre binding zorunlu. |
| Mass assignment | DTO whitelist; `id`, `status`, `*_amount` gibi alanlar client'tan kabul edilmez (server hesaplar). |
| IDOR (T-10) | Her tekil erişimde **object-level authorization** (sahiplik/scope) zorunlu — guard + service. Ek olarak public API'de **ULID/UUID public id kullanımı zorunlu** (sıralı bigint sızıntısı önlenir). Her mutating/tekil read route için route-coverage testi (bkz. TEST_STRATEGY). Kapsam dışı id → policy gereği `404` (varlık gizleme) veya `403`. |
| Rate limit | Global + uç-bazlı (login, export, import daha sıkı). |
| Secrets | Env/secret manager; repoda secret yok; `packages/config` zod ile doğrular. |
| File upload | Content-type + boyut limiti + uzantı whitelist; antivirus opsiyonel; pre-signed URL ile direkt S3; public bucket yok. |
| PDF/SSRF | PDF üretiminde harici URL render edilmez; template + güvenilir asset. |
| Audit | Tüm güvenlik-ilgili olaylar (login, perm değişimi, role atama) audit'e. |

## 5. Hassas Veri ve Loglama

- Loglarda **asla**: parola, token, refresh cookie, tam kart/banka verisi, `Authorization` header.
- Pino redaction config ile `req.headers.authorization`, `password`, `token` alanları maskelenir. Bkz. [OBSERVABILITY.md](../OBSERVABILITY.md).
- PII (müşteri e-posta/telefon) loglarda gerektiğinde maskeli.

## 6. Token & Permission Tutarlılığı

- Rol/permission değişince mevcut access JWT'ler kısa ömrü dolana kadar eski yetkiyi taşır (max ~15 dk). Acil iptal gerekiyorsa `perm_version` claim + DB `users.perm_version` artırımı ile anında invalidasyon.
- Kritik aksiyonlarda (örn. `invoice:issue`, `stock:adjust`) guard DB'den **taze** permission doğrular (JWT claim'e ek), stale yetki riskini düşürür.

## 7. Tehdit Modeli (özet, STRIDE)

| Tehdit | Önlem |
|--------|-------|
| Spoofing | RS256 JWT, rotating refresh, reuse detection. |
| Tampering | Immutable ledger/audit, DB CHECK, server-side hesaplama. |
| Repudiation | Append-only audit (actor + request_id). |
| Information disclosure | Scope filtreleme, IDOR koruması, log redaction, private storage. |
| Denial of service | Rate limit, payload size limit, pagination zorunlu, ağır işler worker'a. |
| Elevation of privilege | Permission guard + scope; **grant ceiling + protected role/permission (§2a/2b)**; role-name dallanması yasak; mass-assignment koruması; price override yalnız `order:price:override`. |

## 8. Yapılması Yasaklananlar

- ❌ Yetkilendirmeyi yalnızca frontend'de yapmak.
- ❌ `if (user.role === 'ADMIN')` ile iş kararı (permission kullan).
- ❌ Client'tan gelen `amount`/`status`/`warehouse_id`'ye sorgusuz güvenmek.
- ❌ Token/parola loglamak.
- ❌ Append-only tabloyu UPDATE/DELETE etmek.
