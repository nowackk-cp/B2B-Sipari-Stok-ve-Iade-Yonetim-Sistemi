# Permission Matrix

> Permission formatı: `<resource>:<action>`. Roller permission gruplamasıdır; kodda **role-name dallanması yasak** — her zaman permission kontrol edilir. `SYSTEM_ADMIN` korumalı sistem rolüdür ve tüm permission'lara sahiptir (wildcard). **Protected permission**'lar (🔒) yalnız SYSTEM_ADMIN tarafından atanabilir; ADMIN dahi atayamaz. **Grant ceiling** kuralları §4'tedir.

## 1. Permission Kataloğu

> 🔒 = **protected permission** (`permissions.is_protected=true`) — yalnız SYSTEM_ADMIN role ekleyebilir/atayabilir.

| Module | Permission code | Açıklama |
|--------|-----------------|----------|
| identity | `user:read` | Kullanıcıları görüntüle |
| identity | `user:create` | Kullanıcı oluştur/davet et |
| identity | `user:update` | Kullanıcı güncelle |
| identity | `user:deactivate` | Kullanıcı pasifleştir (soft) |
| authorization | `role:read` | Rol/permission görüntüle |
| authorization | 🔒 `role:manage` | Rol oluştur/sil, normal permission ata |
| authorization | 🔒 `role:manage:protected` | Protected rol/permission yönet (yalnız SYSTEM_ADMIN) |
| authorization | 🔒 `user:assign-role` | Kullanıcıya rol ata |
| scope | 🔒 `warehouse:scope:all` | Tüm depolara erişim (global) |
| scope | `user:assign-warehouse` | Kullanıcı depo kapsamı yönet (kendi kapsamı dahilinde) |
| catalog | `product:read` / `product:create` / `product:update` / `product:delete` | Ürün CRUD (delete=soft) |
| catalog | `category:manage` | Kategori CRUD |
| warehouses | `warehouse:read` / `warehouse:manage` | Depo görüntüle / yönet |
| inventory | `stock:read` | Bakiye + ledger görüntüle |
| inventory | `stock:receive` | Mal kabul (RECEIPT) |
| inventory | `stock:adjust` | Stok düzeltme (ADJUSTMENT) |
| transfers | `transfer:create` / `transfer:approve` / `transfer:dispatch` / `transfer:receive` / `transfer:cancel` | Transfer yaşam döngüsü (scope matrisi: [SECURITY_MODEL §3a](architecture/SECURITY_MODEL.md)) |
| customers | `customer:read` / `customer:create` / `customer:update` / `customer:delete` | Müşteri CRUD |
| orders | `order:read` / `order:create` / `order:update` | Sipariş okuma/oluşturma/düzenleme |
| orders | `order:approve` / `order:prepare` / `order:ship` / `order:cancel` | Durum geçişleri |
| orders | `order:price:override` | Kalem liste fiyatını override (reason + audit zorunlu) |
| returns | `return:read` / `return:create` / `return:approve` / `return:receive` | İade yaşam döngüsü |
| billing | `invoice:read` / `invoice:create` / `invoice:issue` / `invoice:void` | Fatura |
| billing | `payment:record` | Ödeme kaydı |
| billing | `credit-note:create` | İade/credit note oluştur |
| billing | `quote:read` / `quote:create` / `quote:update` / `quote:send` | Teklif |
| files | `file:read` / `file:upload` / `file:delete` | Dosya |
| imports | `import:run` | Excel import çalıştır |
| exports | `export:run` | Excel/CSV export |
| notifications | `notification:read` | Bildirim okuma |
| audit | `audit:read` | Audit log görüntüle (kendi modül/scope) |
| audit | 🔒 `audit:read:all` | Tüm audit (sistem geneli) |
| dashboard | `dashboard:read` | Dashboard |
| system | 🔒 `system:read` | Job/sistem logları |

## 2. Rol → Permission Eşlemesi (seed)

| Permission ↓ \ Rol → | SYSTEM_ADMIN | ADMIN | WAREHOUSE_MANAGER | SALES | FINANCE | VIEWER |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| user:read / create / update / deactivate | ✅ | ✅ | – | – | – | – |
| 🔒 role:manage | ✅ | ✅¹ | – | – | – | – |
| 🔒 role:manage:protected | ✅ | – | – | – | – | – |
| 🔒 user:assign-role | ✅ | ✅¹ | – | – | – | – |
| 🔒 warehouse:scope:all | ✅ | – | – | – | – | – |
| user:assign-warehouse | ✅ | ✅ | – | – | – | – |
| product:read | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| product:create/update/delete, category:manage | ✅ | ✅ | – | – | – | – |
| warehouse:read | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| warehouse:manage | ✅ | ✅ | – | – | – | – |
| stock:read | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| stock:receive / stock:adjust | ✅ | ✅ | ✅ | – | – | – |
| transfer:create / approve / dispatch / receive / cancel | ✅ | ✅ | ✅ | – | – | – |
| customer:read | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| customer:create / update / delete | ✅ | ✅ | – | ✅ | – | – |
| order:read | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| order:create / update | ✅ | ✅ | – | ✅ | – | – |
| order:approve | ✅ | ✅ | – | ✅ | – | – |
| order:prepare / order:ship | ✅ | ✅ | ✅ | – | – | – |
| order:cancel | ✅ | ✅ | – | ✅ | – | – |
| order:price:override | ✅ | ✅ | – | ◐ | – | – |
| return:read | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| return:create / approve | ✅ | ✅ | – | ✅ | – | – |
| return:receive | ✅ | ✅ | ✅ | – | – | – |
| invoice:read / quote:read | ✅ | ✅ | – | ✅ | ✅ | ✅ |
| invoice:create / issue / void | ✅ | ✅ | – | – | ✅ | – |
| payment:record | ✅ | ✅ | – | – | ✅ | – |
| credit-note:create | ✅ | ✅ | – | – | ✅ | – |
| quote:create / update / send | ✅ | ✅ | – | ✅ | ✅ | – |
| file:read | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| file:upload / delete | ✅ | ✅ | ✅ | ✅ | ✅ | – |
| import:run | ✅ | ✅ | ◐² | – | – | – |
| export:run | ✅ | ✅ | ✅ | ✅ | ✅ | – |
| notification:read | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| audit:read (scope/modül) | ✅ | ✅ | – | – | ◐³ | – |
| 🔒 audit:read:all | ✅ | – | – | – | – | – |
| dashboard:read | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🔒 system:read | ✅ | – | – | – | – | – |

Notlar:
- ¹ ADMIN `role:manage`/`user:assign-role`'a sahiptir **ama grant ceiling** (§4) ile sınırlıdır: protected permission (🔒) ekleyemez/atayamaz, protected rol (SYSTEM_ADMIN) değiştiremez/atayamaz, kendi yetkisini yükseltemez, sahip olmadığı permission'ı veremez. `warehouse:scope:all`, `role:manage:protected`, `audit:read:all`, `system:read` protected olduğu için **seed'de ADMIN'de yoktur**; yalnız SYSTEM_ADMIN açıkça atayabilir.
- ² WAREHOUSE_MANAGER yalnızca stok/import (ürün değil) çalıştırabilir — opsiyonel, ihtiyaca göre.
- ³ FINANCE yalnızca finansal entity audit'ini görebilir (`audit:read` filtreli) — opsiyonel.
- `order:price:override` → SYSTEM_ADMIN ✅, ADMIN ✅, SALES ◐ (indirim eşiğine kadar; eşik üstü onay gerekir), diğer –. `credit-note:create` → SYSTEM_ADMIN/ADMIN/FINANCE.

## 3. Enforcement
- **Guard:** `@RequirePermission('order:approve')` controller-method düzeyinde. **Her mutating route'ta zorunlu** (route↔permission matrix drift testi — [TEST_STRATEGY.md](TEST_STRATEGY.md)).
- **Scope:** depoya bağlı kaynaklarda permission'a ek olarak `warehouse_id ∈ user'ın açık `user_warehouse_scopes` kapsamı` **veya** protected `warehouse:scope:all`. **Implicit/rol-temelli global scope YOKTUR — ADMIN dahil.** Transfer için source/dest matrisi [SECURITY_MODEL §3a](architecture/SECURITY_MODEL.md).
- **Taze doğrulama:** kritik aksiyonlarda (issue/adjust/grant) guard DB'den taze permission okur.
- Detay: [SECURITY_MODEL.md §3](architecture/SECURITY_MODEL.md).

> **Not (permission adı):** Global depo permission'ı kanonik kodu `warehouse:scope:all` (`<resource>:<action>` konvansiyonu). Dot-notasyon `warehouse.scope.all` aynı permission'ın eşdeğer yazımıdır. Protected'tır; yalnız SYSTEM_ADMIN atar.

## 4. Grant Ceiling (yetki yükseltme koruması — A-02/T-01)

Permission grant ve rol atama işlemlerinde **zorunlu** kurallar:

1. **Cannot-grant-above-self:** Aktör yalnız **kendi sahip olduğu** permission'ların alt kümesini atayabilir.
2. **Privilege level:** `actor.max_privilege_level ≥ target_role.privilege_level`. ADMIN (50) kendinden yüksek/eşit privileged rol oluşturamaz/atayamaz.
3. **Protected only SYSTEM_ADMIN:** 🔒 permission ve `is_protected` rol işlemleri yalnız SYSTEM_ADMIN.
4. **Self-escalation deny:** Aktör kendi kullanıcısına rol/permission ekleyerek yetki yükseltemez.
5. **Scope ceiling:** Aktör yalnız kendi warehouse kapsamı dahilinde scope atar; `warehouse:scope:all` yalnız SYSTEM_ADMIN.
6. **Audit:** Tüm grant/atama denemeleri loglanır; başarılılar **aynı transaction içinde business audit** üretir (actor snapshot ile).

> Negatif test zorunluluğu: ADMIN'in privileged rol oluşturma/atama/self-assign/global-scope verme denemeleri **403**; SYSTEM_ADMIN aynısı **başarılı + audit**. Bkz. [TEST_STRATEGY.md](TEST_STRATEGY.md), [SECURITY_MODEL §2a/2b](architecture/SECURITY_MODEL.md).
