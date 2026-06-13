# Inventory Rules

> Stok doğruluğu sistemin en kritik değişmezidir. PostgreSQL tek doğruluk kaynağıdır; Redis asla stok doğruluğunun kaynağı değildir.

## 1. Temel Modeller
- **on_hand:** fiziksel olarak depoda bulunan miktar.
- **reserved:** onaylı siparişler için ayrılmış miktar.
- **available:** `on_hand − reserved`. Saklanmaz, hesaplanır.
- Bakiye `stock_balances`'ta `(product_id, warehouse_id)` başına tek satır.

## 2. Değişmezler (Invariants)
- INV-1: `available ≥ 0` ⇔ `reserved ≤ on_hand` (DB CHECK).
- INV-2: `on_hand ≥ 0`, `reserved ≥ 0` (DB CHECK).
- INV-3: Tüm `on_hand` değişimleri `stock_ledger`'a append edilir (immutable).
- INV-4: `stock_balances`, ledger'ın türevidir; `Σ ledger.quantity` (per ürün-depo) = `on_hand`. Bu eşitlik reconciliation job'ı ile periyodik doğrulanır.
- INV-5: Rezervasyon `on_hand`'i değiştirmez; yalnızca `reserved`'ı etkiler ve ledger'a yazılmaz.

## 3. Ledger Hareket Türleri
| change_type | quantity işareti | on_hand etkisi | Tetikleyen |
|-------------|------------------|----------------|-----------|
| `RECEIPT` | + | artar | mal kabul / stok girişi |
| `SHIPMENT` | − | azalır | sipariş sevkiyatı |
| `TRANSFER_OUT` | − | azalır (kaynak) | transfer başlatma |
| `TRANSFER_IN` | + | artar (hedef) | transfer tamamlama |
| `RETURN_IN` | + | artar | iade kabulü (resellable) |
| `ADJUSTMENT` | ± | düzeltir | sayım/manuel ayar (reason zorunlu) |

- Her ledger satırı `balance_after` taşır (o andaki on_hand) → denetim ve hızlı yeniden hesap.
- Ledger asla UPDATE/DELETE edilmez (trigger ile engelli).

### 3a. Ledger İdempotency (A-05 — ZORUNLU, satır seviyesi)
- `stock_ledger.idempotency_key` **NOT NULL + UNIQUE**. Anahtar **belge değil satır** seviyesinde üretilir; aynı hareketin retry'ı ikinci satır yaratamaz (DB conflict → no-op). Çok kalemli belge sorun yaşamaz (her satır farklı anahtar).
- Anahtar formatları:
  - `ORDER_SHIPMENT:{orderId}:{orderItemId}`
  - `TRANSFER_OUT:{transferId}:{transferItemId}` · `TRANSFER_IN:{transferId}:{transferItemId}`
  - `RETURN_IN:{returnId}:{returnItemId}`
  - `ADJUSTMENT:{adjustmentId}` · `IMPORT:{importJobId}:{importRowId}`
- Rezervasyon ledger'a yazılmaz; rezervasyon idempotency'si `stock_reservations.idempotency_key` (`ORDER_RESERVATION:{orderId}:{orderItemId}`) ile sağlanır.

### 3b. Balance Satırı Oluşturma (A-13)
- `stock_balances` satırı **lazy**: ilk RECEIPT/ADJUSTMENT atomik upsert (`ON CONFLICT (product_id, warehouse_id) DO UPDATE`) ile oluşur. İki paralel receipt → tek balance satırı + iki ledger satırı.
- Satır yokken `reserve()`/okuma → `available = 0`; yetersizse deterministik `422 INSUFFICIENT_STOCK`.

## 4. Rezervasyon Yaşam Döngüsü
```
order APPROVE  → reserve()          : reserved += qty, stock_reservations=ACTIVE
order CANCEL   → release()          : reserved -= qty, ACTIVE→RELEASED
order SHIP     → consumeReservation : on_hand -= qty, reserved -= qty, ledger SHIPMENT, ACTIVE→CONSUMED
```
- `reserve()` yetersiz available'da `InsufficientStockError` fırlatır (kısmi yok).
- Rezervasyon kalemi `(order_id, product_id)` başına tektir.

## 5. Concurrency {#concurrency}
- Her stok mutasyonu transaction içinde ve ilgili satır(lar) `SELECT ... FOR UPDATE` ile kilitli.
- Çok kalemde kilit sırası **deterministik**: `ORDER BY product_id, warehouse_id` → deadlock önleme.
- DB CHECK (`reserved ≤ on_hand`, `on_hand ≥ 0`) son emniyet ağı: kod hatası olsa bile negatif stok DB tarafından reddedilir.
- Eşzamanlı onaylar serileşir; ikinci işlem güncel `reserved`'ı görür.
- Zorunlu test: N paralel onay, toplam rezervasyon ≤ on_hand (bkz. TEST_STRATEGY).

## 6. Transfer Akışı
1. **DRAFT:** transfer + kalemler oluşturulur, stok etkisi yok.
2. **IN_TRANSIT (dispatch):** kaynak depoda her kalem için `available ≥ qty` kontrol. `on_hand -= qty`, ledger `TRANSFER_OUT` (key `TRANSFER_OUT:{t}:{i}`). Yetersizse reddedilir.
3. **COMPLETED/RECEIVED (receive):** **hedef stok yalnızca burada artar** — `on_hand += qty`, ledger `TRANSFER_IN` (key `TRANSFER_IN:{t}:{i}`).
4. **CANCELLED:** yalnızca DRAFT veya IN_TRANSIT'ten; IN_TRANSIT iptalinde kaynak `on_hand += qty` (telafi ledger, reason ile) — fiziksel mal geri döndü varsayımı.
- `source ≠ dest` (DB CHECK).
- **Concurrency:** her geçiş transfer row lock + koşullu geçiş (`WHERE status=$expected`); paralel dispatch/receive → kalem başına tek ledger (idempotency_key unique).

### 6a. Transfer Warehouse Scope (A-03/T-03 — kesin matris)
| Aksiyon | Gerekli scope | Permission |
|---------|---------------|-----------|
| create | source | `transfer:create` |
| approve | source | `transfer:approve` |
| dispatch (on_hand−) | source | `transfer:dispatch` |
| **receive (on_hand+)** | **destination** | `transfer:receive` |
| read/list | source **veya** destination | `transfer:read` |
| cancel | source (IN_TRANSIT telafisi kaynağa) | `transfer:cancel` |
| global | — | `warehouse:scope:all` |

> **Kaynak deposuna erişimi olan personel hedef deponun stoğunu doğrudan değiştiremez.** Hedef `on_hand` yalnızca **destination scope** sahibi kullanıcı receive yapınca artar. Detay: [SECURITY_MODEL §3a](../architecture/SECURITY_MODEL.md).

## 7. Stok Girişi & Düzeltme
- **RECEIPT:** mal kabul; `on_hand += qty`, ledger RECEIPT. (Import ile toplu giriş mümkün.)
- **ADJUSTMENT:** sayım farkı; `on_hand` hedef değere set edilir, fark ledger'a yazılır, **reason zorunlu**, `stock:adjust` permission. Negatif sonuç DB CHECK ile reddedilir.

## 8. Reconciliation (tutarlılık doğrulama)
- Periyodik worker job: her `(product, warehouse)` için `Σ ledger.quantity == stock_balances.on_hand` doğrular.
- Uyumsuzluk → kritik alarm + audit; otomatik düzeltme yapılmaz (manuel inceleme).
- `reserved` doğrulaması: `Σ active reservations.quantity == stock_balances.reserved`.

## 9. Redis Kullanım Sınırı
- Redis yalnızca: BullMQ kuyruğu, geçici cache (örn. dashboard aggregate, kısa TTL), rate-limit sayaçları.
- Stok kararları (rezervasyon, sevk) **asla** Redis'ten okunan değere dayanmaz; her zaman DB satır kilidi üzerinden.

## 10. Yetkiler
| Aksiyon | Permission |
|---------|-----------|
| Bakiye/ledger görüntüle | `stock:read` |
| Mal kabul (RECEIPT) | `stock:receive` |
| Düzeltme (ADJUSTMENT) | `stock:adjust` |
| Transfer oluştur/gönder/al | `transfer:create` / `transfer:dispatch` / `transfer:receive` |
- Tümü warehouse **scope** kontrolünden geçer.

## 11. Değişmezler (test edilecek)
- STK-1: on_hand/reserved hiçbir akışta negatife düşmez.
- STK-2: Her on_hand değişiminin tam karşılığı ledger'da var (Σ = on_hand).
- STK-3: Rezervasyon ledger'a yazılmaz.
- STK-4: Transfer toplam on_hand'i korur (out + in net 0, in-transit hariç).
- STK-5: Reconciliation uyumsuzlukta alarm üretir.
- STK-6: Aynı hareketin (shipment/transfer/return/import satırı) retry'ı ikinci ledger satırı/on_hand değişimi yaratmaz (idempotency_key unique — A-05).
- STK-7: Balance satırı olmayan ürün-depo için reserve → 422 INSUFFICIENT_STOCK; iki paralel receipt → tek balance satırı + iki ledger (A-13).
- STK-8: Kaynak depo personeli hedef depo stoğunu doğrudan artıramaz; hedef on_hand yalnız destination-scope receive ile artar (A-03/T-03).
