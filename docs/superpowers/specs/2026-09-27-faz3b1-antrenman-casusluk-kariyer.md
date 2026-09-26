# Faz 3b-1 — Antrenman, Casusluk ve Kariyer · Tasarım

## 1. Neden bu faz, neden bu kapsam

Faz 3a-3 istemciyi sunucunun görüntüsüne indirgedi ve yerel yarış motoruyla
yerel muhasebeyi sildi. Muhasebe altı şeyi tetikleyen tek yerdi ve kullanıcının
açık onayıyla ertelendiler.

Faz 3b iki dilime ayrıldı. Ayrımın ölçütü **sürücülerin sunucuda yaşayıp
yaşamaması** — ölçülerek çıkarıldı:

| Dilim | Kapsam | Neden |
|---|---|---|
| **3b-1 (bu)** | Antrenman · casusluk · başarımlar · kariyer | Sunucunun elinde gereken her şey var |
| **3b-2** | Sürücü pazarı · personel · maaşlar · sakatlıklar · yaşlanma · rütbe puanı | Hepsi sürücülerin sunucuda yaşamasını gerektiriyor |

Maaşlar ve sakatlıklar ilk bakışta "kırık, önce düzelt" grubundaydı. Değiller:
sunucuda `rosters: {}` boş gidiyor ve maaş/personel/sözleşme kavramı yok. Motor
sakatlığı üretiyor (`injured`) ama işaretlenecek kalıcı bir sürücü yok. İkisi de
3b-2'nin ön koşulunu bekliyor.

## 2. Antrenman geri geliyor

### 2.1 Nasıl kalkmıştı

Faz 3a-3'ün faz eşlemesinde antrenman seansları kaldırıldı. Gerekçe, sunucuda
antrenmanın hiç olmaması ve sıralamanın oyuncunun koşturduğu bir seans değil,
ışıklar sönerken tek seferde gerçekleşmesiydi. Ama bu, **antrenmanın çevrimiçi
oyunda olup olmaması gerektiği** sorusunu sormadan verilmiş bir karardı — bir
eşlemenin yan etkisi olarak. Kullanıcı sorunca açıkça ele alındı.

Silinmeden önceki kodda antrenman:
- tüm sahanın tur sürelerini üretiyordu — "bu pistte arabam sahaya göre nerede?"
- FP1 → FP2 → FP3 → sıralama ritmi veriyordu
- Clean Sweep başarımını besliyordu

Arabayı değiştirmiyordu; brifing doğruluğunu da etkilemiyordu (o personelden).
Değeri **bilgi ve ritim**.

### 2.2 Karar: zamanlı seanslar, herkes aynısını görür

Sunucu FP1, FP2 ve FP3'ü `open` fazı boyunca **belirli saatlerde** koşturur. Her
seans başladığı andaki tercihleri **dondurur** — yarışın ışıklar sönerken
yaptığının aynısı. Herkes aynı zaman tablosunu görür.

Seanslar arasında kurulum değiştirilebilir, gerçek F1'deki gibi. Bu antrenmanı
anlamlı kılan şey: check-in'den önceki son bilgi olur ve bir kurulumu denemenin
tek yoludur.

**Reddedilen:** oyuncunun istediği an koşturduğu antrenman. Daha etkileşimli,
ama zaman tablosu izleyene göre farklı olurdu — diğer takımların kurulumu o an
bilinmez. Bu, "herkes aynı şeyi görür" ilkesini antrenmanda bırakmak demekti.

### 2.3 Zamanlama

Yarışlar **günlük** — her bölgede yerel 21:00 (`REGION_RACE_HOUR`). Yani `open`
penceresi yaklaşık 24 saat. Seanslar ışıkların sönmesinden (T) geriye sayılır:

| Seans | Zaman |
|---|---|
| FP1 | T − 18 sa |
| FP2 | T − 12 sa |
| FP3 | T − 6 sa |

Sprint haftasında tek antrenman (`practiceCount = 1`), T − 12 sa. Değerler
adlandırılmış sabit; ayarlanabilir.

### 2.4 Tarif modeline oturuyor

`simulatePractice` saf ve tohumlu (`rng(seed * 4409 + round * 47 + session * 811)`).
Antrenmanda pit kararı yok, dolayısıyla karar günlüğü de yok: bir seans =
**tohum + tur + seans numarası + o an dondurulan katılım**. Sonuç türetilir,
saklanmaz. Saklanan yalnızca dondurulmuş katılım — yarışın `race_runs`'ının
karar günlüğü olmayan kardeşi.

Hava yarışın havasıdır (`weatherFor(track, seed).wetAtStart`), eski istemcide
olduğu gibi.

## 3. Casusluk sunucuda çözülüyor

### 3.1 Bugünkü durum: kilitli

Sunucuda bir casusluk işi var (`startSpyMission`, `claimSpyReport`, `skipSpy`)
ama yalnızca bir zamanlayıcı ve serbest biçimli yük — **sonucu hesaplayan mantık
tamamen istemcide**. İstemcinin yerel kopyası ise yerel muhasebe silindiğinden
beri hiç çözülmüyor: `resolveIntel`'in tek çağıranı `skipMission`, yani rapor
almanın tek yolu altın ödemek. Çözülmeyen görev yeni görevi de bloke ediyor
(`startMission` bekleyen görev varsa `'pending'` dönüyor). **Casusluk fiilen
kilitli.**

### 3.2 Sonuç sunucuda, tohumlu, istemciye güvenilmeden

Sponsordaki güven sınırının aynısı. İstemci kendi sonucunu seçebilseydi her
görevi başarılı yazardı.

- Sonuç `shared/src/espionage.ts`'in kurallarıyla **sunucuda** hesaplanır:
  ajan profilleri (serbest %55 başarı / %12 yakalanma / %15 yanlış istihbarat;
  premium %85 / %0 / %2).
- Tohum sunucunun bildiği değerlerden türer. `shared/` zaten "cihaz saatini ileri
  alarak sonuç çevrilemesin" diye tasarlanmış — doğru yer sunucu.
- İstemcinin yükündeki hiçbir sonuç alanı okunmaz.

### 3.3 Etkiler

| Sonuç | Etki |
|---|---|
| Başarı | Casusluk yapılan statın **bir sonraki yükseltmesi** ×1,5 (`SPY_BOOST`) |
| Yanlış istihbarat | Aynı stat ×0,5 (`BAD_INTEL_FACTOR`) |
| Yakalanma | RP'nin %15'i, en az 40 (`CAUGHT_FINE_*`) |
| Boş / engellendi | Etki yok |

Çarpan bir sonraki yükseltme işine uygulanır — yükseltme mantığı onu okumalı.
Ceza `chargeRpFloor` ile alınır ve **gerçekten düşülen tutar** bildirilir; bu
kod tabanında bildirilen ile düşülenin ayrışması bir kez yakalandı.

### 3.4 Claim modeli korunuyor

Kullanıcının baştan kurduğu kural: bir işin süresi dolunca ekonomiye hiçbir şey
yazılmaz, yalnızca oyuncunun açık claim'i uygular. Casusluk raporu da claim
edilir. Eski istemcinin "yarış günü otomatik çözüm"ü bu kurala aykırıydı ve
geri gelmiyor.

Bekleme süresi (48 sa, `SPY_COOLDOWN_MS`) sunucuda uygulanır.

## 4. Başarımlar ve kariyer

### 4.1 Başarımlar muhasebede hesaplanıyor

`scoreWeekend` yarış sonucu, sıralama ızgarası ve antrenmandan başarım üretiyor.
Üçü de muhasebe anında sunucuda var — antrenman bu fazla geri geldiği için
Clean Sweep dahil sekizi de hesaplanabilir.

Başarımlar **yalnızca insan koltukları** için hesaplanır. Hafta sonunun başarımları
muhasebe dökümüyle aynı yerde saklanır, ki sonuç ekranı "bu hafta ne kazandın"
gösterebilsin.

### 4.2 Kariyer kullanıcıya ait

`Career` bir ömür boyu kaydı: puan, başarım sayıları, yarış, galibiyet, podyum,
pole, en hızlı tur, DNF, en iyi şampiyona, tamamlanan sezon. Bir oyuncu 3-5
lobide yarışıyor; kariyer bunların **toplamı**, yani **kullanıcı başına** saklanır.

`recordWeekend` muhasebede, aynı transaction'da çağrılır — para ile kariyerin
ayrışabileceği bir çökme penceresi bırakılmaz. Muhasebenin mevcut idempotency
garantisi kariyeri de kapsar: aynı yarış iki kez kariyere yazılmaz.

### 4.3 İki ayrı sayı

Kullanıcının kararı: **kariyer puanı** ile **rütbe puanı** (`users.rank_points`)
ayrı kalır.

- Kariyer puanı gösterişli sonuçları ödüllendirir ve profilde durur.
- Rütbe puanı sezon hedefini zorluk seviyesine göre karşılamayı ödüllendirir ve
  eşleştirmede kullanılır — zayıf arabada hedefini tutturan oyuncuyu adil
  yerleştirir.

İkisi farklı soruları cevaplıyor. Rütbe puanı 3b-2'de, sezon hedefiyle birlikte
gelir. **Bu fazda kariyer puanı `rank_points`'e yazmaz.**

## 5. Değişmeyen sözleşmeler

- **Sunucu `shared/`'ın kurallarını içeri alır, yeniden yazmaz.** Yükseltme
  formüllerinin sessizce sürüklenmesi bir faz boyunca fark edilmedi.
- `now` rotada örneklenir, istekten alınmaz.
- Para yazması ve muhasebesi aynı transaction'da; koruma yazmanın kendi
  `where`'inde. `withTransaction` yalnızca fırlatmada geri alır.
- Transaction içindeki okuma transaction'ın client'ını alır.
- Yayın çizmek için gerekeni taşır, yeniden hesaplamak için gerekeni değil.
- İstemcide yerel yedek yok.

## 6. Doğrulama

`npm run econ` geçmeye devam etmeli.

Kanıtlanacak kapılar:

1. **Antrenman herkese aynı** — iki farklı oyuncu aynı seansı okuyunca aynı
   zaman tablosu.
2. **Antrenman seans başında donuyor** — seanstan sonra değiştirilen kurulum o
   seansın sonucunu değiştirmiyor.
3. **Casusluk sonucu istemciden gelmiyor** — yükte sahte bir `outcome`
   gönderilince yok sayılıyor.
4. **Casusluk artık kilitlenmiyor** — süresi dolan görev claim edilince çözülüyor
   ve yeni görev açılabiliyor.
5. **Başarılı istihbarat bir sonraki yükseltmeyi büyütüyor.**
6. **Yakalanma cezası bildirilen = düşülen.**
7. **Kariyer idempotent** — aynı yarış iki kez kariyere yazılmıyor.
8. **Clean Sweep hesaplanabiliyor** — antrenman, sıralama ve yarışı lider
   tamamlayan kazanıyor.

Her biri için önce kural bozulur, adı konmuş testin düştüğü görülür, geri alınır.

## 7. Kapsam dışı

- Sürücü pazarı, personel, maaşlar, sakatlıklar, yaşlanma, kış (araç
  gerilemesi hariç — o sunucuda zaten var) — **Faz 3b-2**
- Rütbe puanı ve sezon hedefi — **Faz 3b-2**
- Sezon sonu özeti ve arşiv, ayrılma cezası — Faz 4 · arkadaş sistemi — Faz 5
- Sezon öncesi test programı hâlâ yerel ve lobi dışında çalışıyor — ayrı karar
