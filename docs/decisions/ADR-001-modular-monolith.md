# ADR-001: Modüler Monolit

- **Durum:** Kabul edildi
- **Tarih:** 2026-06-13
- **Karar verenler:** Lead Software Architect

## Bağlam
B2B Operations Suite çok sayıda iş modülü (stok, sipariş, fatura, iade…) içeriyor ve bunlar arasında güçlü transactional tutarlılık gerekiyor (özellikle stok ↔ sipariş). Takım küçük, hızlı teslim ve düşük operasyonel yük öncelikli.

## Seçenekler
1. **Mikroservisler:** modül başına servis + ayrı DB.
2. **Modüler monolit:** tek deploy birimi, modül-içi sınırlar, tek DB.
3. **Katmanlı monolit (sınırsız):** modülsüz tek kod tabanı.

## Karar
**Modüler monolit** (#2). Tek NestJS API + standalone worker, tek PostgreSQL. Modüller derleme-zamanı sınırlarıyla ayrılır (bkz. [MODULE_BOUNDARIES.md](../architecture/MODULE_BOUNDARIES.md)), birbirine yalnızca service interface üzerinden bağlanır.

## Gerekçe
- **Transactional tutarlılık:** Sipariş onayı + stok rezervasyonu **tek DB transaction** içinde yapılabilir. Mikroservislerde bu, saga/2PC karmaşıklığı ve eventual consistency riski getirirdi — stok doğruluğu için kabul edilemez.
- **Operasyonel basitlik:** tek deploy, tek DB, tek migration hattı. Küçük takım için uygun.
- **Evrilebilirlik:** net modül sınırları sayesinde ileride bir modül (örn. billing) servise ayrılabilir.

## Sonuçlar
- (+) Güçlü tutarlılık, düşük operasyonel yük, hızlı geliştirme.
- (+) Ortak `packages/domain` API ve worker'da paylaşılır.
- (−) Tek DB ölçek sınırı; ileride partition/read-replica gerekebilir.
- (−) Modül sınırları disiplinle korunmazsa "big ball of mud" riski → lint/CI ile enforce edilir.
- Worker ayrı process (ağır işler API'yi bloklamaz) ama aynı kod tabanı/DB.
