# Pit Wall — Padok Araştırması: Personel, Casusluk, Sürücü Gelişimi, Premium Para

> 2026-09-16. Oyun sahibinin isteği: mekanik / stratejist / pit ekibi
> pazarı ve etkileri; casusluk (ücretsiz ve paralı ajan, yakalanma, garaj
> gizleme); sürücü antrenmanı ve pazarı; premium para (reklam + satın alma);
> araç-sürücü ekseninin detaylı hesabı. Kod parçalı: her sistem kendi
> dosyasında ve kendi store diliminde.

## 1. Kaynaklar ve sayılar

| Konu | Veri | Kaynak |
|---|---|---|
| Pit stop süresi | 2025'te en iyi ekip (Ferrari) ort. **2.44 s**, en yavaşlar (Haas, Williams) **3.05 s**; fark 0.6 s. Arıza durumunda 6-7 s (tekerlek tabancası, somun). | f1pace.com pit stop power rankings; the-race.com / planetf1.com arıza analizleri |
| DHL en hızlı pit | 2025 kazananı Ferrari, 24 yarışta 10 en hızlı stop; stoplar 2.5 s altı. | formula1.com / skysports.com DHL Fastest Pit Stop Award |
| Sürücü gelişimi | Gizli **potansiyel** ve **gelişebilirlik**; gençler daha hızlı gelişir; **28-34 zirve**, 1-3 yıl plato, sonra hızlı düşüş; tesis seviyesi gelişimi hızlandırır; F1 Manager'da yaşla azalan Development Rate ve odak alanı seçimi. | Motorsport Manager topluluk analizleri; F1 Manager 23 Drivers Guide |
| Casusluk gerçeği | 2007: 780 sayfa gizli teknik doküman; **100 milyon $ ceza** ve takımlar şampiyonasından ihraç; sürücüler puan almaya devam etti. Yakalanma tesadüfle (fotokopici) oldu. | Wikipedia 2007 espionage controversy; racingnews365; racefans |
| Premium para ve reklam | Ödüllü video dönüşümü **%70+**; strateji oyunlarında oturum başına 2-4, **günlük 8-12** reklam tavanı; sabırlı oyuncu ödeyenin **%60-70 hızında** ilerleyebilmeli; ödüller yumuşak paraya bağlanmalı. F1 Clash: "Bucks" premium, reklamla ücretsiz coin. | Unity / RevenueFlex / AppFollow monetizasyon rehberleri; F1 Clash wiki |

## 2. Oyuna çevrilen model

### 2.1 Para birimleri
- **RP** (mevcut, yumuşak): sponsor, ödül, brifing.
- **Altın** (yeni, premium): yalnızca **reklam izleyerek** (+1, günde en fazla 8) ve **satın alarak**. Reklam ve ödeme entegrasyonu kodda kanca olarak var, gerçek SDK bağlı değil.

### 2.2 Personel (`data/staff.ts`)
Üç şef koltuğu, her biri 0-100 `skill`, yarış başına RP ücret, sözleşme.

| Rol | Etki | Ölçek (skill 40 → 90) |
|---|---|---|
| Baş mekanik | Geliştirme başına ekstra stat (+0 → +1.5) ve güvenilirlik (+0 → +0.2) | "mekanist ne kadar iyiyse o kadar fazla güçlendirme" |
| Stratejist | Brifing doğruluğu: zayıf stratejist her maddede %30'a kadar **yanlış öneri**; yağmur tahmini ± bant daralır; yardımcı bot hata payı azalır | "ne kadar iyi olursa o kadar doğru tahmin" |
| Pit şefi | Pit kaybı **−0.2 … −1.2 s**, yavaş stop olasılığı %8 → %1 (+5 s) | 2025 gerçek: 2.44 vs 3.05 s, arıza 6-7 s |

Pazar: her turda tohumlu 6 aday; işe alım ücreti 2 × haftalık ücret.

### 2.3 Casusluk (`data/espionage.ts`)
| | Ücretsiz ajan | Paralı ajan (3 Altın) |
|---|---|---|
| Başarı | %55 | %85 |
| Yakalanma | %12 → RP ceza (%15, min 40) + hedef takıma bedava boost | **%0** |
| Kötü istihbarat | %15 → bir sonraki geliştirme o statta ×0.5 | %2 |
| Sonuç | 1 gün sonra (sonraki tur) | 1 gün sonra |
| Bekleme | 3 gün (tur) | 3 gün |
Başarı = hedef stat sende daha zayıfsa, o statta **bir sonraki geliştirme ×1.5** (2 → 3; mekanikle 3.5 → 4).
**Garaj gizleme**: 1 gün 30 RP, 3 gün 1 Altın, 7 gün 2 Altın; süre boyunca sana karşı girişimler başarısız. AI takımlar tabloda ilk 4'teysen %20 ihtimalle deneme yapar; başarılıysa o takım küçük gelişim alır ve haber düşer.

### 2.4 Sürücüler (`data/driverMarket.ts`)
- `age`, `potential` (ulaşabileceği overall), gelişim hızı yaşla düşer: ≤24 ×1.4, 25-28 ×1.0, 29-32 ×0.6, 33+ ×0 ve sezon başına −1 pace.
- **Antrenman**: 6 saat gerçek zaman, tek stat; kazanç = 0.6 × yaşÇarpanı × potansiyelBoşluğu (0.2-1.5 arası) → tipik +0.3 … +1.2 puan. Statlar kesirli tutulur, ekranda yuvarlanır.
- **Pazar**: sezon başına tohumlu 8 serbest sürücü; transfer ücreti RP (150-600), ücret yarış başına; koltuk değişimi anında.

### 2.5 Araç-sürücü ekseni (`explainPace`)
```
statScore  = motor·d.motor + aero·d.aero + grip·d.grip         (bias ile aero/grip ±4)
corePace   = statScore × 0.75 + driver.pace × 0.25
tur süresi = baseLap + (100 − corePace) × 0.08 + form + lastik(aşınma) + yakıt + gürültü×(1.2 − consistency/250)
kalkış     = (100 − reaction)/100 × 2.0 s (+gürültü)           → gridde 0.35 s/sıra
geçiş      = overtaking × (0.35 + 0.6·hızFarkı + 0.3·(racecraft − rakip)/100)
yağmur     = −(wet − 50) × 0.01 s/tur (yağmur lastiğiyle)
pit        = pitLoss × ekipFaktörü (+5 s %p arıza)
```
1 stat puanı ≈ 0.06 s/tur (0.75 × 0.08); 1 sürücü pace puanı ≈ 0.02 s/tur. 60 turda: araçta +10 stat ≈ 36 s, sürücüde +10 pace ≈ 12 s. Araç baskın, sürücü belirleyici ama ikincil — F1 ile aynı oran.
