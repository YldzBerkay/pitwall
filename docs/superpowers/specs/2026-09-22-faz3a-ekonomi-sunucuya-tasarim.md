# Faz 3a — Para ve Zamanlayıcıların Sunucuya Taşınması · Tasarım

> Tarih: 2026-09-22 · Durum: onaylandı, uygulama bekliyor
> İlgili: [çok oyunculu kabuk](2026-09-19-cok-oyunculu-kabuk-tasarim.md) §1.1, §7 ·
> [ekonomi tasarımı](2026-09-19-ekonomi-tasarim.md) · [FEATURES.md](../../FEATURES.md)

Çok oyunculu kabuğun §1.1'i "sunucu otoritedir" diyor. Faz 1 kimliği, Faz 2
lobiyi getirdi; ekonomi hâlâ telefonda. Bu belge onun ilk ve en kritik
parçasını taşır: **para ve zamanlayıcılar**.

---

## 1. Neden şimdi ve neden bu parça

Bugün ekonominin tamamı istemcide ve bütün zamanlayıcılar `Date.now()`
üzerinde çalışıyor:

| Ne | Nerede | Sömürü |
|---|---|---|
| RP, Altın, günlük tavanlar | `store/slices/economySlice.ts` | Değeri doğrudan değiştir |
| Fabrika seviyeleri | `store/gameStore.ts` | Aynı |
| Araç geliştirme (22 saat) | `gameStore.ts` · `build.endsAt = Date.now() + …` | **Cihaz saatini ileri al** |
| Sürücü antrenmanı (6 saat) | `slices/driverSlice.ts` · aynı desen | Aynı |
| Casus görevi (24 saat) + soğuma | `slices/espionageSlice.ts` · aynı desen | Aynı |

Lobi rakipleri gerçek insanlar. Cihaz saatini ileri alan bir oyuncu 22 saatlik
geliştirmeyi saniyede bitirir ve ligi anlamsızlaştırır. Bu, çok oyunculuda
kapatılması zorunlu ilk kapı — kadro ve sponsor sistemlerinden önce gelir.

---

## 2. Kapsam

> **Uygulama notu (2026-09-22):** Bu belge yazılırken Faz 2'nin lobilerde
> yarış koşturduğu varsayılmıştı. Kod okunduğunda öyle olmadığı görüldü:
> `lobbies` tablosunda `phase`, `round_no`, `next_race_at` kolonları var ama
> **hiçbir kod bunları ilerletmiyor**; `lobby/schedule.ts` yalnızca "bir
> sonraki yarış ne zaman" hesaplıyor. Çalışan tek yarış hâlâ Faz 0'dan kalan
> tek global `League` sınıfı (bellekte, `setTimeout` ile).
>
> Bu yüzden faz ikiye bölündü. Aşağıdaki her şey geçerlidir; yalnızca **ne
> zaman** yapıldığı değişti.

### 3a-1 — ekonomi durumu ve zamanlayıcılar (bu planın konusu)

`shared/` paketi · `lobby_economy` · RP ve Altın · fabrika seviyeleri · araç
geliştirme, sürücü antrenmanı ve casusluk için claim modeli · ödüllü reklam ve
mağaza doğrulaması · günlük tavanlar · takım değeri hesabı · eylem ucu.

**Hile kapısını kapatan iş budur** ve yarış koşucusuna bağlı değildir.

### 3a-2 — lobi yarış koşucusu ve muhasebe

Lobi başına faz ilerlemesi ve yarış koşumu · lobi başına WS odası · check-in ve
pit çağrısı · yarış muhasebesi (ödül, sponsor ücreti, brifing bonusu) · parc
fermé / pit yolu başlangıcı (§6) · `Track.pitLaneSec` · **eski ligin
kaldırılması** (`server/src/league.ts` ve `/join`, `/weekend`, `/checkin`,
`/pit` uçları).

Koşucunun dayanıklılık kararı şimdiden alındı: **veritabanı otoritedir.**
Gerçek durum `lobbies.phase` ve `next_race_at`'te durur; sunucu kısa
aralıklarla "vakti gelmiş lobiler" sorgusu koşturup fazı ilerletir. Yeniden
başlatma hiçbir şey kaybettirmez, geç kalınan yarış açılışta hemen koşar, çok
kopyada `for update skip locked` ile tek kopya alır. Bellekte `setTimeout`
tutan mevcut desen taşınmaz.

### 3a-1'in dürüst sınırı

3a-1 bittiğinde lobi ekonomisi kalıcı, sunucu otoriteli ve hileye kapalı olur;
oyuncu RP harcayabilir, geliştirme başlatıp claim edebilir, Altın alabilir.
Ama **kazanç döngüsü kapanmaz** — RP'nin ana kaynağı yarış ödülü ve sponsor
ücretidir, onlar 3a-2'de bağlanır. 3a-1'de lobi ekonomisi başlangıç RP'siyle
ve Altın→RP dönüşümüyle beslenir.

**Ayrı spec'ler:** kadro, sözleşme, transfer ve personel (**3b**) · sponsor
sözleşmeleri ve sezon muhasebesinin tamamı (**3c**).

**Kaldırılıyor (3a-1'de):** çevrimdışı oyun — hesap ve internet zorunlu olur.

**Kapsam dışı ama bu fazın veri ürettiği:** sezon sonu özeti ve arşiv ekranı
(Faz 4). Bu faz yalnızca o ekranın okuyacağı sayıları doğru üretmekle
yükümlüdür — §9.

### 2.1 Çevrimdışı modu kapatmanın maliyeti sıfır

`gameStore.ts`'in `partialize`'ı bugün **yalnızca** ayar tercihlerini ve hesap
oturumunu saklıyor; kariyer, yarış ve ekonomi durumu oturumla birlikte
gidiyor. Yani uygulama kapanınca ilerleme zaten siliniyor. Taşınacak yerel
kayıt yok, göç yolu gerekmiyor.

---

## 3. Otorite modeli

**Tek eylem ucu.** `POST /lobby/:lobbyId/action` gövdesi `{type, ...}` alır.
Sunucu doğrular, uygular ve **o slotun tüm ekonomi durumunu** döner:

```
{ serverNow, rp, gold, factory, car, pendingJobs[], spy, caps, teamValue }
```

İstemci hiçbir türetme yapmaz — gelen durumu çizer. Granular uçlar yerine bu
seçildi çünkü kısmi güncelleme kaçırmak, iki tarafın yuvarlaması ayrışmak ve
ekranın tutarsız kalması yapısal olarak imkânsız hale geliyor. Slot durumu
birkaç KB; maliyeti kabul edilebilir.

**Saat.** Her yanıt `serverNow` taşır. İstemci geri sayımı kendi saatinden
değil, `serverNow` ile yerel saat arasındaki farkı bir kez ölçüp ondan
hesaplar. Cihaz saatini ileri almak hiçbir şey kazandırmaz.

**Eylem listesi (3a):**

| type | Etki |
|---|---|
| `startUpgrade` | Araç geliştirme işi başlatır (stat, süre, RP maliyeti) |
| `claimUpgrade` | Biten geliştirmeyi araca işler |
| `skipUpgrade` | Kalan süreyi Altınla satın alır |
| `startTraining` | Sürücü antrenmanı başlatır |
| `claimTraining` | Biten antrenmanı sürücüye işler |
| `skipTraining` | Kalan süreyi Altınla satın alır |
| `startSpyMission` | Casus görevi başlatır |
| `claimSpyReport` | Biten raporu okur, istihbaratı uygular |
| `skipSpy` | Kalan süreyi Altınla satın alır |
| `upgradeFactory` | Fabrika departmanı seviyesi yükseltir |
| `convertGoldToRp` | Günlük tavan içinde Altın→RP |

Bilinmeyen `type` → `400 unknown_action`. Yetersiz kaynak, dolu iş yuvası,
soğuma süresi gibi her ret kendi kodunu döner; hiçbiri 500 olmaz.

---

## 4. Formüller `shared/` paketine çıkıyor

Sunucu bugün `tsconfig` üzerinden `../mobile/src/data/**` import ediyor. Bu,
sunucunun mobil uygulamanın kaynak ağacına uzanması demek: mobilde yapılan bir
yeniden düzenleme sunucuyu sessizce kırabilir.

Saf formüller ve sabitler `shared/` altına taşınır; `mobile` ve `server` ikisi
de oradan okur:

```
shared/
  economy.ts      ECONOMY_SCALE, RP/Altın kurları, günlük tavanlar
  factory.ts      seviye maliyetleri, factoryEffects
  espionage.ts    süreler, başarı oranları, maliyetler
  season.ts       kış reseti, yaşlanma
  raceEngine.ts   yarış motoru (sunucu koşturur, istemci çizer)
  tracks.ts, teams.ts, driverMarket.ts, achievements.ts, …
```

Kural: `shared/` **saf** kalır — I/O yok, `Date.now()` yok, rastgelelik yalnızca
açıkça verilen tohumla. Zaman ve rastgelelik çağıranın sorumluluğu; sunucu
`now()` ve tohumu verir, test sabit verir.

`npm run econ` denge kapısı `shared/`'ı hedefler.

---

## 5. Zamanlayıcılar — claim modeli

### 5.1 Kural

**Ekonomiye yazan tek şey claim'dir.** `ends_at`'in geçmesi bir durum
değişikliği değil, yalnızca bir eşiktir. Oyuncu `claimUpgrade` göndermeden
araç değişmez, `claimTraining` göndermeden sürücü gelişmez.

```sql
create table pending_jobs (
  id          uuid primary key default gen_random_uuid(),
  lobby_id    uuid not null references lobbies(id) on delete cascade,
  team_key    text not null,
  kind        text not null,          -- upgrade | training | spy
  payload     jsonb not null,         -- stat, driverIdx, hedef takım …
  started_at  timestamptz not null default now(),
  ends_at     timestamptz not null,
  claimed_at  timestamptz,
  notified_at timestamptz
);
create index on pending_jobs (lobby_id, team_key) where claimed_at is null;
create index on pending_jobs (ends_at) where claimed_at is null and notified_at is null;
```

Claim tek transaction'da koşar: `now() >= ends_at` ve `claimed_at is null`
doğrulanır, sonuç yazılır, `claimed_at` damgalanır. İkinci claim `claimed_at`
dolu olduğu için hiçbir şey yapmaz — **idempotent**. Ağ tekrarı, çift dokunuş
ve yeniden gönderim zararsız.

### 5.2 Bildirim ekonomiye dokunmaz

Zamanlanmış görev yalnızca
`ends_at <= now() AND claimed_at IS NULL AND notified_at IS NULL` satırlarını
bulur, push gönderir ve `notified_at` damgalar. **Ekonomiye tek bir yazma
yapmaz.**

Bu ayrım zamanlanmış görevi tehlikesiz kılar: iki kopya aynı anda koşsa en kötü
ihtimalle bir bildirim iki kez gider. Kilitleme, birikmiş iş kuyruğu ve çifte
uygulama koruması gerekmez — çünkü uygulayacak bir şeyi yoktur.

Sunucu günlerce kapalı kalsa bile açıldığında ilk okumada doğru sonuç çıkar:
hesap `ends_at` ile `now()` arasındaki farktan geliyor, kaçırılmış bir tike
bağlı değil.

### 5.3 Claim kapsamı

| İş | Claim ister mi | Gerekçe |
|---|---|---|
| Araç geliştirme (22 saat) | ✅ | Stat artışı claim anında işler |
| Sürücü antrenmanı (6 saat) | ✅ | Sürücü statı claim anında artar |
| Casus raporu (24 saat) | ✅ | Rapor okunana kadar istihbarat işlemez |
| Yarış ödülü, sponsor ücreti, brifing bonusu | ❌ | Yarış biter bitmez sunucu yazar |

Son satır kasıtlı: oyuncu uygulamayı hiç açmasa da yarış kazancı işler.
Ekonomiyi "giriş yapma" şartına bağlamak, çalışmayan bir lig üretirdi.

---

## 6. Parc fermé ve pit yolu başlangıcı

### 6.1 Üç kademe

Yarış saatinde bir işin durumu aracı şöyle etkiler:

| İşin durumu | Araca etkisi | Başlangıç |
|---|---|---|
| **Devam ediyor** | Pişen stat yarıya iner, DNF riski ×2 *(mevcut `crippleSetup`, `CRIPPLED_DNF_SCALE`)* | Normal grid |
| **Bitti, claim edilmedi** | **Geliştirme tam olarak işler** | **Pit yolu** |
| **Bitti, claim edildi** | Tam işler | Normal grid |

Orta satır gerçek F1 kuralının ta kendisidir: sıralama turlarından sonra araca
dokunmak parc fermé ihlalidir ve cezası pit yolundan başlamaktır. Geliştirme
**sayılır** — ihlalin tanımı zaten aracı değiştirmiş olmandır — ama grid yerini
kaybedersin.

Mevcut "devam eden geliştirme aracı sakatlar" mekaniği **kalır**; yeni kural
onun yerine değil, üstüne gelir ve kademe tamamlanır.

### 6.2 Ceza kapsamı: neye dokunulduysa o

- **Araç geliştirmesi** şasiye işler → takımın **iki aracı da** pit yolundan
  başlar.
- **Sürücü antrenmanı** tek sürücüyü ilgilendirir → **yalnızca o araç** pit
  yolundan başlar.
- **Casus raporu** araca dokunmaz → ceza yok, yalnızca istihbarat işlemez.

İki araç da cezalıysa aralarındaki sıralama sıralama turu sonucunu korur.

### 6.3 Modelleme

Gerçekte araç grid yerini almaz; pit çıkışında bekler, yarış kontrolü pit
çıkışını **saha geçtikten sonra** açar ve araç sonda katılır. Bu, gridde
sonuncu başlamaktan daha kötüdür: kalkış tamamen kaybedilir ve pakete birkaç
saniye geriden başlanır.

Motorda (`shared/raceEngine.ts`) grid satırları `GRID_GAP_SEC = 0.35` ile
aralanıyor; 22 araç ~7,4 saniyeye yayılıyor. Pit yolu başlangıcı:

- araç sıralama sonucundaki yerini **almaz**, sahanın tamamının arkasına
  yerleşir;
- üstüne ek bir ilk tur boşluğu alır;
- karşılığında **serbest lastik seçimi** kazanır.

Ek boşluk piste göre değişir. `Track` bugün pit yolu uzunluğu taşımıyor;
bu faz ona `pitLaneSec` alanı ekler — pit yolundan geçmenin normal tura göre
maliyeti, saniye cinsinden. Aynı alan ileride pit stop modelini de
gerçekçileştirmek için kullanılabilir, ama bu fazda yalnızca pit yolu
başlangıcını besler. Her pist için değer, mevcut pist verisinin karakterine
(sokak/hız pisti) göre verilir ve `npm run econ` ile kalibre edilir.

Serbest lastik gerçek telafinin oyundaki karşılığıdır. Araştırmanın en önemli
bulgusu şudur: **pit yolu başlangıcı saf ceza değil, takastır.** Takımlar bunu
bazen bilerek seçer, çünkü parc fermé'yi zaten ihlal ettikleri için aracı
yarışa göre kurabilirler. Oyunda da geliştirmeyi son ana bırakmak bir hata
değil, bilinçli bir kumar olabilmelidir.

Ek boşluğun tam değeri `npm run econ` ile kalibre edilir; hedef, iyi bir araçla
toparlanabilir ama yarışı büyük olasılıkla kaybettiren bir bedel.

---

## 7. Altın, RP ve musluklar

| Birim | Kapsam | Nerede |
|---|---|---|
| **Altın** | Hesap | `users.gold` (şema Faz 1'den hazır) |
| **RP** | Tek lobi | `lobby_economy.rp` |
| **Rütbe puanı** | Hesap | `users.rank_points` |

RP lobiden lobiye taşınmaz (kabuk spec'i §1.2).

### 7.1 Musluklar sunucuda doğrulanır

- **Ödüllü reklam:** AdMob **sunucu-taraflı doğrulama (SSV)** callback'i.
  Google'ın imzaladığı callback'i sunucu doğrular ve Altını o zaman yazar.
  İstemcinin "reklam izledim" demesi hiçbir şey yapmaz.
- **Mağaza satın alımı:** App Store / Play makbuzu sunucuda doğrulanır; Altın
  doğrulama sonrası yazılır. Makbuz `purchase_token` ile tekilleştirilir, aynı
  makbuz iki kez Altın üretemez.
- **Günlük tavanlar** (reklam sayısı, Altın→RP dönüşümü) sunucuda tutulur,
  hesap seviyesinde ve sunucu gününe göre.

Bu olmadan Altını sunucuya taşımak tiyatro olurdu: en değerli para birimi
istemcinin beyanıyla üretilmeye devam ederdi.

---

## 8. Yarış muhasebesi

Lobi takvimi yarışı koşturur; sonuç çıktığı anda **aynı transaction'da** tüm
koltukların RP'si yazılır: yarış ödülü, sponsor ücreti, brifing bonusu.

Yarış başlamadan hemen önce sunucu, o lobinin tüm takımları için biten ama
claim edilmemiş işleri değerlendirir (§6) ve ızgarayı ona göre kurar. Böylece
oyuncu uygulamayı hiç açmasa bile geliştirmesi yarışa yetişir — bedeli pit
yolu başlangıcıdır, kaybı değil.

---

## 9. Takım değeri ve sezon anlık görüntüsü

Sunucu slot durumunda `teamValue` döner: sürücülerin güncel piyasa değeri +
fabrika seviyelerinin kümülatif maliyeti + araç puanının primi, hepsi
`ECONOMY_SCALE` üzerinden. Tek bir yerde hesaplanır (`shared/`), istemci
türetmez.

Sezon bittiğinde bu faz, arşivin ihtiyaç duyacağı sayıları **kaybetmeyecek
şekilde** tutar: sezon sonu RP'si, takım değeri, fabrika seviyeleri, nihai
sıralama ve hedef tutturma durumu. Arşiv tablosu ve sezon sonu ekranı **Faz
4'ün** işidir; bu faz yalnızca verinin doğru ve toplanabilir olmasından
sorumludur.

Gerekçe: arşivin göstereceği "toplam takım fiyatı" ekonomiden türeyen bir
sayıdır. Ekonomi sunucuya taşınırken bu hesap sunucuda doğmazsa, Faz 4'ün
gösterecek güvenilir bir rakamı olmaz.

---

## 10. Çevrimdışı davranış

Son slot durumu cihazda önbelleklenir. Bağlantı yokken:

- kadro, fabrika, sayaçlar ve takım değeri **görünür**;
- **hiçbir eylem yapılamaz** — eylem butonları kapalı, üstte "çevrimdışı"
  şeridi;
- sayaçlar son bilinen `serverNow` farkından akmaya devam eder, ama biten iş
  claim edilemez.

Metroda açılan uygulama boş ekran göstermez; hile kapısı da açılmaz.

---

## 11. Veri modeli

```
lobby_economy    lobby_id, team_key, rp, factory_levels jsonb,
                 car jsonb, spy_state jsonb, updated_at
                 PRIMARY KEY (lobby_id, team_key)

pending_jobs     §5.1

gold_grants      id, user_id, source (ad|iap), external_id,
                 gold, granted_at
                 UNIQUE (source, external_id)   -- aynı makbuz/callback iki kez yazamaz

daily_caps       user_id, day date, ads_watched, gold_converted
                 PRIMARY KEY (user_id, day)
```

`lobby_economy` satırı, oyuncu takımı seçtiği anda (Faz 2'deki koltuk atama
transaction'ı içinde) yazılır. AI koltukları da satır alır — yarış motorunun
okuduğu tek kaynak burasıdır.

---

## 12. Sunucu yapısı

**3a-1:**

```
server/src/
  economy/
    repo.ts        lobby_economy okuma/yazma
    jobs.ts        pending_jobs: başlat, claim, atla
    actions.ts     eylem yönlendirmesi ve doğrulama
    value.ts       takım değeri
    state.ts       slot durumu yanıtının kurulması (serverNow dahil)
    routes.ts      POST /lobby/:id/action
  gold/
    ssv.ts         AdMob callback doğrulaması
    receipts.ts    mağaza makbuzu doğrulaması
    repo.ts        users.gold, gold_grants, daily_caps
  notify/
    scheduler.ts   biten işleri tarar, push gönderir, ekonomiye dokunmaz
```

**3a-2:** `economy/settle.ts` (yarış sonrası muhasebe) ve `lobby/runner.ts`
(faz ilerlemesi, yarış koşumu) eklenir; `server/src/league.ts` ve ona ait
uçlar o fazda silinir.

---

## 13. Doğrulama

`npm run econ` sunucu ekonomisine karşı koşar ve geçmelidir.

Ayrıca bu fazın kapattığı kapıları **kanıtlayan** testler:

**3a-1:**

1. Cihaz saati ileri alınmış bir istemcinin hiçbir şey kazanamadığı — istemci
   `serverNow`'u yok sayıp erken claim gönderdiğinde sunucu reddeder.
2. Aynı claim'in iki kez gönderilmesinin ikinci kez etkisiz olduğu.
3. Aynı AdMob callback'inin / mağaza makbuzunun iki kez Altın yazamadığı.
4. Günlük tavanların sunucu gününe göre işlediği ve istemcinin gün değiştirerek
   aşamadığı.
5. Bildirim görevinin ekonomiye hiçbir şey yazmadığı — iki kez koşturulduğunda
   `lobby_economy` ve `users.gold` bit bazında aynı kalır.

**3a-2:**

6. Claim edilmemiş biten geliştirmenin yarışta pit yolu başlangıcı ürettiği ve
   geliştirmenin **yine de** araca işlendiği.
7. Devam eden geliştirmenin hâlâ aracı sakatladığı (mevcut davranış korunuyor).

Her biri için önce kuralı bozup testin düştüğü görülür, sonra geri alınır —
yeşil ama hiçbir şey kanıtlamayan test kabul edilmez.

---

## 14. Uygulama sırası

### 3a-1 (bu planın konusu)

| Adım | İçerik | Kapı |
|---|---|---|
| **1** | `shared/` paketi: formüller taşınır, `mobile` ve `server` oradan okur | `npm run econ` ve iki tarafın typecheck'i temiz |
| **2** | `003_economy.sql` + `lobby_economy` + koltuk atamaya bağlanması | AI dahil her koltuğun satırı var |
| **3** | `pending_jobs` + başlat/claim/atla + idempotency | Çift claim testi |
| **4** | Eylem ucu ve slot durumu yanıtı (`serverNow` dahil) | Saat ileri alma testi |
| **5** | Altın: SSV, makbuz, günlük tavanlar | Çift callback testi |
| **6** | Takım değeri ve sezon anlık görüntüsü verisi | Tek kaynaktan hesaplanıyor |
| **7** | Bildirim görevi (ekonomiye dokunmaz) | Çift koşumda ekonomi değişmiyor |
| **8** | İstemci: salt-okunur önbellek, eylem çağrıları, çevrimdışı şeridi | Uçtan uca gerçek sunucuya karşı |

### 3a-2 (ayrı plan)

| Adım | İçerik |
|---|---|
| **1** | Lobi faz ilerlemesi: veritabanı otoriteli periyodik tarama, `for update skip locked` |
| **2** | Lobi başına yarış koşumu ve WS odası |
| **3** | Check-in ve pit çağrısının lobiye taşınması |
| **4** | Yarış muhasebesi: ödül, sponsor ücreti, brifing bonusu |
| **5** | Parc fermé / pit yolu başlangıcı + `Track.pitLaneSec` |
| **6** | Eski ligin kaldırılması |

Her adım çalışan bir oyun bırakır.

---

## 15. Kapsam dışı

- Kadro, sözleşme, transfer, personel (Faz 3b)
- Sponsor sözleşmeleri ve sezon muhasebesinin tamamı (Faz 3c)
- Sezon sonu özeti ekranı ve arşiv tablosu (Faz 4) — veri bu fazda üretilir
- Ayrılma cezası (Faz 4) · arkadaş sistemi (Faz 5)
- Google/Apple/Facebook'un mobil istemciye bağlanması (native SDK)
