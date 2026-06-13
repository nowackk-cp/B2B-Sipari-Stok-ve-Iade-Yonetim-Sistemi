# ADR-003: Sipariş Stok Rezervasyonu ve Concurrency

- **Durum:** Kabul edildi
- **Tarih:** 2026-06-13

## Bağlam
Sipariş APPROVED olunca stok rezerve edilmeli; eşzamanlı onaylarda aynı stok iki kez satılmamalı ve stok **asla negatife düşmemeli**. Bu, sistemin en kritik concurrency gereksinimidir (ORD-INV-1).

## Seçenekler
1. **Optimistic concurrency:** `version` kolonu, çakışmada retry.
2. **Pessimistic lock:** `SELECT ... FOR UPDATE` ile satır kilidi.
3. **Uygulama-seviyesi dağıtık kilit (Redis):** Redlock vb.
4. **Sadece DB CHECK:** constraint ihlaline güven.

## Karar
**Çok katmanlı: birincil pessimistic lock (#2) + emniyet ağı DB CHECK (#4) + opsiyonel optimistic version (#1).** Redis kilidi (#3) **reddedildi** — stok doğruluğu Redis'e bağlanamaz (INV-5).

### Mekanizma
1. **Order row lock + expected-status koşullu geçiş (A-04, eklendi):** `SELECT * FROM orders WHERE id=? FOR UPDATE` + `UPDATE orders SET status='APPROVED' WHERE id=? AND status='DRAFT'`; affected rows = 0 → `409 INVALID_STATE`. Farklı idempotency-key'li paralel approve/ship çiftlenemez.
2. Onay transaction'ında ilgili `stock_balances` satır(lar)ı `SELECT ... FOR UPDATE` ile kilitlenir.
3. `available = on_hand − reserved ≥ quantity` kontrol edilir; tüm kalemler için sağlanmazsa `InsufficientStockError` → **tam rollback** (all-or-nothing).
4. Sağlanırsa `reserved += quantity`, `stock_reservations` ACTIVE (`idempotency_key = ORDER_RESERVATION:{orderId}:{orderItemId}` unique).
5. DB CHECK `reserved ≤ on_hand` ve `on_hand ≥ 0` son emniyet: kod hatası olsa bile negatif imkânsız.
6. **Kilit sırası kesin (A-04):** order → order_items → stock_balances; stock_balances **her zaman `ORDER BY warehouse_id, product_id`** → deadlock önleme.
7. **Command idempotency:** `command_idempotency` tablosu (`command_type`, `aggregate_id`, `key`) ile client retry replay'i; ledger/reservation satır-unique son emniyet ağı.

## Gerekçe
- Pessimistic lock yüksek çekişmeli tek-kaynak satırlarda (popüler ürün) optimistic retry fırtınasından daha öngörülebilir.
- DB CHECK, uygulama hatasına karşı son savunma; doğruluğu DB garanti eder.
- Redis kilidi ağ/saat kayması/clock drift riskleri taşır ve doğruluk kaynağı olamaz.

## Sonuçlar
- (+) Negatif stok matematiksel olarak imkânsız (lock + CHECK).
- (+) All-or-nothing rezervasyon → tutarlı sipariş onayı.
- (−) Yüksek çekişmede kilit serileşmesi throughput'u sınırlar (kabul edilebilir; doğruluk > hız).
- (−) Deadlock riski → deterministik kilit sırası ile yönetilir.
- **Zorunlu test:** N+K paralel onay senaryosu (bkz. [TEST_STRATEGY.md](../TEST_STRATEGY.md#concurrency)).
