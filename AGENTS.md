# AGENTS.md

> Bu repoda otonom çalışan kodlama ajanları için sözleşme. [CLAUDE.md](CLAUDE.md) ile birlikte okunur; ayrıntılı kurallar oradadır. Burada **iş akışı ve sınırlar** özetlenir.

## 1. Başlamadan Önce
1. [PROJECT_SPEC.md](PROJECT_SPEC.md) ve ilgili `docs/` belgesini oku.
2. [IMPLEMENTATION_PLAN.md](docs/tasks/IMPLEMENTATION_PLAN.md)'dan bir **TASK** seç; bağımlılıkları (`Bağımlılık`) tamamlanmış olmalı.
3. Görevin kapsamını aşma. Bir görev = bir PR.

## 2. Çalışma Döngüsü (her görev)
1. Görevin "Düzenlenecek dosyalar"ını uygula.
2. Görevin "Testler"ini yaz (önce/birlikte). Kritik iş kuralında concurrency testi şart.
3. Yerel doğrulama: `pnpm lint && pnpm typecheck && pnpm test` + görevin "Doğrulama komutları".
4. "Kabul kriterleri"nin tümünü madde madde karşıla.
5. Değişiklik özeti + hangi kriterin nasıl karşılandığını PR'da belgele.

## 3. Değişmez Sınırlar (asla ihlal etme)
- Frontend → DB doğrudan **yok**; her şey `/api/v1`. ORM entity API'de expose edilmez (public DTO).
- Business logic yalnız `packages/domain` + API service. Controller/React **ince**.
- Para = `Money` (saf bigint minor unit), asla `number`. Fiyat client'tan alınmaz.
- Stok/finans = tek transaction + row lock; append-only tablolara UPDATE/DELETE yok.
- Durum geçişi = order/aggregate row lock + expected-status koşullu update; kilit sırası order→order_items→stock_balances.
- Ledger/effect idempotency = satır-seviyesi unique anahtar (çift hareket/yan-etki yok).
- orders/invoices/ledger/audit **silinmez**; master data soft-delete.
- **Fatura numarası = `invoice_series` kilitli sayaç (gapless); `sequence` yasak.**
- **Yetki: SYSTEM_ADMIN protected sistem rolü; ADMIN grant ceiling** (self-escalation/protected atama yasak). **Implicit global warehouse scope YOK (ADMIN dahil)** — yalnız açık `user_warehouse_scopes` veya protected `warehouse:scope:all` (yalnız SYSTEM_ADMIN atar).
- **Business audit mutasyonla aynı tx** (async/event/outbox consumer DEĞİL); operational/security log + projeksiyon tx dışı.
- **Worker effect: `effect_receipts` state modeli (PLANNED→SUCCEEDED) + provider_idempotency_key**; SUCCEEDED'sız effect tamam sayılmaz; provider idempotency yoksa exactly-once garanti yok (`UNKNOWN`+manuel).
- **Transfer scope:** receive=destination; kaynak personeli hedef stoğu doğrudan değiştiremez.
- Redis stok doğruluğu kaynağı değil. Job'lar idempotent (at-least-once varsayımı).
- Modüller arası yalnız service interface; çağrılan servis `tx` parametre alır.

## 4. Definition of Done
- [ ] Kabul kriterleri tam.
- [ ] Testler yazıldı ve yeşil (gerekliyse concurrency).
- [ ] `lint + typecheck + test` geçiyor; migration drift yok.
- [ ] API değiştiyse OpenAPI + api-client regenerate, drift testi geçiyor.
- [ ] Audit gereken mutasyonlar audit yazıyor; hatalar RFC 7807.
- [ ] Belge güncellemesi gerekiyorsa `docs/` güncellendi.

## 5. Komutlar
```bash
docker compose up -d
pnpm install
pnpm --filter @b2b/db migrate
pnpm dev
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @b2b/web test:e2e
pnpm gen:api-client      # OpenAPI → client
```

## 6. Belirsizlik Politikası
- Küçük/teknik belirsizlik: [PROJECT_SPEC.md §6](PROJECT_SPEC.md) varsayımlarıyla tutarlı, makul kararı kendin ver ve PR'da belirt.
- İş kuralını değiştirecek belirsizlik: önce ilgili `docs/business-rules` + ADR'lere bak; çelişki varsa görevi durdur, soru/karar kaydı (yeni ADR önerisi) bırak.

## 7. Yasaklar
- ❌ Kapsam dışı dosya/davranış değiştirme.
- ❌ Test atlamak, `lint`/`typecheck` susturmak.
- ❌ Güvenlik/yetki/transaction kurallarını "geçici" diye esnetmek.
- ❌ Secret commit'lemek; loglara token/parola yazmak.
- ❌ Append-only/immutable veriyi değiştirmek.
