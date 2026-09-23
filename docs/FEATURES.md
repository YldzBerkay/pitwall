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
- 🔶 Online lig sunucusu (`server/`): aynı motor, WebSocket tur yayını, **5 dk check-in penceresi**, yapmayan takım yardımcı bota düşer. Bu satırın anlattığı TEK global lig ve onun `/join`/`/weekend`/`/checkin`/`/pit` uçları Faz 3a-2'de kaldırıldı — yerini lobi başına Postgres'te kalıcı yarışlar aldı (aşağıdaki "Yarış — lobi başına canlı yarış" bölümüne bakın). İstemci (`store/slices/leagueSlice.ts`) hâlâ ESKİ, artık var olmayan uçları çağırıyor; yeni `/race/*` ailesine bağlanma sırada.

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
- ⬜ **İstemci bağlanması** — kendi planı var, bu fazın kapsamında değil;
  mobil hâlâ kendi store'undaki ekonomiyi kullanıyor (`leagueSlice.ts`
  artık var olmayan `/join`/`/weekend`/`/checkin`/`/pit`'i çağırıyor).

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

**Kazanç döngüsü kısmen kapandı — hangi kısmı DEĞİL:** yarış ödülü
(`racePrize`, `@pitwall/shared/sponsors`) artık gerçekten RP OLARAK ödeniyor.
Sponsor ücreti, brifing bonusu ve rütbe puanı **HENÜZ ödenmiyor** — bilerek,
uydurma sayı yerine: sunucuda yarış başına bir rütbe puanı formülü yok,
`lobby_seats` hiçbir hafta sonu seçimini (setup/taktik/risk) saklamıyor, ve
bir sponsorluk tablosu yok. Bu üçü olmadan ödemek ekonomi kapısını sessizce
kaydırırdı.

- ⬜ Roster/sözleşme/personel sunucuya taşınması (Faz 3b)
- ⬜ Sponsorlar ve tam sezon muhasebesi (Faz 3c) — sponsor ücreti, brifing
  bonusu, rütbe puanı bu fazın kapsamında ödemeye başlayacak
- ⬜ Sezon özeti, arşiv, ayrılma cezası (Faz 4)
- ⬜ Arkadaş sistemi (Faz 5)
- ⬜ **Mobil istemcinin yeniden bağlanması**: `mobile/src/store/slices/leagueSlice.ts`
  hâlâ Faz 3a-2'de silinen `/join`, `/weekend`, `/checkin`, `/pit`'i çağırıyor;
  yeni `/race/checkin`, `/race/pit`, `/race/live`'a taşınması bu fazın
  kapsamında değildi.

## Kapsam dışı / sırada
- ⬜ Google/Apple/Facebook'un mobil istemciye bağlanması (native SDK + cihaz testi gerektiriyor)
- ⬜ Lig oluşturma/davet (şu an tek sabit takım `bosphorus`'a katılım var, takım seçimi/davet akışı yok)
- ⬜ Kayıt/yükleme (persist) — kariyer/yarış/ekonomi durumu; hesap oturumu ve Ayarlar tercihleri zaten kalıcı (yukarı bakın)
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
- 🔶 Ekonominin sunucuya taşınması (Faz 3a) — sunucu tarafı bitti, aşağıdaki "Ekonomi — sunucuya taşıma" bölümüne bakın; istemci hâlâ kendi store'undaki ekonomiyi kullanıyor, bağlanma sırada
- ⬜ Sezon sonu özeti, ayrılma cezası (Faz 4) · arkadaş sistemi (Faz 5)