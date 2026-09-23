# Pit Wall — Mobil İstemci

Expo/React Native uygulaması. Kimlik, ekonomi ve (Aşama 1'den itibaren) yarışın
pit-çağrısı yolu gerçek bir Node/Postgres sunucusuna (`../server`) bağlanır;
sunucu adresi Race Week → Online Lig kartından girilir.

## Çalıştırma

```bash
npm install
npm run start        # expo start
npm run typecheck     # tsc --noEmit
npm run econ          # ekonomi denge kapısı (scripts/econ-check.ts)
npm test               # tsx --test — aşağıya bakın
```

## Test koşucusu ve sınırı

Mobil tarafta jest/jest-expo YOK — tek koşucu `tsx --test`
(`package.json`'daki `test` script'i, `test/*.test.ts`). Bilinçli bir seçim:
bu fazın garantileri bir bileşenin NASIL ÇİZİLDİĞİYLE değil, store mantığı ve
sunucu istemcileriyle (HTTP client'ları, WebSocket client'ı, zustand slice'ları)
ilgili — hepsi düz TypeScript, React Native'e dokunmuyor. Ağır bir bileşen
test yığını (jest-expo, `@testing-library/react-native`) kurmak bu garantiler
için gereksiz bir maliyet olurdu.

**Bunun sonucu bir sınır, bir kusur değil:** `tsx --test` düz Node üzerinde
çalışır — React Native ya da Expo'yu içeri alan HİÇBİR modül test edilemez,
çünkü ikisi de Node altında çözülmez (Metro'nun kendi çözümleyicisi ve
native köprüsü gerekir). Sonuç olarak test edilmesi gereken mantığın
KENDİSİNİN bu bağımlılıklardan arınık kalması gerekiyor — `lib/api/race.ts`,
`lib/api/raceSocket.ts` ve `store/slices/*.ts` bu yüzden RN/Expo'dan bağımsız
yazıldı (bkz. her dosyanın kendi docblock'u). Bir ekranı (`features/**/*.tsx`)
`tsx --test` altında import etmeyi denemek `expo-router`/`react-native`
çözümleme hatalarıyla patlar; bu beklenen bir sonuçtur, koşucunun hatası
değil. Ekran/bileşen doğrulaması bugün elle (`expo start`) yapılıyor.

`@/*` takma adı (`tsconfig.json`'daki `paths`) `tsx`in kendi tsconfig
okumasıyla çözülüyor — testler mobil paketin kökünden (`cd mobile && npm
test`) çalıştırılmalı, başka bir çalışma dizininden değil.

## Bağlantı sözleşmesi — yerel yedek YOK

`lib/api/raceSocket.ts`, sunucunun lobi başına canlı yayın odasına
(`/race/live`) bağlanır ve **hiçbir zaman kendi yarışını uydurmaz**. Bu
kasıtlı: sunucu yarışı otorite olarak koşuyor (ışıklar sönerken bir tarifi
donduruyor — tohum + katılım + değişmez pit karar günlüğü — ve onu
deterministik tikliyor), bu da "lobideki herkes AYNI yarışı görür" iddiasını
bir umuttan çok bir YAPI garantisine çeviriyor. Bağlantı koptuğunda yerele
düşen bir istemci, tam da en görünür anda (kopukken) FARKLI bir yarış
çizerdi — fazın bütün amacını en kritik anda bozardı.

Bunun somut sonuçları:

- **Kopukken ekran DONAR.** `raceSocket.ts` son gerçek çerçeveyi
  (`race.data`) korur, hiçbir şey icat etmez; `raceSlice.ts` da aynı kuralı
  tekrarlar. Ekran "bağlantı kesildi" demeli, sessizce eski bir kareyi yeni
  gibi göstermemeli.
- **Kopukken pit çağrısı KABUL EDİLMEZ, KUYRUĞA DA ALINMAZ.**
  `raceSlice.ts`'in `callPit`i `race.status !== 'connected'` ise isteği ağa
  hiç göndermeden yerelde reddeder. Kuyruğa almak YANLIŞ olurdu: kuyruğa
  alınan bir çağrı ancak bağlantı geri geldiğinde sunucuya ulaşır, o ana
  kadar hedeflediği tur ÇOKTAN KOŞMUŞ olur ve sunucu onu `lap_already_run`
  ile reddeder — oyuncu, çağrısının kuyrukta beklediği SÜRE boyunca
  "gönderdim, işledi" sanmış olur. Anında reddetmek oyuncuya yalan
  söylemeyen tek seçenek.

## Dört bağlantı durumu, altı store durumu

`raceSocket.ts`'in `ConnectionStatus`'u DÖRT değer taşır:
`connecting` | `connected` | `disconnected` | `session-invalid`.
`disconnected` ile `session-invalid` bilerek ayrı tutulur: kopan bir TCP
bağlantısı beklemekle düzelir (modül kendi kendine geri çekilerek —
exponential backoff — yeniden dener); süresi dolmuş/geçersiz bir oturum
düzelmez — ne kadar denenirse denensin sunucunun `unauthorized` cevabı
değişmez, ve "yeniden bağlanıyor…" diye sonsuza dek bekleten bir arayüz
oyuncuyu hiçbir yere göndermez. Yalnızca sunucunun `error: 'unauthorized'`
çerçevesi `session-invalid`e eşlenir; `forbidden` (oturum geçerli ama bu
lobide koltuk yok) gibi diğer kodlar bağlantı durumunu DEĞİŞTİRMEZ, çünkü
bu modülün bir taşıma-katmanı çözümü değildir.

`store/slices/raceSlice.ts` bu dörde İKİ tane daha ekler:
`idle` (henüz `connectRace` çağrılmadı) ve `signed-out`. `signed-out`,
`session-invalid`den AYRI bir durumdur ve ayrı kalmalı: biri "hiç oturum
yoktu, soket hiç açılmadı" (`connectRace` boş bir token'la soket açıp
sunucudan `unauthorized` almayı beklemez, önce kendi kontrolünde durur),
diğeri "oturum vardı ama sunucu reddetti (süresi doldu/geçersiz)". Ekranın
ikisine söyleyeceği söz farklı: biri "giriş yap", diğeri "oturumun bitti,
yeniden giriş yap" — ikisini tek bir "bağlı değil" metnine düşürmek oyuncuyu
yanlış eyleme yönlendirir.

## Tek lastik seçici, iki değil

Motorda `CarSetup.compound` TEK bir alan — sıralama lastiği ile yarış
başlangıç lastiği AYNI değeri paylaşıyor. Bu keyfi bir sadeleştirme değil,
gerçek F1 kuralının (Q2'de en hızlı 10'un ertesi gün STARTED ON o lastikle
başlaması zorunluluğu) doğrudan karşılığı. Bu kuralın ikinci bir sonucu var:
pit yolundan başlamanın (parc fermé ihlali cezası) tek telafisi SERBEST
başlangıç lastiği seçimidir (`server/README.md`'nin "Parc fermé" bölümüne
bakın) — ve bu telafi yalnızca HERKESİN aksi halde lastiğe BAĞLI olmasından
anlam kazanıyor. Sıralama ve yarış lastiğini iki ayrı seçiciye ayırmak bu
bağı çözer ve pit-yolu telafisini anlamsızlaştırırdı; bu yüzden
`PracticePanel`/`QualifyingPanel`'deki iki eski seçici Aşama 1'de tek
seçiciye indirildi.
