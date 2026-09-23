# Faz 3a-3 · Aşama 1 — Yarışı Sunucuya Bağla · Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** İstemcinin yarışı kendi simüle etmeyi bırakıp sunucunun yarışını göstermesi — ve kopukken bunu dürüstçe söylemesi.

**Architecture:** İstemci ikinci bir gerçeklik olmaktan çıkıp sunucunun görüntüsü oluyor. Yerel yarış motoru ve saati siliniyor; `weekend.race`'e yalnızca `/race/live` soketi yazıyor. Bağlantı durumu birinci sınıf bir kavram: kopukken ekran donuyor ve kopuk olduğunu söylüyor, yarış uydurmuyor.

**Tech Stack:** Expo SDK 57 · React Native 0.86 · TypeScript 5.9 · zustand · `tsx --test` (yeni)

**Spec:** [2026-09-23-faz3a3-istemcinin-sunucuya-baglanmasi.md](../specs/2026-09-23-faz3a3-istemcinin-sunucuya-baglanmasi.md)

---

## DURUM

**Bitti:** Görev 1 (`1ae9e64`+`4cea7a9`), 2 (`af9b25e`), 3 (`e8794ff`), 4 (`55cd387`),
5 (hafta sonu tercihleri), 7 (`1559deb` — ölü lig dilimi silindi).
**Kısmen:** Görev 6 (`33ad8de`) — pit yolu sunucuya bağlandı, yerel motor DURUYOR.
**Sırada:** aşağıdaki yeniden planlama.

### PLAN HATASI — Görev 6 Aşama 1'de bitemez

Spec §3 *"`LiveRacePanel` jenerik bir `RaceState` okuyor, yeniden yazılmayacak"*
diyordu. **Yanlış.** Soket `RaceState` değil, daraltılmış bir `SerialisedRace`
gönderiyor ve panel onda olmayan alanları okuyor (`weather.forecast`,
`neutralised`). Görev 6 bunu bulup durdu ve doğru yaptı.

Gerçek bağımlılık zinciri:

1. **Sunucu yayını çizmeye yetmeli** — `weather` ve `neutralised` eklenmeli.
   *(Yapılıyor. `standings`/`entries` EKLENMİYOR: yayın yarışı ÇİZMEK için
   gerekeni taşır, yeniden HESAPLAMAK için gerekeni değil — onları göndermek
   istemcinin kendi muhasebesini koşturmaya devam etmesine izin verirdi.)*
2. **Yerel muhasebe sunucuya taşınmalı** — `settleRaceWeekend` `finishRace(w.race)`
   çağırıyor, o da `state.weather` ve `state.standings` istiyor. Bu **Aşama 2**.
3. **Sıralama seansının karşılığı yok** — sunucu ızgarayı `startRaceFor` içinde
   türetiyor, dışa vermiyor. `weekend.qualifying` ise `settleRaceWeekend`'in ön
   koşulu. Karar gerekiyor: sunucu ızgarayı yayınlasın mı, yoksa çevrimiçi hafta
   sonundan sıralama seansı kalksın mı?

**Sonuç: yerel motorun sökülmesi Aşama 2'nin SONUNA taşındı.** Aşama 1, Görev 8
(entegrasyon + dokümantasyon) ile kapanıyor; yerel motor duruyor ama pit yolu
canlı ve ölü uçlar temizlendi.

Bunu Aşama 1'de zorlamak, tek commit'te 982 satırlık store'un sezon/ekonomi
yolunu da baştan yazmak olurdu — kimsenin inceleyemeyeceği bir değişiklik.

Mobil: 24/24 test, tipler temiz, `npm run econ` geçiyor.
Sunucu: 562/562, üç tip denetimi temiz. Ağaç temiz.

### Yürütmede çıkan, sonraki görevlere taşınan

- **`POST /race/pit` gövdesinde `driverIdx` (0|1) ZORUNLU.** Plandaki tabloda
  eksikti; Görev 2 koda bakıp düzeltti. İstemcide karşılığı var — `PlayerDecisions`
  zaten iki elemanlı demet. Görev 4'ün pit çağrısı hangi aracın pite gireceğini
  sormak zorunda.
- **Node tipleri artık `mobile/tsconfig.json`'da** (`types: ["node"]`). Yeni test
  dosyalarında `/// <reference types="node" />` gerekmiyor.
- **`@pitwall/shared` barrel import'u `tsc` altında patlıyor** (TS5097 — `index.ts`
  açık `.ts` uzantılarıyla re-export ediyor). Bu yüzden mobilde hiçbir dosya bare
  import kullanmıyor, hepsi `@pitwall/shared/economy` gibi alt yollardan giriyor.
  Aynı kurala uy; düzeltmek ayrı bir iş.
- Mobil testlerde sahte `fetch` yerine gerçek `node:http` sunucusu kaldırmak
  yerleşmiş desen (`smoke.test.ts`, `race-api.test.ts`) — başlık ve serileştirme
  hatalarını stub'ın kaçırdığı yerde yakalıyor.

---

## Uygulayıcının bilmesi gerekenler

Koda bakılarak doğrulandı.

### Sunucunun yarış yüzeyi

| Uç | Gövde | Notlar |
|---|---|---|
| `POST /race/checkin` | `{lobbyId}` | Yalnızca `checkin` fazında |
| `POST /race/pit` | `{lobbyId, compound, lap?}` | Yalnızca `live`; `lap` verilmezse sunucu bir sonrakini seçer |
| `POST /race/weekend-choices` | `{lobbyId, compound?, bias?, tactics?, qualiRisk?}` | `open` ve `checkin`; `live`'da 409 |
| `WS /race/live` | `{type:'subscribe', lobbyId, token}` | Çerçeveler: `state`, `lap`, `unsubscribed`, `error` |

Hepsi `Authorization: Bearer` ister (soket hariç — token ilk mesajda gider).
**Takım anahtarı hiçbir zaman gövdeden okunmaz**, sunucu koltuktan türetir.

Sunucunun hata kodları anlamlı ve UI'a taşınmalı: `lap_already_run`,
`already_decided`, `not_checked_in`, `race_not_started`, `race_finished`.

### İstemcide bugün ne var

- `mobile/src/lib/api/identity.ts` ve `lobby.ts` — **izlenecek desen**. Yeni API
  modülü bunlara benzemeli.
- `mobile/src/store/slices/leagueSlice.ts` (162 satır) — tamamen ölü, dört
  silinmiş uca ve `/live`'a çağrı yapıyor. `leagueSlice.ts:132`'deki
  `syncLeagueWeekend` tercihleri zaten paketliyor; şekli işe yarar, hedefi yanlış.
- `mobile/src/store/gameStore.ts` (982 satır) — yerel yarış: `RACE_TICK_MS`,
  modül düzeyinde `setInterval` (`:640`, `:687`), `advanceRaceLap` (`:701`),
  `startRaceSession`, `queuePit` (`:693`).
- `mobile/src/features/raceweek/LiveRacePanel.tsx` — `weekend.race`'i okuyor,
  **kaynağı umursamıyor**. Yeniden yazılmayacak.
- `PracticePanel.tsx` — bias seçici (`:10-16,26,50`).
- `QualifyingPanel.tsx` — sıralama lastiği (`:57-73`), risk, yarış lastiği
  (`:204`), taktik (`:15-19,223,227`).
- `LeagueCard.tsx` — ham sunucu URL'si alan bir kart; `DEFAULT_URL` `:9`.

### Alınmış kararlar (spec §2, §5.1)

- **Yerel motor tamamen kalkıyor.** Bağlantı koparsa yerele düşmek REDDEDİLDİ:
  farklı bir yarış çizmek, fazın tüm amacını en görünür anda bozar.
- **İki lastik seçici bire iniyor.** Motorda `CarSetup.compound` tek alan; F1'de
  Q2 kuralı zaten böyle ve pit yolundan başlamanın "serbest lastik" telafisi tam
  olarak bu bağlanmadan muafiyet.
- **Kopukken pit çağrısı kabul edilmez**, kuyruğa da alınmaz.

### Ortam

```
cd mobile && npm run typecheck && npm run econ
```

`npm run econ` denge kapısı geçmeye devam etmeli. Sunucu paketi **562/562**
geçiyor ve bozulmamalı.

Sunucuyu elle kaldırmak gerekirse:
```bash
cd server && DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall \
SESSION_SECRET=local-dev-secret-at-least-32-chars EMAIL_HASH_PEPPER=local-pepper \
PORT=8787 npx tsx src/index.ts
```

**Commit'ler:** her görevin mesajını kendi oturumunun attribution talimatına göre sonlandır.

---

## Dosya yapısı

| Dosya | Sorumluluk |
|---|---|
| `mobile/src/lib/api/race.ts` | Yarış HTTP uçları |
| `mobile/src/lib/api/raceSocket.ts` | `/race/live` soketi, yeniden bağlanma, durum |
| `mobile/src/store/slices/raceSlice.ts` | Bağlantı durumu, abonelik, gelen çerçeveler |
| `mobile/src/store/slices/leagueSlice.ts` | **Silinir** (Görev 7) |
| `mobile/src/store/gameStore.ts` | **Değişir** — yerel yarış yolu sökülür |
| `mobile/src/features/raceweek/` | Tercih gönderimi, bağlantı rozeti |

---

## Görev 1: Mobil test altyapısı

Mobil tarafta **hiç test yok** — ne jest, ne vitest, tek dosya bile. Spec'in yedi
garantisi bu hâliyle yazılamaz.

**Files:**
- Modify: `mobile/package.json`
- Create: `mobile/test/smoke.test.ts`

- [ ] **Step 1: Ne olduğunu doğrula ve raporla**

```bash
cd mobile && cat package.json && ls test 2>/dev/null
```

- [ ] **Step 2: `tsx --test` ekle**

Ağır bir React Native test yığını (jest-expo, testing-library) **kurma**. Bu
aşamanın garantileri bileşen çizimiyle değil, store mantığı ve soket istemcisiyle
ilgili — hepsi düz TypeScript. `tsx` zaten bir devDependency (`econ` onu
kullanıyor) ve `shared/` ile sunucu aynı koşucuyu kullanıyor.

`package.json`'a ekle: `"test": "tsx --test --test-concurrency=1 test/*.test.ts"`.

React Native'e ya da Expo'ya bağlı bir modülü içeri alan test yazılamaz —
node altında çözülmezler. Bu bir sınırlama değil, sınır: test edilecek mantık
zaten bu bağımlılıklardan arınmış olmalı. Bunu `mobile/test/README.md` yerine
`package.json`'daki script'in yanına kısa bir yorumla değil, Görev 8'de
`mobile/README.md`'ye yaz.

- [ ] **Step 3: Çalıştığını kanıtlayan bir duman testi yaz**

`mobile/test/smoke.test.ts` — `@pitwall/shared`'dan bir sabit içeri alıp
doğrulasın. Bu, hem koşucunun hem de yol takma adlarının çalıştığını gösterir.

- [ ] **Step 4: Koş**

```bash
cd mobile && npm test && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add mobile/package.json mobile/test/smoke.test.ts
git commit -m "chore(mobile): tsx tabanlı test koşucusu"
```

---

## Görev 2: `race.ts` — yarış HTTP istemcisi

**Files:**
- Create: `mobile/src/lib/api/race.ts`
- Test: `mobile/test/race-api.test.ts`

- [ ] **Step 1: Deseni oku ve raporla**

`mobile/src/lib/api/identity.ts` ve `lobby.ts`: taban URL nereden geliyor, token
nasıl ekleniyor, hatalar nasıl şekilleniyor. **Aynı deseni izle.**

- [ ] **Step 2: Başarısız testi yaz**

`mobile/test/race-api.test.ts`, sahte bir `fetch` ile:

- `checkin`, `pit`, `weekendChoices` doğru yola, doğru gövdeyle, `Bearer` ile gider
- **gövdeye `teamKey` KONMAZ** — sunucu koltuktan türetiyor; göndermek, istemcinin
  takım seçebildiği izlenimi verir ve sessizce yok sayılır
- sunucunun hata kodları (`lap_already_run`, `already_decided`, `not_checked_in`,
  `race_not_started`, `race_finished`) çağırana **ayırt edilebilir** biçimde ulaşır,
  tek bir genel hataya düzleşmez
- ağ hatası, sunucu hatasından ayrı bir şey olarak yüzeye çıkar

- [ ] **Step 3: Koş, düştüğünü gör**

- [ ] **Step 4: Yaz**

- [ ] **Step 5: Koş, geçtiğini gör, sonra `npm run typecheck`**

- [ ] **Step 6: Commit**

```bash
git add mobile/src/lib/api/race.ts mobile/test/race-api.test.ts
git commit -m "feat(mobile): yarış HTTP istemcisi"
```

---

## Görev 3: `raceSocket.ts` — canlı yayın istemcisi

**Files:**
- Create: `mobile/src/lib/api/raceSocket.ts`
- Test: `mobile/test/race-socket.test.ts`

- [ ] **Step 1: Sunucu tarafını oku**

`server/src/lobby/live.ts`: el sıkışma (`{type:'subscribe', lobbyId, token}`),
çerçeve tipleri, koltuk kapısı, ve **geç katılanın `state` çerçevesini `last_lap`'e
göre aldığı** (saate göre değil). Bulduklarını raporla.

- [ ] **Step 2: Başarısız testi yaz**

Sahte bir `WebSocket` ile:

1. Bağlanınca el sıkışma gönderilir, token içerir
2. `state` çerçevesi tam durumu yerleştirir; `lap` çerçeveleri ilerletir
3. **Başka bir lobinin çerçevesi gelirse yok sayılır** — sunucu zaten ayırıyor
   ama istemci de kendi aboneliğini bilmeli
4. Soket kapanınca durum `kopuk` olur ve **son bilinen yarış durumu korunur**,
   temizlenmez
5. Yeniden bağlanma geri çekilmeli (backoff) olur, sıkı döngü değil
6. `error` çerçevesi (`forbidden`, geçersiz token) `oturum geçersiz`e ayrılır,
   `kopuk`la karıştırılmaz — biri beklemekle geçer, diğeri geçmez
7. **Yeniden bağlanınca istemci aradaki turları uydurmaz**; sunucunun `state`
   çerçevesine atlar

- [ ] **Step 3: Koş, düştüğünü gör**

- [ ] **Step 4: Yaz**

Zamanlayıcı kullanan her şey test tarafından sürülebilir olmalı — modül
yüklenirken gerçek bir `setInterval` kurma.

- [ ] **Step 5: Koş, geçtiğini gör, `npm run typecheck`**

- [ ] **Step 6: Kopukluğun dürüst olduğunu kanıtla**

Soket kapanınca durumu `kopuk` yapmayı kaldır. Test 4'ün **düştüğünü** gör.
Geri al. Önce/sonrayı raporla.

- [ ] **Step 7: Commit**

```bash
git add mobile/src/lib/api/raceSocket.ts mobile/test/race-socket.test.ts
git commit -m "feat(mobile): canlı yarış soketi ve bağlantı durumu"
```

---

## Görev 4: `raceSlice.ts` — durum katmanı

**Files:**
- Create: `mobile/src/store/slices/raceSlice.ts`
- Test: `mobile/test/race-slice.test.ts`

- [ ] **Step 1: Mevcut dilimleri oku**

`mobile/src/store/slices/lobbySlice.ts` deseni izlenecek. `leagueSlice.ts`'i de
oku — **şeklini** kullan, hedefini değil.

- [ ] **Step 2: Başarısız testi yaz**

1. `connectRace(lobbyId)` aboneliği kurar, durum `bağlanıyor` → `bağlı` olur
2. Gelen `lap` çerçevesi `weekend.race`'i günceller
3. **Kopukken `callPit` reddedilir** ve sunucuya hiçbir şey gitmez
4. **Kopukken kuyruğa alınmaz** — yeniden bağlanınca bekleyen çağrı gönderilmez
5. `lap_already_run` cevabı kullanıcıya anlaşılır bir mesaj olur, sessizce yutulmaz
6. Lobiden çıkınca abonelik bırakılır

- [ ] **Step 3: Koş, düştüğünü gör**

- [ ] **Step 4: Yaz**

- [ ] **Step 5: Koş, geçtiğini gör, `npm run typecheck`**

- [ ] **Step 6: Kuyruklamamayı kanıtla**

Kopukken pit çağrısını kuyruğa alıp yeniden bağlanınca gönderen bir yol ekle.
Test 4'ün **düştüğünü** gör. Geri al ve raporla.

Bu önemli: kuyruklamak makul görünür ama koşmuş bir tura karar yazmaya
çalışmaktır. Sunucu `lap_already_run` ile reddeder ve oyuncu çağrısının
işlediğini sanır.

- [ ] **Step 7: Commit**

```bash
git add mobile/src/store/slices/raceSlice.ts mobile/test/race-slice.test.ts
git commit -m "feat(mobile): yarış durumu dilimi"
```

---

## Görev 5: Hafta sonu tercihleri sunucuya gitsin

**Files:**
- Modify: `mobile/src/features/raceweek/PracticePanel.tsx`, `QualifyingPanel.tsx`
- Modify: `mobile/src/store/gameStore.ts` (tercih alanları)
- Test: `mobile/test/weekend-choices.test.ts`

- [ ] **Step 1: Mevcut seçicileri oku ve raporla**

`PracticePanel.tsx:10-16,26,50` (bias) ve `QualifyingPanel.tsx:57-73,204,223`
(sıralama lastiği, risk, yarış lastiği, taktik). Hangi store alanlarını
yazdıklarını raporla.

- [ ] **Step 2: Başarısız testi yaz**

1. Bir tercih değiştirmek `POST /race/weekend-choices` çağırır
2. **İki lastik seçici tek alana iner** — `qualiCompound`/`raceCompound` ayrımı
   kalmaz, tek `compound` gider
3. `live` fazında gönderim engellenir ve UI bunu **kural olarak** söyler, hata
   olarak değil
4. Sunucu 409 dönerse kullanıcı neden reddedildiğini öğrenir

- [ ] **Step 3: Koş, düştüğünü gör**

- [ ] **Step 4: Uygula**

İki lastik seçiciyi bire indir (spec §5.1). Kaldırılan seçicinin yerine, tek
lastiğin hem sıralamada hem başlangıçta kullanıldığını söyleyen bir satır koy —
oyuncu bir seçeneğini kaybettiğini sanmasın; kural bu.

- [ ] **Step 5: Koş, geçtiğini gör, `npm run typecheck` ve `npm run econ`**

- [ ] **Step 6: Commit**

```bash
git add mobile/src/features/raceweek mobile/src/store/gameStore.ts mobile/test/weekend-choices.test.ts
git commit -m "feat(mobile): hafta sonu tercihleri sunucuya gidiyor"
```

---

## Görev 6: Yerel yarış motorunu sök

> Bu görev bir şey **silmekten** ibaret. Sildiğin her şeyin yerine sunucunun
> karşılığı geçmiş olmalı; geçmediyse dur ve raporla.

**Files:**
- Modify: `mobile/src/store/gameStore.ts`
- Test: `mobile/test/no-local-race.test.ts`

- [ ] **Step 1: Yerel yarış yolunun tamamını çıkar ve raporla**

`RACE_TICK_MS`, modül düzeyindeki `setInterval` (`:640`, `:687`), `advanceRaceLap`
(`:701`), `startRaceSession`, `queuePit`'in yerel tamponu. Her birinin sunucu
karşılığını adlandır. **Karşılığı olmayan bir şey bulursan DUR ve raporla** —
sessizce silme.

- [ ] **Step 2: Başarısız testi yaz**

1. `gameStore` içeri alındığında **hiçbir zamanlayıcı kurulmaz**
2. `weekend.race`'i değiştiren tek yol soket çerçevesidir
3. `@pitwall/shared`'dan `advanceLap`/`startRace`/`simulateQualifying` **koşturmak
   için** içeri alınmaz

Test 3'ü kaynağı okuyarak yaz (import satırlarını denetle); bu, ileride birinin
yerel motoru geri getirmesini yakalar.

- [ ] **Step 3: Koş, düştüğünü gör**

- [ ] **Step 4: Sök**

- [ ] **Step 5: Koş, geçtiğini gör, `npm run typecheck` ve `npm run econ`**

- [ ] **Step 6: Commit**

```bash
git add mobile/src/store/gameStore.ts mobile/test/no-local-race.test.ts
git commit -m "refactor(mobile): yerel yarış motorunu kaldır"
```

---

## Görev 7: `leagueSlice` gitsin, `LeagueCard` bağlantıyı göstersin

**Files:**
- Delete: `mobile/src/store/slices/leagueSlice.ts`
- Modify: `mobile/src/features/raceweek/LeagueCard.tsx`, `mobile/src/store/gameStore.ts`
- Test: `mobile/test/legacy-slice-gone.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

1. `leagueSlice.ts` yok
2. Kod tabanında `/join`, `/weekend`, `/checkin`, `/pit` yollarına çağrı kalmadı
   (`/race/` önekli olanlar hariç)
3. `LeagueCard` bağlantı durumunu gösteriyor

- [ ] **Step 2: Koş, düştüğünü gör**

- [ ] **Step 3: Sil ve yeniden bağla**

`LeagueCard` artık ham bir sunucu URL'si alan kart değil; oyuncunun aktif
lobisinin yarış odasına bağlanma durumunu gösteriyor. `DEFAULT_URL` (`:9`) ve
serbest metin alanı kalkıyor — taban URL `authSlice`'ta.

- [ ] **Step 4: Koş, geçtiğini gör, `npm run typecheck`**

- [ ] **Step 5: Commit**

```bash
git add -u mobile && git add mobile/test/legacy-slice-gone.test.ts
git commit -m "chore(mobile): ölü lig dilimini kaldır"
```

---

## Görev 8: Uçtan uca doğrulama ve dokümantasyon

**Files:**
- Create: `mobile/test/race-integration.test.ts`
- Modify: `mobile/README.md`, `server/README.md`, `docs/FEATURES.md`

- [ ] **Step 1: Gerçek sunucuya karşı entegrasyon testi**

Gerçek sunucuyu kaldır, gerçek bir kullanıcı ve lobi kur, istemcinin API ve soket
modüllerini **sahte olmadan** kullan:

1. Tercih gönderilir ve sunucuda görünür
2. `checkin` yapılır
3. Yarış `live`'a geçince soketten `state` gelir
4. Pit çağrısı kabul edilir
5. Koşmuş bir tura pit çağrısı `lap_already_run` ile reddedilir

Bu test sunucuyu içeri alıyorsa `shutdown()` çağırmayı unutma — `server/README.md`
5. sözleşme. Unutulursa paket sessizce asılı kalır.

- [ ] **Step 2: `server/README.md`'nin bayat uç nokta tablosunu düzelt**

"Uç noktalar" başlığından sonraki tablo silinmiş tek ligi anlatıyor
(`/join`, `/weekend`, `/checkin`, `/pit`, `/live`). Gerçek yüzeyle değiştir.

- [ ] **Step 3: `mobile/README.md`**

Test koşucusunu ve sınırını yaz: React Native'e bağlı modüller node altında
çözülmez, yani test edilecek mantık o bağımlılıklardan arınmış olmalı.

Bağlantı sözleşmesini de yaz: yerel yedek **yok**, kopukken ekran donar ve
bunu söyler, pit çağrısı reddedilir ve kuyruğa alınmaz — nedeniyle.

- [ ] **Step 4: `docs/FEATURES.md`**

Aşama 1'i işaretle. **Açıkça yaz:** ekonomi hâlâ yerel ve cihaz saati açığı
istemcide açık — Aşama 2'de kapanıyor.

- [ ] **Step 5: Tam doğrulama**

```bash
cd mobile && npm test && npm run typecheck && npm run econ
cd ../server && DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test
cd ../shared && npm run typecheck
```

Sunucu paketi **562/562** kalmalı.

- [ ] **Step 6: Commit**

```bash
git add mobile/test/race-integration.test.ts mobile/README.md server/README.md docs/FEATURES.md
git commit -m "test(mobile): uçtan uca yarış + Aşama 1 dokümantasyonu"
```

---

## Bitiş ölçütleri

- [ ] `mobile`, `shared`, `server` — üç tip denetimi temiz
- [ ] `mobile npm test` ve `server npm test` (562/562) geçiyor
- [ ] `npm run econ` geçiyor
- [ ] İstemcide tur ilerleten hiçbir zamanlayıcı yok
- [ ] `weekend.race`'e yalnızca soket yazıyor
- [ ] Kopukken ekran donuyor ve söylüyor; pit çağrısı reddediliyor, kuyruğa alınmıyor
- [ ] Hafta sonu tercihi sunucuya gidiyor ve yarışta etkisi görülüyor
- [ ] Tek lastik seçici
- [ ] Ölü uçlara çağrı kalmadı

## Sırada

**Aşama 2** — ekonomi: `economySlice`, `driverSlice`, `espionageSlice`,
`staffSlice` ve `gameStore`'un fabrika/test/sponsor mantığı sunucuya. Cihaz
saati açığı orada kapanıyor.
**Aşama 3** — yerel sezon, muhasebe ve başarım kalıntılarının silinmesi.
