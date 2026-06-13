# ADR-005: Money Value Object (Para Gösterimi)

- **Durum:** Kabul edildi
- **Tarih:** 2026-06-13
- **İlgili bulgu:** Codex A-14 (kırık `ADR-005` referansı)

## Bağlam
PROJECT_SPEC ve ARCHITECTURE belgeleri para stratejisi için `ADR-005`'e atıf veriyordu ancak ADR mevcut değildi (A-14). Bu boşluk, geliştiricinin `decimal.js`, `dinero.js` veya saf bigint arasında farklı yorum yapmasına yol açabilirdi. Bu ADR kararı tek kaynak yapar.

## Seçenekler
1. **JS `number` (float):** ❌ kabul edilemez — IEEE-754 precision kaybı, para için yasak.
2. **`decimal.js` / `big.js`:** ondalık aritmetik kütüphanesi.
3. **`dinero.js`:** para-özel kütüphane.
4. **Saf `bigint` minor unit + ince `Money` value object:** kanonik kuruş tam sayısı.

## Karar
**#4 — Saf `bigint` minor unit temelli `Money` value object** (`packages/domain/money`).

- **Kanonik gösterim:** `BIGINT` minor unit (TRY için kuruş) + ISO 4217 `currency`.
- **Aritmetik:** tamamen `bigint`; toplama/çıkarma kayıpsız. Çarpma (miktar) `bigint × bigint`.
- **Yuvarlama:** yalnızca tanımlı noktalarda (satır vergisi) **half-up**: `tax = (subtotal × tax_rate_bp + 5000) / 10000` tarzı integer aritmetiği. Toplamlar yeniden yuvarlanmaz (kuruş tutarlılığı).
- **Yüzde:** basis points (`2000 = %20`) integer.
- **Para birimi:** farklı currency ile aritmetik **hata** fırlatır (v1 tek currency TRY; FX yok).
- **API serializasyonu:** `{ amount: string, currency: string }` — `amount` minor-unit **string** (JSON number precision riski yok).

## Gerekçe
- Harici kütüphane (decimal/dinero) gereksiz; problem zaten tam sayı kuruş ile kayıpsız çözülür. Bağımlılık yüzeyi küçülür, davranış tam öngörülebilir.
- `bigint` JS'te yerel ve kayıpsız; DB `BIGINT` ile birebir.

## Sonuçlar
- (+) Kayıpsız, deterministik, bağımlılıksız para aritmetiği.
- (+) DB ↔ domain ↔ API tutarlı (string sınırda).
- (−) Geliştirici `number`'a düşmemeli — lint kuralı + Money tipi zorunlu; code review ile denetlenir.
- (−) Çoklu currency/FX gerekince ADR genişletilecek (v2).
- A-14 kapanır: PROJECT_SPEC/ARCHITECTURE bu ADR'ye işaret eder.
