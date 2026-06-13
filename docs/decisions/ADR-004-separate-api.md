# ADR-004: Ayrı API Katmanı (Frontend DB'ye Bağlanmaz)

- **Durum:** Kabul edildi
- **Tarih:** 2026-06-13

## Bağlam
Next.js App Router server component'lerden doğrudan DB'ye erişebilir. Ancak iş kuralları, yetkilendirme ve transactional tutarlılık tek ve güvenilir bir yerde toplanmalı.

## Seçenekler
1. **Next.js full-stack:** server action/route handler'lar doğrudan Prisma ile DB'ye.
2. **Ayrı NestJS API:** tüm iş işlemleri `/api/v1` üzerinden; web yalnızca client.
3. **Hibrit:** okuma web'den DB, yazma API'den.

## Karar
**#2 — Ayrı NestJS API.** Frontend **asla** DB'ye doğrudan bağlanmaz; tüm okuma/yazma `/api/v1` üzerinden. Web client OpenAPI'den üretilir.

## Gerekçe
- **Tek yetki noktası:** her istek backend'de bağımsız yetkilendirilir (permission + scope). "UI kısıtlaması güvenlik değildir" ilkesi ancak böyle gerçekleşir.
- **Tek iş kuralı yeri:** business logic API service + `packages/domain`'de; React/server component'te değil.
- **Tek transaction sınırı:** stok/finans tutarlılığı tek yerde yönetilir; worker da aynı domain kodunu paylaşır.
- **İstemci çeşitliliği:** ileride mobil/entegrasyon aynı API'yi kullanır.
- **Hibrit (#3) reddedildi:** ikiye bölünmüş erişim, yetki ve audit'i tutarsızlaştırır.

## Sonuçlar
- (+) Net güvenlik sınırı, tek audit/yetki noktası, üretilen tip-güvenli client.
- (+) Frontend ince; SSR'de bile API çağrısı (server-side fetch, yine yetkili).
- (−) Ekstra ağ atlaması (web → API). Kabul edilebilir; gerekirse SSR cache.
- (−) OpenAPI ↔ client senkronu CI'da otomatikleştirilmeli (drift testi).
- Business logic'in controller/React'te bulunması **yasaktır** (lint + review ile enforce).
