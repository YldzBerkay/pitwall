# Faz 3a-2 — Lobi Yarış Koşucusu · Tasarım

> Tarih: 2026-09-23 · Durum: onaylandı, uygulama bekliyor
> İlgili: [ekonomi sunucuya](2026-09-22-faz3a-ekonomi-sunucuya-tasarim.md) §2, §6, §8 ·
> [çok oyunculu kabuk](2026-09-19-cok-oyunculu-kabuk-tasarim.md) §3 · [FEATURES.md](../../FEATURES.md)

Faz 3a-1 ekonomiyi sunucuya taşıdı ama **kazanç döngüsünü kapatmadı**: RP'nin ana
kaynağı yarış ödülüdür ve lobilerde yarış koşturan kod yoktur. Bu belge onu
yazar, yarışı muhasebeye bağlar ve Faz 0'dan kalan tek global ligi kaldırır.

---

## 1. Bugünkü durum

Çalışan tek yarış `server/src/league.ts`: tek global lig, bellekte, 241 satır.

```
lightsOut()  → simulateQualifying → startRace → setInterval(tick, tickMs)
tick()       → advanceLap(state, track, decisions) → WS'ten "lap" yayını
flag()       → finishRace → sıralama, tur ilerlet, check-in'leri sıfırla
```

Bir yarış **canlı, tik atan bir simülasyon**. Oyuncu izler ve yarış sırasında
pit çağırır; check-in yapmayanın takımını asistan sürer.

`lobbies` tablosunda `phase`, `round_no`, `season_no`, `next_race_at` kolonları
Faz 2'den beri var ama **hiçbir kod onları ilerletmiyor**.

Bellekteki `setTimeout`/`setInterval` deseni yüzlerce lobide çalışmaz: sunucu
yeniden başlayınca her şey kaybolur, iki kopya aynı yarışı iki kez koşturur.

---

## 2. Temel gereksinim: herkes aynı yarışı görür

Bir lobide yedi insan aynı yarışı izliyorsa hepsi birebir aynı turları görmeli.
Aksi halde sonuç tartışmaya açılır ve lig anlamını kaybeder.

Bu, performanstan önce gelen gereksinimdir ve tasarımın şeklini o belirler.

### 2.1 Motor zaten deterministik

`shared/src/raceEngine.ts`:

```js
const random = rng(state.seed * 7717 + state.round * 131 + lap * 613 + 13);
```

Tur N'in rastgeleliği taşınan değişken bir durumdan değil, `(seed, round, lap)`
üçlüsünden **türetilir**. `shared/` saflık kuralı (Faz 3a-1) ortam
rastgeleliğini ve saat okumasını zaten yasaklıyor; `rng.ts`'in kendi yorumu
niyeti söylüyor: *"oyuncu ekrandan çıkıp geri gelerek kötü bir hafta sonunu
yeniden zar atamasın."*

Dolayısıyla bir yarış şunların **saf fonksiyonudur**:

```
yarış = f(tohum, katılım anlık görüntüsü, ızgara, karar günlüğü)
```

Başka girdi yoktur.

---

## 3. Yarışı saklama, tarifini sakla

Tur durumlarını veritabanına yazmak yerine yarışı yeniden üretebilecek üç şeyi
saklarız:

| Saklanan | Ne zaman | Boyut |
|---|---|---|
| **Tohum** | Işıklar sönerken, bir kez | bir tamsayı |
| **Katılım anlık görüntüsü** — araçlar, setup, taktik, güvenilirlik, kimin insan kimin asistan olduğu | Işıklar sönerken, bir kez | bir jsonb |
| **Karar günlüğü** — hangi turda, hangi araç, hangi lastik | Her karar geldiğinde | yarış başına birkaç satır |

Sunucu çökerse yeni sahip sıfırdan **yeniden oynatır** ve aynı tura bit bazında
aynı turlarla gelir. Geç katılan ya da bağlantısı kopan oyuncu da aynı yeniden
oynatmayı alır.

**"Herkes aynı şeyi görür" böylece yapısal bir özelliktir**, dikkat edilmesi
gereken bir şey değil. 70 tur durumu saklamaya gerek kalmaz; bir yarış birkaç
satırdır.

### 3.1 Tek kritik kural

> **Bir pit kararı, onu tüketen tur simüle edilmeden ÖNCE kalıcılaşmalıdır.**

Aksi halde çökme sonrası yeniden oynatma farklı bir yarış üretir ve iki oyuncu
farklı sonuç görür — tam da kaçındığımız şey.

Uygulamada: `pit` isteği önce karar günlüğüne yazılır, yazma commit olduktan
sonra istek `ok` döner ve karar bir sonraki turda tüketilir. Yazma başarısızsa
karar hiç uygulanmaz ve oyuncuya öyle bildirilir.

### 3.2 Katılım neden donuyor

Kimin insan kimin asistan olduğu check-in'e bağlıdır ve `assistantStrategy`
farklı sürer. Bu, yeniden oynatmanın girdisidir — ışıklar sönerken donar ve
yarış boyunca değişmez. Yarış başladıktan sonra yapılan check-in o yarışı
etkilemez.

---

## 4. Sahiplik: bir yarışı aynı anda tek süreç sürer

`lobbies` satırına kiralama alanları eklenir:

```sql
alter table lobbies
  add column race_owner   text,          -- süreç kimliği
  add column race_lease_until timestamptz;
```

Bir sunucu vakti gelmiş lobiyi `for update skip locked` ile sahiplenir ve
kirayı periyodik yeniler. Sahip ölürse kira dolar, başka bir kopya alır ve
karar günlüğünden yeniden oynatarak devam eder.

Bu desen Faz 3a-1'de bildirim taramasında kanıtlandı: orada da iki kopyanın
aynı satırı almasını `for update skip locked` engelliyordu.

**Kira süresi tik aralığının birkaç katı olmalı** — çok kısa olursa sağlıklı
bir sahip yavaş bir tikte kirasını kaybeder, çok uzun olursa ölü bir sahibin
yarışı gereksiz bekler. Değer uygulamada ölçülerek belirlenir.

---

## 5. Faz ilerlemesi veritabanı otoriteli

Gerçek durum `lobbies.phase` ve `next_race_at`'tedir. Kısa aralıklı bir tarama
vakti gelmiş lobileri ilerletir:

```
open → checkin (T−5dk) → live (T) → result → open (sonraki tur)
```

Bellekte zamanlayıcı yoktur. Sunucu üç gün kapalı kalsa açılışta doğru yerden
devam eder; geç kalınmış bir yarış hemen koşar.

Sezon `SEASON_ROUNDS`'a ulaştığında tur 1'e döner, sezon artar ve kış reseti
(`season.ts:regressCar`) uygulanır — bugün `League.flag()`'in yaptığı işin
lobi başına karşılığı.

---

## 6. Check-in ve pit çağrısı

Bugünkü davranış korunur:

- Check-in yapan oyuncu yarışı izler ve pit çağırır.
- Yapmayanın takımını **asistan** sürer (`managed: 'assistant'`).
- Kimsenin üstlenmediği koltuklar AI'dır.

Uçlar lobi başına taşınır: `POST /lobby/checkin`, `POST /lobby/pit`, gövdede
`lobbyId`. Takım anahtarı **koltuktan** okunur, istekten değil (Faz 3a-1'de
kurulan kural).

**Check-in yapmamış oyuncunun pit çağrısı reddedilir.** Katılım anlık görüntüsü
o takımı `assistant` olarak dondurmuştur; kararını kabul etmek yeniden
oynatmayı bozar, çünkü günlükteki karar ile donmuş katılım çelişir. Bugünkü
`League.pit()` de `slot.checkedIn` şartını arıyor — davranış korunuyor, yalnızca
gerekçesi artık yeniden oynatmaya da dayanıyor.

Check-in yalnızca `checkin` fazında kabul edilir. Işıklar söndükten sonra
yapılan bir check-in o yarışı etkilemez (§3.2) — bir sonraki tura yazılır.

---

## 7. Parc fermé ve pit yolu başlangıcı

Faz 3a-1'in claim modeli bunu mümkün kıldı: biten bir iş, claim edilene kadar
**uygulanmamış** durur.

Işıklar sönmeden hemen önce her takım için açık işler değerlendirilir:

| İşin durumu | Araca etkisi | Başlangıç |
|---|---|---|
| **Devam ediyor** | Pişen stat yarıya iner, DNF riski ×2 *(mevcut `crippleSetup`)* | Normal grid |
| **Bitti, claim edilmedi** | **Geliştirme tam olarak işler** | **Pit yolu** |
| Bitti, claim edildi | Tam işler | Normal grid |

Orta satır gerçek F1 kuralıdır: sıralama turlarından sonra araca dokunmak parc
fermé ihlalidir, cezası pit yolundan başlamaktır. Geliştirme **sayılır** —
ihlalin tanımı zaten aracı değiştirmiş olmandır — ama grid yeri kaybedilir.

**Kapsam "neye dokunulduysa o":** araç geliştirmesi şasiye işler → takımın iki
aracı da; sürücü antrenmanı tek sürücüyü ilgilendirir → yalnızca o araç. Casus
raporu araca dokunmaz → ceza yok.

### 7.1 Modelleme

Gerçekte araç grid yerini almaz; pit çıkışında bekler, yarış kontrolü pit
çıkışını **saha geçtikten sonra** açar ve araç sonda katılır. Bu, gridde
sonuncu başlamaktan daha kötüdür: kalkış tamamen kaybedilir.

Motorda grid satırları `GRID_GAP_SEC = 0.35` ile aralanır. Pit yolu başlangıcı:

- araç sıralama sonucundaki yerini **almaz**, sahanın tamamının arkasına yerleşir;
- üstüne pistin pit yolu karakterine göre ölçeklenen ek bir ilk tur boşluğu alır;
- karşılığında **serbest lastik seçimi** kazanır.

`Track`'e `pitLaneSec` alanı eklenir: pit yolundan geçmenin normal tura göre
maliyeti, saniye cinsinden. Her pist için değer mevcut pist karakterine
(sokak/hız pisti) göre verilir ve `npm run econ` ile kalibre edilir.

Serbest lastik gerçek telafinin karşılığıdır. Araştırmanın bulgusu şudur:
**pit yolu başlangıcı saf ceza değil, takastır** — takımlar bunu bazen bilerek
seçer, çünkü parc fermé'yi zaten ihlal ettikleri için aracı yarışa göre
kurabilirler. Oyunda da geliştirmeyi son ana bırakmak bir hata değil, bilinçli
bir kumar olabilmelidir.

---

## 8. Yarış muhasebesi

`finishRace` sonucu çıktığı anda, **aynı transaction'da** tüm koltukların RP'si
yazılır: yarış ödülü, sponsor ücreti, brifing bonusu. Ayrıca sıralama tablosu
ve rütbe puanı güncellenir.

**İdempotent**: `(lobby_id, season_no, round_no)` üzerinde benzersiz bir
muhasebe kaydı tutulur; aynı yarış iki kez ödeyemez. Bu, yeniden oynatmanın
zorunlu tamamlayıcısıdır — çöken bir sunucu yeniden oynatıp aynı yarışı
bitirebilir ve ödeme iki kez yazılmamalıdır.

Oyuncu uygulamayı hiç açmasa da kazancı işler; muhasebe claim istemez
(Faz 3a-1 spec §5.3).

**Kazanç döngüsü burada kapanır.**

---

## 9. Eski ligin kaldırılması

Silinenler:

- `server/src/league.ts` (241 satır)
- `/join`, `/weekend`, `/checkin`, `/pit` uçları
- `index.ts`'teki tek global `League` örneği ve ona bağlı WS yayını

WS `/live` **lobi başına odaya** dönüşür: istemci hangi lobiyi izlediğini
söyler, yalnızca o lobinin turlarını alır.

Lobiler onun yaptığı her şeyi yapar; iki yarış yolunu sürdürmek bakımı ikiye
katlar ve "ekonomi hangisine bağlanacak" sorusunu doğurur.

---

## 10. Veri modeli

```
lobbies            + race_owner text
                   + race_lease_until timestamptz

race_runs          lobby_id, season_no, round_no,
                   seed bigint,
                   entries jsonb,          -- ışıklar sönerken donan katılım
                   grid jsonb,             -- sıralama sonucu
                   started_at, finished_at,
                   PRIMARY KEY (lobby_id, season_no, round_no)

race_decisions     lobby_id, season_no, round_no,
                   lap int, team_key text, driver_idx int,
                   compound text, created_at,
                   PRIMARY KEY (lobby_id, season_no, round_no, lap, team_key, driver_idx)

race_settlements   lobby_id, season_no, round_no, settled_at,
                   PRIMARY KEY (lobby_id, season_no, round_no)
```

`race_decisions`'ın birincil anahtarı aynı turda aynı araç için ikinci bir
kararı reddeder — oyuncu fikrini değiştirirse son karar değil **ilk** karar
geçerlidir, çünkü yeniden oynatmanın deterministik olması gerekir.

`race_settlements` muhasebenin idempotency anahtarıdır.

---

## 11. Sunucu yapısı

```
server/src/lobby/
  runner.ts       faz ilerlemesi, kiralama, tik döngüsü
  replay.ts       (tohum, katılım, kararlar) → RaceState; saf
  live.ts         lobi başına WS odası
  checkin.ts      check-in ve pit uçları
server/src/economy/
  settle.ts       yarış sonrası muhasebe, idempotent
```

`server/src/league.ts` silinir.

`replay.ts` **saf** kalır — veritabanı okumaz, saat okumaz. Girdiyi `runner.ts`
verir. Bu, yeniden oynatmanın testte sabit girdiyle doğrulanabilmesi için
gereklidir.

---

## 12. Doğrulama

`npm run econ` denge kapısı geçmelidir.

Bu fazın kapattığı kapıları **kanıtlayan** testler:

1. **Yeniden oynatma bit bazında aynı**: aynı (tohum, katılım, kararlar) iki kez
   oynatıldığında her turun her aracının konumu ve süresi aynı.
2. **Çökme sonrası devam aynı yarışı üretir**: 40. turda durdurulan bir yarış,
   karar günlüğünden yeniden oynatıldığında 40. turda aynı duruma gelir.
3. **Karar, tüketen turdan önce yazılır**: yazma başarısızsa karar uygulanmaz.
4. **Aynı turda ikinci karar reddedilir.**
5. **Muhasebe idempotent**: aynı yarış iki kez bitirildiğinde RP bir kez yazılır.
6. **Claim edilmemiş biten geliştirme pit yolu başlangıcı üretir** ve geliştirme
   **yine de** araca işler.
7. **Devam eden geliştirme hâlâ aracı sakatlar** (mevcut davranış korunuyor).
8. **İki kopya aynı yarışı süremez**: kiralama altında yalnızca biri tik atar.
9. **Eski uçlar gitmiştir** ve lobi yarışları çalışır.

Her biri için önce kuralı bozup testin düştüğü görülür, sonra geri alınır.

---

## 13. Ölçek

Yüzlerce eşzamanlı lobi, tek sunucu hedefi. Yoğunluk region'ın akşam saatinde
toplanır, yani tik yükü birkaç saate sıkışır.

Bellekte tik + saf yeniden oynatma bunu rahat kaldırır. Darboğaz olursa yatay
ölçekleme kiralama mekanizması sayesinde zaten mümkündür — ikinci bir kopya
sahipsiz lobileri alır, kod değişikliği gerekmez.

---

## 14. Uygulama sırası

| Adım | İçerik | Kapı |
|---|---|---|
| **1** | `004_race.sql`: kiralama alanları, `race_runs`, `race_decisions`, `race_settlements` | Kısıtlar ısırıyor |
| **2** | `replay.ts`: saf yeniden oynatma | Aynı girdi iki kez → bit bazında aynı |
| **3** | `runner.ts`: faz ilerlemesi + kiralama (yarış koşturmadan) | İki kopya aynı lobiyi almıyor |
| **4** | Tik döngüsü ve çökme sonrası devam | 40. turdan devam aynı durumu üretiyor |
| **5** | `live.ts`: lobi başına WS odası | İki lobinin yayını karışmıyor |
| **6** | `checkin.ts`: check-in ve pit, karar günlüğüyle | Karar turdan önce yazılıyor |
| **7** | Parc fermé / pit yolu + `Track.pitLaneSec` | Pit yolu testi, `crippleSetup` korunuyor |
| **8** | `settle.ts`: yarış muhasebesi, idempotent | Çift bitirme bir kez ödüyor |
| **9** | Eski ligin kaldırılması | Ölü uç kalmadı, lobi yarışları çalışıyor |

Her adım çalışan bir oyun bırakır. Adım 8'de kazanç döngüsü kapanır.

---

## 15. Kapsam dışı

- Kadro, sözleşme, transfer, personel (Faz 3b)
- Sponsor sözleşmeleri ve sezon muhasebesinin tamamı (Faz 3c)
- Sezon sonu özeti ekranı ve arşiv (Faz 4) — veri Faz 3a-1'de üretiliyor
- Ayrılma cezası (Faz 4) · arkadaş sistemi (Faz 5)
- İstemcinin sunucu ekonomisine bağlanması (ayrı plan)
- Yatay ölçekleme dağıtımı — mekanizma hazır, dağıtım kararı ayrı
