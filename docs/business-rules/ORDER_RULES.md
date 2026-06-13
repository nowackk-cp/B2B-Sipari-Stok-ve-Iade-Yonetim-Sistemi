# Order Rules

> Sipariş yaşam döngüsü ve durum makinesi. Stok etkileşimi için [INVENTORY_RULES.md](INVENTORY_RULES.md) referans alınır.

## 1. Durum Makinesi

```
            create
              │
              ▼
          ┌────────┐  approve   ┌──────────┐  start-prep  ┌────────────┐  ship   ┌──────────┐
          │ DRAFT  │──────────▶ │ APPROVED │────────────▶ │ PREPARING  │───────▶ │ SHIPPED  │ (terminal)
          └───┬────┘            └────┬─────┘              └─────┬──────┘         └──────────┘
              │ cancel               │ cancel                   │ cancel
              ▼                      ▼                          ▼
          ┌─────────────────────── CANCELLED ───────────────────────┐ (terminal)
          (SHIPPED'ten CANCELLED YASAK → iade süreci)
```

İzinli geçişler (whitelist):

| From → To | İzin | Yan etki |
|-----------|------|----------|
| `(new) → DRAFT` | create | yok |
| `DRAFT → APPROVED` | `order:approve` | **stok rezerve** (atomik) |
| `DRAFT → CANCELLED` | `order:cancel` | yok |
| `APPROVED → PREPARING` | `order:prepare` | rezervasyon korunur |
| `APPROVED → CANCELLED` | `order:cancel` | rezervasyon serbest |
| `PREPARING → SHIPPED` | `order:ship` | on_hand− & reserved− (ledger SHIPMENT) |
| `PREPARING → CANCELLED` | `order:cancel` | rezervasyon serbest |
| **diğer tüm geçişler** | — | **reddedilir** (`InvalidStateTransition`) |

- `SHIPPED → *` **yasak** (terminal). İptal yerine [RETURN_RULES.md](RETURN_RULES.md).
- `CANCELLED → *` yasak (terminal).
- Her geçiş `order_status_history`'ye append edilir (from, to, actor, reason).

### 1a. Eşzamanlı Durum Geçişi Koruması (A-04/T-04 HIGH)

Aynı siparişe paralel `approve`/`cancel`/`prepare`/`ship` istekleri (farklı `Idempotency-Key` ile bile) **çiftlenmemelidir**. Üç katman:

1. **Order row lock:** Her geçiş transaction'ı önce `SELECT * FROM orders WHERE id=$id FOR UPDATE`.
2. **Expected-status koşullu geçiş:** `UPDATE orders SET status=$new WHERE id=$id AND status=$expected`; **affected rows = 0** ise başka transaction geçişi yapmış → `409 INVALID_STATE`.
3. **Command idempotency:** `command_idempotency` tablosu (`command_type`, `aggregate_id`, `key`); aynı komut+key replay kayıtlı yanıtı döner. Reservation/ledger satır-seviyesi unique anahtarları (A-05) son emniyet ağıdır.

**Kilitleme sırası (deadlock önleme, kesin):**
1. `orders` (row lock)
2. `order_items`
3. `stock_balances` — **her zaman `ORDER BY warehouse_id, product_id` artan** sırada `FOR UPDATE`.

> Sonuç: iki paralel approve → tek transition, tek reservation seti, tek history/audit. İki paralel ship → kalem başına tek SHIPMENT ledger, tek consumed reservation.

## 2. DRAFT Kuralları
- Stok **etkilenmez**.
- Kalemler (`order_items`) yalnızca DRAFT'ta eklenir/güncellenir/silinir.
- Toplamlar (subtotal/tax/grand_total) kalem değiştikçe yeniden hesaplanır (server-side, Money). **Client'tan gelen `subtotalAmount`/`taxAmount`/`grandTotal` daima reddedilir/yok sayılır.**
- Müşteri ve kaynak depo DRAFT'ta atanır/değiştirilebilir.
- **Aktif ürün doğrulaması (T-08):** kalem ekleme/güncellemede ve APPROVE anında ürün `deleted_at IS NULL AND is_active=true` olmalı. DRAFT'tayken ürün silinirse approve `422 BUSINESS_RULE` ile reddedilir, rezervasyon oluşmaz. Quote→order kopyalama da güncel aktiflik kontrolünden geçer.

## 2a. Fiyatlandırma ve Price Override (A-06/T-07 HIGH)

- **Fiyat kaynağı server'dır.** Kalem `list_price_amount` ve varsayılan `unit_price_amount` **server tarafından** `products.list_price_amount`'tan doldurulur. **Client `unitPrice`/totals gönderemez** (mass-assignment reddi).
- **Override yalnız yetkiyle:** `unit_price` ancak `order:price:override` permission'ı olan kullanıcı tarafından, **zorunlu `reason`** ile değiştirilebilir. Override:
  - `order_price_overrides` kaydı: `original_price`, `overridden_price`, `discount_pct_bp`, `reason`, `actor_user_id`, `created_at`.
  - `discount_pct_bp` indirim eşiğini (örn. %20) aşarsa `requires_approval=true` → onay (`approved_by`) gerekir.
  - **Business audit** (`order.price.override`) aynı transaction.
- Yetkisiz kullanıcının `unitPrice` düşürme denemesi → `403`/`422`; UI'da alan gizli olsa da doğrudan API çağrısı reddedilir.

## 3. APPROVED — Onay (kritik)
- Ön koşullar: en az 1 kalem, geçerli müşteri, geçerli kaynak depo, tüm kalemler aktif ürün.
- **Atomik rezervasyon:** order row lock + koşullu geçiş (`WHERE status='DRAFT'`) sonrası; tüm kalemler için `available ≥ quantity` olmalı. Tek transaction içinde her `(product, warehouse)` satırı `ORDER BY warehouse_id, product_id` sırasıyla kilitlenir (`FOR UPDATE`), `reserved += quantity`; rezervasyon satır anahtarı `ORDER_RESERVATION:{orderId}:{orderItemId}` (unique).
- **Yetersiz stok:** herhangi bir kalemde `available < quantity` ise işlem **tamamen reddedilir** (`InsufficientStockError`), hiçbir kalem rezerve edilmez (all-or-nothing). Sipariş DRAFT kalır.
- Başarılıysa: `status=APPROVED`, `approved_by/approved_at` set, `stock_reservations` kayıtları ACTIVE, status_history + audit yazılır.
- **Concurrency:** eşzamanlı iki onay aynı stoğu tüketemez (row lock + CHECK `reserved ≤ on_hand`). Bkz. [INVENTORY_RULES §Concurrency](INVENTORY_RULES.md#concurrency).
- **İdempotency:** `Idempotency-Key` ile çift onay çift rezervasyon yapmaz.

## 4. PREPARING — Hazırlama
- Yalnızca APPROVED → PREPARING.
- Rezervasyon **korunur** (stok değişmez).
- Depo personeli toplama/paketleme yapar; sistemsel stok etkisi yok.

## 5. SHIPPED — Sevkiyat
- Yalnızca PREPARING → SHIPPED.
- Her aktif rezervasyon için: `on_hand -= quantity`, `reserved -= quantity` **birlikte** (tek transaction), `stock_ledger` SHIPMENT (quantity negatif), reservation `CONSUMED`.
- `shipped_at` set. Terminal başarı durumu.
- İnvariant: işlem sonrası `on_hand ≥ 0`, `reserved ≥ 0` (DB CHECK).

## 6. CANCELLED — İptal
- DRAFT'tan: serbest (stok yok).
- APPROVED/PREPARING'ten: tüm ACTIVE rezervasyonlar `reserved -= quantity`, reservation `RELEASED`. `on_hand` değişmez.
- SHIPPED'ten: **yasak**.
- `cancelled_at` + zorunlu `reason`.

## 7. Toplam Hesaplama (Money)
- Kalem: `line_subtotal = unit_price × quantity`; `line_tax = round_half_up(line_subtotal × tax_rate_bp / 10000)`; `line_total = line_subtotal + line_tax`.
- Sipariş: `subtotal = Σ line_subtotal`, `tax = Σ line_tax`, `grand_total = subtotal + tax`.
- Tüm aritmetik `bigint` minor unit; yuvarlama yalnızca satır vergisinde (toplamların yeniden yuvarlanması yok → kuruş tutarlılığı).
- Fiyat snapshot: kalem `unit_price` onay/oluşturma anındaki değerle dondurulur.

## 8. Yetkiler
| Aksiyon | Permission |
|---------|-----------|
| Oluştur/düzenle (DRAFT) | `order:create` / `order:update` |
| Fiyat override | `order:price:override` |
| Onayla | `order:approve` |
| Hazırlığa al | `order:prepare` |
| Sevk et | `order:ship` |
| İptal | `order:cancel` |
| Görüntüle | `order:read` |
- Tümü ayrıca kaynak depo **scope** kontrolünden geçer.

## 9. Değişmezler (test edilecek)
- ORD-1: İzinsiz durum geçişi reddedilir.
- ORD-2: Yetersiz stokta onay siparişi DRAFT bırakır, hiçbir rezervasyon oluşmaz.
- ORD-3: Eşzamanlı onaylarda toplam rezervasyon ≤ on_hand.
- ORD-4: SHIPPED sipariş iptal edilemez.
- ORD-5: İptal edilen APPROVED/PREPARING siparişin rezervasyonu tamamen serbest bırakılır.
- ORD-6: SHIPPED sonrası on_hand & reserved doğru azalır, ledger SHIPMENT kaydı oluşur.
- ORD-7: Para toplamları number kullanılmadan, kuruş hassasiyetinde.
- ORD-8: Aynı siparişe **farklı key ile** iki paralel approve/ship → tek transition, tek reservation/SHIPMENT seti, tek history/audit (A-04).
- ORD-9: Yetkisiz `unitPrice` override → 403/422; yetkili override reason + `order_price_overrides` + audit üretir; client totals yok sayılır (A-06).
- ORD-10: Soft-deleted/inaktif ürün DRAFT'a eklenemez; DRAFT'tayken silinen ürün approve'da 422, rezervasyon yok (T-08).
