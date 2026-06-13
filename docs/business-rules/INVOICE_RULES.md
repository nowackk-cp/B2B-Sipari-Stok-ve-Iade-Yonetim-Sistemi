# Invoice & Quote Rules

> Faturalar yasal/finansal belgelerdir: kesildikten (ISSUED) sonra immutable.

## 1. Fatura Durum Makinesi
```
DRAFT ──issue──▶ ISSUED ──pay(full)──▶ PAID
  │                 │
  │                 └──void──▶ VOID (terminal)
  └──(silinebilir? hayır — soft yok; DRAFT iptal = VOID veya boş bırakma)
```
| Geçiş | Permission | Etki |
|-------|-----------|------|
| `(new) → DRAFT` | `invoice:create` | düzenlenebilir taslak |
| `DRAFT → ISSUED` | `invoice:issue` | **invoice_number atanır (`invoice_series` kilitli sayaç, boşluksuz)**, totals dondurulur, immutable olur, `issued_at` set |
| `ISSUED → PAID` | `payment:record` | toplam ödeme = grand_total olunca |
| `ISSUED → VOID` | `invoice:void` | iptal; düzeltme için CREDIT_NOTE/yeni fatura |

## 2. Immutability
- **DRAFT:** kalemler, müşteri, tarihler düzenlenebilir; totals yeniden hesaplanır.
- **ISSUED ve sonrası:** fatura ve kalemleri **değişmez**. Hata düzeltmesi:
  - `VOID` + yeni doğru fatura, veya
  - `CREDIT_NOTE` (kısmi/tam alacak dekontu).
- Fatura **asla silinmez** (DB'de delete yok).

## 3. Numara (invoice_number / invoice_no) — Gapless (A-01 BLOCKER)

> **PostgreSQL `sequence` KULLANILMAZ.** Sequence değerleri transaction rollback ile geri alınmaz → boşluk (gap) bırakır. Bunun yerine **transaction içinde kilitlenen sayaç tablosu** `invoice_series` kullanılır. Detay: [ADR-006](../decisions/ADR-006-invoice-numbering.md), [DATABASE_DESIGN §11](../architecture/DATABASE_DESIGN.md).

- Numara **yalnızca ISSUED anında** ve issue transaction'ı içinde atanır.
- `invoice_series` satırı: `(company_id, series_code, fiscal_year, prefix, next_number, version)`.
- **Atama adımları (tek transaction, sıra önemli):**
  1. invoice row lock + koşullu geçiş (`WHERE status='DRAFT'`).
  2. `SELECT ... FROM invoice_series ... FOR UPDATE` (sayaç satırı kilitlenir).
  3. `invoice_number = next_number`; faturaya yaz.
  4. `next_number += 1` (UPDATE).
  5. invoice `ISSUED`; **business audit** (`invoice.issued`); gerekiyorsa outbox event.
- **Rollback olursa** `next_number` artışı da rollback olur → **boşluk oluşmaz** (gapless garantisi, test edilir).
- **Unique:** `(company_id, series_id, fiscal_year, invoice_number)`.
- Numara almış fatura **silinmez**; iptal `VOID` durumu ile (numara korunur).

## 4. Tutar Hesabı (Money)
- Kalem: `line_subtotal = unit_price × qty`; `line_tax = round_half_up(line_subtotal × tax_rate_bp / 10000)`; `line_total = line_subtotal + line_tax`.
- Fatura: `subtotal = Σ`, `tax = Σ`, `grand_total = subtotal + tax`. Hepsi `bigint` minor unit.
- Siparişten fatura: kalemler order_items snapshot'ından kopyalanır (fiyat dondurulmuş).

## 5. Ödemeler (TST-11)
- `payments` append-only (silinmez). `Σ payments.amount == grand_total` → `PAID`, `paid_at` set.
- **Overpayment politikası:** `Σ payments.amount` grand_total'ı **aşamaz** (varsayılan); aşan ödeme `422 BUSINESS_RULE`. Bilinçli fazla ödeme gerekiyorsa açık `allow_overpayment` bayrağı + audit.
- **Partial payment:** kısmi ödemeler birikir; toplam grand_total'a ulaşınca PAID.
- **Duplicate payment idempotency:** ödeme kaydı `Idempotency-Key`/dedup anahtarı ile; aynı ödeme iki kez tutar eklemez.
- **Düzeltme:** yanlış ödeme **ters kayıt** (reversal/refund artifact, onaylı) ile; ödeme satırı silinmez, negatif tutar yazılmaz — ayrı reversal kaydı.

## 6. Teklif (Quote) Durum Makinesi
```
DRAFT ──send──▶ SENT ──accept──▶ ACCEPTED
  │               │
  │               ├──reject──▶ REJECTED
  │               └──(valid_until geçti)──▶ EXPIRED
```
| Geçiş | Permission |
|-------|-----------|
| create/update (DRAFT) | `quote:create` / `quote:update` |
| send | `quote:send` |
| accept/reject | `quote:update` |
- `ACCEPTED` teklif → sipariş veya faturaya **kopyalanarak** dönüştürülür (otomatik bağ opsiyonel, fiyatlar snapshot).
- `EXPIRED` worker job ile `valid_until < today` SENT teklifleri işaretler (idempotent).

## 7. PDF
- ISSUED fatura ve gönderilen teklif PDF olarak üretilir (worker, `documents` modülü), `files`'a kaydedilir, müşteriye e-posta eki (outbox).
- PDF üretimi idempotent (aynı belge + sürüm → tekrar üretimde aynı sonuç, yeni dosya overwrite/sürümleme).

## 8. Değişmezler (test edilecek)
- INVC-1: ISSUED fatura ve kalemleri değiştirilemez/silinemez.
- INVC-2: invoice_number boşluksuz (gapless), benzersiz, monoton.
- INVC-3: Tutarlar number kullanılmadan, kuruş hassasiyetinde.
- INVC-4: Σ ödeme = grand_total olunca PAID; overpayment policy uygulanır.
- INVC-5: Düzeltme yalnızca VOID/CREDIT_NOTE ile.
- INVC-6: Numara ayrıldıktan sonra transaction rollback olursa **boşluk oluşmaz**; bir sonraki başarılı issue ardışık numarayı alır (A-01).
- INVC-7: Paralel issue → benzersiz/monoton; aynı faturanın tekrar issue denemesi ikinci numara üretmez (idempotent).
- INVC-8: Duplicate payment çift tutar eklemez; overpayment reddedilir/audit.
