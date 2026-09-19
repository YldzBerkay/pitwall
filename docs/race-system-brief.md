# Pit Wall — Yarış Sistemi Uygulama Brief'i

> Bu belge başka bir AI'a verilmek üzere yazıldı. Kendi kendine yeter: projeyi
> keşfetmeye çalışmadan önce bunu bütün oku. Kod kimlikleri İngilizce, açıklama
> Türkçe — mevcut kod tabanının kuralı bu.

---

## 0. Görev, tek cümlede

Pit Wall'da **gerçek bir yarış yok**. Oyuncunun yarış sonucu şu anda şampiyona
sıralamasıyla aynı sayı; araç geliştirmeleri, lastik seçimi ve pist uyumu
hiçbir sonuca bağlanmıyor. Görev, hafta sonunu çalışan bir simülasyona
dönüştürmek: **araç + sürücü + pist + lastik + hava → sıralama turu → yarış
sonucu → puan tablosu → sponsor ödemesi.**

---

## 1. Proje bağlamı

F1 takım yöneticisi mobil oyunu. Türkçe arayüz.

| | |
|---|---|
| Kök | `mobile/` (Expo 57, React Native 0.86, TypeScript) |
| Durum yönetimi | zustand 5 — `src/store/gameStore.ts`, tek store |
| Stil | NativeWind 4 + `src/theme` |
| 2D çizim | `@shopify/react-native-skia` 2.6 |
| 3D araç | `react-native-filament` 1.11, `.glb` varlıkları |
| Yol takma adı | `@/` → `src/` |
| Komutlar | `npm run typecheck` (tsc --noEmit), `npm run lint` |
| **Test altyapısı YOK** | doğrulama için `npx tsx` ile atılabilir script yaz (bkz. §8) |

**Para birimi RP.** Ölçek önemli: araç stat'ı +2 için 15-18 RP, fabrika
departmanı 50-250 RP, orta sıra takım yarış başına ~155 RP kazanıyor. Yeni bir
sayı uydururken bu aralığa göre uydur.

---

## 2. Şu an NE VAR (dokunmadan önce oku)

### 2.1 `src/data/teams.ts` — ızgara ve puan tablosu ✅ hazır

```ts
export interface Driver { name: string; number: number }
export interface Team {
  key: string; name: string; short: string; colour: string;
  baseStrength: number;          // 41-93, sezon öncesi güç sırası
  drivers: [Driver, Driver];
  isPlayer?: boolean;            // 'bosphorus', baseStrength 70
}
export const teams: Team[];      // 11 takım, 22 araç
export const playerTeam: Team;
export const teamByKey: (key: string) => Team;
export const POINTS_FOR_PLACE: number[];   // [25,18,15,12,10,8,6,4,2,1]

export interface TeamStanding { teamKey: string; points: number; position: number }
export const seedStandings: (roundsRun: number) => TeamStanding[];
export const positionOf: (standings: TeamStanding[], teamKey: string) => number;

// ⚠️ Bunu DEĞİŞTİRECEKSİN — bkz. §4.3
export const simulateRound: (
  standings: TeamStanding[], playerFinish: number, seed: number,
) => TeamStanding[];
```

`simulateRound` bugün 22 arabayı `baseStrength - sürücü farkı + gürültü` ile
sıralıyor, sonra oyuncunun lider aracını `playerFinish`'e **zorluyor**. Yani
sonucu üretmiyor, dışarıdan alıyor. Asıl iş bu.

### 2.2 `src/data/sponsors.ts` — sponsor ekonomisi ✅ hazır, dokunma

```ts
export function settleRace(sponsorships: Sponsorship[], finishPosition: number): {
  income: number; bonusesEarned: string[]; streaksBroken: string[];
  sponsorships: Sponsorship[];    // serileri ilerletilmiş hâli
};
export function racePrize(championshipPosition: number, gridSize: number): number;
export const ECONOMY_SCALE = 0.2;
```

**Kural (oyun sahibinin açık talimatı):** yarış başına sponsor ücreti **koşulsuz
ödenir**. Kötü sonuç ücreti azaltmaz, sadece hedef bonusunu ve seriyi kaybettirir.
DNF de öyle. Bunu bozan bir şey yapma.

### 2.3 `src/store/gameStore.ts`

```ts
round: number; totalRounds: number;         // 7 / 23
rp: number; weekEarned: number;
carStats: CarStat[];                         // MOTOR, AERO, GRIP
departments: FactoryDepartment[];
livery, compound: CompoundKey, rim, spokes;  // görünüm
standings: TeamStanding[]; championshipPosition: number;
sponsorships: Sponsorship[];
upgradeStat(label): UpgradeResult;           // +2, 100'de tavan
settleRaceWeekend(finishPosition: number): RaceSettlement;   // ⚠️ imzası değişecek
```

### 2.4 `src/data/mock.ts`

```ts
carStats: [
  { label: 'MOTOR', value: 67, cost: 15, fit: 'green' },
  { label: 'AERO',  value: 58, cost: 15, fit: 'yellow' },
  { label: 'GRIP',  value: 72, cost: 18, fit: 'red' },
]                                   // fit ELDE YAZILI, piste göre hesaplanmıyor
sessions: [FP1, FP2, FP3, Q, RACE]  // sadece durum etiketi, statik
nextRace: { gp, country, circuit, type: 'Street / Power', fitScore: 74, startsInMs }
```

**Takvim yok.** Tek bir sabit `nextRace` var. 23 turluk sezon iddiası kodda
karşılıksız.

### 2.5 `src/features/raceweek/RaceWeekScreen.tsx`

296 satır, **tamamen görsel**. `sessions`'ı mock'tan okuyor, lastik seçimi ve
sıralama kilidi geri sayımı yerel `useState`'te, store'a hiç bağlanmıyor.

### 2.6 `src/data/carCustomisation.ts`

```ts
export const tierOf: (value: number) => 1 | 2 | 3;   // <60 / 60-69 / ≥70
export const compounds: Compound[];                   // SOFT MEDIUM HARD INTERMEDIATE WET
export function describeSpec(motor, aero, grip): CarSpec;  // aracın GÖRÜNÜŞÜ
```

Stat'lar bugün yalnızca aracın görünüşünü (hangi parçalar takılı) belirliyor.

---

## 3. Tasarım ilkeleri (bunlara uy)

1. **Belirlenimci olsun.** Aynı tohum + aynı girdi = aynı sonuç. `sponsors.ts`
   ve `teams.ts` içindeki mulberry32 `rng(seed)` kalıbını kullan. Yeniden render
   sonucu değiştirmemeli, oyuncu ekrandan çıkıp girerek sonuç çeviremememeli.
2. **Şans var ama hâkim değil.** Daha iyi araç istikrarlı olarak daha iyi
   bitirmeli; sürprizler olmalı ama "en iyi araç 15. olur" olmamalı.
3. **Oyuncunun kararları sonuca dokunmalı.** Lastik seçimi, geliştirme
   dağılımı, sıralama riski — hepsinin ölçülebilir etkisi olmalı, yoksa arayüz
   yine vitrin olur.
4. **Kötü takım kurtulabilmeli.** Ödül parası düz, sponsor ücreti garantili.
   Kötü bir yarış geliri kesmemeli.
5. **Tek yönlü bağımlılık.** `data/` katmanı saf TypeScript kalsın; React,
   store veya UI import etmesin. Böylece `npx tsx` ile test edilebilir.

---

## 4. Yapılacaklar

### Faz 1 — Takvim ve pist modeli

**Yeni dosya: `src/data/tracks.ts`**

```ts
export interface Track {
  key: string;
  gp: string;            // 'Azerbaijan GP'
  country: string;       // 'AZE'
  circuit: string;       // 'Baku City Circuit'
  /** Pistin hangi stat'ı ne kadar ödüllendirdiği. Üçü toplamı 1.0 olsun. */
  demand: { motor: number; aero: number; grip: number };
  /** Görsel etiket: 'Sokak / Güç' gibi. `demand`'dan türetilebilir. */
  label: string;
  /** Yağmur olasılığı 0-1 — hava için (Faz 4). */
  rainChance: number;
  /** Güvenilirlik baskısı 0-1; sokak pistleri yüksek (Faz 4). */
  attrition: number;
}
export const calendar: Track[];        // 23 pist
export const trackForRound: (round: number) => Track;
```

23 pist uydur — gerçek isim kullanma zorunluluğu yok ama tanıdık olsun
(mevcut mock 'Azerbaijan GP / Baku City Circuit' kullanıyor, o tarzda devam).
Dağılım dengeli olsun: güç pistleri, aero pistleri, grip pistleri ve karışıklar.

**`nextRace`'i mock'tan kaldır**, `trackForRound(round)`'dan türet.
`ManagerHomeScreen` ve `RaceWeekScreen` onu kullanıyor — kırma.

**`carStats[].fit`** artık elle yazılmasın; pistin `demand`'ı ile takımın stat'ı
karşılaştırılarak hesaplansın (yüksek talep + düşük stat = `red`).

### Faz 2 — Araç ve sürücü skoru

**Yeni dosya: `src/data/raceEngine.ts`** (saf TS, React yok)

```ts
export interface CarSetup {
  motor: number; aero: number; grip: number;   // 0-100
  compound: CompoundKey;
}
export interface RaceConditions { track: Track; wet: boolean }

/** Bir aracın ham hızı, 0-100 ölçeğinde. */
export function paceOf(setup: CarSetup, driverSkill: number, cond: RaceConditions): number;
```

Önerilen formül (gerekçesiyle, değiştirmek serbest ama gerekçeyi koru):

```
statScore = motor*demand.motor + aero*demand.aero + grip*demand.grip
            → pist neyi ödüllendiriyorsa o stat ağır basar; toplam 0-100

tyreDelta  = lastik uygunluğu (§4.1)
driverPart = driverSkill * 0.25        → sürücü toplamın ~%25'i, araç %75
             (F1'de araç baskın; oyunun da geliştirme oyunu olması lazım)

pace = statScore * 0.75 + driverSkill * 0.25 + tyreDelta
```

**Sürücü yeteneği:** `Driver`'a `skill: number` (0-100) ekle. Takımın
`baseStrength`'i ile ilişkili ama aynı değil — güçlü takımda zayıf sürücü
olabilmeli. İkinci sürücü birinciden 2-6 puan geride.

**AI araçları için:** `teams.ts`'teki `baseStrength`'i `statScore` yerine
kullan — AI takımlarının stat'ı yok. Sezon boyu hafif gelişim ekleyebilirsin
(`baseStrength + round * 0.1 * gelişimKatsayısı`), böylece tablo canlı kalır.

#### 4.1 Lastik

| Bileşim | Kuru hız | Ömür | Islakta |
|---|---|---|---|
| SOFT | +3.0 | kısa | felaket |
| MEDIUM | +1.5 | orta | kötü |
| HARD | 0 | uzun | kötü |
| INTERMEDIATE | -4 | — | nemde iyi |
| WET | -6 | — | ıslakta iyi |

Kuruda slick, ıslakta inter/wet — yanlış seçim ağır cezalandırılsın (oyuncunun
hava tahminine bakıp karar vermesi lazım, §4.4).

### Faz 3 — Hafta sonu akışı

`RaceWeekScreen`'i store'a bağla. Seanslar gerçek olsun:

1. **Antrenman (FP):** oyuncu setup'a küçük bir ayar yapar (örn. "düşük/yüksek
   kanat"): bir stat'a +, diğerine −. Pist talebiyle uyumluysa kazanç.
2. **Sıralama (Q):** `pace` + küçük gürültü → **grid pozisyonu**. Oyuncu burada
   **risk** seçebilsin (temkinli / agresif): agresif = daha iyi ortalama ama
   hata (grid sonu) olasılığı.
3. **Yarış:** grid pozisyonu başlangıç avantajı olsun ama belirleyici olmasın
   (sokak pistinde geçiş zor → grid ağırlığı yüksek; hızlı pistte düşük). Bunu
   `Track`'e `overtaking: number` (0-1) olarak ekle.

**Sonuç üretimi:**

```
finalScore(car) = pace + gridBonus + rng(±noise)
sırala → 22 araçlık bitiş sırası → oyuncunun yeri = finishPosition
```

`noise` pistin `attrition`'ı ve hava ile büyüsün.

### Faz 4 — Güvenilirlik ve hava

- **Hava:** `rainChance` + tur tohumu → `wet: boolean`. Hafta sonu başında
  **tahmin** göster (olasılık), kesinliği yarış anında belli olsun — lastik
  kararının riskli olmasının tek yolu bu.
- **DNF:** her araç için küçük olasılık, `attrition` ve agresif sürüşle artar.
  DNF = puan yok, ama **sponsor ücreti yine ödenir** (§2.2 kuralı).
- Oyuncunun `departments` (fabrika) seviyeleri güvenilirliği iyileştirsin —
  `manufacturing` / `engine_lab` zaten var, böylece fabrika bir işe yarar.

### Faz 5 — Entegrasyon

**`teams.ts::simulateRound` imzası değişsin:**

```ts
// ESKİ: playerFinish'i dışarıdan alıp zorluyordu
export function simulateRound(standings, playerFinish: number, seed: number): TeamStanding[]

// YENİ: sonucu kendisi üretsin
export interface RaceResult {
  order: { teamKey: string; driver: string; dnf: boolean }[];  // 22 araç, bitiş sırası
  playerFinish: number;        // oyuncunun lider aracı, DNF ise 0
  standings: TeamStanding[];
}
export function simulateRace(input: {
  standings: TeamStanding[]; track: Track; setup: CarSetup;
  wet: boolean; grid: number[]; seed: number;
}): RaceResult;
```

**`gameStore.settleRaceWeekend`** artık `finishPosition` parametresi almasın;
yarışı kendisi koştursun ve `RaceSettlement`'a sonucu eklesin:

```ts
settleRaceWeekend(): RaceSettlement & { result: RaceResult };
```

Çağıran tek yer: `SponsorScreen.tsx:95` (`settleRaceWeekend(championshipPosition)`).
Orayı güncelle. Asıl yarış tetikleyicisi **RaceWeekScreen** olmalı, sponsor
ekranı değil — akışı oraya taşı, sponsor ekranı sadece sonucu göstersin.

**Puan tablosu ekranı:** 22 araçlık bitiş sırası ve güncel tablo görünsün.
(Bu ayrı bir eksik; bkz. §9.)

---

## 5. Dokunma / bozma

- `sponsors.ts`'teki ücret, paket, seri ve yenileme mantığı — **bitti, çalışıyor.**
  Sadece `settleRace`'i çağırma biçimi değişecek.
- `carCustomisation.ts::describeSpec` ve Blender hattı (`tools/blender/`) —
  aracın **görünüşü**. Yarış sistemiyle ilgisi yok, elleme.
- `ECONOMY_SCALE = 0.2` — yeni gelir kaynağı eklersen aynı ölçeğe uy.
- Sponsor ücretinin koşulsuzluğu (§2.2).

---

## 6. Belirlenimcilik sözleşmesi

Her rastgelelik tohumlu olmalı. Tohum kalıbı: `round * asal + ikinciGirdi * asal`.
`Math.random()` **kullanma** — oyuncu ekranı yenileyerek sonuç çevirebilir hale
gelir. Mevcut `rng(seed)` (mulberry32) `sponsors.ts` ve `teams.ts` içinde var;
`raceEngine.ts`'e kopyalamak yerine ortak bir `src/data/rng.ts`'e çıkar ve üç
yerden de import et.

---

## 7. Dosya planı

| Dosya | Durum | İş |
|---|---|---|
| `src/data/rng.ts` | yeni | mulberry32'yi tek yere topla |
| `src/data/tracks.ts` | yeni | 23 pist + `trackForRound` |
| `src/data/raceEngine.ts` | yeni | `paceOf`, `simulateQualifying`, `simulateRace` |
| `src/data/teams.ts` | değişir | `Driver.skill`, `simulateRound` → `simulateRace` |
| `src/store/gameStore.ts` | değişir | hafta sonu durumu, `settleRaceWeekend()` |
| `src/features/raceweek/RaceWeekScreen.tsx` | değişir | store'a bağlan, seansları gerçekleştir |
| `src/features/sponsors/SponsorScreen.tsx` | değişir | yarışı tetiklemeyi bırak |
| `src/data/mock.ts` | temizlik | `nextRace`, `sessions`, `carStats[].fit` takvimden türesin |

---

## 8. Doğrulama (test altyapısı yok, script yaz)

`mobile/` içine geçici bir dosya koy, çalıştır, **sil**:

```bash
cd mobile && npx tsx src/__sim.ts && rm src/__sim.ts
```

En az şunları ölç ve çıktısını rapor et:

1. **Monotonluk:** stat'ları 10 puan artır → 20 sezonluk ortalama bitiş sırası
   iyileşmeli. İyileşmiyorsa formül yanlış.
2. **Şans payı:** aynı araçla 20 yarış → bitiş dağılımı. En iyi araç yarışların
   ~%60-70'ini ilk 3'te bitirmeli, %100'ünü değil.
3. **Lastik kararı ölçülebilir mi:** ıslakta SOFT ile WET arasındaki ortalama
   bitiş farkı en az 5 sıra olmalı.
4. **Tablo tutarlılığı:** 23 tur sonunda toplam dağıtılan puan =
   `23 * POINTS_FOR_PLACE.toplamı` (= 23 × 101).
5. **Belirlenimcilik:** aynı tohumla iki kez koş → birebir aynı sonuç.
6. `npm run typecheck` temiz.

---

## 9. Kapsam DIŞI (ayrı işler, karıştırma)

- **Kayıt/yükleme yok** (persist/AsyncStorage). Uygulama kapanınca her şey
  sıfırlanıyor. Ayrı iş, ama yarış sisteminden hemen sonra yapılmalı.
- **Puan tablosu ekranı** yok — 11 takımlık tablo hiçbir yerde görünmüyor.
- **Sürücü pazarı / sözleşmeleri** yok.
- Sponsor ekranının 16 slotu bölgeye göre gruplaması.

---

## 10. Karar verilmesi gerekenler (uygulamadan önce oyun sahibine sor)

1. **Oyuncu kaç araç yönetiyor?** `teams.ts` her takıma 2 sürücü veriyor ama
   oyun tek araç gibi konuşuyor (`carStats` tek set). İki araç = iki sonuç, iki
   sürücü gelişimi, daha zengin ama daha karmaşık. **Öneri: iki araç, ortak
   `carStats`, farklı sürücü yeteneği.**
2. **Yarış ne kadar interaktif?** (a) tek düğme, sonuç anında; (b) tur tur
   ilerleyen, pit/lastik kararı verilen canlı bir ekran. (b) çok daha büyük iş.
   **Öneri: önce (a), altyapı (b)'yi kaldıracak şekilde yazılsın.**
3. **Sıralama ayrı bir seans mı, yoksa yarıştan türetilsin mi?** Ayrı seans
   oyuncuya bir karar daha verir (risk), ama bir ekran daha demek.
4. **Sezon sonu ne oluyor?** Şampiyonluk ödülü, bir sonraki sezon, takım
   gücünün sıfırlanması — hiçbiri tanımlı değil.

Bu dördü cevaplanmadan Faz 3 ve 5 yazılmasın; ikisi de cevaba göre değişir.
