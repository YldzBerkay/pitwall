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

### Üretici script'ler — asla elle düzenlenmez

- `npm run gen:countries` → `src/identity/countries.ts` (endonym ülke listesi,
  CLDR verisinden üretilir)
- `npm run gen:ip-region` → `src/identity/ip-region-v4.bin` (RIR tahsis
  dosyalarından üretilen /16 IP→bölge tablosu)

Her iki dosya da **ÜRETİLMİŞTİR** — elle düzenlemeyin, ilgili script'i
çalıştırıp çıktıyı commit'leyin.

## Uç noktalar

| Yöntem | Yol | Gövde | Açıklama |
|---|---|---|---|
| GET | `/state` | — | Faz, ışık saati, check-in açılışı, pist, tablo, takımlar |
| POST | `/join` | `teamKey, managerId` | Takımı üstlen; dolu koltuk `taken` |
| POST | `/weekend` | `teamKey, managerId, setup?, tactics?, risk?, reliability?` | Hafta sonu seçimleri (yarış canlıyken reddedilir) |
| POST | `/checkin` | `teamKey, managerId` | Sadece `checkin` fazında; yoksa `closed` |
| POST | `/pit` | `teamKey, managerId, driverIdx, compound\|null` | Sonraki tur için pit çağrısı; check-in yapmamış takım için reddedilir |
| WS | `/live` | — | `{type:'phase'}`, `{type:'lap', race}`, `{type:'result', result}` |

Faz akışı: `open → checkin (T−5dk) → live (T) → result → open (sonraki tur)`.
Check-in yapmayan takımı motor `managed: 'assistant'` ile koşturur; kimsenin
üstlenmediği takımlar AI'dır.

## Dağıtım

`railway.json` hazır: `railway up` ile deploy edilir; `PORT` Railway
tarafından verilir. İstemcide Race Week → Online Lig kartına sunucu adresini
yaz.

Kalıcılık yok: süreç yeniden başlarsa lig sıfırlanır. Sıradaki iş Postgres.
