# Pit Wall — Ekonomi Tasarımı (yeniden)

> Oyunun para, zaman ve ilerleme sisteminin tam tanımı. Mevcut ekonomiyi
> değiştirir. Kod kimlikleri İngilizce, açıklama Türkçe — kod tabanının kuralı.
>
> Tarih: 2026-09-19 · Durum: onaylandı, uygulama planı bekliyor

---

## 0. Neden yeniden

Mevcut ekonominin beş kırık yeri var:

1. **Araç yükseltme fiyatı sabit.** `gameStore.upgradeStat` her seferinde aynı
   15-18 RP'yi kesiyor, hafta sonu limiti yok. 340 RP'lik başlangıç parasıyla
   oyunun ilk dakikasında 22 yükseltme alınıp **+44 stat** yapılabiliyor; 100
   tavanına 2-3 yarışta çarpılıyor. Ana ilerleme döngüsü sezon bitmeden bitiyor.
2. **Maaşlar geliri yiyor ama önemi yok**, çünkü (1) yüzünden paraya zaten
   ihtiyaç kalmıyor.
3. **Fabrika ölü.** Seviye artıyor, fiyat artmıyor; `upgradable` bayrağı
   `mock.ts`'te elle sabit, `manufacturing` ve `driver_academy` hiç
   yükseltilemiyor.
4. **Altın ekonomisi ters.** Günde 8 reklam = 8 Altın bedava, en ucuz paket
   ₺49,99 = 5 Altın. Ödeyen oyuncu bekleyenden geride. Altın'ın toplam üç
   harcama yeri var, talep yok.
5. **`ECONOMY_SCALE = 0.2` tutarsız.** Yalnızca sponsor ve ödüle uygulanıyor;
   maaşlara, yükseltmelere, transferlere uygulanmıyor. Tek knob'la ekonomi
   ayarlanamıyor.

---

## 1. Tasarım kararları (oyun sahibi)

| Karar | Seçim |
|---|---|
| İlerleme temposu | **1 sezon** — orta sıradan şampiyonluk arabasına |
| Ekonominin rolü | Kıt kaynak paylaştırması **+** sürücü ticareti |
| Yükseltme fiyatı | `×1.5` **sıradaki yükseltme** üstüne (stat başına bağımsız merdiven) |
| Geliştirme süresi | Gerçek zaman. **Gruplar arası paralel, grup içinde tek** (araç / sürücü / istihbarat) |
| Sürücü ticareti | Serbest, **%20 komisyon + 2-6 kişilik kadro** ile frenli |
| Altın | Orta agresiflik, **sabit kur 1 Altın = 50 RP**, sadece-Altın mekaniği yok |
| Hızlandırma | **Saat başı 5 Altın** |

---

## 2. Ölçek

`ECONOMY_SCALE` **0.2 → 1.5** (×7,5). Çıpa: orta sıra takım yarış başına
~1.100 RP kazanır, en ucuz araç geliştirmesi 750 RP'dir.

Ölçek bugün yalnızca `sponsors.ts` ve `season.ts` tarafından okunuyor. Yeni
kuralda **maaşlar, transfer bedelleri, fabrika ve casusluk fiyatları da aynı
sabiti okur.** Ekonomi tek yerden ayarlanabilir olmalı.

| | Şimdi | Yeni |
|---|---|---|
| Orta sıra yarış geliri | ~155 RP | **~1.100 RP** |
| Yarış ödülü P1 / P11 | 80 / 35 | 600 / 260 |
| Sezon ödülü P1 / P11 | 240 / 100 | **9.000 / 2.500** |
| Personel maaşı (yetenek 40 / 90) | 4 / 26 | 41 / 119 |
| Sürücü maaşı (ort 55 / 95) | 10 / 40 | 60 / 250 |
| En ucuz araç geliştirmesi | 15 | 750 |

Sezon ödülü formülü: `9000 − 650 × (pozisyon − 1)`, taban 2.500. Şampiyonluk
~6 yarışlık gelir eder; yıldız sürücünün tek gerçekçi finansman kaynağı budur.

---

## 3. Araç geliştirme

### 3.1 Merdiven

Her stat (MOTOR, AERO, GRIP) **kendi** sayaçını tutar. O stat için `n`'inci
geliştirme:

**Süre tarafı zaten kodda** (`carCustomisation.upgradeDurationMs`):
`6 sa × 1.5^done`, **22 saat** tavanlı. Para tarafı aynı çarpanı kullanır, böylece
tek bir kavram olur — *"her yükseltme bir öncekinin bir buçuk katı"*:

```
maliyet(n) = round(750 × 1.5^(n−1) × üretimİndirimi)     ← YENİ
süre(n)    = min(22 sa, 6 sa × 1.5^(n−1)) × üretimSüreKatsayısı   ← MEVCUT
kazanç     = 6 + staffEffects.upgradeBonus + rüzgarTüneliBonusu
atlama     = ceil(kalanSaat) × 5 Altın
```

| # | Fiyat | Süre | Dolu atlama |
|---|---|---|---|
| 1 | 750 | 6,0 sa | 30 Altın |
| 2 | 1.125 | 9,0 sa | 45 |
| 3 | 1.688 | 13,5 sa | 70 |
| 4 | 2.531 | 20,3 sa | 105 |
| 5+ | 3.797 → | 22 sa (tavan) | 110 |
| 6 | 5.695 | 22 sa | 110 |
| 7 | 8.543 | 22 sa | 110 |
| 8 | 12.814 | 22 sa | 110 |

**Yarışa çıkmayı engelleyen hiçbir iş 22 saati aşmaz.** Oyun tek sezonluk ve
OSM tarzı: oyuncunun her yarıştan önce oyuna girmesi isteniyor. 22 saat,
"yattım kalktım hâlâ bitmemiş" hissini vermeden günlük döngüye oturan en uzun
süre — yatmadan başlatılan iş ertesi akşam yarıştan önce hazır olur.

Tavan **araç** (22 sa) ve **sürücü** (6 sa) gruplarına uygulanır, çünkü ikisi
de yarış gününde ceza kesiyor (§5A). **İstihbarat tavanın dışındadır ve
kasıtlı öyle**: casus görevi yarışa hiç dokunmaz, yalnızca bir sonraki
geliştirmeye çarpan verir. Bekletmenin bir yarış bedeli olmadığı için daha
uzun sürebilir (24 sa rapor) ve seyrek kalması (48 sa bekleme) dengeyi korur.

Süre tavan yapar ama **fiyat tavanlanmaz** — geç sezonda fren tamamen parasal
olur, takvimsel değil. Ölçüldü: süre tavanını 72'den 22 saate indirmek sezon
temposunu hiç değiştirmedi (89,7 ort · P3 · 12 geliştirme, aynı), çünkü orta
oyunda bağlayıcı kısıt zaten paraydı. Değişen tek şey, geç sezonda tek bir
geliştirmenin iki yarış arasına sığmaması sorunu — artık her iş sığıyor. Kazanç bugün `2 + upgradeBonus`; **6**'ya çıkacak.

Stat 100'de tavanlanır. Kesirli kazanç `upgradeCarry` ile taşınmaya devam eder
(mevcut davranış korunur).

### 3.2 Tek tezgah

**Bu bölümün büyük kısmı zaten uygulanmış.** `gameStore` bugün `build`,
`upgradesDone`, `buildTimeFor`, `startBuild` ve `collectBuild`'i tutuyor ve
`startBuild` ikinci bir işi `'busy'` ile reddediyor — araç grubunun tek-tezgah
kuralı yerinde. Mevcut tip korunur:

```ts
export interface CarBuild {
  label: string;      // 'MOTOR' | 'AERO' | 'GRIP'
  endsAt: number;
  durationMs: number;
}
```

Eksik olan üç şey:

1. **Para merdiveni.** Bugün `stat.cost` sabit 15-18 RP kesiyor; §3.1'deki
   `750 × 1.5^done` gelecek. Para başlatma anında düşer, stat **bitişte**
   işlenir (mevcut davranış).
2. **Hızlandırma.** `skipBuild()` yok. Kalan saat yukarı yuvarlanır, saat
   başına 5 Altın alınır, `build.endsAt` şimdiye çekilir ve `collectBuild`
   çağrılır.
3. **Yarış günü kilidi** (aşağıda §5A).

Başlatılmış bir geliştirme iptal edilemez — para geri gelmez (tek istisna §4).

Bu, "üç stat'tan hangisini başlatayım, yarışa yetişir mi" kararını doğurur:
araç grubunda tek tezgah olduğu için sezonun geliştirme sayısını para değil
**takvim** belirler. Para tek başına hız satın alamaz; zaman da bir kaynaktır.

### 3.3 Sezon eğrisi (doğrulanmış)

Model varsayımı: yarış arası ~60 saat, gelirin %60'ı araca, 1.200 RP padok
rezervi, en düşük stat'a yatırım.

```
R 4 | 73 76 72 (ort 73.7) | P7 | alınan 1/3/0
R 8 | 79 76 78 (ort 77.7) | P6 | alınan 2/3/1
R12 | 79 82 84 (ort 81.7) | P5 | alınan 2/4/2
R16 | 85 82 84 (ort 83.7) | P4 | alınan 3/4/2
R20 | 85 88 90 (ort 87.7) | P3 | alınan 3/5/3
R23 | 91 88 90 (ort 89.7) | P3 | alınan 4/5/3
```

Ortalama oyuncu sezonu P3 bitirir. P1 için araç yetmez: sürücü geliştirmesi,
iyi bir baş mekanik ve doğru sponsor imzaları da gerekir. Kasıtlıdır.

---

## 4. Sezon geçişi

1 sezonda tavana çıkılacaksa sezon 2'nin yapacak işi kalmalı. Kış resetinde
**hem oyuncunun hem rakiplerin** aracı geriler:

```
yeniStat = round(55 + (eskiStat − 55) × 0.35 + fabrikaTabanBonusu)
fabrikaTabanBonusu = toplam fabrika seviyesi × 1.5
```

Örnek: 91/88/90 araç, toplam fabrika seviyesi 4 (bonus 6) → **74/73/73**.

**Rakiplere gerileme UYGULANMAZ** — uygulamada bu maddeden kasıtlı olarak
sapıldı. `raceEngine.aiStrength` rakip gücünü `round` üzerinden okuyor
(`compressed + (round-1) * 0.1 * devRate`), yani rakipler zaten her sezon
sıfırlanıyor ve sezonlar arası hiç büyümüyorlar. Onlara ayrıca gerileme
uygulamak her yıl zayıflatırdı — istenenin tam tersi.

Denge kendiliğinden kuruluyor ve `econ-check` bunu iki eşikle koruyor:

| | Değer |
|---|---|
| Oyuncunun reset sonrası tabanı | 74 |
| En güçlü rakibin sezon başı gücü | 82,3 |
| Oyuncunun sezon sonu tavanı | ~90 |
| En güçlü rakibin sezon sonu gücü | 84,4 |

Yani oyuncu her kış en güçlü rakibin **altına** düşüyor, sezon boyunca
tırmanıp **üstüne** çıkıyor. Bir sezonluk arkın tekrarlanabilir olmasını
sağlayan şey bu.

Reset sırasında:
- Stat merdiveni sayaçları (`upgradeLadder`) sıfırlanır.
- Fabrika seviyeleri **taşınır**. Kalıcı ilerleme oradadır.
- Devam eden `CarBuild` iptal edilir ve parası **iade edilir**. Bu, §3.2'deki
  "iptal yok, iade yok" kuralının tek istisnasıdır: sezon sınırında biten bir
  geliştirmenin statı zaten resetle silineceği için oyuncu parasını boşa
  vermemelidir. Antrenman ve casus görevleri de aynı şekilde iptal + iade olur.

---

## 5. Sürücü ekonomisi

### 5.1 Fiyat üstel

```
transferBedeli(sürücü) = round(800 × 1.075^(ortalama − 55) + max(0, potansiyel − ortalama) × 25)
maaş(sürücü)           = round(60 + (ortalama − 55) / 40 × 190)
```

| Ortalama / potansiyel | Bedel | Maaş | Kaç yarışlık gelir |
|---|---|---|---|
| 58 / 70 | 1.294 | 74 | 1,2 |
| 62 / 88 | 1.977 | 93 | 1,8 |
| 70 / 80 | 2.617 | 131 | 2,4 |
| 76 / 88 | 3.953 | 160 | 3,6 |
| 82 / 88 | 5.788 | 188 | 5,3 |
| 88 / 92 | 8.801 | 217 | 8 |
| 95 / 97 | 14.485 | 250 | **13** |

Yıldız sürücü yarış parası biriktirerek alınmaz; ancak şampiyonluk ödülüyle
veya **kendin yetiştirerek** gelir.

Sözleşme süresi çarpanları değişmez (`contractTerms`: 1 sezon `feeScale` 0.7 /
`wageScale` 1.25, 2 sezon 1/1, 3 sezon 1.45/0.85). Uzatma bedeli mevcut
kuralda kalır: güncel değerin %45'i.

### 5.2 Ticaret

Satış geliri = `transferBedeli(güncel stat) × 0.80`. %20 menajer komisyonu.

Doğrulanmış döngüler:

| Al | Sat | Alış | Satış (net) | Kâr |
|---|---|---|---|---|
| ort 62, pot 88 | ort 76 | 1.977 | 3.162 | **+1.185** |
| ort 62, pot 88 | ort 82 | 1.977 | 4.630 | **+2.653** |
| ort 58, pot 70 | ort 70 | 1.744 | 2.254 | +510 |

Kârın kaynağı üstel eğridir: 62→76 arası değeri ikiye katlar. Ama asıl kazanç
satış değil, **82'lik sürücüye 5.788 yerine 1.977 ödemiş olmak**. Ticaret ikincil
bir gelir kalemidir, ana gelir değil.

### 5.3 Sömürü frenleri

- **Kadro 2-6 sürücü.** Taban 2'dir: iki araç için iki sürücü şarttır, ikiye
  düşmüşken satış yapılamaz. Tavan 6'dır; yedinci sürücü alınamaz, alınmak
  isteniyorsa biri satılmalı. Aradaki 4 koltuk yedek ve yatırım içindir.
- Her sürücü, koltukta olmasa bile **maaş yer** (asıl iki koltuk tam, diğerleri
  yarı maaş).
- **Antrenman koltuğu tek** ve seans 6 saat (`TRAINING_MS`). Altı sürücü tutmak
  geliştirme hızını artırmaz — sadece maaş yükünü. Sürücü çiftliği zamanla
  sınırlıdır, parayla değil.
- **Tabana yakın kadro risklidir:** antrenmandaki sürücü yarışamaz (§5A). Tam
  2 sürücüyle oynayıp birini antrene edersen o araç yarışa çıkamaz. Üçüncü
  sürücü bir lüks değil, antrenman yapabilmenin bedelidir.
- Aynı sürücü alındığı **raunda** satılamaz (aynı gün al-sat arbitrajı kapalı).

### 5.4 Gelişim hızı — değişmiyor

`driverMarket.ageFactor` ve `trainingGain` zaten istenen davranışı veriyor ve
**dokunulmayacak**:

- ≤24 yaş ×1,4 · 25-28 ×1,0 · 29-32 ×0,6 · **33+ sıfır**
- Potansiyele yaklaştıkça kazanç düşer (`gapFactor`), tavana yakın stat daha
  yavaş gelişir (`statRoom`).

Tek değişiklik: sürücü akademisi seviyesi `trainingGain`'e çarpan olarak bağlanır
(§6).

---

## 5A. Zaman kaynağı — üç tezgah

Para artık tek kısıt değil. Gerçek zamanlı işler **üç gruba** ayrılır ve tek
bir kural işletir:

> **Gruplar arası paralel, grup içinde tek.**
> Üç grubun üçü birden aynı anda çalışabilir. Ama bir grupta aynı anda yalnızca
> bir iş yürür.

| Grup | Kapsadığı işler | Süre | Atlama |
|---|---|---|---|
| **Araç** (fabrika tezgahı) | MOTOR, AERO, GRIP geliştirmeleri | 6-22 sa (§3.1) | 5 Altın/saat |
| **Sürücü** (antrenman koltuğu) | kadrodaki **her** sürücünün **her** statı | 6 sa (`TRAINING_MS`) | 30 Altın |
| **İstihbarat** | casus görevi | **24 sa** | 120 Altın |

Yani:

- AERO pişerken **MOTOR başlatılamaz** — araç grubu dolu. (Aynı stat da olmaz.)
- 1. sürücü antrenmandayken **2. sürücü antrene edilemez**, yedek de edilemez.
  Kadro 6 kişiye kadar çıkabilir ama antrenman koltuğu birdir; kalabalık kadro
  tutmak antrenman hızını artırmaz, sadece maaş yükünü artırır (§5.3 freni).
- Buna karşılık **AERO + 2. sürücü + casus** aynı anda gayet yürür. Oyuncunun
  günlük ritmi budur: gir, üç grubu da doldur, çık.

### Yarış günü kilidi

Zamanın gerçek bedeli burada. **Işıklar söndüğü anda hâlâ çalışan bir iş,
öznesini cezalandırır.** İptal yoktur: ya Altınla bitirilir, ya sonucuna
katlanılır.

| Grup | Yarış anında çalışıyorsa |
|---|---|
| **Araç** | Araç sökük yarışır: **geliştirilen stat yarı değerinde** sayılır (AERO 88 → 44) ve o araç için **DNF olasılığı iki katına** çıkar. |
| **Sürücü** | O sürücü koltuğa oturamaz; **yedek geçer** (sakatlık mekaniğiyle aynı yol). Yedek yoksa o araç yarışa çıkamaz. |
| **İstihbarat** | Ceza yok — casus görevi yarışı etkilemez, sadece raporu geç gelir. |

Araç cezası yalnızca **pişen stat'a** uygulanır, üçüne birden değil; ama tek
tezgah olduğu için zaten aynı anda bir stat pişebilir. Ceza yarış sonunda
kalkar, geliştirme kaldığı yerden devam eder — kaybedilen yarıştır, yatırım
değil.

**Uyarı zorunlu.** Oyuncu yarışa yetişmeyecek bir iş başlatmak üzereyken onay
istenir:

> "Bu geliştirme yarıştan 14 sa sonra biter. Bakü'ye sökük AERO ile çıkacaksın
> (88 → 44) ve DNF riskin iki katı olacak. Devam edilsin mi?"

Bu bir tuzak değil, bilinçli bir tercih olmalıdır: oyuncu bir yarışı feda edip
büyük yatırımı öne almayı seçebilmeli. Uyarı, hesabı önceden göstermekle
yükümlüdür — kaç saat açık, hangi stat, hangi yarış, kaç Altın ile kurtulur.

Hızlandırma fiyatı yarış gününde de aynıdır (5 Altın/saat); "yarış yaklaştı"
diye pahalılaşmaz. Baskı takvimin kendisinden gelir, fiyat oyunundan değil.

Durum modeli gruplara birebir oturur — her grup için en fazla bir kayıt:

```ts
build?:    CarBuild;      // araç grubu
training?: Training;      // sürücü grubu  (mevcut yapı, tek slot)
mission?:  SpyMission;    // istihbarat grubu
```

Sürücü grubu bugün zaten tek slot (`driverSlice`: `if (state.training) return false`),
araç grubu ise henüz yok — yeni gelen kısıt orada.

Arayüz tarafı: her grubun kendi kartı ve geri sayımı olur. Grup doluyken o
grubun "başlat" düğmeleri kilitlenir ve kilidin sebebi yazılır ("Fabrika dolu:
AERO 4 sa 12 dk"), yoksa oyuncu neden başlatamadığını anlayamaz.

### İstihbarat 24 saate geçiyor

Bugün casusluk **round** cinsinden çalışıyor (`SPY_COOLDOWN_ROUNDS = 3`,
`resolvesRound`): rapor bir round sonra gelir. Yeni kuralda gerçek zamana
bağlanır:

```ts
interface SpyMission {
  target: string; stat: StatKey; professional: boolean;
  startedAt: number;
  endsAt: number;     // startedAt + 24 sa
}
```

- Rapor **24 gerçek saat** sonra düşer; `resolvesRound` alanı kaldırılır.
- Bekleme süresi (`SPY_COOLDOWN_ROUNDS`) da gerçek zamana çevrilir: görev
  bittikten sonra **48 saat** yeni görev açılmaz. Böylece "3 raunda bir" ile
  aynı seyreklik korunur ama takvimden bağımsızlaşır.
- 120 Altın ile atlanabilir. Pahalıdır ve öyle olmalıdır: istihbaratın değeri
  **zamanında** gelmesidir; bir sonraki geliştirmeyi yönlendiremeyecek kadar geç
  gelen rapor işe yaramaz. Atlama, yarışa yetişmeyecek bir raporu kurtarır.
- Sonuç, tohumu `startedAt`'ten değil mevcut `round + season + target`
  kalıbından üretmeye devam eder — belirlenimcilik sözleşmesi bozulmaz ve
  oyuncu saati ileri alarak sonucu çeviremez.

## 6. Fabrika

Seviye maliyeti: `round(1500 × 1.7^(seviye−1))` → **1.500 / 2.550 / 4.335 /
7.369 / 12.528**. Sezon fazlası 1-2 seviye alır; süper takım ~4 sezonda kurulur.

`mock.ts`'teki elle yazılı `upgradable` bayrağı kaldırılır — bir departman
yalnızca seviye tavanına (5) ulaştığında yükseltilemez olur.

| Departman | Seviye başına etki |
|---|---|
| `wind_tunnel` | araç yükseltme kazancı **+0,4 stat** |
| `manufacturing` | yükseltme maliyeti **−%6**, süre **−%8** |
| `data_center` | tahmin bandı −%10, seviye 3'te +1 brifing maddesi |
| `engine_lab` | güvenilirlik +0,02 (DNF olasılığını düşürür) |
| `driver_academy` | antrenman kazancı **+%8**; her kış bir bedava çaylak |
| *hepsi* | kış resetinde araç tabanına **+1,5** (§4) |

Üretim indirimi ve süre katsayısı §3.1'deki formüllere girer; çarpımsaldır ve
sırasıyla %30 ve %40 indirimde taban yapar (5 seviyede bile ekonomi kırılmasın).

---

## 7. Padok gideri — kıt kaynak

Maaş formülleri:

```
personelMaaşı(yetenek) = round(25 + (yetenek − 30) / 70 × 110)
sürücüMaaşı(ortalama)  = round(60 + (ortalama − 55) / 40 × 190)
```

| Kadro | Yarış başına |
|---|---|
| Asgari (2 sürücü ort 70/68 + 1 mekanik y52) | **313 RP** |
| Dengeli (2 + 1 yedek + 2 personel y65) | **522 RP** |
| Tüccar (2 + 4 genç ort 62 + 2 personel y65) | **649 RP** |
| Elit (2 yıldız + 4 iyi + 3 personel y90) | **1.235 RP** |

Gelir: P1 ~1.450 · P3 ~1.310 · P6 ~1.100 · P11 ~750 RP.

Yani **elit kadro kurarsan araca para kalmaz** — P1'deyken bile geriye 215 RP
kalır, en ucuz geliştirme 750'dir. Kadro tavanının 6'ya çıkması bu dengeyi
bozmaz, çünkü fazladan her sürücü hem maaş yer hem de tek antrenman koltuğunu
paylaşır. Tasarımın merkezindeki acı verici tercih budur; yumuşatılmamalıdır.

Maaşlar mevcut davranıştaki gibi hafta sonu gelirinden düşer
(`gameStore.settleRaceWeekend`). Gelir maaşı karşılamazsa RP 0'da tabanlanır
(mevcut `Math.max(0, ...)` korunur) — iflas mekaniği **yok**.

---

## 8. Altın

**Sabit kur: 1 Altın = 50 RP.** Hızlandırma **saat başı 5 Altın**.

| | |
|---|---|
| Reklam | günde 8 × 1 Altın |
| Paket `pit-pass` ₺49,99 | **60 Altın** |
| Paket `paddock` ₺129,99 | **180 Altın** (+%20 değer) |
| Paket `motorhome` ₺299,99 | **500 Altın** (+%39 değer) |

Her Altın harcamasının bir RP karşılığı vardır — **sadece Altın'la açılan
hiçbir şey yoktur**:

| Harcama | Altın | RP alternatifi |
|---|---|---|
| Geliştirme / antrenman atlama | 5 / saat | — (beklemek bedava) |
| Casus raporunu atlama (24 sa) | 120 | — (beklemek bedava) |
| İkinci antrenman koltuğu (1 sezon) | 40 | 2.500 |
| Profesyonel casus | 15 | 900 |
| Garaj gizleme 1 / 3 / 7 gün | 3 / 8 / 20 | 200 / 500 / 1.200 |
| RP satın alma | 1 → 50 RP | — |

### Enflasyon freni

Günde 8 reklam = 8 Altın = 400 RP eşdeğeri. Yarış döngüsü ~2,5 gün → bedava
1.000 RP, yani bir yarış gelirinin tamamı. Bu kabul edilemez.

**Fren: Altın→RP dönüşümü günde en fazla 6 Altın (300 RP).** Hızlandırmada ve
diğer harcamalarda tavan yoktur. Bu, bedava geliri yarış döngüsü başına ~750 RP
ile sınırlar (gelirin ~%27'si).

Bu, playtest sonrası ilk ayarlanacak knob'dur.

---

## 9. Değişmeyecekler

- **Sponsor ücretinin koşulsuzluğu.** Kötü sonuç ücreti azaltmaz, sadece hedef
  bonusunu ve seriyi kaybettirir. DNF de öyle. (`sponsors.ts` kuralı.)
- `sponsors.ts`'in ücret/paket/seri/yenileme mantığı — yalnızca
  `ECONOMY_SCALE` değeri değişir, formüller değişmez.
- `driverMarket.ageFactor`, `trainingGain`, `ageOneSeason` — §5.4.
- Sözleşme süresi çarpanları (`contractTerms`).
- Belirlenimcilik sözleşmesi: her rastgelelik tohumlu, `Math.random()` yok.
- `data/` katmanı saf TypeScript kalır; React/store/UI import etmez.

---

## 10. Dosya planı

| Dosya | Durum | İş |
|---|---|---|
| `src/data/economy.ts` | büyür | `ECONOMY_SCALE`, Altın kuru, paketler, tüm RP/Altın fiyat tablosu, dönüşüm tavanı |
| `src/data/carCustomisation.ts` | küçük | `upgradeCostFor(done)` ve `skipCostGold(remainingMs)` eklenir; `upgradeDurationMs` olduğu gibi kalır |
| `src/data/sponsors.ts` | küçük | `ECONOMY_SCALE` 0.2 → 1.5 (yalnızca sabit) |
| `src/data/season.ts` | değişir | sezon ödülü formülü, kış reseti (`regressCar`) |
| `src/data/staff.ts` | değişir | `wageFor` yeni formül |
| `src/data/driverMarket.ts` | değişir | `driverFee` üstel, `driverWage` yeni ölçek, `saleValue` (%20 komisyon) |
| `src/data/espionage.ts` | değişir | görev round yerine gerçek zamanlı: `endsAt`, 24 sa rapor, 48 sa bekleme, atlama |
| `src/data/factory.ts` | **yeni** | departman seviye maliyeti + `factoryEffects` (mock'tan taşınır) |
| `src/data/raceEngine.ts` | değişir | yarış günü kilidi: pişen stat yarı değerde, DNF ×2 |
| `src/store/gameStore.ts` | değişir | `upgradeStat` → `startBuild`/`collectBuild`/`skipBuild`, merdiven sayacı, kış reseti |
| `src/store/slices/economySlice.ts` | değişir | `spendGold` + `convertGoldToRp` (günlük tavanlı), yeni paket boyları |
| `src/store/slices/driverSlice.ts` | değişir | kadro 2-6, `sellDriver`, aynı-raund satış kilidi, antrenmandaki sürücünün yarış kilidi |
| `src/data/mock.ts` | temizlik | `carStats[].cost` ve `factoryDepartments[].cost`/`upgradable` kaldırılır, veriden türetilir |
| `src/features/development/*` | değişir | tezgah arayüzü: pişen geliştirme, geri sayım, atlama düğmesi |
| `src/features/paddock/*` | değişir | satış akışı, kadro limiti uyarısı |

---

## 11. Doğrulama

Test altyapısı yok. `mobile/` içine geçici `src/__econ.ts` yazılır, `npx tsx`
ile koşulur, **silinir**. Ölçülecekler:

1. **Sezon eğrisi:** 23 yarışlık simülasyon → sezon sonu araç ortalaması
   **88-92** aralığında, oyuncu **P1-P4** arasında bitmeli. Dışına çıkıyorsa
   gelir veya kazanç ayarlanır.
2. **Merdiven duvarı:** hiçbir sezonda tek stat'ta **6'dan fazla** yükseltme
   alınamamalı (aksi hâlde ×1.5 fren tutmuyor demektir).
3. **Tezgah darboğazı:** 60 saatlik yarış arasında en fazla 2-3 geliştirme
   bitebilmeli; sezon boyu toplam biten geliştirme **10-14** olmalı.
3b. **Grup dışlayıcılığı:** araç grubu doluyken ikinci bir araç geliştirmesi,
   sürücü grubu doluyken ikinci bir antrenman başlatma denemesi reddedilmeli;
   buna karşılık araç + sürücü + casus üçlüsü aynı anda yürüyebilmeli.
3c. **Yarış günü kilidi:** pişen stat'la yarışan araç, aynı tohumla pişmeden
   yarışan araçtan ortalama **en az 4 sıra geride** bitmeli (ceza gerçekten
   acıtıyor mu). Antrenmandaki sürücünün yerine yedeğin geçtiği, yedeksizken
   aracın çıkmadığı doğrulanmalı.
3d. **Kadro sınırları:** 2 sürücüyken satış reddedilmeli, 6 sürücüyken alım
   reddedilmeli.
4. **Kadro tercihi:** elit kadro senaryosu koşulduğunda sezon sonu araç
   ortalaması yalın kadro senaryosundan **en az 8 puan düşük** olmalı — tercih
   gerçekten acıtıyor mu.
5. **Ticaret kârlı ama baskın değil:** bir sezonluk sürücü çevirmenin net kârı
   toplam sezon gelirinin **%15'ini geçmemeli**.
6. **Kış reseti:** 90+ araç resetten sonra **70-76** aralığında çıkmalı ve
   merdiven sayaçları sıfırlanmış olmalı.
7. **Altın enflasyonu:** günlük tavanla bedava RP, yarış döngüsü gelirinin
   **%30'unu geçmemeli**.
8. **Belirlenimcilik:** aynı tohumla iki koşu birebir aynı sonucu vermeli.
9. **İstihbarat zamanlaması:** görev 24 sa sonra çözülmeli, 48 sa geçmeden
   yenisi açılmamalı ve sonuç aynı tohumla iki koşuda birebir aynı çıkmalı.
10. `npm run typecheck` ve `npm run lint` temiz.

---

## 12. Kapsam dışı

- Kayıt/yükleme (persist). Tezgah ve antrenman gerçek zamanlı olduğu için
  ekonomi bu olmadan tam anlamlı değil, ama **ayrı iştir** ve bu spec'e
  girmez.
- Sunucu tarafı ekonomi doğrulaması (online lig). Şu an istemci otoritesi var.
- Mağaza ürünlerinin (SKU) oluşturulması ve üretim AdMob kimlikleri — dış iş.
- Livery/kozmetik satışı.
