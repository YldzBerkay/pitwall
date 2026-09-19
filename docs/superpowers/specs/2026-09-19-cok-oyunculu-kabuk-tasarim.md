# Pit Wall — Çok Oyunculu Kabuk · Tasarım

> Tarih: 2026-09-19 · Durum: onaylandı, uygulama bekliyor
> İlgili: [ekonomi-tasarim.md](2026-09-19-ekonomi-tasarim.md) ·
> [FEATURES.md](../../FEATURES.md) · `server/src/league.ts`

Bu belge, tek oyunculu Pit Wall'ın üzerine gelen kimlik–lobi–slot–arkadaş
kabuğunu tanımlar. Yarış motoru, ekonomi formülleri ve padok sistemleri
değişmez; değişen şey **kimin, nerede, kaç tane oyun oynadığı**.

---

## 1. Temel kavram

Bugün tek oyunculu kayıt telefonda tutuluyor ve `server/src/league.ts` tek bir
global lig koşturuyor. Bundan sonra zincir şöyle:

```
Hesap ──< Slot ──1:1── Lobi (= bir lig sezonu = bir kayıt dosyası)
```

Oyuncu aynı anda **3** lobide takım yönetir; 4. ve 5. slotu Altınla açar.
Her lobinin kendi takvimi, kendi RP'si, kendi fabrikası, kendi kadrosu vardır.

### 1.1 Otorite

**Sunucu otoritedir.** Her slotun ekonomisi (RP, fabrika seviyeleri, kadro,
sözleşmeler, 22 saatlik geliştirme sayaçları, casus geri sayımı) Postgres'te
tutulur. İstemci eylem gönderir (`geliştirme başlat`, `sürücü al`), sunucu
doğrular ve yeni durumu döner. İstemci yalnızca çizer.

Gerekçe: lobi rakipleri gerçek insanlar. İstemci otoritesinde oyuncu
telefonundaki RP'yi değiştirip sınırsız geliştirme yapabilir — çok oyunculuda
kabul edilemez. Ayrıca sunucu otoritesi cihaz değiştirmede kayıp riskini ve
saat manipülasyonunu da ortadan kaldırır.

### 1.2 Para birimleri

| Birim | Kapsam | Taşınabilirlik |
|---|---|---|
| **Altın** | Hesap | Hesapta durur; slot ve hızlandırma satın alır |
| **RP** | Tek lobi | **Asla taşınmaz.** Lobiden lobiye aktarılamaz, hesaba çıkmaz, sezon sonunda buharlaşır |
| **Rütbe puanı** | Hesap | Lobiler kazandırır, hesapta birikir, rütbe kapılarını belirler |

RP'nin lobiye hapsedilmesi kasıtlıdır: aksi halde oyuncu kolay bir lobide RP
biriktirip zor bir lobiye aktarır, hem denge hem rekabet çöker.

### 1.3 Ekonomi kuralına istisna

`ekonomi-tasarim.md` "sadece Altın'la açılan hiçbir şey yok" diye söz veriyor.
**Slot bu kuralın açık istisnasıdır**: 4. ve 5. slot yalnızca Altınla alınır,
RP karşılığı yoktur — çünkü RP lobiye ait, slot hesaba ait; aralarında geçerli
bir kur kurulamaz.

Bu bir ödeme duvarı değildir: Altın ödüllü reklamla da kazanılır, dolayısıyla
slot ödeme yapmayan oyuncu için de ulaşılabilir. `ekonomi-tasarim.md`
bu istisnayı yazacak şekilde güncellenir.

---

## 2. Kimlik ve profil (Faz 1)

### 2.1 Giriş

Dört yöntem: **Google · Apple · Facebook · e-posta + şifre**.

- iOS'ta başka sosyal giriş sunulduğu için **Apple ile Giriş zorunludur**
  (App Store Review Guideline 4.8).
- Sunucu kendi JWT'sini üretir; sağlayıcı token'ı yalnızca doğrulamada
  kullanılır, saklanmaz.
- Aynı e-posta farklı sağlayıcılardan gelirse tek hesapta birleşir
  (`auth_identities` çoklu satır).

### 2.2 Nickname

Biçim: `taban#4hane` → `TurboKral#0417`.

- Tekillik **`(taban, hane)` çiftindedir**. `TurboKral#0417` ve
  `TurboKral#8823` ikisi de yaşayabilir.
- Hane `0001`–`9999` arasından **rastgele** verilir. Sıralı verilmez — sıralı
  hane kayıt sayısını ve hesap yaşını dışarı sızdırır.
- Bir taban için 9999 hanenin tamamı dolduğunda o taban 5 haneye geçer
  (`00001`–`99999`). Taban bazında bağımsızdır.
- Onboarding'de havuzdan 4 öneri sunulur. Oyuncu isterse kendi tabanını yazar.
- Custom taban: 3–16 karakter, harf/rakam/alt çizgi; küfür ve marka filtresi.
- **E-postadan isim türetilmez.**

Varsayılan taban havuzu (30):

```
TurboKral      ApexAvcısı      PitStopUsta     DriftBaron
RedFlagRider   ChequeredFlag   SlipstreamKing  GridHunter
PolePositionX  FastLapPro      VelocityWolf    RaceLineBey
OverTakeMachine BoxBoxLegend   HotLapHero      CircuitGhost
SafetyCarKral  TurboNitro      RaceCraftPro    GripMaster
DrsZone        FinishLineX     PaddockKing     TarmacTiger
CornerCutter   FullThrottleX   SpeedDemonTR    LightsOutGo
MidfieldWolf   ChampionshipRun
```

**Tahsis algoritması (yarış koşulsuz):** `INSERT ... ON CONFLICT DO NOTHING`
ile `(taban, hane)` benzersiz indeksine yazılır; çakışırsa yeni rastgele hane
ile yeniden denenir (en fazla 8 deneme), sonra taban için kullanılmayan hane
taranır, o da bittiyse hane genişliği artırılır.

### 2.3 Ülke

- ISO 3166-1 alpha-2 kodu.
- Bayraklar [`flag-icons`](https://github.com/lipis/flag-icons/tree/main/flags/1x1)
  1x1 SVG'lerinden alınır ve **derleme zamanında uygulama paketine gömülür**.
  Çalışma anında GitHub'dan veya herhangi bir CDN'den çekilmez.
- Ülke adı **kendi okunuşunda sabittir** ve uygulama diline göre değişmez:
  `Türkiye`, `Deutschland`, `日本`, `España`, `France`, `Ελλάδα`, `Italia`.
- Ülke yalnızca kimliktir — bayrak olarak profilde, lobide ve sonuç
  ekranlarında görünür. Eşleştirmeyi etkilemez.

### 2.4 Region ve KVKK/GDPR uyumu

Region, ülkeden **ayrı bir alandır** ve yarış saatini belirler.

Kovalar: `EU · NA · LATAM · MENA · APAC · SEA · OCE`

**Tespit:** Onboarding isteğinde sunucu, isteğin IP adresinden yalnızca kaba
region kovasını türetir ve yanıtta döner. Bu işlem sırasında:

- IP adresi **hiçbir tabloya yazılmaz**,
- erişim log'una da düşmez (log'lardan IP alanı kaldırılır),
- türetilen region yalnızca **öneri**dir; oyuncu onboarding ekranında onaylar
  veya değiştirir, saklanan tek şey oyuncunun seçtiği değerdir.

Cihaz locale'i, saat dilimi veya herhangi bir cihaz tanımlayıcısı okunmaz.

Hukuki dayanak: GDPR md. 6(1)(f) meşru menfaat (hizmetin coğrafi olarak
uygun sunulması). Saklanan kişisel veri olmadığı için silme/taşıma talebi
konusu oluşmaz. KVKK bakımından aynı gerekçe (md. 5/2-f) geçerlidir.

### 2.5 Profil

Nickname · bayrak · rütbe ve rütbe puanı · aktif oyun sayısı · sezon arşivi
(bitmiş sezonların takım, lobi, final sıralaması, hedef tutturma durumu).

---

## 3. Lobi ve eşleştirme (Faz 2)

### 3.1 Lobi kurma

Boş slot gerektirir; ek Altın harcanmaz (slot zaten oyuncunun). Kurucu ayarlar:

| Ayar | Değerler | Notu |
|---|---|---|
| Region | EU / NA / LATAM / MENA / APAC / SEA / OCE | Günlük yarış saati buradan türer (örn. EU → 21:00 CET) |
| Görünürlük | Herkese açık / Özel | Açıksa hızlı ara havuzuna girer |
| AI zorluğu | Kolay / Normal / Zor | §3.4 |
| Rütbe kapısı | min–max rütbe | Mevcut 10 rütbeli sistem |
| Sezon ortası katılım | Açık / Kapalı | Kapalıysa ilk yarıştan sonra yeni katılım yok |
| Davetli davet edebilir | Açık / Kapalı | Özel lobide davet zincirini kurucu keser |

Görünürlük lobi kurulduktan sonra da değiştirilebilir (kurucu özel açıp sonra
herkese açık yapabilir).

**Lobi adı otomatik:** region havuzundan isim + artan numara —
`Anadolu #14`, `Nordschleife #3`. Oyuncu isim yazmaz; moderasyon yükü yok.

### 3.2 Koltuk seçimi

Izgara 11 takım / 22 araç. **Kurucu takımını seçmeden lobi hiçbir havuzda
görünmez ve kimse katılamaz.** Kurucu 11 takımdan istediğini alır — 250
Altınlık slotun değer önerisi tam olarak budur.

Lobi kurulur kurulmaz takvim işler. İnsan almayan takımları AI sürer; sonradan
katılan oyuncu AI takımını devralır (takım o ana kadarki puanı ve araç
gelişimiyle birlikte devredilir).

### 3.3 Hızlı oyun bul

**Lobi listesi ve arama yoktur.** Oyuncu "Hızlı oyun bul"a basar, sunucu bir
aday seçer ve **önizleme kartı** döner:

```
NORDSCHLEIFE #7                EU · her gün 21:00
Sezon 1 · 14/24. yarış · Zor AI (rütbe ×1.4)
7 insan · 4 AI

Sana kalan takımlar:
  MERIDIAN GP     araç 81   hedef P5  →  850 rütbe puanı
  VOLTA RACING    araç 74   hedef P8  →  600 rütbe puanı
  KESTREL F1      araç 69   hedef P10 →  400 rütbe puanı

        [ Takım seç ]        [ Başka bul ]
```

- "Başka bul" bedava ve sınırsızdır.
- **Slot ancak takım seçildiğinde harcanır.** Bağlanma noktası takım
  seçimidir; öncesi taahhütsüzdür.
- Takım kartında **takımın sezon hedefi ve karşılığındaki rütbe puanı**
  yazılır — oyuncu neye imza attığını görerek seçer.
- Devam eden yarışlar da aday olabilir (14/24 gibi); oyuncu beğenmezse
  "Başka bul" der.

### 3.4 Aday sıralaması — dürüst doluluk

Sunucu uygun lobileri toplar (region uyumlu, rütbe kapısından geçiyor,
katılıma açık, boş koltuk var) ve **gerçek koltuk durumuna** göre puanlar:

| Koşul | Hedef |
|---|---|
| En güçlü 1. ve 2. araç gerçekten dolu | Yüksek ağırlık — öncelikli aday |
| En güçlü 3. araç dolu | Adayların **%85**'i |
| En güçlü 4. araç dolu | Adayların **%75**'i |
| Kalan koltuklar | Rastgele |

Sunucu havuzdan bu dağılımı tutturmaya çalışarak seçim yapar.
**Hiçbir koltuk sahte gösterilmez** — kart her zaman gerçek doluluğu yansıtır.
Sahte kıtlık (dark pattern) üretilmez; AB/TR tüketici mevzuatı ve mağaza
inceleme riski bu nedenle açıkça reddedilmiştir.

Dağılım doğal olarak oluşur: lobi kuranlar en iyi arabayı ilk kapar, dolayısıyla
üst koltuklar zaten gerçekten doludur. Hedef oranı tutturacak aday yoksa
sunucu sıralamayı olduğu gibi kullanır; hiç uygun aday yoksa **taze lobi**
açılır (orada oyuncu her takımı seçebilir).

### 3.5 AI zorluğu

Üç kademe. Rakip AI takımlarının araç gelişim hızını ve strateji keskinliğini
değiştirir, **ve kazanılan rütbe puanını çarpar**:

| Kademe | AI gelişim hızı | Rütbe puanı çarpanı |
|---|---|---|
| Kolay | ×0.75 | ×0.7 |
| Normal | ×1.00 | ×1.0 |
| Zor | ×1.30 | ×1.4 |

Çarpan olmadan herkes Kolay seçer ve rütbe anlamsızlaşır. Çarpanlar
`npm run econ` denge kapısına yeni kontrol olarak eklenir.

### 3.6 Davet

- Özel lobiye arkadaş çağırma.
- İçinde bulunduğun herkese açık lobiye de arkadaş çağırabilirsin.
- "Davetli davet edebilir" kapalıysa yalnızca kurucu davet eder.
- Davet bir boş koltuğu rezerve etmez; davetli geldiğinde kalanlardan seçer.

---

## 4. Slot ekonomisi ve navigasyon (Faz 4)

### 4.1 Slotlar

3 slot hazır gelir. 4. ve 5. her biri **250 Altın**, kalıcı, hesap seviyesinde.
Tavan 5.

### 4.2 Navigasyon

**Onboarding'den sonra ilk görülen ekran GENEL EKRAN'dır:**
Hızlı oyun bul · Lobi kur · Davetler · Arkadaşlar · Mağaza.

**Sonraki her açılışta uygulama doğrudan son aktif oyuna girer.** Üst barda
logo ve altında aşağı ok; basınca dropdown açılır:

```
1 ▸ SCUDERIA ROSSA     Sezon 1 · 6/24 · Anadolu #3
2 ▸ boş
3 ▸ APEX RACING        Sezon 2 · 19/24 · Nordschleife #7
4 ▸ 🪙 250 · slot aç
5 ▸ 🪙 250 · slot aç
───────────────────────
▸ Genel ekran
```

- Dolu slot: takım adı **büyük harflerle**, sezon numarası, kaçıncı yarışta
  olduğu (`6/24`), lobi adı.
- Boş slot: "boş".
- Açılmamış slot: Altın fiyatı ve "slot aç".
- En altta "Genel ekran" satırı.

Oyuncu artık uygulamayı açtığında doğrudan yarış ekranı görmez.

### 4.3 Sezon sonu

Slot kendiliğinden boşalmaz. Oyuncu o slota girer ve **animasyonlu sezon
özeti** görür:

- Rütbe puanı artışı sayaçla akar,
- hedefin üstünde mi altında mı kaldığı,
- sezonun öne çıkanları (galibiyet, podyum, en hızlı tur, kazanılan başarımlar).

`Sezonu bitir` butonuna basınca ödüller hesaba işlenir, slot boşalır, sezon
profil arşivine düşer. O lobinin RP'si buharlaşır (§1.2).

### 4.4 Ayrılma cezası

Takım seçmeden çıkmak ücretsizdir ve slot harcanmamıştır.

Takım seçtikten sonra ayrılmak rütbe puanı keser; ceza kalan yarış oranında
artar:

```
ceza = hedef_tamamlama_puanı × (kalan_yarış / toplam_yarış)
```

24 yarışlık sezonda 6. yarışta ayrılmak ×0.75 (ağır), 22. yarışta ayrılmak
×0.08 (hafif). Ayrılınca slot boşalır ve takımı AI devralır; o sezonun rütbe
puanı kazanılmaz.

---

## 5. Arkadaş sistemi (Faz 5)

Ekleme yöntemleri:

1. **`Nickname#1234` tam etiket araması.** Kısmi arama yoktur — tam etiket
   bilinmeden kimse bulunamaz (gizlilik).
2. **Son rakiplerden ekle.** Bitmiş yarışın sonuç ekranından doğrudan istek.
3. **Davet kodu / deep link.** Uygulama dışına paylaşılabilir.

Rehber veya sosyal hesap arkadaş eşleştirmesi **kapsam dışıdır** — ayrı açık
rıza ve aydınlatma metni gerektirir, ilk sürümde yapılmaz.

İstek akışı: gönder → bekleyen → kabul/ret. Engelleme ve raporlama dahil.

---

## 6. Veri modeli (Postgres)

```
users            id, created_at, gold, rank_points,
                 country_code, region, nickname_base, nickname_tag
                 UNIQUE(nickname_base, nickname_tag)

auth_identities  user_id, provider (google|apple|facebook|password),
                 provider_uid, email_hash
                 UNIQUE(provider, provider_uid)

account_slots    user_id, slot_index (1..5), unlocked, lobby_id|null
                 UNIQUE(user_id, slot_index)

lobbies          id, name, region, visibility, ai_difficulty,
                 rank_min, rank_max, guests_can_invite, mid_season_join,
                 creator_user_id, season_no, round_no, phase, next_race_at

lobby_seats      lobby_id, team_key, user_id|null,
                 managed (human|assistant|ai), joined_at
                 UNIQUE(lobby_id, team_key)

lobby_economy    lobby_id, team_key, rp, factory_levels, roster,
                 contracts, pending_jobs, spy_state        -- sunucu otoritesi

lobby_invites    lobby_id, inviter_user_id, invitee_user_id|code, expires_at

friendships      user_a, user_b, status (pending|accepted|blocked),
                 requested_by, created_at

season_archive   user_id, lobby_id, team_key, season_no,
                 final_position, objective_met, rank_points_earned
```

`lobby_economy`, bugün mobil store'daki slice'ların sunucu karşılığıdır;
yarış motorunun okuduğu tek kaynak odur.

---

## 7. Sunucunun yeniden yapılandırılması

`server/src/league.ts` bugün tek lig, bellekte, kimlik doğrulamasız. Hedef yapı:

```
server/src/
  auth/       sosyal + e-posta girişi, JWT, nickname tahsisi
  identity/   ülke, region çıkarımı, profil
  lobby/      kurma, eşleştirme ağırlıkları, koltuk atama, davet
  season/     lobi başına takvim, faz saati, sezon sonu ödülü
  economy/    lobi başına RP/fabrika/kadro — yarış motorunun otoritesi
  social/     arkadaşlık, istekler, engelleme
  live/       lobi başına WS odası (bugün tek global yayın)
  db/         şema + migration
```

Bu, sunucunun yeniden yazımı ölçeğinde bir iştir. Mobil tarafta da her store
slice'ı "tek oyun" varsayımından "aktif slot" varsayımına geçer ve
`lobby_economy` ile senkronlanan bir görünüm haline gelir.

**Yarış motoru (`mobile/src/data/raceEngine.ts`) ve ekonomi formülleri
değişmez** — yalnızca çağrıldıkları yer ve okudukları durum kaynağı değişir.

---

## 8. Uygulama sırası

| Faz | İçerik | Doğrulama kapısı |
|---|---|---|
| **1** | Postgres + auth + nickname + ülke/region + profil | Kayıt/giriş uçtan uca; nickname eşzamanlı tahsis testi (çakışma yok) |
| **2** | Lobi + koltuk + slot + hızlı ara + takım seçim ekranı | Eşleştirme dağılımı simülasyonu: %85/%75 hedefleri tutuyor mu |
| **3** | Ekonominin sunucuya taşınması | `npm run econ` sunucu ekonomisine karşı geçmeli |
| **4** | Sezon sonu özeti + ayrılma cezası + dropdown navigasyonu | Ceza formülü sınır testleri (1/24 ve 24/24) |
| **5** | Arkadaş sistemi + davetler | Gizlilik testi: kısmi arama sızıntısı yok |

Her faz kendi spec + plan döngüsünü alır. Bu belge fazlar arası sözleşmedir;
bir fazın spec'i bu belgeyle çelişemez.

---

## 9. Kapsam dışı

- Rehber / sosyal hesap arkadaş eşleştirmesi
- Lobi içi sohbet
- Klan / takım birliği yapıları
- Turnuva ve sezonluk etkinlikler
- Çapraz platform hesap aktarımı
- Lobi listesi / tarama ekranı — **kasıtlı olarak yok**, eşleştirme yalnızca
  hızlı ara ve davetle olur
