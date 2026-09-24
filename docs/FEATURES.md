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
- ✅ DNF ve motorun ürettiği **ağır kaza** olayı; uç veya pistin tersine setup kaza ve hata riskini ×2'ye kadar artırır. ⬜ **Sonucun sürücüyü gerçekten sakatlaması deliberately ertelendi** (Faz 3b): `driverSlice.ts`'teki `injuries` alanına artık hiçbir yerden yazılmıyor — yazan tek yer yerel `settleRaceWeekend`'di, o söküldüğü için "SAKAT" satırları hiç tetiklenemez, yedek koltuğa hiç geçmez
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
- ✅ Online lig sunucusu (`server/`): lobi başına Postgres'te kalıcı yarışlar, WebSocket tur yayını (`/race/live`), **5 dk check-in penceresi**, yapmayan takım yardımcı bota düşer. Bu satırın eskiden anlattığı TEK global lig ve onun `/join`/`/weekend`/`/checkin`/`/pit` uçları Faz 3a-2'de kaldırıldı. **Faz 3a-3 tamamlandığında** (aşağıdaki "İstemci — sunucunun görünümü" bölümüne bakın) yarışın KENDİSİ de istemciden söküldü — istemci artık sunucunun ürettiği yarışı ÇİZİYOR, kendi kopyasını koşmuyor.

## Ekonomi ve sonuç — [ekonomi-tasarim.md](superpowers/specs/2026-09-19-ekonomi-tasarim.md)
- ✅ **Tek ölçek knob'u**: `ECONOMY_SCALE = 1.5` (`data/economy.ts`); sponsor, ödül, maaş, transfer, fabrika ve casusluk fiyatlarının hepsi onu okur. Orta sıra takım yarış başına ~1.100 RP kazanır
- ✅ RP: sponsor ücreti koşulsuz, yarış ödülü (P1 600 / P11 263), brifing bonusu. Üçü de artık **sunucuda** ödeniyor, bkz. aşağıdaki "İstemci — sunucunun görünümü" bölümü. Sezon ödülü 9.000–2.500 (~6 yarışlık gelir) — bkz. aşağıdaki ⬜ not, sezon sonu ödülü henüz sunucuya taşınmadı
- ⬜ **Maaş düşümü deliberately ertelendi** (Faz 3b): personel ve sürücü maaşları hiçbir yerden düşmüyor — yerel `settleRaceWeekend` sökülürken maaş kesintisi de onunla gitti, sunucu tarafında henüz karşılığı yok
- ✅ **Araç merdiveni**: her stat kendi sayacını tutar, `750 × 1.5^tamamlanan` RP ve `6 sa × 1.5^n` (**22 sa tavanlı**) süre. Adım başına +6 stat. **Yarışa çıkmayı engelleyen hiçbir iş 22 saati aşmaz** (OSM tarzı günlük döngü: yatmadan başlatılan iş ertesi akşam yarıştan önce hazır). Casus bu tavanın dışında — yarışa dokunmaz, sadece geliştirmeye çarpan verir. Süre tavanlanır, **fiyat tavanlanmaz** — geç sezonda fren tamamen parasal olur
- ✅ **Üç tezgah, gruplar arası paralel / grup içinde tek**: araç (MOTOR+AERO+GRIP tek tezgahı paylaşır), sürücü (kadronun tamamı tek antrenman koltuğunu paylaşır, 6 sa), istihbarat (casus görevi 24 sa, sonraki görev 48 sa sonra — 22 sa tavanının dışında)
- ✅ **Yarış günü kilidi**: ışıklar söndüğünde tezgahta parça varsa araç sökük yarışır — pişen stat yarı değerinde, DNF riski iki katı. Antrenmandaki sürücü koltuğa oturamaz, yerine kadronun en güçlüsü geçer. İptal yok; yarım günden uzun geliştirme başlatılırken hesabı gösteren onay çıkar
- ⬜ **Kış reseti deliberately ertelendi** (Faz 3b): formül hâlâ `shared/src/season.ts`'te duruyor (`55 + (eski − 55) × 0,35 + fabrika × 1,5`) ama onu çağıran tek yer yerel `settleRaceWeekend`'di — o söküldüğü için araç regresyonu, merdiven sıfırlaması ve fabrika taşıması bugün HİÇ tetiklenmiyor. `mobile/src/store/gameStore.ts` `shared/season`'dan yalnızca sezon öncesi test sabitlerini (`TEST_DAYS`, `testReport`) okuyor, kış resetini değil
- ✅ **Fabrika canlı**: seviye maliyeti `1.500 × 1,7^(n−1)`, tavan 5. Rüzgar tüneli yükseltme kazancına, üretim maliyet ve süreye, akademi antrenmana, motor lab güvenilirliğe bağlı; her seviye kış tabanına +1,5
- ✅ **Sürücü ekonomisi**: bedel üstel (`800 × 1,075^(ort−55) + potansiyel × 25`) — ort 95 bir yıldız 14.485 RP, yani 13 yarışlık gelir; biriktirerek alınmaz. Maaş 60–250
- ✅ **Ticaret**: kadro 2–6, satışta %20 menajer komisyonu. 62/88 bir genci 1.977'ye alıp 76'ya çıkarıp satmak +1.185 RP; tek antrenman koltuğu sezona ~1 çevirme sığdırır, yani ticaret ikincil gelir
- ✅ Şampiyona tablosu artık **sunucudan okunuyor** (`GET /lobby/standings`), dondurulmuş yerel bir tohum değil — bkz. aşağıdaki "İstemci — sunucunun görünümü" bölümü
- ⬜ **Sezon sonu ödülü ve sıfırlama, sürücü yaşlanması deliberately ertelendi** (Faz 3b): hepsi `ageDrivers`'a bağlıydı, onu çağıran yerel `settleRaceWeekend` söküldü — bkz. aşağıdaki deferred liste
- 🔶 Hedefler: sıralama ve puan hedefi; rütbe puanı kapısı (tam / 0 / negatif) — hesaplaması hâlâ yerelde tanımlı ama onu tetikleyen yerel yarış sonu akışı gitti, bkz. Başarımlar notu
- ⬜ **Başarımlar deliberately ertelendi** (Faz 3b): `scoreWeekend`'in çağrıldığı tek yer yerel `settleRaceWeekend`'di, o söküldüğü için sonuç sayfasındaki başarım kartı ve rütbe çipi artık hiçbir yarıştan sonra dolmuyor — `RankIcon`/Skia ikonları koda hâlâ duruyor, yalnızca beslenmiyorlar
- ✅ **Altın**: sabit kur 1 Altın = 50 RP, hızlandırma saat başı 5 Altın. Paketler 60/180/500 (₺49,99/₺129,99/₺299,99). `goldPrices`'taki her satırın `rpPrices`'ta karşılığı var — **sadece Altın'la açılan hiçbir şey yok**. Altın→RP dönüşümüne günlük 6 Altın tavanı (bedava reklam Altını ekonomiyi şişirmesin)
- ✅ AdMob ödüllü reklam ve mağaza ödemesi adaptörleri (`lib/monetization/*`); ödül yalnızca SDK onayında verilir. 🔶 Mağazada SKU oluşturma ve üretim reklam kimlikleri kalan dış iş
- ✅ **Denge kapısı**: `npm run econ` (`scripts/econ-check.ts`) — 68 kontrol, sezon simülasyonu dahil. Yalın kadro sezonu 91/88/90 (ort 89.7), P3, 12 geliştirme ile bitirir; elit kadro 22 puan geride kalır

## Padok (`src/store/slices/*`, `features/paddock/*`) — [paddock-research.md](paddock-research.md)
- ✅ Personel: baş mekanik (geliştirme +0…+1.5, güvenilirlik), stratejist (brifing doğruluğu, tahmin bandı, bot keskinliği), pit şefi (pit süresi, hata); 3 koltuk, dolu koltuğa alırken "kimi bırakıyorsun"; pazar günlük
- ✅ Her takımın varsayılan sürücü çifti (`teams.ts`, 22 sürücü, tam stat); tüm kadrolar store'da (`rosters`), sezon sonunda herkes yaşlanır ve potansiyeline göre gelişir, motor güncel kadroları okur, Lig ekranı her takımın sürücülerini gösterir
- ✅ Sürücüler: yaş, potansiyel; 6 saatlik antrenman (gençler hızlı, 33+ gelişmez); günlük pazar, üstel fiyat. **Kadro 2-6**: iki asıl koltuk + dört yedek/yatırım (yarı ücret). Yedek hem sakatlıkta hem de asıl sürücü antrenmandayken koltuğa geçer; satışta %20 komisyon
- 🔶 **Sözleşme süreleri**: 1/2/3 sezon; kısa sözleşme ucuz imza + %25 pahalı maaş, uzun sözleşme %45 pahalı imza + %15 ucuz maaş; maaş sözleşmede sabitlenir. Padoktaki uyarı ve uzatma akışı çalışıyor, ama sözleşmenin kışın GERÇEKTEN sona ermesi `ageDrivers`'a bağlı — bkz. aşağıdaki ⬜ not, bugün hiç tetiklenmiyor
- ⬜ **Rakip transferleri deliberately ertelendi** (Faz 3b): kış transfer penceresi, emeklilik ve zincirleme transfer mantığı hâlâ kodda (`runTransferWindow`, `driverSlice.ts`'in `ageDrivers`'ı) ama onu çağıran yerel `settleRaceWeekend` söküldüğü için sezon sonunda hiçbir kış hiç yaşanmıyor — kadrolar donuk kalıyor
- ✅ Casusluk: hedef takım + stat; ücretsiz ajan (%55 başarı, %12 yakalanma) / profesyonel (15 Altın ya da 900 RP, %85, yakalanmaz); **rapor 24 gerçek saat sonra**, sonraki görev 48 saat sonra, 120 Altınla hemen alınabilir; başarı → sonraki geliştirme ×1.5, yanlış istihbarat ×0.5, yakalanma → RP cezası + hedefe güç
- ✅ Garaj gizleme: 1/3/7 gün — 3/8/20 Altın ya da 200/500/1.200 RP; rakip girişimleri engeller
- ✅ Rakip istihbaratı: ilk 4'teysen %20 deneme, başarılıysa rakip kalıcı güçlenir (`aiBonus`)

## Ekranlar
- ✅ Garaj (kahraman yarış kartı, bugün yapılacaklar, araç, sürücüler), Yarış, Geliştirme, Padok, Sponsorluk, Şampiyona, Profil
- ✅ **Dikey + yatay kabuk**: alt hap sekme çubuğu / yan kapsül, `Cols` ile uyarlanan düzen, açıklayıcı `ScreenHeader`; üç kalite ajanıyla incelenip düzeltildi (docs/design-system.md §7)
- ✅ **Ayarlar** (`features/settings/SettingsScreen.tsx`, `/settings`, header menüsünden açılır): renk körü modu, yazı boyutu, HUD yoğunluğu (Tam/Sade — `LiveRacePanel`'e bağlı, sade modda aşınma yüzdesi/pit sayısı gizlenir) — `@react-native-async-storage/async-storage` üzerinden zustand `persist` ile cihazda kalıcı (yalnızca bu tercihler + hesap oturumu; kariyer/yarış durumu aşağıdaki "Kayıt/yükleme" maddesinin kapsamında, hâlâ yok) (docs/design-system.md §8)
- ✅ **Hesap/lobi navigasyon ayrımı**: Profil artık bir sekme değil — header'daki kask ikonlu buton (`NavShell`) bir dropdown açar (Profilim/Ayarlar/Hesap). Alt gezinme sadece 6 yarış sekmesi (Garaj/Yarış/Geliştir/Sponsor/Padok/Lig); Profil ekranındayken alt gezinme "Oyuna dön" + "Lobi" (`SlotSwitcher` — 5 slotluk gerçek liste) gösterir (docs/design-system.md §10)

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

## Ekonomi — sunucuya taşıma (`server/src/economy/*`, `server/src/gold/*`, `server/src/notify/*`) — Faz 3a-1

Spec: [ekonomi sunucuya taşıma tasarımı](superpowers/specs/2026-09-22-faz3a-ekonomi-sunucuya-tasarim.md).

Bu fazın nedeni: ekonomi eskiden istemcinin `Date.now()`'ına dayanıyordu —
cihaz saatini ileri almak 22 saatlik bir araç geliştirmeyi anında
bitiriyordu. Faz 3a-1, her zamanlayıcıyı ve her yazmayı sunucuya taşıdı;
istemcinin buna bağlanması (Faz 3a-2'nin sonrası) hâlâ sırada — **bu yüzden
kazanma döngüsü bugün kapalı DEĞİL**: RP'nin ana kaynağı yarış ödül parası,
ve yarış hâlâ istemcide koşuyor. Sunucudaki ekonomi bugün gerçek RP/Altın
akışı olmadan test edilebilir durumda.

- ✅ **`shared/` paketi**: oyunun saf formülleri (`economy.ts`, `factory.ts`)
  artık `mobile` ve `server`'ın ORTAK bağımlılığı; sunucu artık
  `mobile/src/data`'ya elini uzatmıyor. Saflığı `server/test/shared-purity.test.ts`
  ile denetleniyor — saat yok, tohumsuz rastgelelik yok, dışa import yok.
- ✅ **Şema** (`003_economy.sql`): `lobby_economy` (RP, araç, fabrika,
  geliştirme sayaçları — takım başına), `pending_jobs` (geliştirme/antrenman/
  casusluk kuyruğu), `gold_grants` (Altın musluğu deftreri, `(source,
  external_id)` üzerinde tekilleştirme), `daily_caps` (reklam ve
  Altın→RP günlük sayaçları, sunucunun UTC gününde).
- ✅ **İş (claim) modeli** (`economy/jobs.ts`): `ends_at`'in geçmesi hiçbir
  şey yazmaz — yalnızca oyuncunun açık CLAIM'i ekonomiyi mutasyona uğratır,
  `claimed_at` bunu idempotent kılar. Yarış günü kilidi (bitmemiş iş → araç
  sökük başlar) Faz 3a-2'nin işi; bu faz sadece bitmiş-ama-teslim-alınmamış
  bir işi uygulanmamış tutmayı garanti ediyor.
- ✅ **Tek komut ucu**: `POST /economy/action` — `startUpgrade`/`startTraining`/
  `startSpyMission`, `claimUpgrade`/`claimTraining`/`claimSpyReport`,
  `skipUpgrade`/`skipTraining`/`skipSpy`, `upgradeFactory`,
  `convertGoldToRp`. Takım her zaman oyuncunun `lobby_seats` satırından
  çözülür; her yanıt slotun TAMAMINI (rp, gold, car, factory, jobs,
  teamValue, caps, `serverNow`) döner, ki istemci hiçbir şeyi kendi
  hesaplamasın. Ayrıntı için `server/README.md`'nin "Ekonomi" bölümüne
  bakın.
- ✅ **Altın musluğu**: AdMob ödüllü reklam (`GET /gold/admob-ssv`, ECDSA
  imza doğrulaması) ve mağaza fişi (`POST /gold/purchase`, Apple
  `verifyReceipt` + Google Play `purchases.products.get`). SKU izin
  listesi ve miktar her zaman kataloktan (`goldPacks`); her iki musluk da
  `(source, external_id)` ile tekilleştirilir.
- ✅ **Bildirici** (`notify/scheduler.ts`): biten işler için "işin bitti"
  bildirimini tarar, yalnızca `notified_at`'ı yazar — ekonomiye asla
  dokunmaz, bu yüzden iki sunucuda aynı anda ya da iki kez çalışması
  güvenli.
- ✅ `server/test/economy-invariants.test.ts` — yarışma koşulları ve
  replay'lere karşı yedi değişmezin (idempotent claim, tekrarlanamaz Altın
  musluğu, eşzamanlılıkta günlük tavan, vb.) kapanış kanıtı; `npm test`
  413 sunucu testiyle geçiyor, `npm run typecheck` (server + shared +
  mobile) temiz.
- ✅ **Yarış koşucusu, yarış sonuçlandırma, parc fermé / pit-lane başlangıcı,
  eski ligin kaldırılması** — Faz 3a-2'de tamamlandı, aşağıdaki "Yarış — lobi
  başına canlı yarış" bölümüne bakın.
- ✅ **İstemci bağlanması — Faz 3a-3'te tamamlandı**: araç geliştirme
  ekonomisi (RP, geliştirme işleri) artık `economyApi`/`displayFactory`
  üzerinden sunucudan okunuyor ve yazılıyor; **cihaz saati hilesi bu yol
  için KAPANDI**. Sürücü antrenmanı/casusluk ve Altın hâlâ mobilin kendi
  yerel sistemleri — bkz. aşağıdaki "İstemci — sunucunun görünümü"
  bölümü ve "Kapsam dışı / sırada" listesi.

## Yarış — lobi başına canlı yarış (`server/src/lobby/*`) — Faz 3a-2

Ayrıntı ve tasarım gerekçesi için `server/README.md`'nin "Yarış" bölümüne
bakın. Kullanıcının şartı: **herkes aynı yarışı görmeli**, ve bu fazın
çözümü yarış DURUMUNU değil onu üreten TARİFİ (tohum + dondurulmuş katılım +
değişmez pit karar günlüğü) saklamak — motor deterministik olduğu için
tarifi yeniden oynatmak bit düzeyinde aynı yarışı veriyor.

- ✅ **Şema** (`004_race.sql`, `005_race_progress.sql`): `race_runs` (tarif,
  değişmez tetikleyiciyle korunur), `race_decisions` (ekleme-only karar
  günlüğü, ilk karar kazanır), `race_settlements` (ödeme tekilleştirme).
- ✅ **Işıklar söner** (`runner.ts` `startRaceFor`): lobinin o anki katılımını,
  parc fermé kararını ve sıralama risklerini tek bir tarife dondurur, bir kez
  yazar. İkinci bir başlatma veritabanı kısıtından fırlar.
- ✅ **Yeniden oynatma** (`replay.ts`): saf, deterministik, çöken sunucunun
  devamı ve geç bağlanan istemcinin görüntüsü aynı fonksiyondan çıkar.
- ✅ **Tik döngüsü** (`runner.ts`): bellekteki `RaceState` kararlı yol
  (~0.9 ms/tik), tam yeniden oynatma yalnızca kurtarmada (~33 ms/78 tur) —
  ikisi aynı yarışı vermek ZORUNDA, `race-runner.test.ts` ve
  `race-invariants.test.ts` bunu çökme senaryosuyla kanıtlıyor.
- ✅ **Kritik kural yapısal**: bir pit kararı onu tüketen tur simüle
  edilmeden önce kalıcı olmak zorunda — `race_runs.last_lap` simülasyondan
  ÖNCE damgalanıp taahhüt ediliyor, `appendDecision` aynı satırı `for
  update` ile kilitleyip o damgaya göre kapı veriyor. Pit çağrısı iptali
  bilerek desteklenmiyor (ilk karar kazanır, günlük değişmez).
- ✅ **Kiralı sahiplik** (`lease.ts`): bir lobinin yarışını aynı anda tek
  süreç sürer, `LEASE_MS` (15 sn) tikin (2.5 sn) altı katı; evre ilerlemesi
  ise veritabanı-otoriter ve kirasız.
- ✅ **Parc fermé / pit-lane başlangıcı** (`parcFerme.ts`): devam eden iş
  aracı sakatlar (normal start); bitmiş-ama-teslim-alınmamış iş TAM
  uygulanır VE araç pit yolundan başlar, serbest başlangıç lastiğiyle
  birlikte (telafisiz ceza mekaniği tersine çevirirdi).
- ✅ **Muhasebe** (`economy/settle.ts`): yarış bittiğinde HER koltuğa
  (AI dahil) RP yazılır, şampiyona tablosu aynı transaction'da üretilir,
  `finishRun` + evre geçişi + ödeme TEK taahhütte (aksi halde çöken bir
  süreç "bitmiş ama hiç ödenmemiş" bir yarış bırakırdı — bu fazın düzelttiği
  gerçek hata).
- ✅ **Sezon/tur dönüşü ve süpürme döngüsü** (`sweep.ts`, `rollover.ts`):
  vakti gelen lobileri kiralar, tikler, bayrakta bir sonraki tura döner.
- ✅ **Eski tek global lig kaldırıldı**: `server/src/league.ts` ve onu
  servis eden `/join`, `/weekend`, `/checkin`, `/pit`, `/state`, eski
  WS `/live` silindi (`test/legacy-gone.test.ts`). Yerlerini `/race/checkin`,
  `/race/pit` ve lobi başına `/race/live` odaları aldı.
- ✅ **`server/test/race-invariants.test.ts`**: spec §12'deki 10
  değişmezliğin kapanış kanıtı — her biri kaynakta kırılıp testin gerçekten
  kırmızıya döndüğü, sonra geri konulduğu ölçülmüş bir turla yazıldı.

**Kazanç döngüsü Faz 3a-3'te kapandı:** yarış ödülü (`racePrize`), sponsor
ücreti ve brifing bonusu artık ÜÇÜ DE sunucuda, aynı muhasebe işleminde
(`economy/settle.ts`) ödeniyor — bkz. aşağıdaki "İstemci — sunucunun
görünümü" bölümü ve `server/README.md`'nin "Ekonomi" bölümü. **Rütbe puanı
hâlâ ödenmiyor** — sunucuda yarış başına bir rütbe puanı formülü yok; bu Faz
3b/3c'nin kapsamında.

- ⬜ Roster/sözleşme/personel sunucuya taşınması (Faz 3b) — bkz. aşağıdaki
  altı deliberately-ertelenmiş madde
- ⬜ Rütbe puanı ve tam sezon muhasebesi (sezon sonu ödülü, arşiv) (Faz 3c/4)
- ⬜ Arkadaş sistemi (Faz 5)
- ✅ **Mobil istemcinin yeniden bağlanması — Faz 3a-3'te tamamlandı**: bkz.
  aşağıdaki "İstemci — sunucunun görünümü" bölümü. Ölü `leagueSlice.ts` ve
  onun artık var olmayan uçlara yaptığı çağrılar silindi.

## İstemci — sunucunun görünümü (`mobile/src/lib/api/race.ts`, `raceSocket.ts`, `store/slices/*`) — Faz 3a-3 tamamlandı

Kullanıcının şartı baştan sona aynı kaldı: **lobideki herkes AYNI yarışı
görmeli**. Faz 3a-2 sunucu tarafını bitirmişti (yarışı otorite olarak koşan,
tarif saklayan bir sunucu); Faz 3a-3 Aşama 1 istemcinin pit çağrısı ve hafta
sonu tercihi yolunu o sunucuya bağladı; bu fazın kapanışı istemcinin
**ikinci gerçekliğini** (kendi yarışını ve kendi araç-geliştirme ekonomisini
hesaplayan yerel motor) tamamen söktü. Bugün itibarıyla istemci sunucunun
ürettiği durumu ÇİZİYOR, kendi kopyasını üretmiyor.

- ✅ **Yerel yarış motoru VE yerel araç-geliştirme ekonomisi tamamen
  söküldü.** `mobile/src/store/gameStore.ts` artık ne bir tur simüle ediyor
  ne de bir geliştirme sayacı işletiyor; ekranda görülen her şey sunucudan
  gelen bir çerçeve ya da sunucudan okunan bir anlık görüntü. Bunun geri
  gelmesine karşı **üç tarama testi** duruyor:
  `mobile/test/no-local-race.test.ts` (motorun tur/başlatma/sıralama
  fonksiyonlarının hiçbir dosyadan çağrılmadığını, `gameStore.ts`'te
  hiçbir `setInterval` kalmadığını ve `LiveRacePanel`'in yerel bir ödeme
  yolu içermediğini tarar), `mobile/test/legacy-league-gone.test.ts`
  (ölü `leagueSlice.ts`'in geri gelmediğini) ve
  `server/test/upgrade-formula.test.ts`'in 5. testi (sunucunun kendi
  geliştirme formülünü yeniden türetmediğini, `shared/`'ı içe aktardığını
  tarar — bkz. aşağıdaki "İki bulgu").
- ✅ **Bağlantı sözleşmesi değişmedi, güçlendi**: dört bağlantı durumu
  (`connecting`/`connected`/`disconnected`/`session-invalid`) artık
  `store/slices/raceSlice.ts`'te iki store durumuyla (`idle`, `signed-out`)
  altıya çıkıyor. **Kopukken ekran donar, hiçbir şey uydurulmaz; pit çağrısı
  reddedilir, kuyruğa ASLA alınmaz** — ayrıntı ve gerekçe:
  `mobile/README.md`'nin "Bağlantı sözleşmesi" bölümü.
- ✅ **Seçici (selector) deseni**: `displayRace`, `displayQualifying`,
  `displayFactory`, `displaySponsors`, `displaySettlement`, `displayPhase`,
  `displayStandings` — hepsi saf fonksiyon, `store/slices/*.ts`'te yaşıyor,
  hiçbiri bir `.tsx` dosyasında değil. Ekranlar hiçbir karar vermez, yalnızca
  bu fonksiyonların döndürdüğü ayrık durumu (`loading`/`no-lobby`/`ready`
  gibi) çizer — gerekçe için `mobile/README.md`'nin "Seçici deseni" bölümüne
  bakın.
- ✅ **Sponsorlar sunucuda**: `GET /sponsors/offers`, `POST /sponsors/sign`,
  `POST /sponsors/release` — `displaySponsors` bu uçları okuyup çiziyor.
  Sözleşme şartları (perRace/bonus/hedef) HER ZAMAN sunucunun kendi
  yeniden ürettiği teklif sayfasından gelir, istemcinin gönderdiği bir
  alandan değil — bkz. `server/README.md`'nin "Sponsorlar" bölümü.
- ✅ **Muhasebe dökümü sunucuda ve kalıcı**: `GET /economy/settlement` yarış
  ödülü + sponsor geliri + brifing bonusunun PARÇALARINI döner;
  `displaySettlement` bunu okuyup `RaceResultSheet`e çizer. Toplam artık
  uydurma değil, sunucunun aynı işlemde yazdığı satırın ta kendisi.
- ✅ **Şampiyona tablosu sunucudan**: `GET /lobby/standings`;
  `displayStandings` dondurulmuş yerel bir tohumu değil bu uç noktayı okur.
- ✅ **Solo/lobisiz oyun kalktı**: `RaceWeekScreen`, lobi yokken (`no-lobby`)
  yerel bir hafta sonu ÇİZMEK yerine "bir lige katıl" mesajı gösterir —
  sunucusuz koşan bir yarış artık hiçbir ekranda yok.
- ✅ **Uçtan uca kanıt**: `server/test/race-client-integration.test.ts`
  gerçek sunucuyu ayağa kaldırıp mobilin KENDİ `race.ts`/`raceSocket.ts`
  modüllerini (hiçbir sahte olmadan) ona karşı çalıştırıyor.

### İki bulgu — kalıcı ders, tek seferlik olay değil

1. **Denge kapısı, oyunun koşmadığı kodu doğrulayabilir.** Sunucu bir süre
   araç geliştirmenin maliyet/süre/stat-kazancı formüllerini özel olarak
   yeniden türetmişti, `shared/`'ı içe aktarmak yerine — ve ikisi ciddi
   şekilde ayrışmıştı: 5. geliştirmede 3797 RP'ye karşı 1831; ilk
   geliştirme sunucuda 22 saat sürerken `shared/` 6 saat diyordu; ve
   tamamlanan her geliştirme 6 yerine 1-3 stat puanı veriyordu. `npm run
   econ` (68 iddialık denge kapısı) bütün bu süre boyunca YEŞİL kalıyordu,
   çünkü `shared/`'ın fonksiyonlarını test ediyordu — sunucunun artık
   kullanmadığı fonksiyonları. Düzeltme: sunucuyu `shared/`'ı içe
   aktarmaya zorlamak, ikinci bir tanım belirirse kırılan bir tarama
   testiyle (`server/test/upgrade-formula.test.ts` #5) korumak altına
   almak.
2. **Bir tarama testi, taradığı şeye karşı kör olabilir.** "Hiçbir
   zamanlayıcı yarışı ilerletmiyor" kontrolü İÇE AKTARMA ANINDA çalışır,
   yani bir store *action*'ının İÇİNDE oluşturulan bir zamanlayıcı ona
   görünmez. Bu yüzden ikinci bir tarama var: `gameStore.ts`'in METNİ hiçbir
   `setInterval` içermemeli. Bozma/geri-getirme kanıtı sırasında ilk tarama
   geçti, yalnızca ikincisi yakaladı.

### Kapsam dışı bırakılan altı özellik — bilerek ertelendi, unutulmadı değil

Yerel muhasebenin (`settleRaceWeekend`) sökülmesi, onu çağıran altı şeyi de
durdurdu. Kullanıcının açık onayıyla Faz 3b'ye ertelendi:

- ⬜ **Başarımlar** (`scoreWeekend`) — sonuç sayfasının başarım kartı ve
  rütbe çipi artık dolmuyor
- ⬜ **Kariyer kaydı** (`recordWeekend`) — profil rütbesi fiilen donuyor
- ⬜ **Sürücü sakatlanması** — `injuries`e artık hiçbir yerden yazılmıyor,
  "SAKAT" satırları hiç tetiklenemez
- ⬜ **Maaş düşümü** — personel ve sürücü maaşları hiçbir yerden ödenmeden
  düşmüyor
- ⬜ **Yarış günü casusluk sonuçlanması** — `resolveIntel` yeni bir görev
  açılırken hâlâ çalışıyor, ama artık muhasebede değil
- ⬜ **Sürücü yaşlanması ve kış** — `ageDrivers`, araç regresyonu,
  geliştirme merdiveni sıfırlaması, `transferNews`, padok başlık şeridi

Hâlâ tamamen istemci tarafında ve sunucu karşılığı hiç olmayan: **sürücü
piyasası** ve **personel sistemi**. Sezon öncesi test paneli de bir lobi
dışında hâlâ çalışıyor — küçük bir tutarsızlık, karar bekliyor.

## Kapsam dışı / sırada
- ⬜ Google/Apple/Facebook'un mobil istemciye bağlanması (native SDK + cihaz testi gerektiriyor)
- ⬜ Kayıt/yükleme (persist) — kariyer durumu (bkz. yukarıdaki "Kapsam dışı
  bırakılan altı özellik" listesi: başarım/kariyer kaydı Faz 3b'ye kadar zaten
  boş); hesap oturumu, Ayarlar tercihleri ve artık sunucudaki yarış/ekonomi
  durumu zaten kalıcı (yukarı bakın)
- ⬜ Mağaza ürünleri ve üretim AdMob kimlikleri (kod hazır)

## Lobi, koltuk ve slot (`server/src/lobby/*`) — Faz 2

Spec: [çok oyunculu kabuk tasarımı](superpowers/specs/2026-09-19-cok-oyunculu-kabuk-tasarim.md) §3, §4.1, §6.

- ✅ **Şema** (`002_lobby.sql`): `account_slots`, `lobbies`, `lobby_seats`, `lobby_invites`. Koltuk sahipliği CHECK ile bağlı (sahipsiz koltuk `human` olamaz); hesabı silinen oyuncunun koltuğunu tetikleyici AI'ya devreder, lobinin 11 takımı hiç eksilmez.
- ✅ **Slotlar** (§4.1): 3 ücretsiz + 250 Altınla açılan 4./5., kalıcı. Satın alma `users` satırını kilitleyerek yapılır — aynı Altınla iki slot alınamaz.
- ✅ **Lobi kurma** (§3.1/§3.2): bölge, görünürlük, AI zorluğu, rütbe kapısı, sezon ortası katılım, davet zinciri. Ad bölge havuzundan otomatik (`Anadolu #14`); oyuncu isim yazmaz. Kurulur kurulmaz 11 koltuk AI olarak yazılır, **kurucu takımını seçene kadar lobi hiçbir havuzda görünmez**.
- ✅ **Hızlı oyun bul** (§3.3/§3.4): tek önizleme kartı, "Başka bul" bedava ve sınırsız. **Slot yalnızca takım seçildiğinde harcanır** — koltuk yarışını kaybeden oyuncunun slotu aynı transaction'da geri döner.
- ✅ **Dürüst doluluk** (§3.4): kartın gösterdiği her sayı gerçek koltuk satırlarından gelir. Dağıtım yalnızca HANGİ gerçek lobinin önerileceğini şekillendirir; sahte kıtlık üretilmez. Sunucu, havuzda o takımı dolu bir aday varsa onu gösteriyor ve hiçbir zaman havuzda gerçekten var olandan fazlasını göstermiyor — `npm run sim:matchmaking` ikisini de ölçüyor.
- ✅ **§3.4 hedefleri ölçümle yeniden belirlendi: %75 / %65.** "En güçlü n. araç" = güç sırasındaki n. TAKIM (bir koltuk = bir takım = iki araç). İlk yazımdaki %85/%75, 11 koltuklu ızgarada ulaşılamıyordu: dürüst tavan `(11 − n) / (11 − 1)` = %80/%70, ölçülen en iyi ~%76/%66. Sebep seçim algoritması değil, ekosistem — lobiyi dolduran 10 katılımcının ilk n−1'i, n. takım henüz boşken gelmek zorunda, yoksa lobi hiç büyümez. Tavanı yükseltmek için koltuğu tek araç yapmak reddedildi (yönetici bir takım yönetir). `npm run sim:matchmaking` hem hedefin tavanın altında olduğunu hem de sunucunun havuzdakinin tamamını gösterdiğini doğruluyor.
- ✅ **Davet** (§3.6): tam `Takma#1234` etiketiyle; kısmi arama yok. Davet koltuk ayırmaz — davetli geldiğinde kalanlardan seçer.
- ✅ **İstemci**: `lib/api/lobby.ts`, `store/slices/lobbySlice.ts`, genel ekran (`features/lobby/LobbyHomeScreen.tsx`, rota `/lobby`), takım seçim kartı (`features/lobby/TeamSelect.tsx` — hedef ve karşılığındaki rütbe puanı satırda yazar), header dropdown'ı gerçek 5 slotluk liste (`components/organisms/SlotSwitcher.tsx`, eski tek-adres bağlan/ayrıl modalının yerine).
- ✅ Ekonominin sunucuya taşınması (Faz 3a) ve istemcinin ona bağlanması (Faz 3a-3) — bkz. aşağıdaki "Ekonomi — sunucuya taşıma" ve "İstemci — sunucunun görünümü" bölümleri
- ⬜ Sezon sonu özeti, ayrılma cezası (Faz 4) · arkadaş sistemi (Faz 5)