# Faz 3b-2 — Sürücüler ve Personel · Tasarım

## 1. Neden bu faz

Faz 3b-1 sürücü gerektirmeyen her şeyi sunucuya taşıdı. Kalanların hepsi tek bir
ön koşula bağlı: **sunucuda sürücü yok.** Her yarış tarifine `rosters: {}` ve
`aiBonus: {}` gidiyor (`server/src/lobby/runner.ts`), yani her yarış motorun
varsayılan sürücüleriyle koşuyor.

Bu yüzden durmuş olanlar:

- sürücü pazarı, sözleşmeler, yedek kadro
- personel sistemi ve etkileri
- **maaşlar** — hiçbir yerden düşmüyor
- **sakatlıklar** — motor ağır kazada `injured` üretiyor, işaretlenecek sürücü yok
- **sürücü yaşlanması** — araç gerilemesi kışın zaten sunucuda (`rollover.ts`),
  sürücü yaşlanması değil
- **rütbe puanı** — `rankPointsFor` bir sayı hesaplıyor, hiçbir şey yazmıyor, ve
  "sezon hedefi tuttu mu" diye bakan kod yok

## 2. Kadroları açmak bir denge olayı

Bugün AI arabasının hızı %75 takım gücü + %25 sürücü hızı
(`raceEngine.ts coreFor`). Kadro boş olduğu için o %25 hep sabit tohum değeri.
Gerçek kadrolar gelince:

- AI hızı donmaktan çıkıyor
- bir insanın kadro değişiklikleri — satış, sakatlık, antrenman — **ilk kez** yarış
  sonucuna yansıyor
- tutarlılık (`shakeOf`) ve yağmur becerisi (`wetTouch`) de sürücüden okunuyor

Bu tesisat değil. **Her yarışın sonucu değişir.** O yüzden ilk aşama bunu tek
başına yapar ve `npm run econ` ile doğrulanır; üstüne başka hiçbir şey binmez.

## 3. Kararlar

Kullanıcıyla birlikte verildi.

### 3.1 Tek pazar, lobi geneli

Lobideki herkes **aynı** serbest sürücüleri görür. İki insan aynı sürücüyü
isterse **ilk imzalayan alır.**

Pazar zaten tohumdan üretiliyor (`driverMarket.ts`, `(season, round)` üzerinden,
tur başına 8 aday), yani herkes aynı adayları görür. Adaylar üretilir,
saklanmaz — sponsor tekliflerindeki gibi. Saklanan yalnızca **imzalanmış**
olmak: bir sürücü benzersiz bir kişidir ve ikinci kez imzalanamaz. Koruma
yazmanın kendi `where`'inde ya da bir kısıtta durur; önceki bir okumada değil.

Personel pazarı aynı kurala uyar (tur başına 6 aday, lobi geneli, ilk işe alan
alır) — iki pazar arasında farklı kural tutarsız olurdu.

**Reddedilen:** takım başına özel pazar. Daha basit, ama aynı lobideki iki insan
farklı sürücüler görür ve rekabet kaybolur.

### 3.2 AI kadroları kalıcı ve yaşlanıyor

AI kadroları gerçek satırlar olarak saklanır, takım varsayılanlarından
(`teams.ts`) tohumlanır, ve herkes gibi yaşlanır ve gelişir. Motor her koltuk
için gerçek kadro görür — tutarlı.

**Ertelenen:** AI'ın kademeli transfer penceresi (`runTransferWindow`). Bir
koltuğu doldurmak aynı döngüde bir başkasını açıyor; bunu bir lobi genelinde
atomik ve idempotent yapmak anketin "en zor kısım" dediği şey. Transfer penceresi
gelene kadar **AI sözleşmeleri kendiliğinden yenilenir**; insan sözleşmeleri
biter ve sürücü pazara döner.

Akademi gençlerinin terfisi de transfer penceresiyle birlikte ertelenir.

### 3.3 Maaş: ödeyebildiği kadar

Maaş muhasebede, **yarış geliri yatırıldıktan sonra**, aynı transaction'da
kesilir. `chargeRpFloor` ile sıfırda tabanlanır ve **gerçekten kesilen tutar**
bildirilir. Yalnızca geliri maaşından az olan takım bu duruma düşer.

Zayıf yanı biliniyor: sıfırda duran bir takım fiilen maaş ödemez. Ama sıfırda
duran takım hiçbir şey geliştiremez, yani cazip bir strateji değil. Zorunlu satış
daha gerçekçi bir borç mekaniği olurdu; ileride eklenebilir.

Maaş formülleri `shared/`'dan içeri alınır. `econ` kapısı maaşları zaten
modelliyor (yalın ve seçkin kadro merdivenleri) — sunucu aynı fonksiyonları
kullanmazsa kapı yine ölü kod test eder.

### 3.4 Rütbe puanı: sezon sonunda, hedef tuttuysa

Sezon bittiğinde bir insan koltuğu, arabasının ait olduğu sıranın
(`objectivePosition(teamKey)`) içinde ya da üstünde bitirdiyse mevcut formülle
puan alır: hedef sırası × zorluk çarpanı (`rankPointsFor`). Tutturamazsa almaz.

Puan **kullanıcıya** yazılır (`users.rank_points`) — kariyer gibi, tüm lobileri
kapsar. Sezon dönüşünün mevcut atomiklik korumasıyla idempotent.

Kariyer puanı ile rütbe puanı **ayrı kalır** (Faz 3b-1 kararı).

## 4. Teknik kararlar

### 4.1 Kadrolar yarış tarifinde donar

Faz 3a-2'nin temel garantisi: yarış durumu saklanmaz, onu yeniden üreten tarif
saklanır. Kadrolar tarifin parçasıdır ve **ışıklar sönerken donar**, tıpkı
`entries` gibi. Donmazsa sonradan bir sürücü satışı zaten koşmuş bir yarışın
yeniden oynatmasını değiştirir — "herkes aynı yarışı görür" garantisi çöker.

`RaceSnapshot`'ta `rosters` alanı zaten var; bugün boş gidiyor.

### 4.2 Kışın devri `rollover.ts`'ten çağrılır

Yaşlanma, gelişme ve sözleşme süreleri sezon dönüşünde çalışır. Ayrı bir modülde
yazılır ama `rollover.ts`'in **aynı transaction'ından** çağrılır — mevcut
atomiklik korumasını paylaşır, kodu ayrı tutar.

### 4.3 Personel etkileri gerçek yollara akar

`staffEffects` üç rolden yedi etki üretiyor. Her biri bir sunucu yoluna gitmeli,
yoksa personel işe almak hiçbir şeyi değiştirmez:

| Etki | Nereye |
|---|---|
| `upgradeBonus` | yükseltme kazancı (`jobs.ts`) |
| `reliabilityBonus` | yarış girişi — bugünkü `0.3 + engineLab×0.02` ile birleşir |
| `briefAccuracy`, `forecastBand` | brifing (`briefFor`) |
| `assistantErrorScale` | yarış girişi |
| `pitSecondsSaved`, `pitFailChance` | yarış girişi |

Boş koltuk 40 beceriye düşer, sistem kırılmaz.

### 4.4 Sakatlıklar muhasebede

Muhasebe `FinishEntry.injured`'ı okur ve sürücüyü 1-2 yarış için sakat işaretler
(tohumlu). Sakat sürücünün yerine sonraki yarışın donmuş katılımında en iyi yedek
ya da geçici sürücü (`stopgapDriver`) girer. AI sürücüleri de sakatlanır — artık
kalıcılar.

### 4.5 Antrenman sonunda bir yere yazıyor

Antrenman işi (`pending_jobs`, tür `training`) bugün başlatılabiliyor ama
**sonucunu yazacak bir yeri yok** — `jobs.ts` bunu açıkça söylüyor. Sürücüler
gelince claim edilen antrenman sürücü statına yazar. Claim modeli korunur.

### 4.6 `playerTeam` sabit kodları

Yarış motorunda hâlâ tek bir sabit `playerTeam`'e bağlı kolaylık sarmalayıcıları
var (`soloEntries`, `isPlayerEntry`). Takım parametreli yardımcılar zaten var.
Bu fazdaki her yeni motor kancası parametreli yardımcıyı kullanır.

### 4.7 `AI_DEVELOPMENT_RATE` ölü kalıyor

`grid.ts`'te tanımlı, hiçbir yerde kullanılmıyor. AI arabasının sezon içi
gelişimi için bir zorluk düğmesi gibi görünüyor. Bu fazın kapsamı değil;
belgelenip bırakılıyor.

## 5. Aşamalar

| Aşama | İçerik | Kapı |
|---|---|---|
| **A** | Sürücüler sunucuda var: şema, tohumlama, tarifte donma, kışın yaşlanma | `econ` geçiyor; yeniden oynatma kadroyla bit bazında aynı |
| **B** | Pazar, sözleşmeler, yedek kadro, antrenman | İlk imzalayan alır; imza iki kez olmaz |
| **C** | Personel pazarı ve etkileri | Her etki bir sunucu yolunu gerçekten değiştiriyor |
| **D** | Maaşlar ve sakatlıklar muhasebede | Bildirilen maaş = kesilen; sakat sürücü sonraki yarışta yok |
| **E** | Rütbe puanı sezon sonunda | Hedef tutunca yazılıyor, iki kez değil |
| **F** | İstemci: padok ve yönetici ekranları sunucuya | Yerel yedek yok |

A önce, tek başına — çünkü denge olayı o.

## 6. Önceki fazların dersleri — bu fazda kontrol listesi

- **Üretimde kim çağırıyor?** Dört kez bir fonksiyon yazıldı, testlendi ve
  üretimde hiçbir şey çağırmadı. Her görev yeni kodun üretim yolunu göstermeli.
- **Sunucu bunu dışa veriyor mu?** Her istemci taşıması, sunucunun hesaplayıp
  attığı bir değere takıldı. Ekran taşınmadan önce kontrol edilir.
- **Sunucu `shared/`'ı içeri alır, yeniden yazmaz.**
- **Bildirilen sayı = gerçekleşen sayı.**
- **İstemcinin gönderdiği şartlar okunmaz.** İmzalanan sürücünün ücreti
  sunucunun kendi tohumdan ürettiği değerdir.
- `withTransaction` yalnızca fırlatmada geri alır · transaction içindeki okuma
  transaction'ın client'ını alır · havuzu ısıtmayan eşzamanlılık testi hiçbir şey
  kanıtlamaz.

## 7. Doğrulama

1. **Yeniden oynatma kadroyla bit bazında aynı** — kadrolar donmuş tariften okunuyor.
2. **Sonradan satılan sürücü koşmuş yarışı değiştirmiyor.**
3. **İlk imzalayan alır** — iki eşzamanlı imza, havuz ısıtılmış, tam biri kazanıyor.
4. **İstemcinin gönderdiği ücret yok sayılıyor.**
5. **Her personel etkisi bir sunucu yolunu değiştiriyor.**
6. **Bildirilen maaş = kesilen RP**, sıfırda tabanlı durum dahil.
7. **Sakat sürücü sonraki yarışın donmuş katılımında yok.**
8. **Rütbe puanı hedef tutunca yazılıyor, sezon dönüşü tekrarlansa bile bir kez.**
9. **`econ` geçiyor** ve sunucunun kullandığı maaş/gelişim fonksiyonlarını test ediyor.

Her biri için önce kural bozulur, adı konmuş testin düştüğü görülür, geri alınır.

## 8. Kapsam dışı

- AI transfer penceresi ve akademi terfisi — sonraki dilim
- Zorunlu satış / borç mekaniği
- `AI_DEVELOPMENT_RATE` ile AI araç gelişimi
- Sprint yarışları (sunucu koşturmuyor — ayrı iş)
- Sezon sonu özeti ve arşiv, ayrılma cezası — Faz 4 · arkadaş sistemi — Faz 5
