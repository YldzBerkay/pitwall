# Pit Wall — Lig Sunucusu

Aynı yarış motorunu (`mobile/src/data`) sabit bir saatte koşturur ve her turu
WebSocket ile yayınlar. Sunucu otoritedir; istemci sadece çizer ve pit
çağrısı gönderir.

## Çalıştırma

```bash
cd server && npm install
npm run dev          # ilk yarış 20 sn sonra, check-in 15 sn önce açılır (geliştirme)
npm start            # varsayılan: ilk yarış 1 saat sonra, check-in 5 dk, günde bir yarış
```

Ortam değişkenleri: `PORT` (8787), `TICK_MS` (2500), `CHECKIN_SECONDS` (300),
`INTERVAL_SECONDS` (86400), `RACE_IN_SECONDS` (3600).

## Kimlik (`src/auth/*`, `src/identity/*`)

Postgres tabanlı kimlik katmanı: Google/Apple/Facebook sosyal girişi ve
e-posta+şifre, otomatik `Takma Ad#1234` ataması, ülke/bölge seçimi ve IP'den
çevrimdışı bölge önerisi. Altı uç nokta:

| Yöntem | Yol | Gövde | Notlar |
|---|---|---|---|
| GET | `/onboarding/bootstrap` | — | Önerilen 4 takma ad, bölge önerisi (`suggestedRegion`, istemci IP'sinden), bölge listesi, ülke listesi. Oturum gerektirmez |
| POST | `/auth/social` | `provider` (`google\|apple\|facebook`), `token`, `nicknameBase?`, `countryCode?`, `region?` | Sağlayıcı token'ını doğrular, hesabı bulur/oluşturur. **201** yeni hesapta, **200** var olanda, **401** `invalid_token` ise |
| POST | `/auth/password/register` | `email`, `password`, `nicknameBase?`, `countryCode?`, `region?` | **201** yeni hesap, **409** `email_taken` ise |
| POST | `/auth/password/login` | `email`, `password` | **200** başarılı, **401** `invalid_credentials` ise |
| GET | `/me` | — (Bearer token) | Oturumdaki kullanıcının genel profili. **401** oturum geçersizse |
| PATCH | `/me` | `countryCode?`, `region?` | Profili günceller. **400** `invalid_country`/`invalid_region`, **401** oturum geçersizse |

`/auth/social` ve `/auth/password/*` başarılı yanıtları `{ token, isNew, user }`
döner; `user` her zaman `publicProfile()`'dan geçer (bkz. aşağıdaki gizlilik
sözleşmesi).

### Gizlilik sözleşmesi (KVKK/GDPR)

- **İstemci IP'si asla saklanmaz.** `clientIpOf()` ile okunur, `regionForIp()`
  ile bir bölge kovasına (`EU`/`NA`/`LATAM`/…) çevrilir ve atılır — hiçbir
  tabloya, log satırına veya yanıta yazılmaz.
- **Ham e-posta ve şifre asla saklanmaz.** Yalnızca `email_hash`
  (`EMAIL_HASH_PEPPER` ile HMAC-SHA256) ve `password_hash` (scrypt) saklanır.
- Bu sözleşme yorumla değil, **`test/privacy.test.ts` ile kaynak ağacı
  üzerinde denetlenir**: log satırlarında IP/parola/e-posta geçip geçmediği,
  şemada ham adres/e-posta kolonu olup olmadığı, `clientIpOf` sonucunun
  yalnızca `regionForIp`'e gidip gitmediği ve `publicProfile()` çıktısında
  e-posta anahtarı/değeri olup olmadığı taranır. Bu test kırılırsa gizlilik
  sözleşmesi bozulmuş demektir — CI'da asla gevşetilmemeli.

### Operasyonel notlar

Bunlar inceleme sırasında bulundu ve kaybolmamalı:

1. **`EMAIL_HASH_PEPPER` asla döndürülmemeli.** Döndürmek sağlayıcılar arası
   her hesap bağlantısını öksüz bırakır. Pepper değişikliği veya veri
   aktarımından sonra `email_hash`'in farklı `user_id`'ler arasında benzersiz
   olduğu doğrulanmalı — iki kullanıcı aynı hash'i paylaşırsa
   `findUserByEmailHash` rastgele (ama deterministik) birini döner.
2. **Şifre maliyeti tavanı `MAX_N` değil `MAXMEM` ile sınırlı.**
   `maxmem = 64MB`, `r = 8` iken kullanılabilir en yüksek `N`, 32768 — mevcut
   16384'ün tam bir katlaması üstü. `N`'i bunun ötesine çıkarmak `MAXMEM`'i de
   orantılı artırmayı gerektirir, yoksa `hashPassword` kayıtta hata fırlatır.
3. **`create index concurrently` migration içinde kullanılamaz.** Her
   migration bir transaction içinde çalışır, PostgreSQL bu ifadeyi
   transaction içinde yasaklar.
4. **Askıda kalan bir HTTP handler soketi süresiz açık tutar.** Router'da
   handler zaman aşımı yok; bu politika kasıtlı olarak henüz kararlaştırılmadı.
   Faz 1b daha yavaş uç noktalar eklemeden önce çözülmeli.
5. **IP→bölge `/16` çözünürlüğünde.** İyi bilinen bir adres kendi ülkesinden
   farklı bir bölgeye düşebilir — `1.1.1.1`, `OCE` değil `SEA` döner, çünkü o
   `/16` bloğu sayıca TH'ye ait adreslerce domine edilir. Bu bir hata değil,
   tasarımın beklenen sonucu.
6. **Üretilen IP tablosu zamanla eskir.** Tahsisler değiştikçe
   `npm run gen:ip-region`'ı arada bir yeniden çalıştırıp güncel ikiliyi
   commit'leyin.

### Yerel veritabanı kurulumu

Homebrew ile `postgresql@17` (port 5432); `postgresql@13` Homebrew'da
desteği bitmiş (EOL) ve devre dışı bırakıldığı için 17 kullanılıyor.

```bash
brew install postgresql@17
brew services start postgresql@17

# rol ve veritabanları
createuser -s pitwall
createdb -O pitwall pitwall
createdb -O pitwall pitwall_test
```

Bağlantı: `postgres://pitwall:pitwall@localhost:5432/pitwall` (ve `_test`).
Migration'ları çalıştırmak için `npm run migrate` (bkz. `src/db/migrate.ts`).

### Test ve tip kontrolü

```bash
DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test
npm run typecheck
```

### Denge ve doğrulama script'leri

```bash
npm run sim:matchmaking   # §8 Faz 2 kapısı: eşleştirme dağılımı
```

Spec §3.4, önerilen adayların %75'inde en güçlü 3., %65'inde en güçlü 4.
takımın gerçekten dolu olmasını ister ("n. araç" = güç sırasındaki n. takım;
bir koltuk = bir takım = iki araç). Bu, tek bir kartın değil kartlar
AKIŞININ özelliğidir, o yüzden ölçülerek doğrulanır.

Script üç şeyi kontrol eder: (1) sunucu havuzdaki her uygun adayı gösteriyor
ve gerçeği hiç aşmıyor, (2) ölçülen dağılımı yazar, (3) hedefler dürüst
tavanın altında ve en iyi gerçekçi havuzda tutuyor.

Tavan `(11 − n) / (11 − 1)` = %80 / %70: oyuncular en iyi boş takımı aldığı
için lobiyi dolduran 10 katılımcının ilk n−1'i, n. takım henüz boşken gelmek
zorunda — yoksa lobi hiç büyümez. Hedefler ilk yazımda %85/%75'ti; ölçüm
bunların tavanın üstünde olduğunu gösterdi ve aşağı çekildiler. Koltuğu takım
yerine tek araç yapmak tavanı yükseltirdi, tasarım gereği reddedildi.

### Üretici script'ler — asla elle düzenlenmez

- `npm run gen:countries` → `src/identity/countries.ts` (endonym ülke listesi,
  CLDR verisinden üretilir)
- `npm run gen:ip-region` → `src/identity/ip-region-v4.bin` (RIR tahsis
  dosyalarından üretilen /16 IP→bölge tablosu)

Her iki dosya da **ÜRETİLMİŞTİR** — elle düzenlemeyin, ilgili script'i
çalıştırıp çıktıyı commit'leyin.

## Ekonomi (`src/economy/*`, `src/gold/*`, `src/notify/*`)

Spec: `docs/superpowers/specs/2026-09-22-faz3a-ekonomi-sunucuya-tasarim.md`.

Faz 3a-1, ekonomiyi telefondan sunucuya taşıdı. Sebep basit: eskiden her
sayaç istemcinin kendi `Date.now()`'ını okuyordu — cihaz saatini ileri almak
22 saatlik bir araç geliştirmeyi anında bitiriyordu. Artık her zamanlayıcı ve
her yazma sunucuda; `shared/` ise iki tarafın (mobil + sunucu) AYNI formülü
okumasını sağlıyor — bkz. aşağıdaki "Paylaşılan paket".

### `POST /economy/action`

Tek uç nokta, tek gövde şekli — `Authorization: Bearer <token>` ister.
`lobbyId` gövdede taşınır, çünkü router'ın path parametresi yok
(`src/http/router.ts` tam yol eşlemesi yapar). Eylem türü `type` alanıyla
seçilir:

| `type` | Ek alanlar | Ne yapar |
|---|---|---|
| `startUpgrade` | `label` (`motor\|aero\|grip`) | Araç geliştirmesi başlatır, RP düşer |
| `startTraining` | `driverIdx` | Sürücü antrenmanı başlatır |
| `startSpyMission` | (serbest, olduğu gibi saklanır) | Casusluk görevi başlatır |
| `claimUpgrade` / `claimTraining` / `claimSpyReport` | `jobId` | Biten işi teslim alır, etkisini uygular |
| `skipUpgrade` / `skipTraining` / `skipSpy` | `jobId` | Kalan süreyi Altınla atlar |
| `upgradeFactory` | `code` | Fabrika departmanını bir seviye yükseltir |
| `convertGoldToRp` | `gold` | Altını RP'ye çevirir (günlük tavan içinde) |

Takım her zaman **oyuncunun kendi `lobby_seats` satırından** çözülür —
gövdede gönderilen bir `teamKey` hiçbir yerde okunmaz.

**Her yanıt slotun TAMAMINI döner** — `rp`, `gold`, `car`, `factory`,
`upgradesDone`, açık `jobs`, `teamValue`, günlük `caps`, ve `serverNow`.
Sebep: istemci hiçbir şeyi kendi hesaplamıyor, sadece sunucunun tam
anlık görüntüsünü çiziyor. Parça parça yanıtlarla istemcinin kendi
başına "slotum şu an nasıl görünüyor"yu birleştirmesi gerekirdi, ve tek bir
kaçırılmış/sıra dışı gelen parça iki tarafı sessizce ayırırdı — oyuncu
ekranının sunucuyla uyuşmadığını fark edene kadar görünmeyen bir hata.
Tek bir tam anlık görüntüyle birleştirilecek hiçbir şey kalmıyor.
`serverNow`, istemcinin geri sayımlarını KENDİ saatiyle `serverNow`
arasındaki farktan türetmesi için var — cihaz saatini ileri almak artık
hiçbir şeyi değiştirmiyor (bkz. `src/economy/state.ts`'in docblock'u).

### İş (job) modeli

`pending_jobs` (araç geliştirme, sürücü antrenmanı, casus görevi) tek bir
kurala dayanıyor: **`ends_at`'in geçmesi HİÇBİR ŞEY yazmaz.** Ekonomiyi
mutasyona uğratan tek şey oyuncunun açık CLAIM'i, ve `claimed_at` bunu
idempotent kılıyor — tekrar bir claim hiçbir şeye mal olmaz ve hiçbir şeyi
değiştirmez. Bitmiş ama teslim alınmamış bir iş yarışa girer ama araç
sökük başlar (parc fermé cezası, Faz 3a-2) — motor bu mekaniği devreye
sokmak için işin claim'e kadar uygulanmamış kalmasını garanti etmek
zorunda, o kadar. Ayrıntı ve eşzamanlılık kanıtı için `src/economy/jobs.ts`'in
docblock'una ve `server/test/economy-jobs.test.ts`'e bakın.

### Altın musluğu iki yoldan doluyor

- **AdMob ödüllü reklam** (`GET /gold/admob-ssv`): Google'ın imzaladığı
  callback'in imzası ECDSA (P-256) ile doğrulanır (`src/gold/ssv.ts`).
  İstemcinin "reklamı izledim" demesi hiçbir zaman yeterli değil.
- **Mağaza ödemesi** (`POST /gold/purchase`): Apple `verifyReceipt` /
  Google Play `purchases.products.get` ile fiş doğrulanır
  (`src/gold/receipts.ts`).

İkisi için de iki sabit kural var: **SKU izin listesi** — `goldPacks`'ta
olmayan bir SKU, fiş ne kadar gerçek olursa olsun hiçbir Altın vermez — ve
**miktar her zaman kataloktan gelir** (`@pitwall/shared/economy`'deki
`goldPacks`), asla istekten ya da mağaza yanıtındaki bir alandan değil. Her
iki musluk da `(source, external_id)` üzerindeki bir veritabanı kısıtıyla
tekilleştirilir — replay olan bir callback/fiş 200 döner ama Altın vermez.

### Yerel kurulum, test, tip kontrolü

```bash
cd server && npm install
DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test
npm run typecheck
```

### Paylaşılan paket (`shared/`)

`shared/`, oyunun saf formüllerinin (ekonomi, fabrika, vb.) tek kopyası —
hem `mobile` hem `server` ONU tüketir (sunucu artık `mobile/src/data`'ya
elini uzatmıyor). Saf kalması şart: bir tarafın saati ya da tohumsuz
rastgeleliği okuması, iki tarafın farklı sonuç hesaplamasına yol açar ve bu
sessizce olur — `server/test/shared-purity.test.ts` bunu kaynak ağacı
üzerinde denetler. `src/identity/countries.ts` ve
`src/identity/ip-region-v4.bin` hâlâ üretilmiş dosyalar; yukarıdaki
"Üretici script'ler" bölümüne bakın.

### Dört sözleşme — bu fazda ortaya çıktı, koda göçmeden önce buraya yazıldı

1. **`now` sadece route'ta `new Date()` ile örneklenir, istekten asla
   okunmaz.** `src/economy/jobs.ts` kasıtlı olarak saati kendisi hiç okumaz
   — her giriş noktası `now`'ı çağırandan alır, ki bu test edilebilirlik
   sağlar ama tüm hile-önleme garantisini çağrı noktasına yükler.
   Somut olarak: `skipCostGold(ends_at − now)`, `ends_at`'i geçmiş bir
   `now` için **0** döner — yani `now`'ı şişirebilen bir çağıran bedava
   atlama kazanır; aynı `now`, `claimJob`'ın hazır olma kontrolünü de
   sürüyor. `src/economy/routes.ts` bu yüzden `now`'ı SADECE kendi
   `new Date()`'inden okur; gövdedeki bir `now`/`serverNow`/`timestamp`
   hiçbir yerde okunmaz.
2. **`shared/` saftır.** G/Ç yok, saat yok, tohumsuz rastgelelik yok —
   yukarıya bakın.
3. **Bir para birimi yazması ve onun sayaç kaydı TEK transaction'da
   olmalı.** Bu faz aynı hatayı üç kez üretti: `skipJob`'ın zaten claim
   edilmiş bir işten Altın kesmesi, reklam kredisinin günlük tavan
   sayacı olmadan yazılması, Altın→RP harcamasının RP'yi kredilemeden
   Altını düşmesi. Üçü de aynı şey: "başarılı görünen ama hiçbir şey
   satın almayan harcama". Desen: koru YAZMANIN KENDİ `where`'inde olsun
   (`spendGold`'ın `where gold >= $2`'si ve `grantGoldForAd`'ın
   `where ads_watched < cap`'i gibi), önceki bir okumada değil.
4. **`withTransaction` sadece bir throw'da geri alır.** Callback'in içinden
   bir başarısızlık sonucu `return` etmek, o ana kadar yazılmış her şeyi
   COMMIT eder. Bu fazda üç ayrı ajan buna çarptı; ikisi geri almayı
   zorlamak için bir sentinel hata fırlatmak zorunda kaldı. Yeni bir
   transactional yol yazan biri bunu yazmadan ÖNCE bilmeli, sonra değil.

Bilinen bir sınır: `grantGold` kendi transaction'ını açar ve çağıranınkine
katılamaz. Bugün bu sorun değil çünkü satın alma yolunun günlük tavanı yok
— ama satın almaya bir tavan eklenirse, `grantGoldForAd`'ın deseni (tek
transaction içinde koşullu upsert) tekrarlanmalı, iki transaction art arda
dizilmemeli.

## Uç noktalar

| Yöntem | Yol | Gövde | Açıklama |
|---|---|---|---|
| GET | `/state` | — | Faz, ışık saati, check-in açılışı, pist, tablo, takımlar |
| POST | `/join` | `teamKey, managerId` | Takımı üstlen; dolu koltuk `taken` |
| POST | `/weekend` | `teamKey, managerId, setup?, tactics?, risk?, reliability?` | Hafta sonu seçimleri (yarış canlıyken reddedilir) |
| POST | `/checkin` | `teamKey, managerId` | Sadece `checkin` fazında; yoksa `closed` |
| POST | `/pit` | `teamKey, managerId, driverIdx, compound\|null` | Sonraki tur için pit çağrısı; check-in yapmamış takım için reddedilir |
| WS | `/live` | — | `{type:'phase'}`, `{type:'lap', race}`, `{type:'result', result}` |

### Lobi ve slot (Faz 2 — hepsi `Authorization: Bearer <token>` ister)

| Yöntem | Yol | Gövde | Açıklama |
|---|---|---|---|
| GET | `/slots` | — | Hesabın beş slotu, dolu olanların lobi/takım özeti |
| POST | `/slots/unlock` | `slotIndex` | 4. ya da 5. slotu 250 Altına açar; yetmezse `402 insufficient_gold` |
| POST | `/lobby/create` | `region?, visibility?, aiDifficulty?, rankMin?, rankMax?, guestsCanInvite?, midSeasonJoin?` | Lobi kurar, 11 koltuğu AI olarak yazar. **Slot harcanmaz** |
| POST | `/lobby/quick-match` | `exclude?: lobbyId[]` | Tek bir önizleme kartı; havuz boşsa `{candidate: null}` (taze lobi aç) |
| POST | `/lobby/join` | `lobbyId, teamKey, slotIndex?` | Takımı al — **slot tam burada harcanır** |
| GET | `/lobby?id=` | — | Lobinin koltuk listesi; özel lobiyi yalnızca içindekiler görür |
| POST | `/lobby/invite` | `lobbyId, nickname` | Tam `Takma#1234` etiketiyle davet; kısmi arama yok |
| GET | `/invites` | — | Bekleyen davetler ve o an boş takımlar |

Kurucusu takım seçmemiş lobi hiçbir havuzda görünmez (§3.2). Bir önizleme
kartının gösterdiği insan/AI sayıları ve boş takım listesi **gerçek koltuk
satırlarıdır** — sahte doluluk üretilmez (§3.4).

Faz akışı: `open → checkin (T−5dk) → live (T) → result → open (sonraki tur)`.
Check-in yapmayan takımı motor `managed: 'assistant'` ile koşturur; kimsenin
üstlenmediği takımlar AI'dır.

## Dağıtım

`railway.json` hazır: `railway up` ile deploy edilir; `PORT` Railway
tarafından verilir. İstemcide Race Week → Online Lig kartına sunucu adresini
yaz.

Kalıcılık yok: süreç yeniden başlarsa lig sıfırlanır. Sıradaki iş Postgres.
