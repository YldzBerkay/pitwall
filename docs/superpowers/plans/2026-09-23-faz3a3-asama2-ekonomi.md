# Faz 3a-3 · Aşama 2 — Ekonomiyi ve Muhasebeyi Sunucuya · Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** İstemcinin kendi ekonomisini ve muhasebesini koşturmayı bırakması — ve bunun sonucunda yerel yarış motorunun sökülebilir hâle gelmesi.

**Architecture:** İstemci sunucunun görüntüsü oluyor. Ekonomi eylemleri `POST /economy/action`'a, durum `buildSlotState`'e gidiyor. Muhasebe zaten sunucuda çalışıyor; istemci onu hesaplamayı bırakıp okumaya başlıyor. Yerel motorun sökülmesi bu aşamanın **sonunda** yapılıyor, çünkü Aşama 1'de önce denendi ve muhasebeye bağlı olduğu için tıkandı.

**Tech Stack:** Expo SDK 57 · React Native 0.86 · TypeScript 5.9 · zustand · `tsx --test`

**Spec:** [2026-09-23-faz3a3-istemcinin-sunucuya-baglanmasi.md](../specs/2026-09-23-faz3a3-istemcinin-sunucuya-baglanmasi.md) §6

---

## Aşama 1'den devralınan gerçekler

Bunlar ölçüldü, varsayım değil.

### Neden bu sıra

Aşama 1'de yerel motoru sökmeyi denedim ve tıkandı. Zincir şu:

```
yerel motoru sök
  → weekend.race ve weekend.qualifying kalkar
    → settleRaceWeekend çöker (finishRace(w.race) çağırıyor)
      → sponsorlar, ödül, sıralama, maaşlar, sakatlıklar, başarımlar, sezon dönüşü çöker
```

Yani **muhasebe önce taşınmalı.** Bu planın son görevi yerel motorun sökülmesi ve
ancak o zaman mümkün.

### Yayının sözleşmesi

> Yayın, yarışı **ÇİZMEK** için gerekeni taşır; yeniden **HESAPLAMAK** için
> gerekeni değil.

`serialise()` bu yüzden `standings`, `entries` ve `rosters` göndermiyor ve
`server/test/race-live.test.ts`'te bunu koruyan bir test var. **Bu koruma
kırılmayacak.** Muhasebeyi istemciye geri getirmenin cazip yolu tam da onları
göndermektir; cevap onları göndermek değil, muhasebeyi sunucuda bırakmaktır.

`weather` ve `neutralised` çizim için gerekli olduğu için eklendi (`3b7c8b3`).
Sıralama sonucu da aynı gerekçeyle ekleniyor (Görev 1).

### Sunucuda hazır olanlar

- `POST /economy/action` — `server/src/economy/actions.ts`. Yükseltme, antrenman,
  casusluk işleri; claim mekanizması; altın→RP dönüşümü.
- `buildSlotState({lobbyId, teamKey, userId, now})` — `server/src/economy/state.ts`.
  Slot durumunun tamamı, `serverNow` dahil.
- `server/src/economy/settle.ts` — yarış muhasebesi, idempotent, bayrakla aynı
  transaction'da. **Zaten çalışıyor ve RP ödüyor.**
- `POST /gold/purchase`, `GET /gold/admob-ssv` — altın.

### İstemcide sökülecekler

| Dosya | Ne yapıyor |
|---|---|
| `mobile/src/store/slices/economySlice.ts` | Altın, reklam ödülü, altın→RP — hepsi yerel `set()` |
| `mobile/src/store/slices/driverSlice.ts` | Sürücü pazarı, sözleşmeler, maaşlar — yerel `rp` mutasyonu |
| `mobile/src/store/slices/espionageSlice.ts` | Casusluk — yerel |
| `mobile/src/store/slices/staffSlice.ts` | Personel — yerel |
| `mobile/src/store/gameStore.ts` | Fabrika, test günleri, sponsor teklifleri, `settleRaceWeekend` |

### Cihaz saati açığı

Faz 3a-1'in var olma sebebi: saati ileri almak 22 saatlik bir yükseltmeyi anında
bitiriyordu. Sunucuda kapandı, **istemcide hâlâ açık** çünkü istemci sunucuya hiç
sormuyor. Görev 3'te kapanıyor ve kanıtlanıyor.

### Ortam

```
cd server && DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test
cd mobile && npm test && npm run typecheck && npm run econ
```

Sunucu 567/567, mobil 42/42. `npm test` dış sarmalayıcı olmadan bitmeli — asılı
kalırsa bir teardown yolu bozulmuştur (`server/README.md` 5. sözleşme).

Mobilde React Native ya da Expo içeri alan modül node altında çözülmez; test
edilecek mantık onlardan arınmış olmalı. `@pitwall/shared` barrel import'u `tsc`
altında patlıyor (TS5097) — alt yol kullan.

**Commit'ler:** her görevin mesajını kendi oturumunun attribution talimatına göre
sonlandır.

---

## Görev 1: Sunucu sıralama sonucunu yayınlasın

*(Bu görev bu plan yazılırken zaten başlatıldı — kullanıcı "sıralama seansı
kalsın" kararını verdi.)*

Sıralama tariften saf olarak türüyor; `replayRace` hesaplayıp atıyor. Saklanmıyor,
açığa çıkarılıyor. Tek yarış boyunca sabit olduğu için `state` çerçevesinde
gidiyor, her `lap` çerçevesinde değil.

**Bitiş ölçütü:** sıralama abone olan istemciye ulaşıyor, deterministik, ve her
turda tekrarlanmıyor.

---

## Görev 2: İstemci sıralamayı sunucudan okusun

**Files:**
- Modify: `mobile/src/store/slices/raceSlice.ts`, `mobile/src/features/raceweek/QualifyingPanel.tsx`
- Test: `mobile/test/qualifying-from-server.test.ts`

- [ ] **Step 1: Oku ve raporla**

`QualifyingPanel.tsx` bugün `weekend.qualifying`'i nereden alıyor, hangi alanları
çiziyor. `raceSlice.ts`'in `state` çerçevesini nasıl işlediği. Gerçek satır
numaralarını raporla.

- [ ] **Step 2: Başarısız testi yaz**

1. `state` çerçevesindeki sıralama `raceSlice`'a yerleşiyor
2. Lobiye bağlıyken panel sunucunun sıralamasını okuyor, yerelini değil
3. Bağlı değilken panel yerel sıralamayı okumaya **geri dönmüyor** — sunucunun
   yarışı için yerel bir ızgara uydurmak, silmeye çalıştığımız ikinci gerçeklik

- [ ] **Step 3: Koş, düştüğünü gör**
- [ ] **Step 4: Uygula**
- [ ] **Step 5: Koş, geçtiğini gör; `npm run typecheck` ve `npm run econ`**

- [ ] **Step 6: Geri düşmemeyi kanıtla**

Bağlı değilken yerel sıralamaya geri dönen bir yol ekle. Test 3'ün düştüğünü gör.
Geri al, raporla.

- [ ] **Step 7: Commit**

---

## Görev 3: Ekonomi eylemleri sunucuya — cihaz saati açığı kapanıyor

> Bu aşamanın en önemli görevi.

**Files:**
- Create: `mobile/src/lib/api/economy.ts`, `mobile/src/store/slices/serverEconomySlice.ts`
- Test: `mobile/test/economy-api.test.ts`, `mobile/test/device-clock.test.ts`

- [ ] **Step 1: Oku ve raporla**

`server/src/economy/routes.ts` ve `actions.ts`: `POST /economy/action`'ın gerçek
gövde şekli, eylem türleri, hata kodları. `server/src/economy/state.ts`:
`buildSlotState`'in döndürdüğü `SlotState`. `mobile/src/lib/api/race.ts`: izlenecek
desen. **Brif'le çelişen her şeyi söyle.**

- [ ] **Step 2: Başarısız testi yaz**

`economy-api.test.ts` — gerçek `node:http` sunucusuyla (yerleşik desen):
1. Her eylem türü doğru yola, doğru gövdeyle, `Bearer` ile gidiyor
2. Takım anahtarı gövdede **gitmiyor** — sunucu koltuktan türetiyor
3. Sunucunun hata kodları ayırt edilebilir kalıyor, tek genel hataya düzleşmiyor
4. `buildSlotState` cevabı dilime yerleşiyor

`device-clock.test.ts` — açığın kapandığının kanıtı:
5. **İş bitiş zamanı sunucunun `serverNow`'undan hesaplanıyor**, `Date.now()`'dan
   değil
6. Cihaz saatini ileri almak hiçbir işi bitirmiyor

Test 6 bu aşamanın var olma sebebi. Sahte bir saat kullan; `Date.now()`'u
değiştirmek testin kendisini bozmasın.

- [ ] **Step 3: Koş, düştüğünü gör**
- [ ] **Step 4: Uygula**
- [ ] **Step 5: Koş, geçtiğini gör; üç tip denetimi ve `npm run econ`**

- [ ] **Step 6: Açığı kanıtla**

İş kalan süresini `Date.now()` ile hesaplayan bir yol ekle. Test 6'nın düştüğünü
gör. Geri al. **Önce/sonrayı raporla** — bu, fazın kapattığı en somut kapı.

- [ ] **Step 7: Commit**

---

## Görev 4: Yerel ekonomi dilimlerinin sökülmesi

**Files:**
- Delete: `economySlice.ts`, `driverSlice.ts`, `espionageSlice.ts`, `staffSlice.ts`
- Modify: `gameStore.ts` ve onları okuyan ekranlar
- Test: `mobile/test/no-local-economy.test.ts`

- [ ] **Step 1: Her tüketiciyi bul ve raporla**

```bash
grep -rn "economySlice\|driverSlice\|espionageSlice\|staffSlice" mobile/src mobile/app
```

Aşama 1'de brifim "tek tüketici" dedi ve **üç tanesini kaçırdı**. Grep'e güvenme,
`tsc`'nin de söylediklerine bak.

- [ ] **Step 2: Başarısız testi yaz**

1. Dört dilim dosyası yok
2. `mobile/src` altında hiçbir dosya RP/altın mutasyonu yapmıyor (metin taraması)
3. Store bu dilimler olmadan kuruluyor

- [ ] **Step 3: Koş, düştüğünü gör**
- [ ] **Step 4: Sil ve yeniden bağla**
- [ ] **Step 5: Koş, geçtiğini gör; üç tip denetimi ve `npm run econ`**

- [ ] **Step 6: Taramanın ısırdığını kanıtla**

Bir dosyaya yerel RP mutasyonu ekle. Test 2'nin düştüğünü gör. Kaldır, raporla.

- [ ] **Step 7: Commit**

---

## Görev 5: Muhasebe sunucudan okunsun

**Files:**
- Modify: `mobile/src/store/gameStore.ts` (`settleRaceWeekend`)
- Test: `mobile/test/settlement-from-server.test.ts`

> Yerel motorun sökülmesini tıkayan düğüm bu.

- [ ] **Step 1: Oku ve raporla**

`settleRaceWeekend` bugün tam olarak ne hesaplıyor (`gameStore.ts` ~744-883) ve
bunların hangileri sunucunun `settle.ts`'inde **zaten** var. Farkı raporla —
sunucuda karşılığı olmayan bir şey varsa **DUR ve söyle**, uydurma.

Bilinen fark: sunucu yarış ödülünü RP olarak ödüyor; sponsor geliri, brifing
bonusu ve rütbe puanı henüz ödenmiyor çünkü sunucuda o veri yok (Faz 3b/3c).

- [ ] **Step 2: Başarısız testi yaz**

1. Yarış bitince istemci RP'yi **sunucudan okuyor**, hesaplamıyor
2. İstemci `finishRace` **çağırmıyor**
3. Sunucunun ödemediği kalemler istemcide de uydurulmuyor

- [ ] **Step 3: Koş, düştüğünü gör**
- [ ] **Step 4: Uygula**
- [ ] **Step 5: Koş, geçtiğini gör; üç tip denetimi ve `npm run econ`**

- [ ] **Step 6: Commit**

---

## Görev 6: Yerel yarış motorunun sökülmesi

> Aşama 1'de denendi ve tıkandı. Görev 5'ten sonra artık mümkün.

**Files:**
- Modify: `mobile/src/store/gameStore.ts`
- Test: `mobile/test/no-local-race.test.ts` *(Aşama 1'de yazıldı, kırmızı duruyor)*

- [ ] **Step 1: Aşama 1'in haritasını doğrula**

`33ad8de` commit'i ve `docs/superpowers/plans/2026-09-23-faz3a3-asama1-yaris.md`'in
"PLAN HATASI" bölümü zincirin tamamını satır numaralarıyla çıkarmıştı. **Hâlâ
doğru mu kontrol et** — arada dört görev geçti.

- [ ] **Step 2: Aşama 1'in testlerini kırmızıdan yeşile götür**

`no-local-race.test.ts` zaten yazılı ve altı testi kırmızı:
1. `gameStore` hiçbir zamanlayıcı kurmuyor
2. Hiçbir modül düzeyinde yarış saati kalmadı
3. `weekend.race` yalnızca soket çerçevelerinden yazılıyor
4. Hiçbir dosya `advanceLap`/`startRace`/`simulateQualifying` **çağırmıyor**
5. `queuePit` `raceSlice.callPit`'e gidiyor *(zaten yeşil)*
6. Kopukken pit çağrısı reddediliyor *(zaten yeşil)*

- [ ] **Step 3: Sök**
- [ ] **Step 4: Koş, hepsinin geçtiğini gör; üç tip denetimi ve `npm run econ`**

- [ ] **Step 5: İki taramanın ısırdığını kanıtla**

Zamanlayıcıyı geri ekle → test 1 düşmeli. `advanceLap` çağrısı geri ekle → test 4
düşmeli. İkisini de geri al, raporla.

Bu iki tarama, yerel motorun ileride sessizce geri sızmasına karşı tek kalıcı
korumadır.

- [ ] **Step 6: Commit**

---

## Görev 7: Doğrulama ve dokümantasyon

**Files:**
- Create: `server/test/economy-client-integration.test.ts`
- Modify: `mobile/README.md`, `docs/FEATURES.md`

- [ ] **Step 1: Gerçek sunucuya karşı uçtan uca test**

`server/test/race-client-integration.test.ts` deseni izlensin (Aşama 1'de yazıldı,
istemci modüllerini göreli yolla içeri alıyor, sahte yok). Kanıtlanacak:

1. İstemci bir yükseltme başlatıyor, sunucuda görünüyor
2. Cihaz saatini ileri almak işi bitirmiyor
3. Claim edilince RP değişiyor
4. Yarış bitince muhasebe RP yazıyor ve istemci onu okuyor

**`shutdown()` çağırmayı unutma** — yoksa paket sessizce asılı kalır.

- [ ] **Step 2: `mobile/README.md`**

Ekonominin artık sunucuda olduğunu ve cihaz saatinin neden artık işe yaramadığını
yaz.

- [ ] **Step 3: `docs/FEATURES.md`**

Aşama 2'yi işaretle. **Açıkça yaz:** sponsor geliri, brifing bonusu ve rütbe puanı
hâlâ ödenmiyor (Faz 3b/3c) — kazanç döngüsü yarış ödülü kadar kapalı.

- [ ] **Step 4: Tam doğrulama**

```bash
cd server && npx tsc --noEmit -p . && DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test
cd ../mobile && npm test && npm run typecheck && npm run econ
cd ../shared && npm run typecheck
```

- [ ] **Step 5: Commit**

---

## Bitiş ölçütleri

- [ ] Üç tip denetimi temiz, iki paket de yeşil, `npm run econ` geçiyor
- [ ] Cihaz saatini ileri almak hiçbir işi bitirmiyor **(bozup kanıtlanmış)**
- [ ] İstemcide RP/altın mutasyonu yok
- [ ] İstemci `finishRace` çağırmıyor
- [ ] İstemcide tur ilerleten zamanlayıcı yok
- [ ] `weekend.race` yalnızca soketten yazılıyor
- [ ] Yayın hâlâ `standings`/`entries`/`rosters` taşımıyor

## Sırada

**Aşama 3** — yerel sezon, başarım ve sponsor kalıntılarının silinmesi;
`gameStore`'un sunucu görüntüsüne indirgenmesi.

---

## YÜRÜTME NOTU — yerel motoru sökmek iki kez daha durdu

Görev 6 (yerel motorun sökülmesi) Aşama 1'de bir, Aşama 2'de bir daha denendi ve
iki kez de haklı olarak durduruldu. Her seferinde tıkanma bir öncekinden daha
derindi.

**Birinci duruş (Aşama 1):** motoru silmek `weekend.race`'i siliyor, o da
`finishRace(w.race)` çağıran `settleRaceWeekend`'i çökertiyordu. Çözüm: muhasebe
önce sunucuya. *Yapıldı.*

**İkinci duruş (Aşama 2):** paranın taşınması yetmedi. İki sebep:

1. `settleRaceWeekend` aynı zamanda **başarımları, kariyeri, sakatlıkları, yerel
   sıralamayı, maaşları, sezon dönüşünü, casusluğu ve sürücü yaşlanmasını**
   tetikleyen tek yer. Hiçbiri sunucuda yok.
2. **Asıl tıkanma: `weekend.phase`'in sunucu kaynağı yok.** Lobi fazı sunucuda
   var ama hiçbir soket çerçevesi taşımıyor; istemciye yalnızca `GET /slots`
   üzerinden ulaşıyor. `weekend.phase`'i yalnızca yerel motorun kendi
   fonksiyonları ilerletiyor. Motoru silersen hafta sonu `'practice'`te donuyor,
   `LiveRacePanel` hiç mount olmuyor ve sunucunun canlı yarışı **arayüzde
   erişilemez** hâle geliyor.

**Sıra bu yüzden:** önce faz sunucudan gelmeli, sonra motor sökülebilir.
Sökme işinin kendisi ondan sonra mekanik.

### Yolda bulunan gerçek para hatası

Yerel ödeme düğmesi **soketin canlı olmasına** bağlıydı. Lobide oturan ve
bayraktan önce soketi düşen bir oyuncu, sunucunun zaten ödediği yarış için
kendine yerel RP yazabiliyordu. Artık lobi koltuğuna bağlı (`b830135`).

### Hâlâ sunucuda karşılığı olmayanlar

Başarımlar, kariyer, sakatlıklar, maaşlar, sezon dönüşü (istemci tarafı),
casusluk, sürücü yaşlanması, sürücü pazarı, personel. Yerel motor sökülünce
bunların da bir cevabı olmalı — Aşama 3'ün kapsamı budur ve sanıldığından
büyüktür.
