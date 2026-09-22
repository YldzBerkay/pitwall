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

## Ekonomi ve sonuç — [ekonomi-tasarim.md](superpowers/specs/2026-09-19-ekonomi-tasarim.md)
- ✅ **Tek ölçek knob'u**: `ECONOMY_SCALE = 1.5` (`data/economy.ts`); sponsor, ödül, maaş, transfer, fabrika ve casusluk fiyatlarının hepsi onu okur. Orta sıra takım yarış başına ~1.100 RP kazanır
- ✅ RP: sponsor ücreti koşulsuz, yarış ödülü (P1 600 / P11 263), brifing bonusu; **maaşlar** (personel + sürücü) ödemeden düşer. Sezon ödülü 9.000–2.500 (~6 yarışlık gelir)
- ✅ **Araç merdiveni**: her stat kendi sayacını tutar, `750 × 1.5^tamamlanan` RP ve `6 sa × 1.5^n` (**22 sa tavanlı**) süre. Adım başına +6 stat. **Yarışa çıkmayı engelleyen hiçbir iş 22 saati aşmaz** (OSM tarzı günlük döngü: yatmadan başlatılan iş ertesi akşam yarıştan önce hazır). Casus bu tavanın dışında — yarışa dokunmaz, sadece geliştirmeye çarpan verir. Süre tavanlanır, **fiyat tavanlanmaz** — geç sezonda fren tamamen parasal olur
- ✅ **Üç tezgah, gruplar arası paralel / grup içinde tek**: araç (MOTOR+AERO+GRIP tek tezgahı paylaşır), sürücü (kadronun tamamı tek antrenman koltuğunu paylaşır, 6 sa), istihbarat (casus görevi 24 sa, sonraki görev 48 sa sonra — 22 sa tavanının dışında)
- ✅ **Yarış günü kilidi**: ışıklar söndüğünde tezgahta parça varsa araç sökük yarışır — pişen stat yarı değerinde, DNF riski iki katı. Antrenmandaki sürücü koltuğa oturamaz, yerine kadronun en güçlüsü geçer. İptal yok; yarım günden uzun geliştirme başlatılırken hesabı gösteren onay çıkar
- ✅ **Kış reseti**: `55 + (eski − 55) × 0,35 + fabrika × 1,5`. 90'lık araç ~74'e geriler, merdiven sayaçları sıfırlanır, fabrika taşınır. Oyuncu her kış en güçlü rakibin (82,3) altına düşer, sezon sonunda (~90) üstüne çıkar — bir sezonluk ark tekrarlanabilir
- ✅ **Fabrika canlı**: seviye maliyeti `1.500 × 1,7^(n−1)`, tavan 5. Rüzgar tüneli yükseltme kazancına, üretim maliyet ve süreye, akademi antrenmana, motor lab güvenilirliğe bağlı; her seviye kış tabanına +1,5
- ✅ **Sürücü ekonomisi**: bedel üstel (`800 × 1,075^(ort−55) + potansiyel × 25`) — ort 95 bir yıldız 14.485 RP, yani 13 yarışlık gelir; biriktirerek alınmaz. Maaş 60–250
- ✅ **Ticaret**: kadro 2–6, satışta %20 menajer komisyonu. 62/88 bir genci 1.977'ye alıp 76'ya çıkarıp satmak +1.185 RP; tek antrenman koltuğu sezona ~1 çevirme sığdırır, yani ticaret ikincil gelir
- ✅ Şampiyona tablosu, sezon sonu ödülü ve sıfırlama, sürücü yaşlanması
- ✅ Hedefler: sıralama ve puan hedefi; rütbe puanı kapısı (tam / 0 / negatif)
- ✅ Başarımlar: podyum, pole, en hızlı tur, galibiyet, duble, hat-trick, grand slam, clean sweep; zayıf takım çarpanı; 10 rütbe ve **özgün çizgi rütbe ikonları** (`RankIcon`, Skia)
- ✅ **Altın**: sabit kur 1 Altın = 50 RP, hızlandırma saat başı 5 Altın. Paketler 60/180/500 (₺49,99/₺129,99/₺299,99). `goldPrices`'taki her satırın `rpPrices`'ta karşılığı var — **sadece Altın'la açılan hiçbir şey yok**. Altın→RP dönüşümüne günlük 6 Altın tavanı (bedava reklam Altını ekonomiyi şişirmesin)
- ✅ AdMob ödüllü reklam ve mağaza ödemesi adaptörleri (`lib/monetization/*`); ödül yalnızca SDK onayında verilir. 🔶 Mağazada SKU oluşturma ve üretim reklam kimlikleri kalan dış iş
- ✅ **Denge kapısı**: `npm run econ` (`scripts/econ-check.ts`) — 68 kontrol, sezon simülasyonu dahil. Yalın kadro sezonu 91/88/90 (ort 89.7), P3, 12 geliştirme ile bitirir; elit kadro 22 puan geride kalır

## Padok (`src/store/slices/*`, `features/paddock/*`) — [paddock-research.md](paddock-research.md)
- ✅ Personel: baş mekanik (geliştirme +0…+1.5, güvenilirlik), stratejist (brifing doğruluğu, tahmin bandı, bot keskinliği), pit şefi (pit süresi, hata); 3 koltuk, dolu koltuğa alırken "kimi bırakıyorsun"; pazar günlük
- ✅ Her takımın varsayılan sürücü çifti (`teams.ts`, 22 sürücü, tam stat); tüm kadrolar store'da (`rosters`), sezon sonunda herkes yaşlanır ve potansiyeline göre gelişir, motor güncel kadroları okur, Lig ekranı her takımın sürücülerini gösterir
- ✅ Sürücüler: yaş, potansiyel; 6 saatlik antrenman (gençler hızlı, 33+ gelişmez); günlük pazar, üstel fiyat. **Kadro 2-6**: iki asıl koltuk + dört yedek/yatırım (yarı ücret). Yedek hem sakatlıkta hem de asıl sürücü antrenmandayken koltuğa geçer; satışta %20 komisyon
- ✅ **Sözleşme süreleri**: 1/2/3 sezon; kısa sözleşme ucuz imza + %25 pahalı maaş, uzun sözleşme %45 pahalı imza + %15 ucuz maaş; maaş sözleşmede sabitlenir. Son yılına giren sürücü padokta uyarı verir, uzatma transfer ücreti değil güncel değerinin %45'i kadar imza parası ister; uzatılmazsa kışın takımdan ayrılır ve koltuğa akademiden genç çıkar
- ✅ **Rakip transferleri**: her kış sözleşmesi biten ve takımının seviyesinin çok altında kalan sürücüler koltuğunu boşaltır; boşalan koltukları güçlü takımdan başlayarak serbest sürücülerden ve zayıf takımların son yılındaki sürücülerinden doldururlar (zincirleme transfer), kalan koltuğa çaylak çıkar; 36+ (34+ ise %40) sözleşmesi biten sürücü emekli olur. Bizim ayrılan sürücümüz de bu havuza girer ve bir rakibe gider. Hepsi sezona tohumlu — ligdeki herkes aynı kışı görür
- ✅ Casusluk: hedef takım + stat; ücretsiz ajan (%55 başarı, %12 yakalanma) / profesyonel (15 Altın ya da 900 RP, %85, yakalanmaz); **rapor 24 gerçek saat sonra**, sonraki görev 48 saat sonra, 120 Altınla hemen alınabilir; başarı → sonraki geliştirme ×1.5, yanlış istihbarat ×0.5, yakalanma → RP cezası + hedefe güç
- ✅ Garaj gizleme: 1/3/7 gün — 3/8/20 Altın ya da 200/500/1.200 RP; rakip girişimleri engeller
- ✅ Rakip istihbaratı: ilk 4'teysen %20 deneme, başarılıysa rakip kalıcı güçlenir (`aiBonus`)

## Ekranlar
- ✅ Garaj (kahraman yarış kartı, bugün yapılacaklar, araç, sürücüler), Yarış, Geliştirme, Padok, Sponsorluk, Şampiyona, Profil
- ✅ **Dikey + yatay kabuk**: alt hap sekme çubuğu / yan kapsül, `Cols` ile uyarlanan düzen, açıklayıcı `ScreenHeader`; üç kalite ajanıyla incelenip düzeltildi (docs/design-system.md §7)
- ✅ **Ayarlar** (`features/settings/SettingsScreen.tsx`, `/settings`, header menüsünden açılır): renk körü modu, yazı boyutu, HUD yoğunluğu (Tam/Sade — `LiveRacePanel`'e bağlı, sade modda aşınma yüzdesi/pit sayısı gizlenir) — `@react-native-async-storage/async-storage` üzerinden zustand `persist` ile cihazda kalıcı (yalnızca bu tercihler + hesap oturumu; kariyer/yarış durumu aşağıdaki "Kayıt/yükleme" maddesinin kapsamında, hâlâ yok) (docs/design-system.md §8)
- ✅ **Hesap/lobi navigasyon ayrımı**: Profil artık bir sekme değil — header'daki kask ikonlu buton (`NavShell`) bir dropdown açar (Profilim/Ayarlar/Hesap). Alt gezinme sadece 6 yarış sekmesi (Garaj/Yarış/Geliştir/Sponsor/Padok/Lig); Profil ekranındayken alt gezinme "Oyuna dön" + "Lobi" (`LobbySwitcher` modalı, tek-lobi bağlan/ayrıl) gösterir (docs/design-system.md §10)

## Kimlik (`server/src/auth/*`, `server/src/identity/*`) — Faz 1a
- ✅ Postgres tabanlı hesap kimliği: `users` + `auth_identities`, sağlayıcı başına tek satır, hesap birleştirme e-posta özetinden
- ✅ Dört giriş yöntemi: Google, Apple, Facebook (JWKS/Graph doğrulamalı, alg-confusion ve JWKS altyapı arızası ayrımlı loglama) ve e-posta+şifre (scrypt, 8-200 karakter)
- ✅ Otomatik **`Takma Ad#1234`** ataması: profanity filtresi, taban önerileri, dolan etiket genişliği otomatik büyür
- ✅ **Endonym ülke listesi** (CLDR'den üretilir, `gen:countries`) ve 7 bölge kovası (`EU/NA/LATAM/MENA/APAC/SEA/OCE`), her bölgenin kendi yarış saati
- ✅ **Çevrimdışı IP→bölge önerisi**: RIR tahsis verisinden üretilen `/16` çözünürlüklü ikili tablo (`gen:ip-region`), üçüncü taraf çağrısı yok
- ✅ Altı uç nokta: `GET /onboarding/bootstrap`, `POST /auth/social`, `POST /auth/password/register`, `POST /auth/password/login`, `GET /me`, `PATCH /me`
- ✅ **Gizlilik sözleşmesi (KVKK/GDPR)**: istemci IP'si yalnızca bölge kovasına çevrilip atılır, ham e-posta/şifre asla saklanmaz — sadece `email_hash`/`password_hash`; sözleşme `server/test/privacy.test.ts` ile kaynak ağacı üzerinde denetlenir
- ✅ 195 sunucu testi, `npm run typecheck` temiz
- ✅ **Faz 1b — mobil istemciye bağlandı** (`mobile/src/lib/api/identity.ts`, `store/slices/authSlice.ts`, `features/auth/AuthScreen.tsx`, rota `/auth`, Profil ekranındaki "Hesap" kartından açılır): e-posta+şifre ile giriş/kayıt, takma ad (bootstrap önerisiyle ön dolu, düzenlenebilir), bölge seçici (7 bölge + yarış saati), aranabilir ülke seçici (CLDR listesi), oturum tokenı + hesap profili cihazda kalıcı (`gameStore.ts` persist). Gerçek sunucuya karşı uçtan uca doğrulandı (register → me → login → patch). `leagueSlice`'daki `managerId` artık signed-in hesabın gerçek id'sini kullanıyor (`effectiveManagerId`), anonim değilse. **Google/Apple/Facebook bağlanmadı** — native SDK (client id, bundle id, cihaz testi) gerektiriyor, kapsam dışı bırakıldı; butonlar arayüzde "yakında" olarak görünüyor, `lib/api/identity.ts`'deki `loginWithSocial` sunucu tarafını çağırmaya hazır bekliyor.

## Kapsam dışı / sırada
- ⬜ Google/Apple/Facebook'un mobil istemciye bağlanması (native SDK + cihaz testi gerektiriyor)
- ⬜ Lig oluşturma/davet (şu an tek sabit takım `bosphorus`'a katılım var, takım seçimi/davet akışı yok)
- ⬜ Kayıt/yükleme (persist) — kariyer/yarış/ekonomi durumu; hesap oturumu ve Ayarlar tercihleri zaten kalıcı (yukarı bakın)
- ⬜ Mağaza ürünleri ve üretim AdMob kimlikleri (kod hazır)
