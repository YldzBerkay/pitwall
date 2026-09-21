# GUI/UX Rehberi — Boşluk Analizi

2026-09-21 · Kaynak: kullanıcının yüklediği "F1 Yarış Oyunu — GUI/UI/UX Rehberi" (10 bölüm).
Yöntem: bu belgedeki her madde, mevcut kodla (`mobile/src/`, `docs/design-system.md`,
`docs/FEATURES.md`) tek tek karşılaştırıldı.

> **Güncelleme (2026-09-21, aynı gün):** Bu analizdeki en somut 5 bulgu koda uygulandı.
> Uygulanan değişikliklerin dökümü için en alttaki **"Uygulanan değişiklikler"** bölümüne
> bakın; aşağıdaki envanter metni bilinçli olarak değiştirilmedi (o anki durumun kaydı
> olarak kalır), sadece ilgili satırlara ✅-güncel notu eklendi.

**Önemli çerçeve notu:** Rehber bir *sürüş* oyunu (hız göstergesi, DRS/ERS, kokpit HUD'u)
varsayımıyla yazılmış. Pit Wall bir **menajer/strateji** oyunu — yarış canlı izleniyor
(`LiveRacePanel`: harita + sıralama + pit duvarı), sürülmüyor. Bu yüzden SpeedGauge,
RPM/vites, gaz-fren, DRS aktivasyon göstergesi gibi maddeler doğrudan uygulanamaz;
bunlar "N/A — farklı tür" olarak işaretlendi. Zamanlama kulesi, sektör renkleri, pit
uyarıları, bayrak overlay'i gibi *bilgi* katmanı maddeleri ise doğrudan uygulanabilir
çünkü `LiveRacePanel` zaten bir "pit duvarı / yayın" perspektifi.

Durum kısaltmaları: ✅ karşılanıyor · 🟡 kısmen karşılanıyor · ⬜ eksik · ⛔ N/A (tür farkı).

---

## 1. Ekran Akışı ve Bilgi Mimarisi

| Rehber maddesi | Durum | Not |
| --- | --- | --- |
| Splash/logo (atlanabilir, ~2sn) | ⬜ | `app/_layout.tsx` font+Skia yüklenirken düz boş `View` gösteriyor (`styles.root`, satır 58-60). Logo yok, atlama yok, ilerleme yok. |
| Başlık ekranı ("Başla" + döngülü video) | ⬛ yok | Uygulama doğrudan `(tabs)` içine açılıyor; ayrı bir başlık ekranı hiç yok. Kimlik/onboarding zaten `FEATURES.md`'de ⬜ olarak işaretli (Faz 1b). |
| Ana menü: düz vs hub kararı | ✅ (hub) | `ManagerHomeScreen` + alt sekme çubuğu (`NavShell`) fiilen "hub" modeli — Garaj, Yarış, Geliştir, Padok, Sponsor, Lig, Profil. Rehberin F1 World / GT7 paviyon modeline yakın. |
| Mod seçimi (Hızlı Yarış / Kariyer / Zaman Denemesi / Çok Oyunculu) | ⛔ N/A | Oyunda tek mod var: sezon kariyeri + opsiyonel online lig (`league`). Zorluk ön ayarı da yok — asist/zorluk kavramı sürüş oyununa özgü. |
| Araç/sürücü seçimi (kaydırılabilir seçici + stat çubuğu) | 🟡 | `DevelopmentScreen` + `CustomisationPanel` araç görünümü sunuyor (livery/spec), ama "seçim" değil — oyuncu tek takımı yönetiyor, seçmiyor. `CarStatCard`/`LiquidProgressBar` stat çubuğu deseni zaten var. |
| Pist seçimi (küçük resim + harita + tur/hava/rekor) | 🟡 | `RaceWeekScreen`/`BriefCard`/`TrackMap` pist bilgisini gösteriyor ama bir "seçim ekranı" yok — takvim otomatik ilerliyor (bu oyunun tasarımı gereği doğru, rehberdeki "seçim" kariyer modunda genelde de yok). |
| Yükleme ekranı (gerçek ilerleme + ipucu/harita) | ⬜ | Yok. Font/Skia yüklemesi sırasında (potansiyel olarak >1sn) hiçbir ilerleme/ipucu gösterilmiyor — rehberin "durağan/boş ekran bozuk hissettirir" uyarısına tam ters. |
| Grid/başlangıç ekranı (yayın tarzı tanıtım) | ⬜ | Yarış direkt `LiveRacePanel`'e "Tur 0" ile başlıyor; grid tanıtım anı (sürücü isimleri, pozisyon, takım renkleri sırayla) yok. Bu, rehberin özellikle vurguladığı "yüksek değerli daldırma anı" — düşük maliyetli, yüksek etkili bir ekleme adayı. |
| Duraklatma menüsü (tek input, Devam/Yeniden Başla/MFD/Ayarlar/Çıkış) | ⬜ | Hiç yok. Canlı yarış "no pause, no fast-forward" olarak bilinçli tasarlanmış (`LiveRacePanel.tsx:24` yorumu — online ligle simetri için), bu doğru bir ürün kararı. Ama bir **Ayarlar ekranı** (ses, colorblind, bildirim) de yok — rehberdeki "Ayarlar" ihtiyacı pause'a bağlı değil, bağımsız da eksik. |
| Sonuç ekranı (duygusal sonuç → zaman → ilerleme ödülü → sonraki aksiyon) | ✅ | `RaceResultSheet` tam olarak bu sırayı izliyor: Kazanç/Başarım/Puan tablosu kartları → tam sonuç tablosu → (varsa) sezon özeti → "Sonraki yarışa geç" butonu. Rehberin önerdiği tempo zaten uygulanmış. |
| Geçişler: her ekranda aynı yerde/davranışta geri tuşu | 🟡 | Sekme çubuğu tutarlı ama gerçek bir "geri" davranışı (alt ekrandan üst ekrana) her yerde test edilmedi; `RaceResultSheet` içindeki "Tüm sonucu göster" gibi genişlet/daralt paternleri tutarlı görünüyor. Sistemik bir geri-tuşu denetimi yapılmadı. |

## 2. HUD Tasarımı

| Rehber maddesi | Durum | Not |
| --- | --- | --- |
| Birincil katman: hız+vites/RPM, pozisyon, tur, delta, harita, ERS/DRS, lastik/yakıt özeti | 🟡 | Hız/RPM/DRS/ERS ⛔ N/A (sürülmüyor). Pozisyon (`Pos`), tur sayısı, harita (`TrackMap`), lastik özeti (`CompoundDot`, aşınma barı) ✅ var. "Delta" karşılığı `fmtGap` (lidere fark) — zamanlayıcı deltası değil ama eşdeğer bilgi. |
| İkincil: tam zamanlama kulesi, sektör, hasar, pit penceresi, ceza, bayrak/hava | 🟡 | Zamanlama listesi (`boardCard`) var ama sektör zamanı/renk yok (mor/yeşil/sarı sektör kavramı hiç yok — bu oyunda "sektör" kavramı zaten simüle edilmiyor, tur bazlı). Bayrak overlay'i var (`flag` objesi: KIRMIZI BAYRAK/GÜVENLİK ARACI/SARI BAYRAK, renk kodlu). Hasar detayı yok (DNF var ama "hasar" ayrı bir gösterge değil). Pit penceresi uyarısı yok — sadece "karar anı" (`prompt`) genel amaçlı bir bildirim. |
| Üçüncül: MFD, motor modları, yakıt karışımı, detaylı lastik sıcaklığı, radyo | ⛔ N/A | Motor modu/yakıt karışımı sürüş-zamanlı kararlar; bu oyunda strateji zaten "pit duvarı" kartında (lastik seçimi, pit çağrısı) toplu veriliyor — kavramsal karşılığı var ama üçüncül bir MFD paneli yok, hepsi ikincil katmanda. |
| Yerleşim: köşeler/kenarlar, merkez boş | ✅ | `LiveRacePanel` zaten "harita solda/ortada, sıralama sağda, pit duvarı altta" — merkezde oynanış alanı (harita) boş bırakılıyor, tıkanma yok. |
| Sektör renkleri (mor/yeşil/sarı) | ⬛ yok | Kavram bu motorda yok (tur bazlı simülasyon, sektör verisi üretilmiyor). Uygulanabilir ama `raceEngine.ts`'e veri modeli eklemek gerekir — büyük iş, ayrı karar gerektirir. |
| Dinamik/uyarlanır HUD (bağlama göre solan elemanlar) | ⬬ yok | Statik kartlar; hiçbir HUD elemanı context'e göre solmuyor/belirmiyor. |
| Özelleştirme/OSD editörü (aç-kapa, ölçek, opaklık, yeniden konumlandırma) | ⬬ yok | Hiç yok — Ayarlar ekranı olmadığı için bu zaten mümkün değil. Rehberin en somut, en çok tekrar eden talebi bu; şu an sıfır karşılanıyor. |

## 3. Referans Oyun Karşılaştırması

Doğrudan uygulanabilir kod maddesi yok; bilgi amaçlı. Not edilecek tek şey: rehberin
F1 serisi için andığı "varsayılan zamanlama kulesi sadece üst sıraları gösterir"
sınırlaması — Pit Wall'da tam tersi, `boardCard` **tüm gridi** gösteriyor (`race.cars.map`),
yani bu bilinen sınırlamayı zaten aşmış durumda.

## 4. Mobil vs Konsol/PC UX

Bu bölüm doğrudan uygulanabilir çünkü Pit Wall mobil-öncelikli (Expo/React Native).

| Rehber maddesi | Durum | Not |
| --- | --- | --- |
| Başparmak erişim bölgeleri (birincil aksiyon altta, yıkıcı aksiyon üstte) | 🟡 | `RaceResultSheet`'te ana CTA (`GlassButton "Sonraki yarışa geç"`) zaten en altta. Ama sistemik bir "yıkıcı aksiyon her zaman üstte" kuralı yok çünkü Çıkış/Sıfırla gibi yıkıcı aksiyonlar hiç yok (kayıt/yükleme sistemi de yok — `FEATURES.md`: ⬜). |
| Kapatma (occlusion) — geri bildirim parmağın üstünde/yanında | ⬬ denetlenmedi | Dokunma sonrası haptik var (`haptic.select()` vb.) ama görsel onayın parmağa göre konumu kod incelemesiyle doğrulanamaz (cihazda test gerekir). |
| Dokunma hedefleri ≥44×44 pt / 48×48 dp | ⬬ denetlenmedi | `NavShell`'de 40px dairesel butonlar var (`docs/design-system.md` §5: "40px dairesel butonlar") — bu **Apple HIG'in 44pt eşiğinin altında**. En somut, ölçülebilir bulgu bu raporda: nav kapsülündeki ikon butonları hedef boyutun ~9 px altında. |
| Okunabilirlik (ucuz cihaz, güneş altı, mobil veri testi) | ⬬ denetlenmedi | Kod incelemesiyle görülemez; cihaz testi gerekir. |
| HUD sadeleştirmesi (sık/acil/yoksa-ekranda-değil) | ✅ | `LiveRacePanel` zaten minimal: harita, sıralama, pit duvarı — sürüş-HUD'una özgü fazlalık (RPM, gaz/fren) yok çünkü zaten yok. |
| Kontrol şemaları (tilt/dokunma/controller, dead-zone) | ⛔ N/A | Sürüş kontrolü yok — oyun dokunma/buton tabanlı strateji arayüzü. |
| Oturumlar: granular autosave, tek input yeniden giriş | ⬬ eksik-bilinen | `FEATURES.md` zaten "⬜ Kayıt/yükleme (persist)" olarak işaretlemiş — rehberin "sık otomatik kayıt" talebiyle birebir örtüşen, halihazırda bilinen bir eksik. |
| Canlı-servis yoğunluk artışı / periyodik "çıkarım gözden geçirmesi" | ⬬ N/A henüz | Henüz banner/para birimi/ikon birikimi yaratacak kadar canlı-servis yüzeyi (mağaza, bildirim) devrede değil; ileride izlenmeli. |

## 5. Genel UX Prensipleri

| Rehber maddesi | Durum | Not |
| --- | --- | --- |
| Bilişsel yük (max 5-7 ana nokta) | 🟡 | Çoğu kart bu sınırda (`RaceResultSheet` 3 üst kart + 1 tablo). `LiveRacePanel`'in pit duvarı kartı tek araçta: pozisyon, lastik ikonu, aşınma %, pit sayısı, lastik seçici, pit butonu — 6 öğe, sınırda ama kabul edilebilir. |
| Bilgi hiyerarşisi/katmanlama (birincil/ikincil/üçüncil, tutarlı stil) | ✅ | `AppText` varyant sistemi (`hero/pageTitle/sectionTitle/cardTitle/body/label/labelSmall/stat*`) zaten katmanlı; `docs/design-system.md` §2 bunu net tanımlıyor. |
| "3 tıklama kuralı" | ⛔ efsane, rehber de reddediyor | Uygulama zaten sekme tabanlı, çoğu ekran 1 dokunuşla ulaşılıyor. |
| Yükleme ekranları (>10sn ilerleme, <1sn hiçbir şey) | ⬜ | Yukarıdaki §1 ile aynı bulgu: mevcut font/Skia yüklemesi belirsiz sürede boş ekran gösteriyor — süre sınırına göre davranış farklılaştırılmıyor. |
| Modal/popup yorgunluğu | ✅ (fazlasıyla) | Kod taramasında hiç modal/toast bileşeni bulunamadı — sistemik bir "modal yorgunluğu" riski zaten yok çünkü hiç engelleyici modal kullanılmıyor. Ancak bu aynı zamanda bir boşluk: onay gerektiren yıkıcı aksiyon (ör. ileride "Sözleşmeyi feshet") için bir `ConfirmDialog` bileşeni de yok. |
| Renk kodlama (ISO 22324, kırmızı/sarı/yeşil/mavi + renk-tek-başına-değil) | 🟡 | Anlam renkleri doğru: `neonCoral` (tehlike/DNF), `solarAmber` (dikkat/SC-VSC), `matrixGreen`/`electricCyan` (olumlu/uyum). **Ama** bayrak rozetinde (`LiveRacePanel` `flag` objesi) tek sinyal renk+metin (KIRMIZI BAYRAK yazısı var, bu iyi — metin zaten ikon yerine geçiyor). Lastik aşınma barında da renk + `%wearPct` sayısı birlikte var (✅ fazlalık kodlama). Colorblind filtresi ise tamamen yok (aşağıya bakın). |
| Tutarlılık (buton/ikon/font/terminoloji/geri davranışı) | ✅ | `docs/design-system.md` §7 "Kurallar" bölümü bunu zaten yazılı kural haline getirmiş (tek vurgu rengi, Türkçe tam terim, sayı biçimi vb.) — rehberle örtüşüyor. |
| Erişilebilirlik tabançizgisi (WCAG kontrast, colorblind modu, ölçekleme, sesli asistan) | ⬜ | En büyük boşluk. Aşağıda ayrıntılı. |

### Kontrast — ölçülebilir bulgu

`textTertiary` (`#5C5E63`) `bgElevated` (`#17181C`) üzerinde kontrast oranı ~2.7:1 —
WCAG AA'nın metin için istediği 4.5:1'in altında. Bu token, tüm ekranlarda "ikincil/pasif"
etiketler için yaygın kullanılıyor (ör. `RaceResultSheet`'teki "Sıra · sürücü · takım ·
grid farkı · lidere fark" başlık satırı, `LiveRacePanel`'deki zaman damgaları). Rehberin
"minimum 4.5:1" kuralına göre bu ton düşük kontrastlı okunması gereken yerlerde riskli.

### Colorblind desteği — tamamen eksik

`grep` taramasında "colorblind"/"renk kör" hiçbir dosyada geçmiyor. Rehberin hem
genel prensipler (§5) hem F1 referansı (§3) hem yol haritası (§8 madde 9) üç kez
vurguladığı Protanopia/Deuteranopia/Tritanopia filtresi ve genel bir "Ayarlar" ekranı
şu an hiç yok. Bu, rehberdeki en somut ve tekrar eden eksik.

## 6. UI Bileşen Kütüphanesi

Rehberin önerdiği bileşen listesiyle mevcut `mobile/src/components/` karşılaştırması:

**HUD bileşenleri** — SpeedGauge/TelemetryCluster/ERSMeter/DRSIndicator/FuelBar ⛔ N/A
(sürüş verisi yok). Karşılığı olanlar: PositionBadge → `Pos`, LapCounter → `LiveRacePanel`
başlığındaki "Tur X/Y" metni, TimingTower → `boardCard`, MiniMap → `TrackMap`,
TyreStatusChip → `CompoundDot` + aşınma barı, FlagBanner → `flag` rozeti, PitPrompt →
`prompt` kartı, MFDPanel → kavramsal karşılığı `wallCard` (pit duvarı) ama ayrı bir
pause-panel değil, ana akışın içinde.

**Menü/Ekran bileşenleri** — PrimaryButton/SecondaryButton → `GlassButton` (ikincil/outline
varyantı kod taramasında görülmedi, tek stil var); CardSelector → `CarStatCard`/kart desenleri
var; StatBar → `LiquidProgressBar`/aşınma barları var; TabGroup → `SegmentTabs` var;
ResultRow → `DriverCell`/`StandingRow` var; SettingsToggle/Slider ⬜ yok; **ProgressLoader
(gerçek yükleme çubuğu + ipucu) ⬜ yok**; **Modal/ConfirmDialog ⬜ yok**;
**Toast/Notification ⬜ yok**; **ColorblindFilterSelector ⬜ yok**.

## 7. Renk Paleti

Rehberin önerdiği fonksiyonel renk hex'leri ile `mobile/src/theme/colors.ts` doğrudan
karşılaştırıldı:

| Rehber | Hex (rehber) | Pit Wall karşılığı | Hex (kod) |
| --- | --- | --- | --- |
| Kırmızı (tehlike) | `#E10600` | `neonCoral` | `#FF3B5C` |
| Sarı (dikkat) | `#FFD400` | `solarAmber` | `#E3B341` |
| Yeşil (onay/PB) | `#00D26A` | `matrixGreen`/`electricCyan` | `#2DD4BF` |
| Mor (rekor tur) | `#B026FF` | `accentViolet` | `#9B5CFF` |
| Mavi (bilgi) | `#0090FF` | — | tanımlı değil (mavi bilgi rengi yok) |

Pit Wall kasıtlı olarak farklı bir sanat yönü kullanıyor ("Night Circuit": acid-lime +
menekşe tek vurgu ikilisi, `docs/design-system.md` §1) — rehberin F1-yayın-doğru hex
paletini birebir kopyalamak **istenmeyebilir**, bu tasarım kararı. Ama iki somut boşluk:
(1) rehberin "mavi sadece bilgilendirme, tehlike için asla" kuralına karşılık gelecek
ayrı bir mavi/bilgi tonu tanımlı değil — mavi bayrak eşdeğeri bir durum olsaydı hangi
renk kullanılacağı belirsiz; (2) **Colorblind varyant paleti tanımlı değil** (rehber
madde 5: "kırmızı/yeşil yerine mavi/turuncu kontrastına geçen ayrı bir palet").

Kontrast oranı kuralı (madde 1, min 4.5:1) yukarıdaki §5'te ayrıca not edildi.
Doygunluk=önem kuralı (madde 3) ve takım renginin sadece rozet/çubukta kullanılması
(madde 4) zaten `docs/design-system.md` §7'de yazılı kural olarak var ve kodda
(`StandingRow`'daki `team.colour` şerit) uygulanıyor — ✅.

## 8. Uygulama Yol Haritası — aşama aşama durum

- **Aşama 1 (temel):** Bilgi katmanları ✅ tanımlı (`AppText` varyantları). Hub vs düz
  menü kararı ✅ verilmiş (hub). Yayın kimliği 🟡 kısmen (bayrak/pozisyon/harita var,
  sektör renklendirmesi ve grid tanıtımı yok).
- **Aşama 2 (HUD kurulumu):** Yerleşim ✅ yapılmış. Tam HUD özelleştirmesi ⬜ yok.
  Dinamik/solan HUD ⬜ yok.
- **Aşama 3 (mobil uyarlama):** HUD zaten mobil-öncelikli tasarlanmış (✅), ama dokunma
  hedefi ölçüsü (40px nav butonları) ve gerçek cihaz testi ⬬ doğrulanmadı/eksik.
- **Aşama 4 (cila ve kapsayıcılık):** Colorblind ön ayarları ⬜, metin ölçekleme ⬜,
  yükleme ekranı ⬜ — bu aşamanın tamamı eksik.

---

## Özet — en somut 5 bulgu

1. **Colorblind modu ve genel bir Ayarlar ekranı yok** — rehberde 3 ayrı yerde vurgulanan
   tek madde, kodda hiç karşılığı yok.
2. **Yükleme ekranı yok** — font/Skia yüklenirken boş `View` (`app/_layout.tsx:58`),
   ilerleme çubuğu ya da ipucu içermiyor.
3. **Nav kapsülü dokunma hedefleri 40px** — Apple HIG'in 44pt eşiğinin altında
   (`docs/design-system.md` §5).
4. **`textTertiary` (#5C5E63) kontrastı düşük** (~2.7:1), WCAG AA 4.5:1 eşiğinin altında,
   yaygın kullanımda.
5. **Grid/başlangıç tanıtım anı yok** — yarış doğrudan "Tur 0"dan başlıyor; rehberin
   vurguladığı düşük maliyetli/yüksek daldırma anı hiç uygulanmamış.

Sürüş-HUD'una özgü maddeler (SpeedGauge, RPM/vites, DRS/ERS göstergesi, kontrol şeması,
sektör bazlı zamanlama) bu oyunun türüyle uyumsuz olduğu için değerlendirme dışı
bırakıldı; bunlar eksiklik değil, tür farkıdır.

---

## Uygulanan değişiklikler (2026-09-21)

Yukarıdaki "en somut 5 bulgu" ve birkaç ek madde koda uygulandı. Tip kontrolü
(`npm run typecheck`) ve lint (`expo lint`) değiştirilen tüm dosyalarda temiz.

1. **Colorblind modu** — `mobile/src/theme/colors.ts`: `SemanticColors` arayüzü
   (danger/attention/positive/record/info) ve `protanopia`/`deuteranopia`/`tritanopia`
   için ayrı paletler (`semanticColors(mode)`). `LiveRacePanel` (bayrak rozeti, lastik
   aşınma rengi, en hızlı tur, DNF) ve `RaceResultSheet` (hedef/başarım verdict renkleri,
   DNF) artık bu çözümlenmiş renkleri okuyor — renk hâlâ her zaman ikon/metinle birlikte.
2. **Ayarlar ekranı** — yeni `mobile/src/features/settings/SettingsScreen.tsx`
   (`app/settings.tsx` rotası), Profil ekranındaki "Ayarlar" butonundan açılıyor:
   renk körü modu seçici (canlı önizleme swatch'larıyla), yazı boyutu (Normal/Büyük/En
   büyük — `AppText` artık `textScale`'i okuyor), HUD yoğunluğu (Tam/Sade — `hudCompact`,
   `LiveRacePanel`'e bağlandı: sade modda pit duvarındaki aşınma yüzdesi/çubuğu ve
   sıralamadaki pit sayısı sütunu gizlenir).
3. **Kontrast düzeltmesi** — `textTertiary` `#5C5E63` (~2.7:1) → `#8A8D93` (~5.3:1
   `bgElevated` üzerinde), WCAG AA eşiğinin üzerine çıkarıldı.
4. **Dokunma hedefleri** — yatay kabuk `navItemSize` 40→44px (Apple HIG eşiği);
   dikey hap sekme çubuğunda dar ekranlarda (<390pt) `paddingHorizontal` 8→10 ve her
   iki düzende `hitSlop={6}` eklendi.
5. **Gerçek yükleme ekranı** — yeni `ProgressLoader` atomu (`mobile/src/components/atoms/`):
   gerçek ilerleme (font + Skia yükleme aşamalarından), dönen ipuçları, yalnızca ~400ms'den
   uzun süren yüklemede görünür (kısa yüklemede hiçbir şey göstermez, rehberin
   "<1sn'de hiçbir şey" kuralına uygun). `app/_layout.tsx`'teki boş `View` yerine geçti.
6. **Grid/başlangıç anı** — yeni `GridIntro` organism'i: yarış Tur 0'da başladığında ~2,4
   saniyeliğine başlangıç gridini (pozisyon, sürücü, takım rengi) tam ekran gösterip
   otomatik kapanıyor; dokunarak da erken kapatılabiliyor.
7. **Yeni atomlar (rehberin bileşen kütüphanesi boşlukları)** — `ConfirmDialog` (yıkıcı
   aksiyonlar için engelleyici onay, henüz hiçbir ekranda tüketilmiyor — kayıt/yükleme
   veya sözleşme feshi gibi bir yıkıcı aksiyon eklendiğinde kullanılacak) ve `Toast`
   (engellemeyen bildirim, tek seferde tek toast, otomatik kapanır — henüz hiçbir akışa
   bağlanmadı, altyapı hazır).
8. **`infoBlue` tokenı** — rehberin "mavi sadece bilgilendirme, tehlike için asla"
   kuralına karşılık gelen ayrı bir ton tanımlandı (`colors.infoBlue` / `semantic.info`).
9. **Ayarlar kalıcılığı** (sonradan eklendi) — `gameStore.ts` artık `zustand/middleware`'in
   `persist`'i + `@react-native-async-storage/async-storage` ile sarmalı; yalnızca
   `colorblindMode`/`textScale`/`hudCompact`/`auth` (hesap oturumu, bkz. madde 11) cihazda
   saklanıyor (`partialize`). Kariyer/yarış/ekonomi durumu bilinçli olarak dışarıda
   bırakıldı — `docs/FEATURES.md`'deki "Kayıt/yükleme" maddesi hâlâ ayrı ve çok daha
   büyük bir iş (tüm oyun durumunun serileştirilmesi + online lig ile tutarlılık).
10. **HUD "Sade" modu bağlandı** (sonradan eklendi) — `LiveRacePanel` artık `hudCompact`
    okuyor: pit duvarındaki lastik aşınması yüzdesi/çubuğu ve sıralama tablosundaki pit
    sayısı sütunu sade modda gizlenir; konum, tur, sıralama, pit çağrı kontrolü ve karar
    anı kartı her iki modda da kalır.
11. **Faz 1b — hesap sistemi mobil istemciye bağlandı** (sonradan eklendi) — server'ın
    bitmiş kimlik sistemi (`docs/FEATURES.md` §Kimlik) `lib/api/identity.ts` +
    `authSlice.ts` + `features/auth/AuthScreen.tsx` (`/auth`, Profil'deki "Hesap"
    kartından) ile bağlandı: e-posta+şifre giriş/kayıt, tek ekranda takma ad + bölge +
    aranabilir ülke seçimi. `leagueSlice`'daki anonim `managerId` artık signed-in
    hesabın gerçek id'sini kullanıyor. Google/Apple/Facebook bilinçli olarak dışarıda
    bırakıldı (native SDK + cihaz testi gerektiriyor); butonlar arayüzde "yakında"
    olarak görünüyor.

### Bilinçli olarak yapılmayanlar

- **Kariyer/yarış durumu kalıcılığı**: `docs/FEATURES.md`'nin "Kayıt/yükleme" maddesi
  hâlâ açık — yalnızca görüntü/erişilebilirlik tercihleri ve hesap oturumu kalıcı
  hale geldi (yukarı bakın).
- **Sektör bazlı zamanlama/renklendirme**: `raceEngine.ts`'e yeni bir veri modeli
  (sektör süreleri) eklemek gerektirir — kapsam dışı bırakıldı, ayrı bir karar konusu.
- **Google/Apple/Facebook girişi**: server tarafı hazır ve test edilmiş, ama native
  SDK bağlama (client id, bundle id, cihaz testi) bu işin kapsamı dışında bırakıldı.
- **Lig oluşturma/davet**: online lige katılım hâlâ tek sabit takıma (`bosphorus`)
  bağlı — takım seçimi/davet akışı ayrı bir iş.
- **Sürüş-HUD'a özgü maddeler**: yukarıda açıklandığı gibi tür farkı nedeniyle atlandı.
