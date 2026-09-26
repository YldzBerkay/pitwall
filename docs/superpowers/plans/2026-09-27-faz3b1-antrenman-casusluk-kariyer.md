# Faz 3b-1 — Antrenman, Casusluk, Kariyer · Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Casusluğu çözülebilir hâle getirmek, antrenmanı zamanlı sunucu seansları olarak geri getirmek, başarımları ve kariyeri sunucuda hesaplamak.

**Architecture:** Üçü de mevcut desenleri izliyor. Casusluk sonucu sponsor teklifleri gibi sunucuda, tohumlu ve istemciye güvenilmeden hesaplanır. Antrenman yarış gibi bir tariftir — karar günlüğü olmayan bir `race_runs`. Başarımlar ve kariyer muhasebenin transaction'ına katılır.

**Tech Stack:** Node 24 · TypeScript · Postgres 17 · Expo / React Native · `tsx --test`

**Spec:** [2026-09-27-faz3b1-antrenman-casusluk-kariyer.md](../specs/2026-09-27-faz3b1-antrenman-casusluk-kariyer.md)

---

## Başlangıç durumu

Sunucu **636/636**, mobil **163/163**, üç tip denetimi temiz, `npm run econ` 68
iddiayla geçiyor, ağaç temiz.

## Uygulayıcının bilmesi gerekenler

### Bu kod tabanının kuralları — hepsi bir kez ısırdı

- **Sunucu `shared/`'ın kurallarını içeri alır, yeniden yazmaz.** Yükseltme
  formülleri bir faz boyunca sessizce sürüklendi ve 65 iddialık denge kapısı
  ölü kodu test ettiği için fark etmedi. Bir tarama testi artık koruyor.
- **İstemcinin gönderdiği sonuç/şartlar asla okunmaz.** Sponsor imzalamada
  sunucu teklifleri yeniden üretip kendi kopyasını imzalıyor.
- **Bildirilen sayı = gerçekleşen sayı.** `chargeRpFloor` tabanladığı için
  nominal ceza düşülenden büyük olabiliyordu; artık gerçek tutarı döndürüyor.
- **`withTransaction` yalnızca fırlatmada geri alır.** Hata sonucu döndürmek
  yazılanı commit eder — üç ayrı para kaybı hatası buradan çıktı.
- **Transaction içindeki okuma transaction'ın client'ını alır.** Çıplak havuz
  okuması tam bir havuzu kilitler; gerçekten gözlendi.
- **Havuzu ısıtmayan eşzamanlılık testi hiçbir şey kanıtlamaz.** 30 çağırandan
  yalnızca 1'i yarış penceresine ulaşıyordu.
- **Tarama testi aradığına kör olabilir.** İçe aktarma anında zamanlayıcı arayan
  test, bir eylemin içinde kurulanı görmüyor.
- `now` rotada `new Date()` ile örneklenir, istekten alınmaz.
- Yönlendiricide yol parametresi yok; sorgu dizesi var (`GET /lobby?id=`).
- Takım anahtarı `lobby_seats`'ten, oturumdan okunur — istekten asla.

### Mobil

- Yerel yedek yok. Kopukken son gerçek durum donar ve söylenir.
- Kararlar saf seçicilerde (`displayRace`, `displayPhase`, `displayStandings`…),
  `.tsx`'te değil — React Native node altında çözülmez.
- `gameStore.ts` node altında içeri alınabilir; `persist()`'in istediği
  `window.localStorage` `economy-store.test.ts`'te taklit ediliyor.
- `@pitwall/shared` barrel import'u `tsc`'de patlıyor (TS5097) — alt yol.

### Test veritabanı

Paylaşılan. Oluşturduğun kimlikleri izle, yalnızca onları sil; tablo geneli
`delete` başka paketlerin satırlarını siler.

---

## Görev 1: Casusluk sonucu sunucuda

> Casusluk bugün kilitli: süresi dolan görev hiç çözülmüyor ve yeni görevi bloke
> ediyor. Bu yüzden ilk.

**Kapsam:** `claimSpyReport` sonucu `shared/src/espionage.ts`'in kurallarıyla,
tohumlu olarak hesaplar; istemcinin yükündeki sonuç alanları okunmaz. Başarı ve
yanlış istihbarat bir sonraki yükseltmenin çarpanı olarak saklanır ve
`jobs.ts`'in yükseltme uygulaması onu okur. Yakalanma cezası `chargeRpFloor` ile
alınır ve gerçek tutar bildirilir. 48 saatlik bekleme sunucuda uygulanır.

**Kanıtlar:**
- yükte sahte bir `outcome` → yok sayılıyor (kaldırılınca test düşmeli)
- başarılı istihbarat bir sonraki yükseltmeyi ×1,5 yapıyor
- bildirilen ceza = düşülen RP
- aynı görev iki kez claim edilemiyor

---

## Görev 2: Casusluk istemcisi sunucuya

**Kapsam:** `espionageSlice.ts`'in yerel `startMission`/`skipMission`/`resolveIntel`'i
sunucu eylemlerine geçer. Padok ekranı (`PaddockScreen.tsx`) sunucudan okur.
Lobi yoksa bunu söyler.

**Kanıtlar:**
- süresi dolan görev claim edilince çözülüyor ve **yeni görev açılabiliyor**
  (bugünkü kilidin tersinin kanıtı)
- lobi yokken yerel görevlere geri düşülmüyor

---

## Görev 3: Antrenman — şema ve zamanlı seanslar

**Kapsam:** yeni migration: dondurulmuş katılım, seans başına
`(lobby_id, season_no, round_no, session)`. Süpürme döngüsü seans saati gelince
katılımı dondurur (T − 18/12/6 sa; sprint haftasında tek seans T − 12 sa).
Sonuç `simulatePractice` ile türetilir, saklanmaz.

**Kanıtlar:**
- seanstan sonra değiştirilen kurulum o seansın sonucunu değiştirmiyor
- aynı seans iki kez dondurulamıyor (kiralama altında)
- sprint haftasında tek seans

---

## Görev 4: Antrenman — yayın ve istemci

**Kapsam:** tamamlanan seanslar istemciye ulaşır (okuma ucu + soket duyurusu —
faz çerçevesi deseni). `PracticePanel`'in zaman tablosu sunucudan okunur.

**Kanıtlar:**
- iki farklı oyuncu aynı seansı okuyunca **aynı** zaman tablosu
- lobi yokken yerel antrenmana geri düşülmüyor

---

## Görev 5: Başarımlar ve kariyer — sunucu

**Kapsam:** muhasebe, insan koltukları için `scoreWeekend` çağırır (antrenman,
sıralama, yarış — Clean Sweep dahil). Hafta sonunun başarımları muhasebe
dökümüyle saklanır. Kariyer kullanıcı başına saklanır; `recordWeekend` aynı
transaction'da. **`rank_points`'e yazılmaz.**

**Kanıtlar:**
- aynı yarış iki kez kariyere yazılmıyor
- muhasebe ortasında hata → kariyer değişmiyor
- Clean Sweep hesaplanabiliyor
- AI koltuklarına kariyer yazılmıyor

---

## Görev 6: Başarımlar ve kariyer — istemci

**Kapsam:** sonuç ekranı hafta sonunun başarımlarını, profil ekranı kariyeri
sunucudan okur.

**Kanıtlar:**
- lobi yokken yerel kariyere geri düşülmüyor

---

## Görev 7: Doğrulama ve dokümantasyon

`docs/FEATURES.md`, `server/README.md`, `mobile/README.md`. Spec §6'nın sekiz
kapısı tek bir değişmez dosyasında, her biri bozma/geri alma kanıtıyla.

---

## Bitiş ölçütleri

- [ ] Üç tip denetimi temiz, iki paket yeşil, `npm run econ` geçiyor
- [ ] Casusluk artık kilitlenmiyor
- [ ] Casusluk sonucu istemciden gelmiyor
- [ ] Antrenman herkese aynı ve seans başında donuyor
- [ ] Kariyer idempotent ve muhasebeyle atomik
- [ ] Sekiz başarımın sekizi de hesaplanabiliyor

## Sırada

**Faz 3b-2** — sürücüler ve personel sunucuda; üstüne maaşlar, sakatlıklar,
yaşlanma, rütbe puanı ve sezon hedefi.
