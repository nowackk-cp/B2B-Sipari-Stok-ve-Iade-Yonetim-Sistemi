# ADR-007: Business Audit Mutasyonla Aynı Transaction İçinde

- **Durum:** Kabul edildi
- **Tarih:** 2026-06-13
- **İlgili bulgu:** Codex A-07 [HIGH], T-09, TST-10

## Bağlam
Belgeler arası çelişki: DATABASE_DESIGN "her mutasyonun audit'i aynı transaction'da" derken MODULE_BOUNDARIES audit'i event-consumer/outbox yan etkileri arasında sayıyordu. İki model farklı hata davranışı üretir: async audit'te mutasyon rollback olsa bile audit kalabilir, ya da mutasyon commit olur ama async audit hiç yazılmaz (A-07).

## Karar
**Business/security-kritik audit, mutasyonu yapan service tarafından AYNI DB transaction içinde explicit yazılır. Event/outbox audit için kullanılmaz.**

### Kapsam — aynı transaction zorunlu (authoritative business audit)
order status changes · inventory movements · stock adjustments · transfer transitions · return transitions · invoice issue/void · price override · user role changes · permission changes · protected role operations.

- Domain transaction rollback → audit de rollback.
- Audit insert hatası → business transaction rollback.
- Audit payload: actor_id + **actor snapshot** (`actor_email`, `actor_name`, `actor_roles_snapshot` — A-10), before/after (domain-specific, explicit), request_id, ip, user_agent.

### Kapsam — transaction dışı (operational/security log)
Başarısız yetki denemeleri, başarısız login, rate-limit, başarısız request → Pino + opsiyonel `security_logs`, **transaction dışında**. Bunlar non-authoritative.

### Interceptor rolü
Genel metadata (actor, request_id, ip) interceptor ile sağlanabilir, ama **domain-specific before/after explicit** yazılır (interceptor tek başına yetmez).

## Gerekçe
- Finansal/stok/yetki kayıtlarında "işlem oldu ama izi yok" veya "iz var ama işlem yok" kabul edilemez. Atomiklik ancak aynı transaction ile sağlanır.
- Async audit yalnız non-authoritative bildirim/metrics için uygundur.

## Sonuçlar
- (+) Audit ile veri kayıtları atomik; repudiation/tutarsızlık riski kalkar.
- (+) Actor snapshot ile email reuse sonrası tarihsel doğruluk korunur (A-10).
- (−) Audit yazımı transaction süresine eklenir (küçük maliyet, kabul edilebilir).
- **Zorunlu test (TST-10):** business-failure→no-audit; audit-failure→no-mutation; success→audit present.
