# Faz 3b-2 — Sürücüler ve Personel · Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sürücüleri ve personeli sunucuya taşımak; üstüne maaş, sakatlık, yaşlanma ve rütbe puanını kurmak.

**Architecture:** Sürücüler ve personel lobi başına sunucu satırları. Pazarlar tohumdan üretilir, imzalanmış olmak saklanır. Kadrolar yarış tarifinde ışıklar sönerken donar. Maaş ve sakatlık muhasebenin transaction'ında, yaşlanma ve rütbe puanı sezon dönüşünün transaction'ında.

**Tech Stack:** Node 24 · TypeScript · Postgres 17 · Expo / React Native · `tsx --test`

**Spec:** [2026-09-27-faz3b2-surucu-personel.md](../specs/2026-09-27-faz3b2-surucu-personel.md)

---

## DURUM — oturum sonu (2026-09-27)

Sunucu **780/780**, mobil **193/193**, üç tip denetimi temiz, `econ` geçiyor,
ağaç temiz. Son commit `dcfd271`.

| Aşama | Durum | Commit'ler |
|---|---|---|
| **A** Sürücüler sunucuda | ✅ | `303facb` şema · `66be8a3` tarifte donma · `f50b6fd` yaşlanma |
| **B** Pazar, sözleşme, antrenman | ✅ | `8618efc` pazar · `9c3513e` geçici sürücü · `0687a63` antrenman |
| **C** Personel | ✅ | `ab611ff` pazar · `e1a9f35` etkiler · `dcfd271` boş koltuk = 40 |
| **D** Maaş ve sakatlık | ⬜ **sırada** | |
| **E** Rütbe puanı | ⬜ | |
| **F** İstemci | ⬜ | |

### Yürütmede verilen kararlar (kullanıcıyla)

- **Sözleşmesi biten insan yarış koltuğu → geçici sürücü** oturur, oyuncu yenisini
  imzalayana kadar. (Ajan önce koltuğu 1 yılda sabitlemişti; bu yenilemeyi
  anlamsız kılıyordu.) `stopgapDriver` artık `shared/`'da.
- **Personelsiz insan takımı = 40 beceri.** Motorun "alan boş" varsayılanları
  cömertti: personelsiz takım en iyi strateji uzmanıyla aynı brifingi bedavaya
  alıyordu, yani personel tutmamak zayıf personel tutmaktan iyiydi. İstemcinin
  orijinal tasarımı geri getirildi. AI takımları motor varsayılanlarında kalıyor.

### Aşama D için bilinmesi gerekenler

- **Geçici sürücü mekanizması hazır** (`seatStopgapDriver`) — sakat sürücünün
  yerine de o ya da en iyi yedek girecek.
- **Personel sözleşmeleri zaten muhasebede işliyor** (`tickStaffContracts`), yani
  maaşın muhasebeye eklenmesi aynı yere oturuyor.
- **Maaş kararı:** ödeyebildiği kadar, `chargeRpFloor` ile, gelirden SONRA, aynı
  transaction'da, gerçek tutar bildirilir.

### Açık kalanlar (Aşama F'de kapanmalı)

- **Brifing istemciye hiç gönderilmiyor.** Sunucu onu yalnızca muhasebede
  hesaplıyor; oyuncu takip etmesi gereken brifingi göremiyor. Mobil hâlâ kendi
  yerel kopyasını üretiyor.
- **Antrenman `stat`'ı isteğe bağlı.** İstemci göndermezse antrenman sessizce
  hiçbir şey yapmaz — Aşama F'de istemcinin gönderdiği kanıtlanmalı.
- **Yedek kadro antrenmanı** kapsam dışı bırakıldı (kararlı bir sıra indeksi yok).

### Bu fazda dört kez görülen hata sınıfı: tohum lobiler arası tekrarlıyor

Casusluk sonucu (takım adının **uzunluğu**), kışın gelişme, sürücü pazarı ve
personel pazarı — dördü de lobi içermeyen bir tohumla her lobide aynı davranıyordu.
`strHash` artık `shared/rng.ts`'te; yeni tohumlanmış her kural lobiyi içermeli.

### Paralel iş

Kararsız sunucu testlerinin ortak sebebini arayan ayrı bir oturum koşuyor
(`task_cd27bf6a`). **Aynı test veritabanını paylaşıyor** — o koşarken burada
görülen tek seferlik bir düşüş, iki oturumun çakışmasından olabilir.

---

## Başlangıç durumu

Sunucu **712/712**, mobil **193/193**, üç tip denetimi temiz, `npm run econ`
68 iddiayla geçiyor, ağaç temiz.

## Her görevin kontrol listesi

Önceki fazlarda her biri gerçek bir hataya yol açtı:

- [ ] **Üretimde kim çağırıyor?** Yeni kodun üretim yolu raporda gösterilir.
      Dört kez bir fonksiyon testlendi ve hiçbir şey çağırmadı.
- [ ] **Sunucu bunu dışa veriyor mu?** İstemci ekranı taşınmadan kontrol edilir.
- [ ] **`shared/` içeri alınır, yeniden yazılmaz.**
- [ ] **Bildirilen = gerçekleşen.**
- [ ] **İstemcinin gönderdiği şartlar okunmaz.**
- [ ] `withTransaction` yalnızca fırlatmada geri alır.
- [ ] Transaction içindeki okuma transaction'ın client'ını alır.
- [ ] Havuzu ısıtmayan eşzamanlılık testi hiçbir şey kanıtlamaz.
- [ ] Her garanti bozma/geri alma ile kanıtlanır.

---

## Aşama A — Sürücüler sunucuda var

> Tek başına, çünkü her yarışı değiştiren denge olayı bu.

### Görev A1: Şema ve tohumlama

Lobi başına sürücü satırları: koltuk (0/1), yedek kadro ya da serbest. Sözleşme
(`seasonsLeft`, `wage`). Her takım `teams.ts` varsayılanlarından tohumlanır;
lobi kurulurken ya da ilk ihtiyaçta — hangisi, gerekçesiyle.

**Kanıt:** her takımın iki koltuğu dolu; aynı sürücü iki yerde olamaz.

### Görev A2: Kadrolar yarış tarifinde donar

`buildFrozenEntries` / anlık görüntü kadroları okur; `rosters: {}` kalkar.

**Kanıtlar:** yeniden oynatma kadroyla bit bazında aynı; ışıklardan sonra
satılan sürücü koşmuş yarışı değiştirmiyor; `econ` geçiyor.

### Görev A3: Kışın yaşlanma ve gelişme

`rollover.ts`'in sezon dönüşü transaction'ından çağrılan ayrı modül:
`ageOneSeason`, gelişme, sözleşme süreleri. AI sözleşmeleri kendiliğinden
yenilenir; insan sözleşmeleri biter.

**Kanıtlar:** herkes bir yaş büyüyor; sezon dönüşü iki kez tetiklenirse bir kez.

---

## Aşama B — Pazar, sözleşmeler, yedek kadro, antrenman

### Görev B1: Sürücü pazarı

Lobi geneli, tohumdan üretilen adaylar, imzalanmış olmak saklanır. İmza,
sürenin satış, yenileme uçları.

**Kanıtlar:** ilk imzalayan alır (havuz ısıtılmış eşzamanlılık); istemcinin
gönderdiği ücret yok sayılıyor; imzalanan sürücü pazardan düşüyor.

### Görev B2: Antrenman sonucu sürücüye yazar

Claim edilen antrenman sürücü statına yazar.

**Kanıt:** claim edilen antrenman statı değiştiriyor, bir kez.

---

## Aşama C — Personel

### Görev C1: Personel pazarı ve işe alım

Lobi geneli, ilk işe alan alır.

### Görev C2: Personel etkileri

Yedi etkinin her biri gerçek bir sunucu yoluna: yükseltme kazancı, güvenilirlik,
brifing, asistan hatası, pit süresi ve arızası.

**Kanıt:** her etki için, personel varken ve yokken ölçülebilir fark.

---

## Aşama D — Maaşlar ve sakatlıklar

### Görev D1: Maaşlar muhasebede

Gelirden sonra, aynı transaction'da, `chargeRpFloor` ile. Döküme yazılır.

**Kanıtlar:** bildirilen = kesilen, sıfırda tabanlı durum dahil; muhasebe iki
kez maaş kesmiyor.

### Görev D2: Sakatlıklar

Muhasebe `injured`'ı okur, 1-2 yarış işaretler; sonraki yarışta yedek girer.

**Kanıt:** sakat sürücü sonraki yarışın donmuş katılımında yok.

---

## Aşama E — Rütbe puanı

Sezon sonunda, hedef tuttuysa, kullanıcıya.

**Kanıtlar:** tutunca yazılıyor, tutmayınca yazılmıyor; sezon dönüşü tekrarlansa
bir kez; kariyer puanına dokunmuyor.

---

## Aşama F — İstemci

Padok ve yönetici ekranları sunucuya. `driverSlice.ts` ve `staffSlice.ts`
silinir.

**Kanıt:** lobi yoksa yerel kadroya geri düşülmüyor; metin taraması —
istemcide yerel sürücü/personel mutasyonu kalmadı.

---

## Bitiş ölçütleri

- [ ] Üç tip denetimi temiz, iki paket yeşil, `npm run econ` geçiyor
- [ ] Spec §7'nin dokuz kapısı bir değişmez dosyasında, her biri kanıtlı
- [ ] `docs/FEATURES.md`, `server/README.md`, `mobile/README.md` güncel

## Sonra

AI transfer penceresi ve akademi terfisi; sprint yarışları.
