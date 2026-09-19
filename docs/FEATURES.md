# Pit Wall — Özellik Listesi

> Oyundaki her sistemin tek sayfalık envanteri. Ayrıntı için ilgili belgeye
> bakın. Durum: ✅ kodda ve doğrulandı · 🔶 kodda, sunucu/SDK bekliyor ·
> ⬜ planlandı.

## Yarış motoru (`src/data/raceEngine.ts`) — [race-live-plan.md](race-live-plan.md)
- ✅ Tur tur simülasyon: lastik aşınması ve uçurum, pit, yakıt, form, gürültü, geçiş zorluğu
- ✅ Araç %75 / sürücü %25 pace ekseni; `explainPace` ile ekranda kırılım
- ✅ Sürücü statları: pace, consistency, racecraft, wet, reaction (5 ışık kalkışı), dev
- ✅ Hava: baştan ıslak, yarış içi yağmur/kuruma; tahmin stratejiste göre bantlı
- ✅ Yarış kontrolü: sarı, VSC, SC (alan toplanır, pit yarı fiyat), kırmızı (duran yeniden başlangıç, serbest lastik) — gerçek pist verisiyle kalibre ([race-control-research.md](race-control-research.md))
- ✅ **Antrenman ve sıralamada kırmızı bayrak**: pistin yarış profilinden ölçeklenir (FP ×0.4, Q ×0.45, yağmurda ×1.8 — hafta sonlarının ~%16'sı); kazayı yapan turunu tamamen kaybeder, o sırada pistte olan araçlar (alanın ~%20-55'i) turunu çöpe atar, seans ne kadar geç durursa kayıp o kadar büyük
- ✅ DNF ve **ağır kaza** (sürücü 1-2 yarış dışı, yedek geçer); uç veya pistin tersine setup kaza ve hata riskini ×2'ye kadar artırır
- ✅ Pit ekibi etkisi: stop başına saniye ve hatalı stop (+5 s)
- ✅ Sprint seansı (1/3 mesafe, 8-1 puan)
- ✅ Belirlenimci: her şey tohumlu, `Math.random` yok

## Hafta sonu (`src/store/gameStore.ts`, `features/raceweek/*`)
- ✅ Her pist bir gün; bölgeye göre seans saatleri (yerel saatte)
- ✅ Standart: FP1 FP2 FP3 Q Yarış · Sprint: FP1 SQ Sprint Q Yarış (6 pist)
- ✅ Antrenman setup bias'ı, sıralama risk seçimi, başlangıç lastiği, yardımcı taktiği
- ✅ Canlı yarış: gerçek zaman 2.5 s/tur, hızlandırma ve durdurma yok, harita + liderlik + pit duvarı
- ✅ Karar anı kartları (yağmur, uçurum, SC/VSC/kırmızı)
- ✅ Yardımcı bot (check-in yoksa): taktik ön ayarı + hata payı; stratejist hatayı azaltır
- ✅ Mühendis brifingi: lastik, hava, yarış kontrolü, geçiş, setup → tutulan öneri başına +8 RP, +5 skor; zayıf stratejist yanlış öneri verir
- ✅ Sezon öncesi 3 test günü: mühendis raporu, doğru program +2 stat
- ✅ Online lig sunucusu (`server/`): aynı motor, sabit saat, WebSocket tur yayını; `/join`, `/weekend`, `/checkin`, `/pit`; **5 dk check-in penceresi**, yapmayan takım yardımcı bota düşer; istemcide Race Week → Online Lig kartı, yarış sunucudan aynı canlı panele akar (`store/slices/leagueSlice.ts`). Kalıcılık yok (Postgres sırada)

## Ekonomi ve sonuç
- ✅ RP: sponsor ücreti koşulsuz, yarış ödülü, brifing bonusu; **maaşlar** (personel + sürücü) ödemeden düşer
- ✅ Şampiyona tablosu, sezon sonu ödülü ve sıfırlama, sürücü yaşlanması
- ✅ Hedefler: sıralama ve puan hedefi; rütbe puanı kapısı (tam / 0 / negatif)
- ✅ Başarımlar: podyum, pole, en hızlı tur, galibiyet, duble, hat-trick, grand slam, clean sweep; zayıf takım çarpanı; 10 rütbe ve **özgün çizgi rütbe ikonları** (`RankIcon`, Skia)
- ✅ **Altın** (premium): reklam (+1, günde 8) ve paket; ✅ AdMob ödüllü reklam (`react-native-google-mobile-ads`, Google test birimleri) ve mağaza ödemesi (`react-native-iap`, OpenIAP) adaptörleri (`lib/monetization/*`); ödül yalnızca SDK onayında verilir. 🔶 Mağazada ürünlerin (SKU) oluşturulması ve üretim reklam kimlikleri kalan dış iş

## Padok (`src/store/slices/*`, `features/paddock/*`) — [paddock-research.md](paddock-research.md)
- ✅ Personel: baş mekanik (geliştirme +0…+1.5, güvenilirlik), stratejist (brifing doğruluğu, tahmin bandı, bot keskinliği), pit şefi (pit süresi, hata); 3 koltuk, dolu koltuğa alırken "kimi bırakıyorsun"; pazar günlük
- ✅ Her takımın varsayılan sürücü çifti (`teams.ts`, 22 sürücü, tam stat); tüm kadrolar store'da (`rosters`), sezon sonunda herkes yaşlanır ve potansiyeline göre gelişir, motor güncel kadroları okur, Lig ekranı her takımın sürücülerini gösterir
- ✅ Sürücüler: yaş, potansiyel; 6 saatlik antrenman (gençler hızlı, 33+ gelişmez); günlük pazar, güce göre fiyat (sürücü > tekniker); yedek sürücü (yarı ücret), sakatlıkta koltuğa geçer
- ✅ **Sözleşme süreleri**: 1/2/3 sezon; kısa sözleşme ucuz imza + %25 pahalı maaş, uzun sözleşme %45 pahalı imza + %15 ucuz maaş; maaş sözleşmede sabitlenir. Son yılına giren sürücü padokta uyarı verir, uzatma transfer ücreti değil güncel değerinin %45'i kadar imza parası ister; uzatılmazsa kışın takımdan ayrılır ve koltuğa akademiden genç çıkar
- ✅ **Rakip transferleri**: her kış sözleşmesi biten ve takımının seviyesinin çok altında kalan sürücüler koltuğunu boşaltır; boşalan koltukları güçlü takımdan başlayarak serbest sürücülerden ve zayıf takımların son yılındaki sürücülerinden doldururlar (zincirleme transfer), kalan koltuğa çaylak çıkar; 36+ (34+ ise %40) sözleşmesi biten sürücü emekli olur. Bizim ayrılan sürücümüz de bu havuza girer ve bir rakibe gider. Hepsi sezona tohumlu — ligdeki herkes aynı kışı görür
- ✅ Casusluk: hedef takım + stat; ücretsiz ajan (25 RP, %55 başarı, %12 yakalanma) / profesyonel (3 Altın, %85, yakalanmaz); 3 günde 1, sonuç 1 gün sonra; başarı → sonraki geliştirme ×1.5, yanlış istihbarat ×0.5, yakalanma → RP cezası + hedefe güç
- ✅ Garaj gizleme: 1 gün 30 RP, 3 gün 1 Altın, 7 gün 2 Altın; rakip girişimleri engeller
- ✅ Rakip istihbaratı: ilk 4'teysen %20 deneme, başarılıysa rakip kalıcı güçlenir (`aiBonus`)

## Ekranlar
- ✅ Garaj (kahraman yarış kartı, bugün yapılacaklar, araç, sürücüler), Yarış, Geliştirme, Padok, Sponsorluk, Şampiyona, Profil
- ✅ **Dikey + yatay kabuk**: alt hap sekme çubuğu / yan kapsül, `Cols` ile uyarlanan düzen, açıklayıcı `ScreenHeader`; üç kalite ajanıyla incelenip düzeltildi (docs/design-system.md §7)

## Kapsam dışı / sırada
- ⬜ Sunucuda kalıcılık (Postgres), kimlik doğrulama, lig oluşturma/davet
- ⬜ Kayıt/yükleme (persist)
- ⬜ Mağaza ürünleri ve üretim AdMob kimlikleri (kod hazır)
