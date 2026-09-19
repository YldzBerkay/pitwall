# Pit Wall Infrastructure

## Local Services

Pit Wall v2 uses PostgreSQL for relational game state and Redis for short-lived OpenF1 cache, live polling cache, leaderboard materialization, and future push/lock jobs.

```bash
npm install
docker compose up -d
npm run db:migrate
npm run db:seed
npm run dev
```

Services:

| Service | Local URL | Purpose |
|---|---|---|
| Backend API | http://localhost:3000/api | Express API |
| Frontend | http://localhost:4200 | Angular SSR app |
| PostgreSQL | localhost:5432 | Users, leagues, teams, predictions, scores |
| Redis | localhost:6379 | OpenF1 cache, leaderboard/live-session foundation |

## Environment

Required production variables:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Railway PostgreSQL connection string |
| `REDIS_URL` | Railway Redis connection string |
| `FRONTEND_URL` | Public frontend origin for CORS/session cookies |
| `SESSION_SECRET` | Secure Express session secret |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth |
| `OPENF1_BASE_URL` | Defaults to `https://api.openf1.org/v1` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push notification foundation |

## CI/CD

GitHub Actions runs:

1. `npm ci`
2. `npm run db:migrate`
3. `npm run db:seed`
4. `npm test`
5. `npm run build`

Railway uses `railway.json`:

1. Build: `npm ci && npm run build`
2. Start: `npm run db:migrate && npm run db:seed && npm run start -w backend`

Provision Railway PostgreSQL and Redis plugins, then set the variables above.

## Database Verification Gate

Before adding API endpoints against a new schema slice, run the database path against a real PostgreSQL instance:

```bash
docker compose up -d
npm run db:migrate
npm run db:seed
```

Then verify the invariants that protect league-season manager creation:

```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename IN ('seasons', 'game_sessions')
  AND indexdef LIKE '%WHERE%';

SELECT name, base_motor, base_aero, base_grip, base_durability, base_budget
FROM constructors;
```

## Commissioner Model

Leagues use `owner_user_id` as the commissioner/creator pointer. `league_members.role` controls membership permissions with `admin` and `player` roles. Commissioner-only actions, such as starting a league season, should require either `leagues.owner_user_id = current_user.id` or an `admin` league member row.

## Faz 1a dağıtımı — `server/` (Railway)

`server/` altındaki Node/TypeScript lig sunucusunun ve Postgres tabanlı kimlik
katmanının Railway'e dağıtımı için hazırlık notları. Bu bölüm hiçbir sırrı
üretmez; Railway konsolunda yapılması gereken adımları ve kodun okuduğu ortam
değişkenlerini belgeler.

### Ortam değişkenleri

`src/index.ts` ve içe aktardığı modüller şu değişkenleri okur (kaynak:
`server/src` üzerinde `process.env` grep'i ile doğrulandı):

| Değişken | Kaynak | Zorunlu mu | Yanlış/eksikse ne kırılır |
|---|---|---|---|
| `DATABASE_URL` | `src/db/pool.ts` | Evet | Yoksa `getPool()` hemen `Error` fırlatır; migration'lar ve tüm kimlik uçları çalışmaz. Railway Postgres eklentisi bunu otomatik enjekte eder |
| `SESSION_SECRET` | `src/auth/jwt.ts` | Evet, 32+ karakter | Eksik veya 32 karakterden kısaysa `secret()` fırlatır; oturum imzalama/doğrulama tamamen durur (`/auth/*` ve `/me`) |
| `EMAIL_HASH_PEPPER` | `src/auth/emailHash.ts` | Evet | Yoksa `hashEmail()` fırlatır; e-posta+şifre kaydı/girişi ve sosyal girişte e-posta ile hesap eşleme çalışmaz |
| `GOOGLE_CLIENT_IDS` | `src/auth/providers/google.ts` | Hayır (yoksa Google girişi kapalı) | Boşsa `configuredAudiences()` boş döner, `verifyGoogleToken` her zaman `null` döner — Google ile giriş sessizce reddedilir |
| `APPLE_BUNDLE_IDS` | `src/auth/providers/apple.ts` | Hayır (yoksa Apple girişi kapalı) | Aynı desen: boşsa Apple ile giriş her zaman reddedilir |
| `FACEBOOK_APP_ID` | `src/auth/providers/facebook.ts` | Hayır (yoksa Facebook girişi kapalı) | `FACEBOOK_APP_SECRET` ile birlikte eksikse `verifyFacebookToken` erken `null` döner |
| `FACEBOOK_APP_SECRET` | `src/auth/providers/facebook.ts` | Hayır (yoksa Facebook girişi kapalı) | Yukarıdakiyle aynı |
| `PG_POOL_MAX` | `src/db/pool.ts` | Hayır (varsayılan `10`) | Yanlış/parse edilemeyen bir değer `NaN`'a düşer; havuz boyutu etkin biçimde sınırsız/garanti dışı davranır — sayısal bir değer ver |
| `PORT` | `src/index.ts` | Hayır (varsayılan `8787`) | Railway kendi `PORT`'unu enjekte eder; elle ayarlamaya gerek yok |
| `TICK_MS` | `src/index.ts` (`League`) | Hayır (varsayılan `2500`) | Lig motorunun tur/adım sıklığını değiştirir; yanlışsa yarış hızı bozulur |
| `CHECKIN_SECONDS` | `src/index.ts` (`League`) | Hayır (varsayılan `300`) | Check-in penceresinin uzunluğu; yanlışsa takımlar check-in yapamadan pencere kapanır/açık kalır |
| `INTERVAL_SECONDS` | `src/index.ts` (`League`) | Hayır (varsayılan `86400`) | İki yarış arası süre; yanlışsa lig takvimi kayar |
| `RACE_IN_SECONDS` | `src/index.ts` (`League`) | Hayır (varsayılan `3600`) | Boot sonrası ilk yarışa kalan süre; yanlışsa ilk yarış beklenmedik anda başlar |

İki sır için üretim komutları (kullanıcı kendi terminalinde çalıştırır, buraya
değer yazılmaz):

```bash
# SESSION_SECRET
openssl rand -base64 48

# EMAIL_HASH_PEPPER
openssl rand -base64 32
```

### En kritik üç uyarı

1. **`EMAIL_HASH_PEPPER` asla döndürülmemeli.** Hesaplar, doğrulanmış
   e-postanın biberli (peppered) bir hash'i üzerinden sağlayıcılar arasında
   bağlanır; ham adres hiçbir zaman saklanmaz. Pepper'ı döndürmek mevcut
   *her* bağlantıyı öksüz bırakır — Google ile kayıt olup sonra Apple ile
   giriş yapan bir kullanıcı kendi hesabına değil, sıfırdan boş bir hesaba
   düşer. Bunun geri dönüşü yoktur; eski pepper'la üretilmiş hash'leri yeni
   pepper'a taşıyacak bir migration yolu da yoktur.
2. **`SESSION_SECRET` döndürülebilir.** Tek sonucu, mevcut tüm oturum
   token'larının doğrulanamaz hale gelmesidir — herkes oturumdan atılır ve
   yeniden giriş yapar. Bunu pepper ile karıştırmayın: biri (pepper) kalıcı
   veri bütünlüğünü etkiler ve geri dönüşsüzdür, diğeri (oturum sırrı) sadece
   geçici bir oturum durumunu etkiler ve zararsızca döndürülebilir.
3. **Migration'lar başlangıcı kilitler.** `runMigrations()`, `listen()`'dan
   önce çalışır; başarısız olursa süreç hatayı loglayıp `exit(1)` ile çıkar,
   Railway dağıtımı sağlıksız (unhealthy) olarak işaretler. Bu kasıtlıdır —
   yarı uygulanmış bir şema üzerinden asla servis vermeyiz. Bu şekilde
   başarısız olan bir dağıtım yeniden başlatma ile değil, migration'ı
   düzeltmekle çözülür.

### Sağlayıcı kimlik bilgileri kurulumu

- **`GOOGLE_CLIENT_IDS`**: Google Cloud Console → API'ler ve Hizmetler →
  Kimlik Bilgileri altında oluşturulan OAuth istemci ID'leri. iOS ve Android
  ayrı istemci ID'leridir; değişken virgülle ayrılmış birden çok değeri kabul
  eder (`ios-id,android-id`).
- **`APPLE_BUNDLE_IDS`**: Apple Developer hesabındaki uygulama bundle
  identifier'ı (birden çoksa yine virgülle ayrılmış liste).
- **`FACEBOOK_APP_ID`** / **`FACEBOOK_APP_SECRET`**: Meta for Developers
  üzerinde oluşturulan uygulamanın app id ve app secret'ı.

Bu değişkenlerden biri **ayarlanmazsa ilgili giriş yöntemi kapalı-güvenli
(fail closed) davranır** — o sağlayıcıyla gelen her girişi reddeder, hiçbir
şeyi kabul etmez. Yani eksik bir sağlayıcı yapılandırması sisteme zarar
vermez ama sessizce devre dışı kalır; dağıtımdan sonra her yöntemi tek tek
denemek gerekir.

### Postgres

Railway projesine "PostgreSQL" eklentisi eklendiğinde `DATABASE_URL` sunucu
servisine otomatik enjekte edilir — elle girmeye gerek yoktur. Havuz
(`src/db/pool.ts`), bağlantı adresinin ayrıştırılmış host adı `localhost`
olmayan her durumda TLS'i `{ rejectUnauthorized: false }` ile açar, çünkü
Railway'in yönetilen Postgres'i kendi CA'sıyla imzalanmış bir sertifika
sunar.

### Dağıtım sonrası doğrulama

Railway'in verdiği alan adı üzerinden:

```bash
# Lig hâlâ ayakta mı
curl https://<railway-domain>/state

# Kimlik katmanı ayakta mı — takma ad önerileri ve ülke listesi döner
curl https://<railway-domain>/onboarding/bootstrap
```

`/onboarding/bootstrap` yanıtındaki `suggestedRegion` alanı, çağıranın IP
adresine bağlı olarak `null` gelebilir — bu normaldir, bir hata değildir.

### Devreye alma kontrol listesi (Railway konsolunda, sırayla)

1. Railway'de yeni bir servis oluştur, bu repodaki `server/` dizinini kaynak
   olarak bağla (NIXPACKS otomatik algılanır, `railway.json` build/start
   komutlarını ve sağlık kontrolünü zaten tanımlıyor).
2. Projeye **PostgreSQL** eklentisini ekle; bu `DATABASE_URL`'i otomatik
   enjekte eder.
3. Yukarıdaki komutlarla `SESSION_SECRET` ve `EMAIL_HASH_PEPPER`'ı kendi
   terminalinde üret, servis değişkenleri olarak Railway konsolundan gir.
4. Kullanılacak sosyal giriş sağlayıcıları için `GOOGLE_CLIENT_IDS`,
   `APPLE_BUNDLE_IDS`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`
   değişkenlerini gir (hangileri atlanırsa o yöntemler kapalı-güvenli kalır).
5. Dağıtımı başlat ve Railway'in dağıtım günlüklerinden `runMigrations()`
   adımının başarıyla tamamlandığını doğrula.
6. Sağlık kontrolünün (`/state`) yeşile döndüğünü Railway panelinden
   doğrula.
7. Yukarıdaki `curl /state` ve `curl /onboarding/bootstrap` komutlarını
   gerçek alan adıyla çalıştırıp yanıtları gözle kontrol et.
8. Yapılandırdığın her sosyal giriş yöntemini (Google/Apple/Facebook) ve
   e-posta+şifre akışını uçtan uca bir kez dene.
