# Pit Wall — Canlı Yarış Sistemi Planı

> `race-system-brief.md` §10'daki dört kararın cevabı ve bunun üstüne kurulan
> tasarım. Brief'in Faz 1-2-4'ü uygulandı ve doğrulandı (`data/rng.ts`,
> `data/tracks.ts`, `data/raceEngine.ts`, `Driver.skill`). Bu belge kalan işi
> tanımlar.

---

## 0. Kararlar (oyun sahibi, 2026-09-16)

| # | Soru | Karar |
|---|---|---|
| 1 | Kaç araç? | **İki araç, ortak `carStats`, farklı sürücü yeteneği.** Sponsor hedefi lider araca bakar. |
| 2 | Yarış interaktif mi? | **Tur tur canlı yarış** (pit / lastik kararı). Hızlı olmalı; süre §3'te. Pist haritasında 11 takımın varsayılan rengi (`Team.colour`). |
| 3 | Sıralama? | **Ayrı seans, temkinli / agresif risk seçimi.** |
| 4 | Sezon sonu? | **Sezon özeti + ödül + profilde başarımlar** (pole, galibiyet, podyum, en hızlı tur, hat-trick, grand slam, duble, clean sweep) ve geniş skor tabanlı **10 rütbeli** sıralama sistemi. Takım gücüne göre çarpan. |

### Lisans notu (soru: "haritaları gerçek pist şeklinde yapmak sorun çıkarır mı?")

Evet, risk var. Bazı pist sahipleri pist **siluetini** tescilli marka olarak
korur (Silverstone, Nürburgring, Spa-Francorchamps, Suzuka, Circuit of the
Americas bunların arasında); pist **adları** da markadır ("Silverstone",
"Hungaroring", "Yas Marina"…). "Formula 1" ve "X Grand Prix" biçimindeki resmi
yarış adları FOM'un markalarıdır. Gerçek takım, sürücü ve sponsor adları zaten
kullanılmıyor; aynı ilkeyi pistlere de uyguluyoruz:

- **Pist adları kurgusal** (ülke kodu gerçek kalır — ülke adı marka değil).
- **Pist şekilleri özgün tasarım**: gerçek bir siluet kopyalanmaz; pist
  karakteri (sokak / güç / akıcı) şekilden okunur ama hiçbir gerçek pistin
  çizgisi izlenmez.
- "Grand Slam", "hat-trick", "duble", "pole" genel spor terimleri, sorun yok.

Bu koşullarla canlı yarış (karar 2) lisans açısından temiz; tek düğmeli
seçeneğe dönmeye gerek yok.

---

## 1. Yarış modeli (tur bazlı)

`data/raceEngine.ts` genişler; saf TS kalır. Tek atışlık `simulateRace`
korunur ve **tur motorunun sonuna kadar koşturulmuş hâli** olur (testler ve
"sona atla" için).

```
Track      += laps, baseLapSec, pitLossSec, layout: Point[] (özgün şekil, 0-1 normalize)
RaceState   = { lap, cars: CarState[22], weather, events[], finished }
CarState    = { entry, totalSec, lastLapSec, compound, tyreWear 0-1+, stops,
                dnf, lapsLed, bestLapSec, pitting }
Decision    = { pit: boolean, compound?: CompoundKey }   // sadece oyuncunun 2 aracı

startRace(input)                       → RaceState (tur 0, gridden)
advanceLap(state, decisions, seed)     → RaceState (tur +1)
finishRace(state)                      → RaceResult (+ lapsLed, fastestLap, sıralama)
```

**Tur süresi** = `baseLapSec + (100 − pace) × 0.08 + tyre(compound, wear, wet)
+ fuel + gürültü + olay`.

- `pace` mevcut `paceOf` (araç %75, sürücü %25, lastik hariç — lastik artık tur
  modelinde).
- **Lastik**: `gripOffset` (SOFT −0.6 s, MEDIUM 0, HARD +0.5) + aşınma
  cezası `wear² × 3 s`; `wear > 1` = uçurum (+2 s/tur ve DNF riski). Aşınma
  hızı SOFT .045 / MEDIUM .028 / HARD .018 per tur, sokak/attrition ile ölçekli.
  Islakta slick +6 s ve aşınma ×2; inter/wet kuruda +3 s ve aşınma ×3.
- **Pit**: `pitLossSec` (18-25) eklenir, lastik sıfırlanır. AI stratejisi:
  `wear > 0.72` → pit, kuruda MEDIUM→HARD, ıslak başlarsa 1 tur içinde inter/wet.
- **Geçiş**: kümülatif zaman sırasında arkadaki araç öndekini geçecekse
  `P(geçiş) = overtaking × f(paceFarkı)`; geçemezse öndekinin 0.4 s arkasına
  yapışır. Grid avantajı buradan doğar, ayrı `gridBonus` kalkar.
- **Hava**: `weatherFor` → `{ forecast, wetAtStart, rainFromLap?, dryFromLap? }`.
  Yağmur ya baştan, ya yarış ortasında gelir (rainChance'in yarısı). Tahmin
  ekranda "%" olarak; `data_center` seviyesi ≥3 ise tahmin daralır.
- **DNF**: tur başına `dnfChance / laps`; uçurumdaki lastik ve agresif ıslak
  slick artırır. DNF = puan yok, sponsor ücreti yine ödenir (§2.2 kuralı).
- **Gürültü**: tur başına bell × 0.9 s + %2 olay (+3 s kilitlenme). 20 sezon
  simülasyonu ile "en iyi araç podyum %60-70" hedefi korunur.

### Sezon sonu için kaydedilenler

`RaceResult` şunları da taşır: `poleTeam/driver`, `fastestLap`, `lapsLed`,
`ledEveryLap`, `practiceLeaders[3]`. Başarımlar buradan türetilir.

## 2. Hafta sonu akışı (store'daki durum makinesi)

```
'practice' → 'qualifying' → 'grid' → 'race' → 'result' → (settle) → yeni tur
```

1. **Practice (FP1-FP3)**: oyuncu **setup bias** seçer (mevcut Aero ↔
   Mechanical kaydırıcısı): `aero += b×4, grip −= b×4`. Her FP seansı
   `simulatePractice` ile 22 araçlık tur listesi verir; oyuncu bias'ı FP'ler
   arasında değiştirebilir. FP'yi lider bitirmek clean sweep için sayılır.
2. **Qualifying**: lastik (kuru: S/M/H, ıslak: I/W) + risk → `simulateQualifying`
   → grid açıklanır (pole başarımı).
3. **Race (canlı)**: harita + liderlik tablosu + pit paneli. Tur sayacı zamanla
   ilerler, her tur `advanceLap`. **Kritik anlarda otomatik durur** ve kart
   çıkar: yağmur başladı / lastik uçuruma yaklaştı (wear > .8) / rakip pit
   yaptı ve undercut riski / son 10 tur. Oyuncu istediği an da durdurabilir.
4. **Result**: 22 araç, kazanılan başarımlar, sponsor ödemesi (`settleRace`),
   ödül, tablo. Sponsor ekranındaki "Settle" düğmesi kalkar; orası sadece son
   ödemeyi gösterir.

### Süre

Hedef **~3 dakika** bir yarış hafta sonu, yarış kısmı ~2 dakika:

| Hız | Tur/saniye | 55 tur |
|---|---|---|
| 1× | 2.2 s | ~2 dk |
| 2× | 1.1 s | ~1 dk |
| ⏭ Sona atla | anlık | — |

Duraklamalar bunun üstüne gelir; kart başına oyuncu ne kadar isterse. Pistler
45-70 tur arası (`Track.laps`), böylece sokak pistleri biraz daha uzun sürer.
İlk kullanıcı testinde 1× çok yavaş gelirse varsayılan 2× yapılır — tek sabit.

## 3. Başarımlar ve rütbe (`data/achievements.ts`)

| Başarım | Koşul | Taban puan |
|---|---|---|
| Podyum | ilk 3 | 10 |
| Pole | grid 1 | 15 |
| En hızlı tur | yarışın en hızlı turu | 10 |
| Galibiyet | P1 | 30 |
| Duble | takımın iki aracı P1-P2 | 40 |
| Hat-trick | pole + galibiyet + en hızlı tur, ama liderliği en az bir tur kaptırdı | 60 |
| Grand Slam | pole + galibiyet + en hızlı tur + her turu lider | 100 |
| Clean Sweep | FP1, FP2, FP3, Q ve yarış hepsi lider | 150 |

**Çarpan**: takımın grid güç sırası `r` (1 = en güçlü, `baseStrength`'e göre).
`× (0.6 + 0.2 × (r − 1))` → 1. takım ×0.6, 6. takım (oyuncu) ×1.6, 9. takım
×2.2, 11. takım ×2.6. Zayıf takımla kazanmak daha değerli.

Yarış başına ek küçük puan: `max(0, 12 − finish)` (bitirmek bile bir şey).

**Kariyer skoru** → 10 rütbe. İsimler İngilizce-Türkçe okunuşuyla uyumlu
(ikisinde de anlaşılır ve telaffuzu doğal olsun diye ortak kelimeler seçildi):

| # | Rütbe | Eşik |
|---|---|---|
| 1 | Paddock | 0 |
| 2 | Rookie | 100 |
| 3 | Grid | 300 |
| 4 | Apex | 700 |
| 5 | Podium | 1 400 |
| 6 | Pole | 2 500 |
| 7 | Maestro | 4 200 |
| 8 | Titan | 6 500 |
| 9 | Legend | 10 000 |
| 10 | Grand Slam | 15 000 |

İkon: ilk sürümde ikon yok; rütbe **JetBrains Mono iki harfli glif + rütbe
rengi** ile gösterilir (nav kapsülündeki RW/MG stiline uyar). İkon istenirse
tek çizgi kalınlığında, 24 grid, acid-lime tek renk çizgi seti olarak üretilir
— gerçek logo/marka çağrıştıran hiçbir form kullanılmaz.

## 4. Sezon sonu (`data/season.ts`)

23. yarış bittiğinde:

- **Şampiyona ödülü**: tabloya göre `(1200 − 700 × t) × ECONOMY_SCALE` RP
  (1. → 240, 11. → 100). Ödül parası gibi düz.
- **Özet**: tablo, oyuncunun podyum/pole/galibiyet sayısı, kazanılan
  başarımlar, rütbe ilerlemesi, sürücü başına puan.
- **Sıfırlama**: `standings` sıfır, `round = 1`; `carStats`, RP, fabrika,
  sponsorlar **korunur**. AI `baseStrength` sabit kalır (sürücü pazarı yok).
- Profil: `career` (toplam skor, başarım sayaçları, sezon geçmişi) store'da.

## 5. Dosya planı

| Dosya | İş |
|---|---|
| `data/tracks.ts` | kurgusal adlar, `laps`, `baseLapSec`, `pitLossSec`, `layout` |
| `data/raceEngine.ts` | tur motoru: `startRace`, `advanceLap`, `finishRace`, `simulatePractice`, hava zaman çizelgesi |
| `data/achievements.ts` | başarımlar, çarpan, rütbeler |
| `data/season.ts` | sezon sonu ödülü ve özeti |
| `store/gameStore.ts` | `weekend` durum makinesi, `career`, `settleRaceWeekend()` parametresiz |
| `features/raceweek/RaceWeekScreen.tsx` | fazlara göre içerik |
| `features/raceweek/TrackMap.tsx` | Skia: pist çizgisi + 22 nokta |
| `features/raceweek/LiveRacePanel.tsx` | liderlik tablosu, pit paneli, hız, kartlar |
| `features/raceweek/RaceResultSheet.tsx` | 22 araç + başarımlar + ödeme |
| `features/league/LeagueScreen.tsx` | 11 takım tablo + son yarış |
| `features/profile/ProfileScreen.tsx` | rütbe, skor, başarım sayaçları |
| `features/sponsors/SponsorScreen.tsx` | settle düğmesi kalkar |
| `data/mock.ts` | `sessions`, `weather`, `trackFit`, `qualiLockMs`, `tyreCompounds` kalkar |

## 6. Online lig (oyun sahibi, 2026-09-16, ikinci tur kararlar)

> "Bu tüm kullanıcılarda eş zamanlı olacak; öbür takımlarda da başkaları olacak.
> Belirli bir saatte başlayacak, hızlandırma olmayacak. Yarış başlamadan 5 dk
> içinde orada olmayan katılamaz; yardımcı bot mevcut veri ve taktiklere göre,
> hata payıyla yönetir."

### Ne değişti (kodda, bugün)

- **Motor takım-bağımsız**: `RaceInput.entries: Record<teamKey, TeamEntry>`.
  Bir takımın kaydı varsa kendi `setup`/`reliability`/`tactics` ile koşar;
  yoksa AI (`baseStrength`). Tek oyunculu bugünkü hâl `soloEntries()` ile bu
  yapının özel durumu. 11 insan takım = 11 kayıt, kod değişmez.
- **Pit kararları `carId` ile**: `Decisions = Record<'team:idx', PitDecision>`.
  Sunucu her tur bütün insan çağrılarını tek nesnede toplar.
- **`TeamEntry.managed: 'human' | 'assistant'`** — check-in yapmayan takımı
  `assistantStrategy` yönetir: takımın ön ayar taktiği (`temkinli / dengeli /
  agresif`, grid ekranında seçilir) + hata payı (hava çağrısında gecikme %60,
  stint'i uçuruma uzatma %45, bir kademe sert lastik %15). Ölçüm: 20 sezonda
  yardımcı ortalama 0.2-0.5 sıra daha kötü; ıslak yarışlarda çok daha fazla.
- **Hızlandırma / durdurma yok.** Yarış saati store'da tek `setInterval`
  (`RACE_TICK_MS = 2500`); ekran sadece çizer. Karar kartı saati durdurmaz,
  3 tur vurgulu kalır.

### Sunucu mimarisi (sonraki iş, henüz yazılmadı)

```
                 ┌────────────── Node sunucu (Railway) ──────────────┐
 istemci A ──ws──┤  data/raceEngine.ts AYNI dosya, ts-node/tsx ile    ├──ws── istemci B
 istemci C ──ws──┤  lig durumu (Postgres): takımlar, setup, tablo     ├──ws── …
                 │  yarış saati: her 2.5 s advanceLap(state, ...)      │
                 └───────────────────────────────────────────────────┘
```

1. **Otorite sunucuda.** İstemci `advanceLap` çalıştırmaz; sunucu her tur
   `RaceState`'i (ya da sadece `Decisions` + tohum → istemci belirlenimci
   yeniden üretir, bant genişliği için) yayınlar. Motor saf ve tohumlu olduğu
   için iki yaklaşım da aynı sonucu verir.
2. **Takvim.** Lig başına sabit yarış saati (örn. her gün 21:00). Antrenman ve
   sıralama hafta içi asenkron; grid yarıştan 5 dk önce kapanır.
3. **Check-in.** T-5 dk … T-0 arasında `POST /race/:id/checkin`. Gelenler
   `managed: 'human'`, gelmeyenler `'assistant'`. Yarış içinde bağlantı kopan
   oyuncunun aracı da yardımcıya düşer (çağrı gelmezse `undefined` zaten =
   "kal"; sunucu 3 tur sessizlikte `assistant`'a çevirir).
4. **Pit çağrısı.** `POST /race/:id/pit { carId, compound }` → sonraki turda
   uygulanır (bugünkü davranış). Geç gelen çağrı bir sonraki tura kayar.
5. **Sezon sonu, başarımlar, rütbe** sunucuda hesaplanır (`achievements.ts`,
   `season.ts` aynı dosyalar); profil verisi hesaptan gelir.
6. **Yerel oyun** kalır: aynı ekranlar, `soloEntries`, sunucusuz. Lig
   modunda `advanceRaceLap` yerine ws mesajı store'a `race`'i yazar.

Açık sorular: lig büyüklüğü 11'den azsa boş koltuklar AI mı (bugünkü davranış)
yoksa lig dolunca mı başlar; sıralama seansı da canlı mı yoksa asenkron mu;
saat dilimi/ülke bazlı lig saatleri.

## 6b. Sürücü statları ve kalkış (oyun sahibi, 2026-09-16, üçüncü tur)

`teams.ts::Driver.stats` — her biri 0-100, motor hepsini okur:

| Stat | Nerede sayılır |
|---|---|
| `pace` | Sürücünün tur zamanına payı (`corePace`, %25) |
| `consistency` | Tur gürültüsünü ve kilitlenme olasılığını küçültür (0.8×–1.2×), lastiği korur |
| `racecraft` | Geçiş düellosunda saldıranın–savunanın farkı, ±0.15 olasılık |
| `wet` | Yağmur lastiğiyle ıslak turda ±0.5 sn/tur |
| `reaction` | **Kalkış**: beş ışık sönünce 0–2 sn kayıp (`LAUNCH_MAX_SEC`), gridde 0.35 sn/sıra → en iyi ile en kötü arası 4-6 sıra; oyuncu araçları için "mükemmel/iyi/orta/kötü çıkış" olayı |
| `dev` | Henüz kullanılmıyor (geliştirme hızı için ayrılmış) |

`skill` artık `overallOf(stats)` (pace %40, consistency %20, racecraft %20,
wet %10, reaction %10). Manager ekranındaki pilot kartları `mock.ts` yerine
`playerTeam.drivers`'dan okur; START statı eklendi. Kayacan hızlı kalkışçı
(reaction 88), Ferreira yağmur uzmanı (wet 84).

Ölçüm: P11'den kalkan lider araç, 1. tur sonunda reaction 95 ile ort. 10.6,
reaction 45 ile ort. 11.6 sıra.

## 6c. Yarış kontrolü, hafta sonu formatı, hedefler (2026-09-16, dördüncü tur)

Araştırma ve sayılar: [race-control-research.md](race-control-research.md).
Kodda:

- `tracks.ts`: `raceControl {sc, vsc, red, yellow}`, `sprint`, `region`,
  `weekendSchedule()` (bölgeye göre UTC seans saatleri, 60/30/90 dk aralar),
  `sprintLaps()`. 6 sprint pisti.
- `raceEngine.ts`: tur başına sarı / VSC / SC / kırmızı çağrıları
  (`raceControlCall`), DNF tetiklemesi, ıslak çarpanı; SC altında alan
  toplanır ve pit yarı fiyat, VSC altında %60, kırmızıda duran yeniden
  başlangıç ve serbest lastik; `session: 'sprint'` (1/3 mesafe, 8-1 puan).
  50 sezon ölçümü: SC'li yarış %45, SC veya VSC %65, kırmızı %10.
- `achievements.ts`: `targetsFor` / `judgeTargets` — sıralama hedefi tutarsa
  rütbe puanı tam, sadece puan hedefi tutarsa 0, 4+ sıra gerisinde negatif.
- `brief.ts`: 5 maddelik mühendis brifingi (lastik, hava, yarış kontrolü,
  geçiş, setup); tutulan madde başına +8 RP ve +5 kariyer skoru.
- `season.ts`: 3 günlük sezon öncesi test, mühendis raporu, doğru program +2.
- Store: `sprintQualifying → sprintGrid → sprint` fazları, `testing`,
  `finishSprint`, brifing uyumu ödemede.
- UI: seans saatleri zaman çizelgesinde, `BriefCard`, `TestingPanel`, sprint
  modunda `QualifyingPanel`, canlı yarışta bayrak afişi, sonuçta hedef kartı.

## 6d. Padok (2026-09-16, beşinci tur)

Araştırma: [paddock-research.md](paddock-research.md). Tam envanter:
[FEATURES.md](FEATURES.md). Kod parçalı: `data/economy.ts`, `data/staff.ts`,
`data/espionage.ts`, `data/driverMarket.ts` ve `store/slices/{economy,staff,
espionage,driver}Slice.ts`; çekirdek store dilimleri birleştirir ve ödemede
maaş, istihbarat çözümü, sakatlık ve sezon sonu yaşlanmayı işler. Ekran:
`features/paddock/PaddockScreen.tsx`, sekme `PD`.

## 6e. Kapanan kısımlar (2026-09-17)

- **Sunucu**: `server/` — `League` sınıfı (faz zamanlayıcısı, check-in
  penceresi, yardımcı bot ataması, tur saati, WebSocket yayını). Uçtan uca
  test: katılım, çift katılım reddi, setup, pencere içinde check-in, 58 tur
  yayını, pit çağrısı uygulandı, sonuç ve sonraki tur. Ayrıntı: `server/README.md`.
- **İstemci lig modu**: `leagueSlice` sunucu turlarını `weekend.race`'e yazar;
  aynı `LiveRacePanel` çizer; pit çağrıları sunucuya gider; ödeme düğmesi lig
  modunda gizlenir. `LeagueCard` bağlan / geri sayım / check-in.
- **Reklam ve ödeme**: `lib/monetization/ads.ts` (AdMob ödüllü, test
  birimleri) ve `iap.ts` (OpenIAP, consumable). Ödül yalnızca SDK onayıyla.
- **Setup riski**: `setupRiskFactor` — uç bias ×1.4, pistin tersine ×2.
- **Rütbe ikonları**: `RankIcon` — 10 özgün çizgi işareti, Skia, tek renk.

## 7. Doğrulama

`npx tsx` scripti (brief §8'in tur motoruna uyarlanmışı): monotonluk, en iyi
araç podyum %60-70, ıslakta SOFT–WET ≥ 5 sıra, puan toplamı 23×101,
belirlenimcilik, **pit stratejisi ölçülebilir** (hiç pit yapmayan SOFT vs tek
pit MEDIUM→HARD en az 4 sıra fark), `npm run typecheck`, `npm run lint`.
