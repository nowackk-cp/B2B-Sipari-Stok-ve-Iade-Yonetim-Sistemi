# ADR-006: Fatura Numaralandırma (Gapless, invoice_series)

- **Durum:** Kabul edildi
- **Tarih:** 2026-06-13
- **İlgili bulgu:** Codex A-01 [BLOCKER], P-02 [BLOCKER], TST-07

## Bağlam
Belgeler `invoice_no` için "boşluksuz (gapless), monoton" yasal sıra istiyor ve bunu PostgreSQL `sequence` ile çözeceğini söylüyordu. **PostgreSQL sequence değerleri transaction rollback ile geri alınmaz.** Issue transaction'ı numara aldıktan sonra (PDF/outbox/audit/CHECK hatası ile) rollback olursa numara kalıcı boşta kalır → gapless ihlali (A-01).

## Seçenekler
1. **`sequence` + "boşluk void loguyla açıklanır":** gapless gevşetilir.
2. **Transaction içinde kilitlenen sayaç tablosu (`invoice_series`):** gerçek gapless.
3. **Advisory lock + ayrı sayaç.**

## Karar
**#2 — `invoice_series` sayaç tablosu, issue transaction içinde `SELECT ... FOR UPDATE`.** Sequence tabanlı gapless ifadeleri **tüm belgelerden kaldırıldı.**

### Veri modeli
`invoice_series(id, company_id, series_code, fiscal_year, prefix, next_number, version)`, `UNIQUE(company_id, series_code, fiscal_year)`.

### Atama (issue transaction, sıra önemli)
1. invoice row lock + koşullu geçiş (`WHERE status='DRAFT'`).
2. `SELECT * FROM invoice_series WHERE company_id=? AND series_code=? AND fiscal_year=? FOR UPDATE`.
3. `invoice_number = next_number`; faturaya atanır.
4. `UPDATE invoice_series SET next_number = next_number + 1, version = version + 1`.
5. invoice `ISSUED`; **business audit** (`invoice.issued`); gerekiyorsa `outbox_events`.
- **Hepsi tek transaction.** Rollback → `next_number` artışı da rollback → **boşluk yok**.
- **Unique:** `UNIQUE(company_id, series_id, fiscal_year, invoice_number)`.

### Değişmezler
- Numara almış fatura **silinmez**; iptal `VOID` ile (numara korunur). Düzeltme `CREDIT_NOTE`.
- Aynı faturanın tekrar issue denemesi ikinci numara üretmez (idempotent; status DRAFT değilse no-op/uygun hata).

## Gerekçe
- Sayaç tablosu satır kilidi, numara tüketimini transaction'a **gerçekten** bağlar; rollback sayacı da geri alır.
- `company_id`/`series_code`/`fiscal_year` ile çoklu tüzel kişilik/seri/mali yıl desteklenir (v1 tek company, alan modellenir).

## Sonuçlar
- (+) Gerçek gapless, yasal uyum; rollback boşluk bırakmaz.
- (+) Paralel issue'lar sayaç satırında serileşir (benzersiz, monoton).
- (−) Yüksek issue hacminde sayaç satırı kilit darboğazı → seri/yıl bazında satır bölme ile azaltılır.
- **Zorunlu test:** rollback-after-allocation no-gap, parallel issue unique/monotonic, retry-same-invoice no-second-number (TST-07).
