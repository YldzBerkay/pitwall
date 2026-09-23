# Faz 3a-3 — İstemcinin Sunucuya Bağlanması · Tasarım

## 1. Bugünkü durum

Sunucu artık oyunun tamamına sahip: kimlik, lobiler, koltuklar, ekonomi ve —
Faz 3a-2 ile — yarışın kendisi. İstemci bunların hiçbirini kullanmıyor.

Ölçüldü (`mobile/src` anketi):

| Yüzey | Sunucuda | İstemci ne yapıyor |
|---|---|---|
| Kimlik, lobi, koltuk | ✅ | ✅ kullanıyor |
| Yarış (`/race/checkin`, `/race/pit`, `/race/live`) | ✅ | ❌ silinmiş uçlara çağrı yapıyor — **404** |
| Ekonomi (`/economy/action`, `buildSlotState`) | ✅ | ❌ hiç çağırmıyor, kendi kopyasını koşuyor |
| Altın (`/gold/purchase`, reklam) | ✅ | ❌ hiç çağırmıyor |

`mobile/src/store/gameStore.ts` (982 satır) `@pitwall/shared`'ın tüm simülasyon
yığınını **gösterim için değil, koşturmak için** içeri alıyor ve modül düzeyinde
kendi `setInterval`'ıyla yerel bir yarış sürüyor — sunucunun lobi döngüsüne
paralel, ikinci bir gerçeklik.

İki somut sonucu var:

- **Cihaz saati açığı hâlâ canlı.** Faz 3a-1'in var olma sebebi buydu: saati
  ileri almak 22 saatlik bir yükseltmeyi anında bitiriyordu. Sunucuda kapandı,
  istemcide kapanmadı — çünkü istemci sunucuya hiç sormuyor.
- **İki yarış var.** `LiveRacePanel` kaynağı umursamıyor, `weekend.race`'te ne
  varsa çiziyor; oraya hem yerel `advanceLap` hem (ölü) sunucu soketi yazıyor.
  Bugün çakışmıyorlar ama bu tesadüf, yapısal değil.

## 2. Karar: yerel motor tamamen kalkıyor

Tek oyunculu kariyer ayrı bir mod olarak **yaşamıyor**. İstemci sunucunun
görüntüsü oluyor; yarışı, ekonomiyi ve sezonu kendisi hesaplamıyor.

Bunun sonucu, `gameStore.ts`'in büyük kısmının sökülmesi. Kabul ediliyor.

**Reddedilen seçenek:** bağlantı koparsa yerele düşmek. Yarış ortasında yerele
düşen istemci, sunucunun koşturduğundan **farklı** bir yarış çizer — Faz 3a-2'nin
tüm amacı olan "herkes aynı yarışı görür" garantisini tam da en görünür anda
bozar. Bağlantı koptuğunda doğru davranış, yarışın bir görüntüsünü uydurmak
değil, koptuğunu söylemektir.

`shared/` simülasyonu silinmiyor: sunucu onu kullanıyor ve saf kalmaya devam
ediyor. Kalkan şey, istemcinin onu **koşturması**.

## 3. Yerel motorun yerine ne geçiyor

| Bugün istemcide | Yarın |
|---|---|
| `advanceRaceLap` + `raceClock` | `/race/live` soketinden gelen `lap` çerçeveleri |
| `startRaceSession`, `simulateQualifying` | Sunucu ışıkları söndürür; istemci `state` çerçevesini alır |
| `queuePit` → yerel karar tamponu | `POST /race/pit` |
| Yerel `settleRaceWeekend`, `racePrize` | Sunucu muhasebesi; istemci sonucu okur |
| `economySlice`, `driverSlice`, `espionageSlice`, `staffSlice` | `POST /economy/action` + `buildSlotState` |
| Yerel sezon, `regressCar`, `summariseSeason` | Sunucu sezon dönüşü |

**Yeniden yazılmayanlar:** `LiveRacePanel` ve çizim katmanı jenerik bir
`RaceState` okuyor, kaynağı umursamıyor. Hafta sonu seçim UI'ı da duruyor
(`PracticePanel`'de bias, `QualifyingPanel`'de sıralama lastiği, risk, yarış
lastiği, taktik) — yalnızca değerlerini sunucuya göndermeye başlıyorlar.

## 4. Bağlantı durumu birinci sınıf bir kavram

Yerel yedek olmadığına göre, istemci "sunucuyla aram nasıl" sorusunu dürüstçe
cevaplamak zorunda. Tek bir durum alanı:

```
'bağlı' | 'bağlanıyor' | 'kopuk' | 'oturum geçersiz'
```

Kopukken yarış ekranı **son bilinen durumu donmuş olarak** gösterir ve kopuk
olduğunu söyler. Devam ediyormuş gibi yapmaz. Yeniden bağlanınca sunucu
`state` çerçevesini gönderir ve istemci oraya atlar — arayı kapatmaya çalışmaz,
çünkü sunucudaki `last_lap` otoritedir.

Pit çağrısı kopukken **kabul edilmez**. Kuyruğa alıp sonra göndermek, koşmuş
bir tura karar yazmaya çalışmak demektir; sunucu zaten reddeder (`lap_already_run`)
ve oyuncu çağrısının işlediğini sanmış olur.

## 5. Hafta sonu tercihleri

Sunucu tarafı bu faza paralel yazıldı: `lobby_seats`'e tercih sütunları, bunları
yazan bir uç, ve `startRaceFor`'un varsayılan yerine onları okuması. Tercihler
ışıklar sönerken **donar** — tıpkı `managed` gibi.

İstemci tarafı küçük: dört seçim zaten UI'da, tipler `shared/`'da ortak. Ölü
`leagueSlice.ts:132` bunları paketleyen fonksiyonu bile içeriyor. Yapılacak,
onu lobi kapsamlı uca yöneltmek ve gövdeden `teamKey`/`managerId`'yi çıkarmak —
sunucu ikisini de oturumdan ve koltuktan türetiyor.

**UI'ın söylemesi gereken:** tercihler `live`'dan önce gönderilmeli. Sonrası
reddedilir ve bu bir hata değil, kuralın kendisi.

## 6. Sıra: önce yarış, sonra ekonomi

Yarış şu anda **kırık** (404), ekonomi ise yanlış ama çalışıyor. Önce kırık olan.

- **Aşama 1 — yarış.** `race.ts` API modülü, `leagueSlice` → `raceSlice`, soket
  aboneliği, hafta sonu tercihlerinin gönderilmesi, yerel yarış yolunun silinmesi.
  Sonunda: bir lobide yarış izlenebiliyor ve pit çağrılabiliyor.
- **Aşama 2 — ekonomi.** `economySlice`, `driverSlice`, `espionageSlice`,
  `staffSlice` ve `gameStore`'un fabrika/test/sponsor mantığı sunucu çağrılarına
  dönüşüyor. Sonunda: cihaz saati açığı kapanıyor.
- **Aşama 3 — kalıntıların silinmesi.** Yerel sezon, yerel muhasebe, yerel
  başarımlar. Sonunda: `gameStore` bir sunucu görüntüsü.

Her aşama çalışan bir oyun bırakmalı.

## 7. `gameStore` ne olacak

982 satırlık tek bir store, online/offline ekseninde dilimlenmemiş — yani her
değişikliğin yayılma alanı geniş. Aşama aşama sökmek, tek seferde yeniden
yazmaktan güvenli, ama sonunda ortaya çıkması gereken şey net:

- **Sunucudan gelen durum** (yarış, ekonomi, sıralama, koltuklar) — salt okunur
  görüntü, istemci hesaplamaz.
- **Yerel UI durumu** (seçili sekme, açık panel, erişilebilirlik ayarları) —
  `persist`te kalan tek şey, bugün de zaten öyle.
- **Gönderilecek niyetler** (pit çağrısı, hafta sonu tercihi, ekonomi eylemi) —
  sunucuya yazılır, cevabı beklenir.

Bugün `persist` yalnızca `colorblindMode`, `textScale`, `hudCompact` ve auth'u
saklıyor; bu zaten doğru ve değişmiyor.

## 8. Doğrulama

`npm run econ` geçmeye devam etmeli.

Bu fazın kapattığı kapıları kanıtlayan testler:

1. **Yerel yarış motoru koşmuyor** — istemcide tur ilerleten hiçbir zamanlayıcı
   kalmadı; `weekend.race`'e yalnızca soket yazıyor.
2. **Kopuk hâlde yarış donuyor ve bunu söylüyor**, uydurma tur ilerletmiyor.
3. **Kopuk hâlde pit çağrısı reddediliyor**, kuyruğa alınmıyor.
4. **Hafta sonu tercihi sunucuya gidiyor** ve yarışta etkisi görülüyor.
5. **`live` fazında tercih göndermek reddediliyor.**
6. **Ekonomi eylemleri sunucuya gidiyor**; cihaz saatini ileri almak hiçbir işi
   bitirmiyor — Faz 3a-1'in açığının istemci tarafındaki kanıtı.
7. **Sunucu sonucu ile ekranda görünen aynı** — istemci ikinci bir hesap yapmıyor.

Her biri için önce kural bozulur, adı konmuş testin düştüğü görülür, geri alınır.

## 9. Kapsam dışı

- Kadro, sözleşme, personel (Faz 3b) · sponsor sözleşmeleri (Faz 3c)
- Sezon sonu özeti ve arşiv, ayrılma cezası (Faz 4) · arkadaş sistemi (Faz 5)
- Sosyal giriş SDK'ları — uçlar hazır, yerel SDK bağlanmadı (`AuthScreen.tsx:57`
  düğmeleri kapalı)
- `server/README.md`'nin uç nokta tablosu silinmiş tek ligi anlatıyor; bu fazda
  düzeltilecek ama tasarım konusu değil
