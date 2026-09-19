# Pit Wall — Yarış Kontrolü Araştırması ve Hafta Sonu Formatı

> 2026-09-16. Oyun sahibinin isteği: sarı bayrak, kırmızı bayrak, VSC ve SC
> olasılıklarını güncel verilerle pist bazında bul; hafta sonu formatını
> (test günleri, sprint, seans saatleri, mühendis brifingi, hedefler) gerçeğe
> yakın kur. Bu belge önce veriyi, sonra oyuna çevrilmiş modeli verir.

---

## 1. Kaynaklar

| Kaynak | Ne verdi |
|---|---|
| formula1.com "Need to Know" (2025-2026 yarış önü) | Pist başına resmi **SC olasılığı / VSC olasılığı** (son 6-8 yarış): Monaco SC %29 / VSC %43, Singapur %83 / %33, Spa %63 / %0, Abu Dabi %38 / %50, Avustralya %50 / %67 |
| lightsoutblog.com — 2024 ve 2025 sezonu tüm SC/VSC listesi | Yarış yarış her nötrleme: 2024'te **14 SC + 9 VSC**, 2025'te **20 SC + 13 VSC** (24 yarış) + sprintlerde 6 SC |
| lightsoutblog.com — 2025 tüm kırmızı bayraklar | Yarışta 1 (Belçika, ısınma turu, hava), sprintte 2 (Miami, São Paulo); antrenman+sıralamada **~52** kırmızı bayrak / 24 hafta sonu |
| racingnews365.com — kırmızı bayrak trendi | Yarış durdurma: 2021: 7, 2022: 3, 2023: 6; 2020-2023 toplam 20 |
| f1betuk.com — pist bazlı SC bahis rehberi | Singapur %100 (1.71 SC/yarış), Monaco ~%70 (son 10), Kanada 9 yarışta 14 SC, Bahreyn ~%14; sokak/permanent ayrımı; hava çarpanı (Spa, Suzuka, Interlagos) |
| gpblog.com — Bakü | Sokak pisti: SC neredeyse garanti, **kırmızı bayrak ~%40** |
| axiorablogs.com — SC ve beklenen değer | Stratejistler SC olasılığını pit penceresine nasıl katıyor (geç pit, "ucuz pit") |
| Wikipedia — Safety car | VSC: %35 hız düşüşü, delta zamanı; SC: alan toplanır, geçiş yasak |
| formula1.com / skysports / yahoo — 2026 sprint takvimi ve Zandvoort zaman çizelgesi | 6 sprint hafta sonu (Çin, Miami, Kanada, Britanya, Hollanda, Singapur). Cuma FP1 09:30 → SQ 13:30; Cumartesi Sprint 10:00 → Q 14:00; Pazar yarış 13:00 |
| motorsportmagazine / racingnews365 — 2026 sezon öncesi test | Barselona 5 gün (takım başına 3), Bahreyn 2×3 gün; günde 8-9 saat pist |

Sarı bayrak sıklığı için pist bazlı kamuya açık istatistik **yok**; sadece
kural açıklamaları var. §3'te sarı bayrak, SC/VSC/DNF sayılarından türetilmiş
bir tahmindir ve öyle etiketlendi.

## 2. Sayılar

### 2.1 Sezon düzeyi

| | 2024 (24 yarış) | 2025 (24 yarış) |
|---|---|---|
| Yarışta SC sayısı | 14 | 20 |
| Yarışta VSC sayısı | 9 | 13 |
| En az bir SC olan yarış | ~%46 | 13/24 = **%54** |
| SC veya VSC olan yarış | ~%60 | 18/24 = **%75** |
| Yarış kırmızı bayrağı | ~2 | 1 GP + 2 sprint |
| Antrenman/sıralama kırmızı bayrağı | — | ~52 (**2.2 / hafta sonu**) |

Kırmızı bayrak 2020'lerde yılda 3-7 arası; yarış başına ortalama **%8-12**.
Sokak pistlerinde ve yağmurda çok daha yüksek (Bakü tarihsel ~%40, Belçika
2025 hava).

### 2.2 Pist tipi bazında (oyunun analog pistlerine eşlendi)

| Gerçek analog | Oyundaki pist | SC (yarış başına) | VSC | Kırmızı | Not |
|---|---|---|---|---|---|
| Singapur | Marina Lights | 0.90 (ort. 1.7 SC) | 0.35 | 0.15 | Sokak, gece, en yüksek |
| Monaco | Rocher Harbour | 0.55 | 0.45 | 0.20 | Sokak, dar; 2025'te sadece VSC |
| Bakü | Caspian Old Town | 0.60 | 0.30 | 0.30 | Sokak, uzun düz; kırmızı rekoru |
| Cidde | Corniche Lights | 0.55 | 0.25 | 0.15 | Hızlı sokak |
| Las Vegas | Neon Boulevard | 0.35 | 0.55 | 0.08 | Sokak ama geniş; VSC ağır |
| Miami | Bayfront | 0.45 | 0.50 | 0.10 | 2025: 3 VSC + sprintte 2 SC |
| Kanada | Île du Nord | 0.70 | 0.30 | 0.12 | Şampiyonlar duvarı |
| Melbourne | Harbour Park | 0.50 | 0.60 | 0.12 | 2025: 3 SC (yağmur) |
| Spa | Ardennes | 0.60 | 0.05 | 0.15 | Hava çarpanı; VSC neredeyse yok |
| Silverstone | Greystone | 0.45 | 0.35 | 0.08 | 2025: 3 SC + 2 VSC (yağmur) |
| Zandvoort | Duinen | 0.55 | 0.30 | 0.12 | 2025: 3 SC; 2026 kırmızı |
| Interlagos | Serra Hill | 0.65 | 0.35 | 0.15 | 2024: 3 SC; yağmur |
| Imola | Valle d'Oro | 0.40 | 0.30 | 0.08 | |
| Suzuka | Kashima | 0.35 | 0.20 | 0.08 | Yağmurda çarpan |
| Şanghay | Pearl River | 0.35 | 0.35 | 0.05 | |
| Bahreyn | Al Rimal | 0.20 | 0.25 | 0.03 | En düşük |
| Barselona | Sierra Blanca | 0.25 | 0.25 | 0.04 | |
| Avusturya | Alpenring | 0.35 | 0.35 | 0.05 | |
| Macaristan | Danube Ring | 0.30 | 0.25 | 0.05 | |
| Monza | Velocità | 0.35 | 0.30 | 0.06 | |
| Austin | Prairie Hill | 0.40 | 0.35 | 0.06 | Sprintte 2 SC (2025) |
| Meksika | Altiplano | 0.45 | 0.30 | 0.10 | 2024 1. tur SC, 2023 kırmızı |
| Abu Dabi | Lagoon Marina | 0.30 | 0.45 | 0.03 | |

Kalibrasyon: 23 pistin ortalaması SC 0.46, VSC 0.34, kırmızı 0.10 → sezon
düzeyindeki 2024-2025 gözlemine (%46-54 SC, ~%10 kırmızı) oturur.

### 2.3 Sarı bayrak (türetilmiş)

Her SC/VSC/kırmızı bir sarıyla başlar; ayrıca pistten çıkmalar, spin'ler ve
enkaz sarısı var. Model: **yarış başına yerel sarı = 2 + 3 × attrition**
(Bahreyn ~3, Singapur ~4.3). Etki: sarı sektördeki araçlar o tur 0.5-1.5 sn
kaybeder, geçiş yok. Bu bir tahmindir; ölçülmüş veri yok.

## 3. Oyuna çevrilen model (`raceEngine.ts`)

| Olay | Tetikleyici | Süre | Etki |
|---|---|---|---|
| Sarı | tur başına `yellow/laps` | 1 tur | Alanın ~%30'u +0.5-1.5 sn, o araçlar geçiş yapamaz |
| VSC | tur başına `vsc/laps`; DNF sonrası %30 | 1-2 tur | Herkes +28 sn/tur (%35 yavaş), fark korunur, geçiş yok, **pit kaybı ×0.6** |
| SC | tur başına `sc/laps`; DNF sonrası sokakta %60, diğer %35; ıslakta ×1.5 | 3-5 tur | Alan toplanır (0.6 sn/sıra), +40 sn/tur, geçiş yok, **pit kaybı ×0.5** |
| Kırmızı | yarış başına `red`; ıslakta ×2; büyük kaza | 1 tur (oyun) | Yarış durur; **duran başlangıçla** mevcut sırayla yeniden; **lastik serbest** (aşınma 0), yarış süresi nötr |

Yeşil bayrakla yarış normal kaldığı yerden devam eder. Olaylar günlükte:
`yellow | vsc | sc | red | green`.

## 4. Hafta sonu formatı

### 4.1 Her pist bir gün, saatler bölgeye göre

Gerçekte hafta sonu üç gün; oyunda **bir gün**. Seanslar bölgenin "prime
time"ına oturur (kullanıcının yerel saatine çevrilir):

| Bölge | FP1 (UTC) | Standart: FP1 · FP2 · FP3 · Q · Yarış | Sprint: FP1 · SQ · Sprint · Q · Yarış |
|---|---|---|---|
| Avrupa | 12:00 | 12:00 · 13:00 · 14:00 · 14:30 · 16:00 | 12:00 · 13:00 · 14:00 · 15:00 · 16:30 |
| Orta Doğu | 13:00 | +1 saat kaydır | +1 saat kaydır |
| Asya-Pasifik | 05:00 | | |
| Amerika | 17:00 | | |

Aralar: antrenmanlar arası 60 dk, FP3→Q 30 dk, Q→yarış 90 dk, sprint günü
SQ→Sprint 60 dk, Sprint→Q 60 dk, Q→yarış 90 dk. Gerçek Zandvoort 2026
çizelgesinin (FP1 09:30 / SQ 13:30 / Sprint 10:00 / Q 14:00 / yarış 13:00)
tek güne sıkıştırılmış hâli.

### 4.2 Sprint pistleri

Gerçekte 6/24. Oyunda 6/23: Pearl River (Çin), Bayfront (Miami), Île du Nord
(Kanada), Greystone (Britanya), Duinen (Hollanda), Marina Lights (Singapur).
Sprint: yarış mesafesinin ~1/3'ü, pit zorunluluğu yok, ilk 8'e 8-7-6-5-4-3-2-1.
Sprint sıralaması ayrı seans (temkinli koşulur), sprint gridi buradan.

### 4.3 Sezon öncesi test — 3 gün

Gerçek: 11 gün (Barselona 5, Bahreyn 2×3). Oyun: sezon başında **3 test günü**.
Her gün mühendis bir zayıflık raporu verir (takvimin talebine göre en geride
kalan stat); oyuncu bir test programı seçer (motor / aero / grip /
güvenilirlik). Doğru program: **+2 stat** (ya da +1 fabrika seviyesi) ve
kariyer skoru; yanlış program: +1 stat. Böylece test "doğru hamle" ödülünü
gerçekten geliştirme olarak verir.

### 4.4 Mühendis / yorumcu brifingi ("doğru hamle" sistemi)

Antrenmanda pit duvarı brifingi verir; her madde bir öneriye bağlanır ve
hafta sonu sonunda tutulan öneri sayısı ödüllenir (madde başına +8 RP ve +5
kariyer skoru):

| Madde | Veri | Öneri |
|---|---|---|
| Lastik aşınması | `attrition`, `tyreLifeLaps` | başlangıç bileşimi, pit sayısı (taktik ön ayarı) |
| Hava | `weatherFor.forecast`, `rainFromLap` | slick mi yağmur mu; tahmin ≥ %50 → temkinli taktik |
| Yarış kontrolü | `raceControl.sc/vsc` | SC olasılığı yüksekse geç pit (agresif taktik) |
| Geçiş | `overtaking` | zor pistte sıralama riski **agresif** (grid her şey), kolay pistte temkinli |
| Setup | `demand` vs stat | bias önerisi (aero/mekanik) |

### 4.5 Takım hedefleri ve rütbe puanı kapısı

Her yarış için takımın güç sırasından türeyen iki hedef: **sıralama hedefi**
(lider araç için beklenen bitiş) ve **puan hedefi** (iki aracın beklenen
puanı). Kural (oyun sahibi):

1. Sıralama hedefi tutar → başarım/rütbe puanının tamamı.
2. Sıralama tutmaz ama puan hedefi tutar → rütbe puanı **0** (şampiyona puanı
   yine yazılır).
3. İkisi de tutmaz → 0; bitiş hedefin 4+ sıra gerisindeyse **negatif**:
   −2 × (fark − 3), en az −20.

Şampiyona puanı hiçbir zaman kesilmez; kapı yalnızca kariyer/rütbe skorunu
etkiler.
