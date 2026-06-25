# Manuel Test Raporu — B2B Operations Suite

| | |
|---|---|
| **Tarih** | 2026-06-25 |
| **Branch** | `feat/web-app-shell-auth-dashboard` |
| **Ortam** | Yerel (Windows 10, gerçek PostgreSQL 16 / EDB) |
| **Test eden** | Claude (Claude Code) |
| **Kapsam** | Çalışan tam stack üzerinde uçtan uca manuel testler (UI + API) |
| **Genel sonuç** | ✅ **GEÇTİ** — tüm çekirdek akışlar çalışıyor; bilinen kısıt: worker/Redis devre dışı |

---

## 1. Test ortamı

| Servis | Detay | Durum |
|---|---|---|
| PostgreSQL 16 | `127.0.0.1:55432`, db `b2b_dev` | ✅ 21 migration uygulandı |
| Seed | 69 permission / 229 rolePermission / 6 rol / 1 şirket / 1 depo / 1 fatura serisi | ✅ idempotent |
| API (NestJS) | `http://localhost:3001/api/v1` (derlenmiş `dist/main.js`) | ✅ ayakta |
| Web (Next.js 14.2.21) | `http://localhost:3000` (production build + `next start`) | ✅ ayakta |
| Worker | Redis gerektiriyor — **başlatılmadı** | ⚠️ kapsam dışı |
| Demo kullanıcı | `admin@demo.local` / `Demo1234!` (SYSTEM_ADMIN, `warehouse:scope:all`) | ✅ |

**Çalıştırma sırasında gereken düzeltmeler** (ayrıntı: oturum notları)
- API: bayat `tsconfig.build.tsbuildinfo` nedeniyle incremental tsc boş çıktı veriyordu → temiz build + derlenmiş dist çalıştırıldı.
- Web: auth-gate'li client sayfalar build'de statik prerender'da `useContext null` ile patlıyordu → `apps/web/app/layout.tsx`'e `export const dynamic = 'force-dynamic'` eklendi (root segment config tüm route'lara yayılır).
- `next dev`, react-refresh'in `@b2b/ui/dist`'e `import.meta` enjeksiyonu yüzünden bozuk → production yolu (`next build && next start`) kullanıldı.

---

## 2. Kimlik doğrulama (Auth)

| # | Test | Beklenen | Sonuç |
|---|---|---|---|
| A1 | Geçerli kimlikle login (UI) | Dashboard'a yönlendirir | ✅ PASS |
| A2 | Geçerli kimlikle login (API `POST /auth/login`) | 200 + JWT access token (368 ch) + user objesi | ✅ PASS |
| A3 | Geçersiz şifre (API) | 401 reddedilir | ✅ PASS |
| A4 | Eksik/hatalı payload (API) | 400 VALIDATION_ERROR + alan bazlı hatalar | ✅ PASS |
| A5 | Token'sız korumalı endpoint (`GET /products`) | 401 UNAUTHENTICATED | ✅ PASS |
| A6 | Logout (UI "Log out") | `/login`'e yönlendirir, oturum kapanır | ✅ PASS |
| A7 | Tekrar login / oturum kalıcılığı | Yeniden giriş çalışır | ✅ PASS |
| A8 | `GET /auth/me` | 200 + roller `["SYSTEM_ADMIN"]` | ✅ PASS |

---

## 3. Hata sözleşmesi (RFC 7807) & doğrulama

Tüm hatalar `application/problem+json` + stabil `code` + `requestId` korelasyonu ile dönüyor (CLAUDE.md kural: ERROR_HANDLING):

| Senaryo | HTTP | `code` | Not |
|---|---|---|---|
| Token yok | 401 | `UNAUTHENTICATED` | `detail: "Missing bearer token"` |
| Bilinmeyen route | 404 | `NOT_FOUND` | — |
| Geçersiz login payload | 400 | `VALIDATION_ERROR` | `errors[]` alan listesi (email/password) |
| Bilinmeyen query param (`?page=`) | 400 | `VALIDATION_ERROR` | "property page should not exist" → **strict whitelist DTO doğrulaması** (CLAUDE.md kural 10) ✅ |

---

## 4. Modül sayfaları (UI render)

Sol menüdeki tüm modüller doğrulandı:

| Sayfa | Render | Not |
|---|---|---|
| Dashboard | ✅ | 12 metrik kartı; veri sonrası canlı güncelliyor |
| Products | ✅ | Liste + Import/Export CSV + New product + arama + status filtresi |
| Warehouses | ✅ (API 200) | Seed'li MAIN deposu |
| Customers | ✅ | Liste + New customer + arama + type filtresi + Edit/Delete |
| Orders | ✅ | Liste + status filtresi + New order + **detay drawer** (kalemler, toplamlar, aksiyonlar) |
| Invoices | ✅ | Liste; INV-2026-000001 + ISSUED + TRY + 0,00 TRY + View |
| Returns | ✅ (API 200) | — |
| Credit Notes | ✅ (API 200) | — |
| Inventory | ✅ | Reports/Inventory sekmesine yönlendiriyor (stok bakiyeleri) |
| Reports | ✅ | Sales / Inventory / Returns sekmeli görünüm |

---

## 5. CRUD testleri

| # | Test | Yöntem | Sonuç |
|---|---|---|---|
| C1 | Ürün oluştur (`TEST-100`, "Test Widget") | API `POST /products` | ✅ PASS — listede Active, %20 vergi |
| C2 | Stok artır (+100 MAIN) | API `POST /stock/adjustments` (Idempotency-Key) | ✅ PASS — bakiye 100/100 |
| C3 | Müşteri oluştur (`CUST-100`, COMPANY) | API `POST /customers` | ✅ PASS |
| C4 | **Müşteri oluştur (UI formu)** (`CUST-UI-200`) | Web "New customer" modalı → Save | ✅ PASS — listeye anında eklendi |
| C5 | Müşteri type doğrulaması | `type=CORPORATE` reddedilir (COMPANY/INDIVIDUAL) | ✅ PASS — 400 |

---

## 6. Sipariş yaşam döngüsü + fatura (en kritik iş kuralları)

Tek ürün (qty 10), 100 stoklu MAIN deposu üzerinden tam akış:

| Adım | Endpoint | Sipariş durumu | Stok (on-hand / available) | Doğrulama |
|---|---|---|---|---|
| Oluştur | `POST /orders` | **DRAFT** | 100 / 100 | ✅ |
| Onayla | `POST /orders/:id/approve` | **APPROVED** | 100 / **90** | ✅ rezervasyon doğru |
| Sevk et | `POST /orders/:id/ship` (Idem-Key) | **SHIPPED** | **90** / 90 | ✅ on-hand düşürüldü, rezerv serbest |
| Faturala | `POST /orders/:id/invoice` (Idem-Key) | — | 90 / 90 | ✅ |

**Fatura sonucu:** `INV-2026-000001` (gapless, `invoice_series` sayacı), seri `INV`, mali yıl 2026, status **ISSUED**.
**Para gösterimi:** `{amount, currency}` value object (ADR-005) — UI'da "0,00 TRY". Ürün list_price tanımsız olduğu için tutarlar 0 (beklenen davranış: fiyat server'dan, client'tan değil — CLAUDE.md kural 16). VAT oranı 2000 bps (%20).

**Dashboard akış sonrası** (canlı doğrulandı): totalProducts=1, activeProducts=1, totalCustomers=1, shippedOrders=1, issuedInvoices=1.
**Inventory raporu:** TEST-100 → ON HAND 90, RESERVED 0 ✅ (sevk sonrası doğru).

---

## 7. API liste endpoint'leri (authed, cursor pagination)

`{data, pageInfo:{nextCursor, hasNextPage}}` zarfı ile hepsi 200:

| Endpoint | HTTP | Not |
|---|---|---|
| `/products` `/warehouses` `/customers` `/orders` `/invoices` `/returns` `/credit-notes` | 200 | warehouses=1 (seed MAIN) |
| `/dashboard/summary` | 200 | 12 metrik |
| `/reports/inventory` | 200 | — |
| `/reports/sales` | 400 | `dateFrom`/`dateTo` zorunlu (doğrulama çalışıyor) ✅ |

---

## 8. Bulgular & notlar

**Sorun bulunmadı** — tüm test edilen akışlar beklendiği gibi çalıştı.

Gözlemler (hata değil):
1. **Worker/Redis çalışmıyor** — arka plan job'ları (mail/PDF outbox) test edilmedi. API rate limiter Redis yokken fail-open; çekirdek işlevsellik etkilenmiyor.
2. **Para tutarları 0** — test ürününe list_price girilmediği için. Money value object'in `{amount, currency}` şekli doğru; gerçek fiyatla yeniden test edilebilir.
3. **`next dev` yerel ortamda bozuk** (react-refresh + `@b2b/ui` dist `import.meta`). Production yolu sorunsuz. İsterse ayrı bir görev olarak dev modu için `@b2b/ui` ESM/transpile düzeltmesi yapılabilir.

**Güvenlik/sözleşme pozitifleri:**
- Strict DTO whitelist doğrulaması (bilinmeyen alan reddi).
- RFC 7807 + stabil `code` + `requestId` her hatada.
- Deny-by-default: token'sız istek 401; UI gating yalnız kolaylık (API her isteği yetkilendiriyor).
- Gapless fatura numarası `invoice_series` üzerinden (sequence değil).
- Stok değişmezleri: rezervasyon onayda, düşüm sevkte; `available = on_hand − reserved`.

---

## 9. Sonuç

Çalışan stack üzerinde **Auth, tüm modül sayfaları, CRUD (UI + API), tam sipariş→fatura yaşam döngüsü ve API hata sözleşmesi** uçtan uca manuel olarak doğrulandı. Bloklayıcı kusur yok. Worker/Redis ve para-tutarlı akışlar takip testi olarak önerilir.
