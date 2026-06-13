# Return Rules

> İade, SHIPPED siparişler için tek geri-alma mekanizmasıdır (SHIPPED sipariş iptal edilemez).

## 1. Ön Koşullar
- İade yalnızca **SHIPPED** durumundaki bir siparişe açılabilir.
- İade kalemleri sipariş kalemlerine (`order_item_id`) bağlıdır.
- İade edilebilir miktar: `sevk edilen miktar − önceki tamamlanmış iadeler`. Aşım reddedilir.

## 2. Durum Makinesi
```
DRAFT ──approve──▶ APPROVED ──receive──▶ RECEIVED ──finalize──▶ COMPLETED
  │                    │
  └──reject──▶ REJECTED◀┘
```
| Geçiş | Permission | Yan etki |
|-------|-----------|----------|
| `(new) → DRAFT` | `return:create` | yok |
| `DRAFT → APPROVED` | `return:approve` | yok (mal henüz gelmedi) |
| `DRAFT/APPROVED → REJECTED` | `return:approve` | yok (terminal) |
| `APPROVED → RECEIVED` | `return:receive` | **resellable kalemler stoğa girer** |
| `RECEIVED → COMPLETED` | `return:receive` | varsa credit note/iade faturası tetiklenir (billing) |

## 3. Stok Etkisi
- **RECEIVED** geçişinde, her kalem için:
  - `condition = RESELLABLE` **ve** `restock = true` → `on_hand += quantity` (iade siparişin kaynak deposuna), ledger `RETURN_IN` (reference RETURN). 
  - `condition = DAMAGED` → stoğa **girmez** (ledger yazılmaz; hasar/scrap süreci v1 dışı, kayıt amaçlı return_item kalır).
- Stok girişi transaction içinde, ilgili `stock_balances` satırı kilitli.
- İade rezervasyon yaratmaz; doğrudan on_hand artışı.

## 4. Finansal Etki (A-11 — netleştirildi)
- **Faturalı sipariş** iadesi `COMPLETED` olunca finansal düzeltme **zorunludur** (stok-finans ayrışmasını önlemek için). Politika (varsayılan): iade edilen tutar kadar **credit note taslağı** (`invoices.doc_type='CREDIT_NOTE'`, status DRAFT) otomatik oluşturulur ve **finance onayı** bekler (`credit-note:create`/`invoice:issue`).
  - Alternatif yapılandırma: doğrudan ISSUED credit note (otomatik) veya manuel finans görevi — biri seçilir; v1 varsayılanı **onay bekleyen taslak**.
- **Faturasız sipariş** iadesinde credit note üretilmez (yalnız stok etkisi).
- Credit note **idempotency_key** (`CREDIT_NOTE:{returnId}`) ile; aynı return tekrar finalize edilirse **çift credit note oluşmaz**.
- Orijinal fatura değişmez (immutable). Tutar hesabı orijinal kalem `unit_price` snapshot'ı üzerinden (Money, kuruş).

## 5. Değişmezler (test edilecek)
- RET-1: SHIPPED olmayan siparişe iade açılamaz.
- RET-2: İade miktarı sevk edilen − önceki iadeleri aşamaz.
- RET-3: Yalnızca RESELLABLE+restock kalem stoğa girer; her giriş ledger RETURN_IN üretir (key `RETURN_IN:{returnId}:{returnItemId}`).
- RET-4: Hasarlı iade on_hand'i artırmaz.
- RET-5: Orijinal fatura değişmez; düzeltme credit note ile.
- RET-6: Faturalı sipariş iadesi COMPLETED → tek credit note (taslak/onay politikasına göre); aynı return tekrar finalize edilirse çift credit note oluşmaz (A-11).
- RET-7: RECEIVED geçişi return row lock + koşullu geçiş; tekrar RECEIVE denemesi ikinci stok girişi yapmaz.
