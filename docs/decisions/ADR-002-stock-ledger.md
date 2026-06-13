# ADR-002: Append-Only Stok Ledger

- **Durum:** Kabul edildi
- **Tarih:** 2026-06-13

## Bağlam
Stok doğruluğu ve denetlenebilirliği kritik. "Neden bu üründen şu kadar var?" sorusu her an, geriye dönük yanıtlanabilmeli. Mutable bir sayaç (yalnız `on_hand` kolonu) geçmişi kaybeder ve hata ayıklamayı imkânsızlaştırır.

## Seçenekler
1. **Sadece mutable bakiye:** `stock_balances.on_hand` güncellenir, geçmiş yok.
2. **Append-only ledger + türetilmiş bakiye:** her hareket immutable kaydedilir; `on_hand` ledger'ın özetidir.
3. **Event sourcing (tam):** tüm domain event store + projeksiyon.

## Karar
**#2 — Append-only `stock_ledger` + türetilmiş `stock_balances`.** Her fiziksel `on_hand` değişimi (RECEIPT/SHIPMENT/TRANSFER_IN/OUT/RETURN_IN/ADJUSTMENT) ledger'a yazılır; `balance_after` taşır. `stock_balances` performans için tutulan, ledger'dan **yeniden hesaplanabilir** türev durumdur.

## Gerekçe
- **Denetlenebilirlik:** her değişimin kim/ne/ne zaman/neden izi kalıcı.
- **Doğrulanabilirlik:** `Σ ledger.quantity == on_hand` reconciliation ile sürekli doğrulanır.
- **Immutability:** ledger UPDATE/DELETE DB trigger ile engellenir → tahrifata karşı koruma.
- Tam event sourcing (#3) bu aşamada gereksiz karmaşıklık; ledger pragmatik orta yol.

## Önemli Kararlar
- **Rezervasyon ledger'a yazılmaz** — fiziksel hareket değildir; `stock_balances.reserved` + `stock_reservations` ile izlenir.
- `quantity` işaretli (+/−); `balance_after` denetim için.
- **İdempotency ZORUNLU ve satır seviyesinde (A-05, güncelleme):** `stock_ledger.idempotency_key NOT NULL UNIQUE`. Anahtar belge değil **satır** seviyesinde deterministik üretilir (`ORDER_SHIPMENT:{orderId}:{orderItemId}`, `TRANSFER_OUT/IN:{transferId}:{transferItemId}`, `RETURN_IN:{returnId}:{returnItemId}`, `IMPORT:{jobId}:{rowId}`, `ADJUSTMENT:{adjustmentId}`). Çok kalemli belge sorunsuz; aynı hareketin retry'ı ikinci satır yaratamaz. (Eski opsiyonel `(reference_type, reference_id, change_type)` unique terk edildi — çok kalemli belgede hatalıydı.)
- **Balance satırı lazy oluşur** (A-13): ilk RECEIPT/ADJUSTMENT atomik upsert; satır yokken available=0.

## Sonuçlar
- (+) Tam denetim izi, reconciliation, tahrif direnci.
- (+) `stock_balances` ile hızlı okuma (her seferinde ledger toplamı gerekmez).
- (−) İki yapı senkron tutulmalı → her zaman aynı transaction'da yazılır.
- (−) Ledger büyür → partition (aylık) + BRIN index ile yönetilir.
