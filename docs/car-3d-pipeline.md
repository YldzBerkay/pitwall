# Pit Wall — 3D araç: nasıl yapıldı, nasıl üretilir

Bu belge uygulamadaki döndürülebilir F1 aracının **nasıl modellendiğini**, hangi
kararların neden alındığını ve render hattının uçtan uca nasıl çalıştığını anlatır.
Kod tarafı `tools/blender/` altındadır; uygulamaya giren varlıklar spec başına
bir sprite sheet olan `mobile/assets/car/turntable_{C,B,A}.png` dosyalarıdır.

![Hero](car-toon-hero.png)
![Yan](car-toon-side.png)

---

## 1. Hedef

İlk model (`build_f1_car.py`) gerçekçi oranlı, koyu stüdyoda render edilmiş bir
araçtı. İstenen şey iki yönlüydü:

1. **Güncel 2026 nesli F1 aracına benzesin** — referans olarak FIA'nın 2026
   regülasyon aracı görselleri kullanıldı (alçak burun, ön kanatla bütünleşen
   gövde, derin undercut'lı sidepod'lar, swan-neck üzerinde arka kanat, kapaklı
   jantlar).
2. **Daha "cartoon-cool" dursun** — oyun içinde bir ikon gibi okunsun: tombul,
   parlak, konturlu, canlı renkli.

Bu iki hedef çelişmez: oranlar referanstan, üslup oyuncaktan gelir.

---

## 2. Mimari: eskiyi silmeden üstüne kurmak

Yeni model `tools/blender/build_toon_car.py` içindedir ve eski dosyayı **modül
olarak içe alır**:

```
build_toon_car.py
 ├─ import build_f1_car as base       # geometri yardımcıları, malzemeler, stüdyo, turntable, glb
 ├─ build_wheel()   ← yeniden yazıldı (2026 jant kapağı)
 ├─ build_car()     ← yeniden yazıldı (tüm gövde)
 ├─ setup_studio()  ← base.setup_studio'yu sarar, ışığı değiştirir
 └─ main()          ← base.build_car / base.setup_studio / base.FRONT_AXLE'ı yamalar, base.main()'i çağırır
```

Neden böyle:

- `loft`, `revolve`, `wing_element`, `annulus`, `box`, `cylinder`, `torus` gibi
  geometri ilkelleri, `srgb_to_linear` renk dönüşümü, kamera-uydurma
  matematiği, 24 karelik turntable döngüsü ve `.glb` dışa aktarımı zaten
  yazılmıştı ve doğruydu. Kopyalamak iki dosyayı ayrıştırırdı.
- `car_config.py` kataloğu (livery, lastik bileşimi, jant, gelişim spec'i)
  aynı yerde kaldı; yalnızca parça bayrakları genişletildi (bkz. 4b). Aynı
  `--livery / --compound / --rim / --motor / --aero / --grip` bayrakları
  çalışır; uygulamadaki TS kataloğu ile eşleşme korunur.
- Eski builder hâlâ çalışır: `CAR=classic ./render_variants.sh …`.

> Dikkat: `setup_studio` sarmalanırken orijinal fonksiyon **yamalamadan önce**
> `_base_setup_studio = base.setup_studio` diye saklanır. İlk denemede
> `base.setup_studio(...)` çağrısı yamalanmış hâle, yani kendine gidip
> `RecursionError` verdi.

---

## 3. Geometri nasıl kuruldu

### Koordinat sistemi

Metre cinsinden, Blender'ın Z-up dünyasında: **+X ileri (burun)**, Y yanal, Z yukarı.
Ön aks `x = 1.72`, arka aks `x = -1.76`. Referans araca göre dingil mesafesi
biraz kısaltıldı; bu, tekerlekleri büyütmekle birlikte "oyuncak" hissinin ana
kaynağıdır.

Yanal ölçü tek bir sabitten gelir: `CAR_HALF_WIDTH = 0.95` (2026'nın 1900 mm
genişliği). Tekerlekler **dış yüzlerinden** konumlanır — `y = ±(0.95 − w/2)` —
yani GRIP kademesiyle lastik genişleyince araç dışa taşmaz, içe doğru büyür.
Bunun iki sonucu var: aracın silueti her spec'te aynı genişlikte kalıyor, ve
ön kanat gövde genişliğinin tamamını kaplayabiliyor (endplate tam lastiğin dış
hizasında) — daha önce olduğu gibi endplate'in lastiğin *içinde* kalması
imkânsız hale geliyor.

### Loft istasyonları

Gövdenin tamamı `loft()` ile üretilir: bir dizi **süperelips kesit** (yuvarlatılmış
dikdörtgen) X boyunca sıralanır ve aralarına yüzey örülür. Her istasyon
`(x, merkez_z, yarı_genişlik, yarı_yükseklik, üs)` beşlisidir; `üs` 2'de elips,
büyüdükçe köşeli olur.

```python
BODY = [
    (-2.45, 0.34, 0.050, 0.050, 3.0),   # kuyruk
    ...
    (-0.25, 0.47, 0.295, 0.235, 4.2),   # kokpit — en geniş, en köşeli
    ...
    ( 2.78, 0.18, 0.060, 0.038, 3.0),   # burun ucu — alçak, ön kanadın üstünde
]
```

Bu tablo aracın **tek yerden ayarlanan omurgasıdır**. Bir istasyonun `merkez_z`'si
düşürülürse burun alçalır, `yarı_genişlik` artırılırsa gövde tombullaşır.

Aynı yaklaşım airbox/motor kapağı, sidepod'lar, sidepod eteği, taban, difüzör,
kokpit açıklığı ve hava girişleri için ayrı loft'larla tekrarlanır.

`loft()` artık istasyon başına **altıncı bir değer, `center_y`** kabul ediyor.
Sidepod'lar bunu kullanıyor: tek bir `location.y` kaydırması podu bir bütün
olarak taşıyabiliyor ama kuyruğunu daraltamıyordu, dolayısıyla pod kuyruğu arka
lastiğin içinden geçiyordu. Şimdi `0.445`'ten `0.170`'e daralan gerçek bir
coke-bottle var. Altıncı değer verilmeyen her loft eskisi gibi çalışır.

### Süspansiyon: iki ucu da bir yere bağlı

Eski `suspension()`'ın **iki ucu da tahmindi**. İç uç sabit bir `y` idi (önde
0.20, arkada 0.30) — oysa şasi orada yalnızca ~0.15 yarı-genişlikte, yani her
kol havada başlıyordu. Dış uç ise tekerleğin **görünen dış yüzünü** hedefliyordu,
yani kollar lastiğin üstünden geçip jant kapağında bitiyordu. "Bağlantı yerleri
kopuk" görüntüsünün kaynağı buydu.

Şimdi:

- İç uç `body_at(x)` ile monokokun gerçek derisinden okunuyor (`BODY` tablosunun
  lineer interpolasyonu) — gövde profili değişince kollar kendiliğinden takip eder.
- Dış uç, lastiğin **iç yanağının 3.5 cm içine** yerleştirilen bir `PW_Upright`
  kutusunda bitiyor; gerçek bir porya taşıyıcısı da oradadır ve dışarıdan lastik
  onu örter. Bağlantının bağlantı gibi okunmasını sağlayan şey bu dikme.
- Önde üst/alt salıncak + direksiyon kolu + **pushrod**, arkada salıncaklar +
  toe link + **pullrod** + `PW_Driveshaft` (arka tekerleklerin bir şeyle
  döndürülmesi gerekiyor).

### Ön kanat: lastikten tamamen önde

`FW_REAR_LIMIT = FRONT_AXLE + 0.405 + 0.06 = 2.185`. Ön kanada ait hiçbir yüzey
bu çizginin gerisine geçemez; `check_front_wing_gap()` build sırasında bunu
kontrol eder ve ihlalde `SystemExit` atar. Eskiden yığın `x = 1.97`'ye kadar
geliyordu, lastiğin ön ucu ise `2.11`'de — üst flap ve endplate doğrudan
tekerleğin içinden çıkıyordu. Regresyonun render'a bakılarak fark edilmesi
yerine build'i durdurması tercih edildi.

Endplate'ler artık kutu değil: `plate()` yardımcısı XZ düzleminde kapalı bir
poligonu Y boyunca ekstrüde eder, böylece 2026'nın alttan oyulmuş / üstten
süpürülmüş endplate profili çıkar. Döndürülmüş bir kutu üç-çeyrek açılardan
kaçınılmaz olarak levha gibi görünüyordu.

### Kanat elemanları: plaka değil, açıklık boyunca loft

`wing_element()` tek bir kesiti iki uç arasında düz ekstrüde eder. Sonuç
plakadır: önden bakınca ön kanat üç yassı çubuk gibi okunuyordu, "aero hiç yok
gibi". Gerçek bir ön kanadın plakanın yapamadığı üç şeyi var ve görünüşünü
belirleyen de bunlar:

- **Kavis (`arch`)** — eleman endplate'e doğru yükselir, merkez piste yakın kalır.
- **Uçta artan veter (`tip_chord`)** — outwash orada üretilir, eleman dışa
  doğru kalınlaşır.
- **Burulma (`twist`)** — uç kesiti orta kesitten farklı açıda çalışır.

`swept_wing()` kesiti açıklık boyunca 12 istasyonda yeniden üretip loft eder;
üçü de istasyon başına parametredir. Ön kanat ana elemanı `arch 0.048`,
`tip_chord 1.22`, `twist -6°`; flaplar daha güçlü (`tip_chord 1.30`,
`twist -10°`). Her elemanın hücum kenarına ince bir vurgu şeridi eklendi —
referans araç kanadı çıplak yüzeyle değil çizgilerle anlatıyor.

Ana eleman artık karbon değil ikinci ton: koyu bir ana eleman, iki renkli
çubuğun altında zemin plakası gibi duruyordu. Yığın aşağıdan yukarı ikinci
ton → birinci ton → vurgu şeklinde katmanlanıyor.

Ama düz bir poligon da levhaydı. Profil noktaları artık üçüncü bir değer
taşıyabiliyor: **dışa kavis**. Gerçek ön kanat endplate'i düz değildir,
yükseldikçe dışa yatar; kavis plakanın ön-üst tarafında büyür, arka-üstte
küçük kalır — çünkü flap uçlarının oturduğu yer orasıdır. İlk denemede kavis
tüm üst kenarı dışa taşıdı ve plaka üst flapın ucundan tamamen kaçtı; temas
grafiği `PW_FrontFlap2`'yi "şasiye bağlı değil" diye bildirdi. Flaplar da artık
plakanın nominal hattından 3 cm **içeri gömülüyor**, böylece kavis plakayı
oynatınca uçta boşluk açılmıyor.

Boyalı dış deri de ayrı bir elle yazılmış profil değil: `inset_profile()` ile
plakanın kendi profilinden türetiliyor. İki ayrı liste tutulduğu sürece
birbirinden iki kez kaydı.

### 2026 özelliklerinin karşılıkları

| Referansta | Modelde |
|---|---|
| Alçak, ön kanada oturan burun | BODY'nin son istasyonları `z ≈ 0.18`; ön kanat ana elemanı `z = 0.09` |
| Yüksek, sığ sidepod girişi + undercut | Pod loft'u girişte `hh = 0.09`; altına ayrı, ince `PW_PodSkirt` loft'u |
| Airbox'tan arkaya süzülen motor kapağı | `PW_Airbox` loft'u `z 0.83 → 0.42`; T2+ aero'da shark fin |
| Swan-neck arka kanat, dik endplate | İki `wing_element` (ana + DRS flap), eğik `PW_SwanNeck` plakaları, `0.60×0.40` endplate |
| Beam wing | `PW_BeamWing` `z = 0.44` |
| Kapaklı jant | `PW_WheelCover`: `revolve` ile çukur disk + vurgu halkası + delik deseni + merkez somun |
| Geniş lastik bandı | `annulus` bandı yanak yüzeyinden 4 mm dışarıda |
| Halo | Ovalleştirilmiş `torus` + eğik orta direk |
| Burun ucunun ön kanada oturması | `BODY`'nin son istasyonu `z = 0.115`, ana elemanın (`z = 0.09`) *içine* gömülü |
| İnce, yüksek sidepod girişi (letterbox) | `PW_Inlet` loft'u `hh = 0.040`, üstünde ayrı `PW_InletLip` dudağı |
| Coke-bottle sidepod | Pod loft'u istasyon başına `center_y` ile içeri daralıyor: `0.445 → 0.170` |
| Aktif aero (X-mod) | AERO T3'te arka flap `-6°` düz konuma iniyor |

### Livery şeritleri: gövdeye "sarılan" bant hilesi

Şerit çizmek için UV/texture yok. Yerine, gövde istasyonlarından **türetilen**
çok yassı bir loft kullanılır: aynı X'lerde, `yarı_genişlik + 1.4 cm`,
`yarı_yükseklik = 2 cm`. Bu ince disk gövdenin içinden geçer, sadece iki yanda
dışarı taşan kenarları görünür ve bir şerit gibi okunur. `band()` yardımcı
fonksiyonu bunu `BODY` listesinden hesaplar; gövde değişince şerit otomatik
takip eder.

---

## 4. "Cartoon" üslubu nereden geliyor

1. **Oranlar** — lastik yarıçapı 0.385 m (gerçek ~0.36), arka lastik 45 cm
   genişlikte, kısa dingil, tombul kokpit kesiti.
2. **Kontur çizgisi** — her kabuk parçasına *ters kabuk* (inverted hull) uygulanır:
   `Solidify` modifier, **pozitif** kalınlık, `offset = 1` (dışa büyüt),
   `use_flip_normals = True`, `use_rim = False`; yeni yüzeyler `material_offset`
   ile siyah, `backface_culling` açık `PW_Outline` malzemesini alır. Kamera
   tarafındaki yüzler culled olur, silüetten taşan arka yüzler ince siyah hat
   olarak kalır. Kalınlık parça başına 6–18 mm (`shell(..., ink=)`).
   > İlk denemede kalınlık negatifti; kabuk içe büyüdü ve hiç görünmedi.
3. **Parlak boya** — `Roughness 0.22`, `Coat Weight 0.6`, `Coat Roughness 0.08`.
4. **Işık** — eski yumuşak alan ışıkları 2–3× güçlendirildi, üstüne sert bir
   `SUN` (4.5 W/m², 6° açı) ve lacivert bir dünya ortam rengi eklendi. Güneş,
   cel-shading'i andıran net ışık/gölge sınırları verir; lacivert ortam gölge
   tarafını griye çekmeden aydınlatır. Stüdyo zemini yansımasız
   (`Specular IOR Level 0`) koyu lacivert.
5. **Renk yönetimi** — `Standard` view transform (AgX değil): AgX canlı
   livery'leri pastele çeker. Katalogdaki sRGB renkler `srgb_to_linear` ile
   Base Color'a verilir.

---

## 4b. Upgrade sistemi: her seviye araçta görünür

Oyun üç stat geliştirir (MOTOR · AERO · GRIP), her biri 3 kademeli (T1 <60,
T2 60–69, T3 ≥70). Ortalama harfi verir (C / B / A). İlk sürümde kademeler
arasında yalnızca lastik bandı rengi değişiyordu; upgrade'in araçta karşılığı
yoktu. Şimdi **her kademe adımı en az bir silüet-seviyesinde parça ekler**:

![C → B → A](car-spec-tiers.png)

| Stat | T1 | T2 ekler | T3 ekler |
|---|---|---|---|
| MOTOR | egzoz yok, düz airbox | egzoz borusu, vurgu renkli yüksek **airbox ağzı** (`PW_Scoop`), **batarya soğutma podu** (`PW_EnergyPod`) | büyük egzoz + **kızgın uç** (emissive), motor kapağı **solungaçları**, **güç omurgası** şeridi, ızgaralar |
| AERO | tek elemanlı ön ve arka kanat, kısa düz endplate | ikinci ön flap, **arka flap**, orta boy endplate + vurgu şeridi, **beam wing**, **taban kanatçığı**, **taban çitleri** | üçüncü flap, **aktif aero / X-mod** (arka flap düz konumda), **yüksek endplate**, **köpekbalığı yüzgeci** (vurgu kenarlı), T-kanat, endplate dudakları, ayna kanatçıkları |
| GRIP | dar lastik, düz koyu jant kapağı | geniş lastik, kapakta **vurgu halkası** + delik deseni, **fren kanalı** kanatçığı | en geniş lastik, **takım rengi jant kapağı**, **büyük difüzör** + kanatçıklar |

2026'ya taşınırken iki yeni bayrak eklendi (`energy_pods`, `active_aero`) ve
`bargeboards` aynı adla kalıp geometrisi **taban çitlerine** dönüştü — barge
board'lar 2022'den beri yasak, 2026 aracında tabanın ön ucunda duran
yönlendirici kanatçıklar var. Bir ara eklenen tekerlek üstü kanatçık geri
alındı: 2022-25 aracının parçası, 2026 regülasyon aracında yok.

Bayraklar tek kaynaktan gelir: `tools/blender/car_config.py::describe_spec()`
ve TS aynası `mobile/src/data/carCustomisation.ts::describeSpec()`. Biri
değişirse diğeri de değişmelidir; 2D Skia çizimi (`CarIllustration.tsx`) ve
Geliştirme ekranındaki "kilit açılır" metinleri (`tierUnlocks`) aynı bayrakları
okur.

### Uygulamaya nasıl yansır

Turntable **spec harfi başına bir sprite sheet**tir: `turntable_C/B/A.png`
(`render_turntables.sh`). 27 kombinasyon için 27 sheet yerine 3 sheet seçildi;
her biri ~5.7 MB. Sheet'ler `render_variants.sh`'daki spec tanımlarıyla aynı
stat/jant/lastik ile render edilir, böylece vitrin görselleri ve uygulama
birbirini tutar.

`CarTurntable` `spec` prop'u alır. Harf değişince eski sheet altta kalır, yeni
sheet 420 ms'de üstüne solar (`SWAP_MS`); `CarUpgradeStage`'in kıvılcım ve
flaşı bu geçişin üstüne biner, parçaların "takıldığı" hissini verir.
Sheet'lerin kırpma kutuları farklı olduğu için her birinin `cellAspect`'i
`SHEETS` tablosunda ayrı tutulur.

---

## 4c. Livery'ler

![Livery'ler](car-liveries.png)

On livery var ve renk çarkına yayılmak üzere seçildiler: lime · lacivert ·
kırmızı · beyaz · turuncu · karbon · turkuaz · yeşil · magenta · sarı. Üçü
birden mavinin tonu olan bir set, telefon boyutundaki bir araçta oyuncuya
seçecek bir şey bırakmıyor. Her livery dört renk taşır — `primary` (gövde),
`secondary` (motor kapağı / ikinci ton), `accent` (şeritler, endplate dudağı,
kask) ve `trim` (karbon parçalar) — ve vurgu rengi çarkın karşı tarafından
seçildi ki şeritler küçük boyutta da okunsun.

`style` alanı vurgunun gövdeye nasıl düştüğünü belirler:

| Stil | Ne yapar | Kullananlar |
|---|---|---|
| `stripe` | Gövdeyi saran iki bant (biri vurgu, biri ikinci ton) | pitwall, scarlet, solar |
| `flash` | `stripe` + yan kutu flankında ayrı bir vurgu şeridi | midnight, sunset, stealth |
| `duotone` | Tüm gövde ikinci tonda, vurgu şeritleri ikinci bant olur | monza, aqua |
| `split` | Şasi birinci tonda, motor kapağı/kuyruk/arka kanat ikinci tonda, dikişte vurgu bandı | emerald, fuchsia |
| `bare` | Şeritsiz; yalnızca `--style bare` ile hata ayıklama için | — |

`split` bu turda eklendi. İki nokta belirleyici oldu:

- **İkinci ton değerle ayrılmalı, tonla değil.** İlk denemede emerald'ın iki
  yeşili %4 apart idi ve telefon boyutunda tek renk gibi okunuyordu; ikinci ton
  neredeyse siyaha çekildi.
- **Yan kutular birinci tonda kalıyor.** Önce pod'lar da koyulaştırılmıştı ama
  o zaman aracın en geniş yüzeyleri livery rengini taşımıyordu; ayrım motor
  kapağı, kuyruk ve arka kanatla sınırlandı.

Panel, monokokun **aynı istasyonlarından** 4 mm dışarıda loft edilir
(`PW_SplitPanel`), böylece her eğriyi sarar; omuzdan kayan bir çıkartma gibi
durmaz. Dikiş bandı (`PW_SplitSeam`) 9 mm dışarıda, iki istasyonluk ince bir
halkadır.

Katalog iki yerde yaşıyor ve **elle senkron tutulur**:
`tools/blender/car_config.py::LIVERIES` ve
`mobile/src/data/carCustomisation.ts::liveries`. Bu tur ikisi de tek bir
tablodan üretildi. `render_variants.sh`'ın livery döngüsü artık listeyi
`car_config`'ten okuyor, yani yeni bir livery ikinci bir düzenleme olmadan
vitrin sayfasına giriyor.

---

## 4d. Reklam alanları ve sponsor logoları

Araçta sekiz reklam alanı var (`SPONSOR_DECALS`). Bu turda üçü birden değişti:
nasıl yerleştikleri, ne kadar büyük oldukları ve üzerlerine ne çizildiği.

### Yerleşim: eksen-hizalı kutu değil, yüzeye örtüşen yama

Plakalar elle yazılmış üç sayıya konan eksen-hizalı kutulardı; kodun kendi
yorumu da bunu kabul ediyordu ("Rotations are skipped"). Neredeyse her yeri
eğri olan 2026 gövdesinde bunun anlamı, bir ucu gömülü diğer ucu havada duran
bir plaka. Plakayı yüzey normaline döndürmek açıyı düzeltir ama eğriliği
düzeltmez: reklam büyüdükçe köşeleri kalkar — ve en büyük olması gereken
reklam yan kutudakidir.

`conform_decal()` bunun yerine yamayı panele **örnekleyerek** üretir: reklamın
ayak izi boyunca bir nokta ızgarası panelin derisine düşürülür, yerel normal
boyunca `lift` kadar kaldırılır ve 0..1 UV taşıyan bir dörtgen ağa dikilir.
Sonuç: panel altında nasıl dönerse dönsün reklam sabit yükseklikte oturur,
çalışma zamanı dokusu da kare iner.

Normal tek poligondan değil, ayak izinden **ortalanarak** alınır. Tek poligonun
normali hangi faset en yakınsa odur; fasetli yuvarlak bir panelde (halo
borusu) aynı reklamın sağ ve sol kopyası gözün savunamayacağı bir sebeple
farklı açılarda duruyordu.

### Bölgeler: gerçek araç nasıl imzalanıyorsa

Sekiz özdeş panel yerine, 2025 Mercedes / Red Bull / Ferrari'nin fiilen yaptığı
şey model alındı. Üçü de aynı düzeni kuruyor: yan kutuya **tek dev başlık
sponsoru**, motor kapağının yan yüzünden aşağı **üç-dört orta boy logoluk dikey
yığın**, burun boyunca iki tane, arka kanadın ana elemanına bir büyük isim ve
endplate'ine **ikili yığın**, kalanlar kokpit çevresi, halo, ayna ve ön kanatta.

| Bölge | Adet | Ölçü (m) | Oran | Karşılığı |
|---|---|---|---|---|
| Yan kutu | 1 | 0.72 × 0.215 | 3.35 | PETRONAS · ORACLE · Shell |
| Motor kapağı | **3** | 0.30 × 0.072 | 4.0 | Microsoft · SOLERA · AMD |
| Burun ucu (üst) | 1 | 0.26 × 0.085 | 3.06 | Ferrari'nin burun rozeti |
| Burun (yan) | 1 | 0.42 × 0.105 | 4.0 | Richard Mille · AT&T |
| Arka kanat ana eleman | 1 | 0.80 × 0.110 | 7.3 | PETRONAS |
| Arka kanat endplate | **2** | 0.26 × 0.075 | 3.47 | Snapdragon + CROWDSTRIKE |
| Ön kanat endplate | 1 | 0.30 × 0.120 | 2.5 | Mobil 1 · UniCredit |
| Ön kanat flap | 1 | 0.70 × 0.075 | 9.3 | RAUCH · V-Power |
| Kokpit çevresi | **2** | 0.17 × 0.052 | 3.2 | IBM · aws |
| Halo | 1 | 0.15 × 0.042 | 3.57 | |
| Ayna | 1 | 0.052 × 0.055 | 0.95 | Signify |
| Zemin kenarı | 1 | 0.84 × 0.046 | 18.3 | |

Toplam **16 pozisyon, 11 bölge** (aynalı olanlar her iki yanda; 30 yama).
Ücretler bölgenin ne kadar televizyon süresi aldığına göre: yan kutu 32,
kokpit 4. Toplam taban değer 142 — eski sekiz slotun 131'ine yakın, yani
ekonomi değil yalnızca dağılım değişti.

Reklamın hangi yöne **okunduğu** da slotun verisi (`along`): çoğu araç boyunca
uzanır ama arka kanadın ana elemanındaki ve ön kanat flapındaki reklam
**açıklık boyunca** uzanır. Bu bir kolaylık değil zorunluluk: kanat elemanının
yüzeyi arkaya bakar, orada "araç boyunca" yönü sıfıra iner.

İki yerleşim ölçerken düzeldi. Arka kanat reklamı **arkadan** tohumlanınca her
ızgara noktası kanadın keskin firar kenarına düşüp yama bir çizgiye çöküyordu —
tohum kanadın üstüne alındı. Burun ucu reklamı burnun yanındayken ön kanat
endplate'inin arkasında kalıyordu (endplate orada burundan yüksek); Ferrari'nin
yaptığı gibi burnun üstüne alındı.

İki yerleşim hatası ölçerken çıktı: **burun** reklamı ön aksın üstündeydi, yani
tam ön lastiğin arkasında — yandan hiç görünmüyordu; burun konisine, tekerleğin
önüne alındı. **Arka kanat** reklamı AERO T1'de endplate'ten taşıyordu; bu da
altındaki gerçek hatayı ortaya çıkardı: endplate kesikleri sabit ölçüdeydi
(0.15 / 0.13) ve 0.22 yüksekliğindeki T1 plakasında alt kesik üst kesiğin
üstüne çıkıp poligonu kendi kendine kesiyordu — her temel spec aracın arka
kanadı bükülmüş çıkıyormuş. Kesikler artık `ep_h` oranında.

`check_decals.py` bunların hepsini ölçer: her yama köşesinin panele uzaklığı
(hepsi 4.0 mm, sapma 0.0 mm olmalı) ve yamanın istenen ayak izini koruyup
korumadığı. `check_contacts.py` bunu yakalamaz — açılı duran, bir ucu gömülü
bir plaka da "bağlı"dır.

### Reklam boyanın üstünde durur

Livery şeritleri de geometridir: `band()` gövdeyi **14 mm**, yan kutu şeridi
**8 mm** dışarıdan sarar. 4 mm yükseklikteki bir reklam bunların *altında*
kalıyordu — şerit doğrudan logonun üstünden geçiyordu. Artık yükseklik slot
başına: livery'nin kestiği paneller (burun 20 mm, yan kutu ve motor kapağı
18 mm) boyayı aşar, kesmedikleri 5 mm'de kalır.

Bu, iki kontrolü çelişkiye sokuyor. `check_contacts.py`'nin kuralı "hiçbir
parça 6 mm'den uzakta durmasın"; reklamlar ise bilerek daha uzakta. Sınırı
gevşetmek gerçek bir kopuk parçayı da geçirirdi, o yüzden reklamlar temas
grafiğinden muaf tutuldu ve yüksekliklerini `check_decals.py` slot slot kendi
hedefine karşı ölçüyor.

### Logolar

Sponsor logoları görsel dosya değil, **çizim talimatı** (`Brand.logo`): 0..100
kutusunda bir SVG yolu (`mark`), bir kelime markası ve mürekkep rengi. Sebebi
oranlar: reklam alanları 1:1 aynadan 18:1 zemin şeridine kadar gidiyor ve tek
bir bitmap birinde okunmuyor, diğerinde eziliyor. Yol + kelime her alana
yeniden dizilebiliyor.

`CarTurntable.paintDecalPng()` dokuyu slotun **kendi oranında** üretir ve
kilidi ona göre seçer: çok geniş şeritte yalnız kelime, geniş alanda solda
mark sağda kelime, kareye yakın alanda üstte mark altta kelime. Ortadaki
durumda kelime markın yanına sığmak için okunmaz hale gelecekse mark düşürülür
ve kelime plakanın tamamını alır. Metin **ölçülür, tahmin edilmez** — markalar
"APEX"ten "CHRONARC"a kadar uzuyor ve tahmini bir glif genişliği uzun olanlarda
plakadan taşıyor.

Marklar kalın ve geometrik tutuldu: halo plakasında logonun tamamı telefonda
~40 piksel yüksekliğinde, birkaç birimden ince her şey kayboluyor. Dolgu kuralı
markın türüne göre: içteki alt yolun delik açması istenen marklarda (COREVEX'in
altıgeni, VOLTRIDE'ın şimşeği) even-odd, şekillerin **birleşimi** olanlarda
(ÖZTÜRK'ün kamyonu ve tekerlekleri) normal dolgu — aksi halde her çakışma
XOR'lanıp çentiğe dönüşüyor.

**Her markanın plakası yok.** `plate: false` olan markalar (şu an altı tane)
doğrudan gövdeye basılır: dokunun arka planı şeffaftır ve mürekkep markanın
kendi renginden değil, **altındaki boyadan** seçilir — koyu araçta beyaz, açık
araçta neredeyse siyah. Kendi rengini kullanmak, lacivert bir araca #14060A
bir logo basmak demekti. Bunun için `.glb`'deki reklam malzemeleri alfa
harmanlamalı olmak zorunda; glTF dışa aktarıcısı `alphaMode`'u Principled
*Alpha* girişinin sürülüp sürülmediğine bakarak seçiyor ve doku çalışma
zamanında geldiği için dışa aktarma anında görecek bir şey yok. Sezgiyi
kandırmak yerine bayrak dosyaya yazılıyor (`force_blend_alpha`).

Marklar da kimlik gibi çalışsın diye soyut tutuldu. İlk tur her sektörün en
bariz stok sembolüydü — buluta bulut, yakıta damla, sigortaya şemsiye, kahveye
fincan — ve bir marka kimliğinden çok ikon seti gibi duruyordu. Şimdi
monogramlar (KESTREL'in K'si, GRENDEL'in X'i, HAULBERG'in H'si) ve geometrik
aygıtlar (VECTRA'nın üçlü şevronu, MERIDIAN'ın meridyenli küresi, COREVEX'in
altıgenden kesilmiş C'si) var. İki kez düzeltme gerekti: TAUROX, VOLTARA ve
VALEMONT üç ayrı kalın "V" olmuştu, SKYRA'nın süpürülmüş şeridi de havayolu
değil şimşek gibi okunuyordu.

Markaların tamamı kurgusaldır ve adları yabancıdır.

---

## 5. İterasyon döngüsü

Model **tamamen headless** Blender ile geliştirildi: script değiştir → üç açı
render et → sheet'e bak → düzelt. Bunun için `tools/blender/preview_toon.sh`
hero/yan/ön görünümleri alır ve tek bir `sheet.png`'de üst üste koyar.

Tur tur düzeltilenler (ne yanlıştı → ne yapıldı):

| Gözlem | Sebep | Düzeltme |
|---|---|---|
| Jant kapağı görünmüyor, koyu barrel görünüyor | Barrel silindiri `width × 0.97`, kapağın önüne taşıyor | Barrel `width × 0.84` |
| Arka kanat kutu gibi | Endplate `0.66×0.62`, kanadı tamamen örtüyor; kanat çok yüksek | Endplate `0.60×0.40`, `rw_z 0.92 → 0.76`, kanat 22 cm öne |
| DRS flap dik duruyor | `-52°` hücum açısı | Kapalı `-36°`, açık `-20°` |
| Zemin açık gri | Güçlendirilen ışıklar zemin speküleriyle çarpıyor | Roughness 1.0, specular 0, koyu lacivert |
| Kontur yok | Solidify içe büyüyor | Kalınlık pozitif |
| Yan profil düz mekik | Burun 0.9 m ileride, sidepod kokpit önüne taşıyor | Burun ucu `3.02 → 2.78`, pod girişi `x 0.45`, airbox yükseltildi |
| Araç soluk | Sadece alan ışığı | SUN + ortam |

### 2026 revizyonunda düzeltilenler

| Gözlem | Sebep | Düzeltme |
|---|---|---|
| Ön lastik kanadın içinden çıkıyor | Kanat yığını `x = 1.97`'ye kadar geliyordu, lastiğin ön ucu `2.11` | Yığın tamamen `2.185` önüne alındı + `check_front_wing_gap()` build guard'ı |
| Endplate lastiğin *ortasında* duruyor | Tekerlek merkezden konumlanıyordu (`TRACK_HALF + w/2`), geniş lastik aracı 2.19 m yapıyordu | Tekerlek dış yüzünden konumlanıyor, `CAR_HALF_WIDTH = 0.95` |
| Süspansiyon kolları havada başlıyor | İç uç sabit `y = 0.20` / `0.30`, şasi orada 0.15 | `body_at(x)` ile gerçek deriden |
| Kollar lastiğin üstünden geçip jant kapağında bitiyor | Dış uç `face_y`'yi hedefliyordu | İç yanağın 3.5 cm içindeki `PW_Upright`'ta bitiyor |
| Taban ve difüzör arka lastiğin içinden geçiyor | Taban yarı-genişliği 0.78, lastik iç yüzü 0.47 | Taban `0.62 → 0.41`, difüzör `0.44 → 0.38` |
| Sidepod kuyruğu arka lastiğin içinde | `location.y` podu bir bütün olarak taşıyor, daraltamıyor | `loft()` istasyon başına `center_y` — gerçek coke-bottle |
| Arka kanat direkleri iki ucunda da boşlukta | Sabit `z`, gövdenin 18 cm üstünde başlıyordu | Taban `body_at(-2.16)`'dan, tepe ana elemanın üst yüzeyinde |
| Ayna ve roundel gövdeden ayrık | `y = 0.38` / `z = 0.485`, gövde orada 0.264 / 0.424 | Deriden hesaplandı |

---

## 6. Üretim hattı (komutlar)

Repo kökünden:

```bash
# Hızlı üç açılı önizleme → tools/blender/out/toon/sheet.png
./tools/blender/preview_toon.sh
```

```bash
# "Reklamlar paneline yapışık mı?" — köşe köşe ölçer
for v in 78 64 48; do
  /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
    --python tools/blender/check_decals.py -- --motor $v --aero $v --grip $v
done
```

```bash
# "Havada duran parça var mı?" — üç spec için de sıfır tolerans
for v in 78 64 48; do
  /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
    --python tools/blender/check_contacts.py -- --motor $v --aero $v --grip $v
done
```

`check_contacts.py` her mesh'i dolaşıp temas grafiği kurar ve **her parçanın
`PW_Monocoque`'a bir yol bulabildiğini** doğrular. Tek komşuya değmek yeterli
sayılmaz: iki parça birbirine tutunup topluca havada kalabilir — nitekim ilk
çalıştırmada tekerlek takımlarının tamamı (22 parça) kendi adasıydı, çünkü
`suspension()` parametresini `half_width` diye adlandırıp çağrıda tam genişliği
alıyordu ve porya lastiğin 13 cm içinde kalıyordu.

Temas üç adımda karara bağlanır, çünkü mesafe tek başına yanlış soru:
`BVHTree.overlap` ile yüzey kesişimi (bu araçtaki parçaların çoğu komşusunun
içine gömülü modellendiği için asıl ölçüt bu), ışın pariteli içerme testi
(kapalı kalan ama gayet bağlı olan parçalar, ör. sidepod'un içindeki hava
girişi), ve ancak bunlar tutmazsa yüzey-yüzey mesafesi. İlk sürüm yalnızca
mesafeye bakıyordu ve 25 kez yanlış alarm verdi.

```bash
# Uygulamanın üç turntable sprite sheet'i (spec C/B/A · 24 kare · 15° · şeffaf)
./tools/blender/render_turntables.sh
```

Script her spec için Blender'ı `--turntable 24 --width 1280 --height 544` ile
çağırır, sonra `make_sprite_sheet.py` kareleri ortak alfa kutusuna kırpıp 4×6
paketler ve `aspect for CELL_ASPECT: …` basar. Bu değerler
`mobile/src/components/organisms/CarTurntable.tsx` içindeki `SHEETS`
tablosundaki `cellAspect` ile **aynı olmalıdır**. Kare sayısı veya sütun
değişirse `FRAME_COUNT / SHEET_COLS / SHEET_ROWS` da güncellenir.

```bash
# Spec / livery / bileşim / jant vitrin renderları ve şeffaf sprite'lar
./tools/blender/render_variants.sh tools/blender/out/toon/variants all
```

`render_variants.sh` varsayılan olarak yeni modeli kullanır; `CAR=classic` ile
eskisine döner.

```bash
# 3D görüntüleyici için .glb (kontur kabukları poligon sayısını ikiye katlar; kapat)
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
  --python tools/blender/build_toon_car.py -- --no-outline \
  --export-glb tools/blender/out/f1-car.glb
```

Malzeme adları (`PW_Primary`, `PW_Accent`, `PW_CompoundBand`, `PW_Rim` …) sabittir;
uygulama livery'yi bu adlarla yeniden boyar.

---

## 7. Değiştirmek isteyenlere

- **Oran** → `build_car()` içindeki `BODY` ve diğer loft tabloları. Bir
  istasyon ekleyip çıkarmak serbest; sadece X'ler artan/azalan sırada kalsın.
- **Parça var/yok** → `car_config.describe_spec()` **ve** TS aynası
  `carCustomisation.describeSpec()`; builder `parts[...]` bayraklarına bakar.
  Yeni bir parça eklerken: bayrağı iki katalogda tanımla → builder'da
  `if parts["…"]:` bloğu → `tierUnlocks` metnine ekle → `render_turntables.sh`
  ile sheet'leri yeniden üret → `cellAspect` değerlerini güncelle.
- **Renk** → `car_config.LIVERIES / COMPOUNDS / RIMS`. Değerler sRGB'dir.
- **Kontur kalınlığı** → `shell(obj, mat, coll, ink=…)`; büyük yüzeyler
  14–18 mm, ince parçalar 6–10 mm.
- **Işık** → `setup_studio()` içindeki `boost` sözlüğü ve `PW_Sun`.
- **Kamera açıları** → `build_f1_car.VIEWS` (azimut, yükseliş, lens, kenar payı).

Değişiklikten sonra mutlaka `preview_toon.sh` ile üç açıya bakın; tek açıda
iyi görünen bir istasyon yan profilde kolayca bozulur.

---

## 8. Uygulamada gerçek zamanlı görüntüleyici

Turntable sprite sheet'leri (24 önceden render edilmiş kare, sürüklerken karede
kare atlayan bir şerit) yerini **gerçek zamanlı bir 3D sahneye** bıraktı.
Kütüphane [react-native-filament](https://github.com/margelo/react-native-filament) —
Google'ın Filament motorunu JSI üzerinden bağlıyor, iOS'ta Metal / Android'de
Vulkan-GLES kullanıyor, render kendi thread'inde çalışıyor. Karşılaştırılan
alternatif `@react-three/fiber` + `expo-gl` idi; ondan vazgeçme sebebi, güncel
Expo sürümlerinde bilinen bir `expo-gl` sürüm uyuşmazlığı (cihazda çökme) ve
Filament'in JSI tabanlı olup JS thread'ini hiç bloklamamasıydı.

### Model → uygulama

`tools/blender/export_glb.sh` her spec için `build_toon_car.py --no-outline
--export-glb` çalıştırır → `mobile/assets/car/f1-car-{C,B,A}.glb`. Kontur BU
ihracatta kapalı: mürekkep çizgisi aynı mesh üzerinde ikinci bir malzeme
slotu olarak bakılıyordu (Solidify + ters normal), glTF bunu iki primitive'e
bölüyor ve react-native-filament'ın `getMaterialInstanceAt(entity, 0)`'ı
hangisini bulacağı garanti değil — renk değiştirirken mürekkebi boyama
riski vardı. Kapatmak her malzeme index'ini öngörülebilir kıldı; oyuncak
oranlar, parlak cila ve güçlü rim ışığı stilize hissi hâlâ taşıyor.

`build_f1_car.py::export_glb()`'deki `join_by_material()` her birleşik mesh'i
malzemesinin adıyla yeniden adlandırıyor (`PW_Primary`, `PW_Accent`,
`PW_CompoundBand`, `PW_Rim`, …) — hem glTF düğüm adı hem tek malzemesi bu isim.
`CarTurntable.tsx` bunu kullanır:

```tsx
<Model source={MODELS[spec]} transformToUnitCube>
  <EntitySelector byName="PW_Primary"
    materialParameters={{ index: 0, parameters: { baseColorFactor: [...] } }} />
</Model>
```

Livery/lastik bileşimi/jant seçimi değiştiğinde `baseColorFactor` her karede
değil, sadece seçim değiştiğinde worklet üzerinden render thread'ine yazılır —
Blender'da bir renk için tekrar render almaya gerek kalmadı. Renk sRGB hex'ten
linear'e `CarTurntable.tsx::srgbToLinear` ile çevrilir (Python tarafındaki
`srgb_to_linear` ile aynı eğri); atlanırsa livery pastelleşir.

**Bilinen sadeleştirmeler:**
- `PW_CarbonLight` yalnızca spec B/A'da var (C'de hiçbir parça kullanmıyor,
  glTF ihracatı kullanılmayan malzemeyi atıyor) — `RECOLOR_TARGETS` bunu spec
  başına listeler; olmayan bir düğümü `byName` ile aramak
  `<EntitySelector>`'ı throw ettirir.
- Jant kataloğu (`carCustomisation.ts::Rim`) yalnızca renk taşıyor;
  `car_config.py::RIMS`'teki finish başına metalik/pürüzlülük değerleri TS
  tarafına hiç geçmemişti — `PW_Rim` rengi canlı değişir, parlaklığı ihracat
  anındaki `accent/turbine` ön ayarında sabit kalır.
- Spec (C/B/A) hâlâ üç ayrı `.glb` — parça geometrisi (shark fin, T-kanat…)
  `join_by_material()` sonrası malzeme başına birleştiği için tek başına
  görünür/gizlenir yapılamıyor. Spec değişince model değişir, karşılıklı
  geçiş kısa bir opacity iniş-çıkışıyla yumuşatılır (`SWAP_MS`).

### Kamera

`useCameraManipulator({ orbitHomePosition, targetPosition, orbitSpeed })` +
tek parmak `Gesture.Pan()` → `grabBegin/grabUpdate/grabEnd`. Eskisinden farklı
olarak artık **her iki eksende** de dönüyor (yükseklik dahil), çünkü gerçek
geometri var — sprite sheet'te sadece yatay 15°'lik adımlar mümkündü.
`transformToUnitCube` her spec'in farklı uzunluğunu (T3'ün difüzörü ve arka
kanadı daha uzun) tek tip ~1 m kutuya normalize ettiği için kamera konumunun
aracın gerçek boyutunu bilmesi gerekmiyor.

### Kurulum notları

- `npm i react-native-filament react-native-worklets-core`.
- `babel.config.js`: `react-native-worklets-core/plugin` eklendi
  (`processNestedWorklets: true`), Reanimated'ın `react-native-worklets/plugin`
  öncesinde — iki ayrı worklet çalışma zamanı yan yana yaşıyor.
- `metro.config.js`: `resolver.assetExts`'e `'glb'` eklendi, yoksa Metro
  `.glb`'yi JS modülü sanıp `.ts/.js/...` uzantılarıyla arar ve
  "None of these files exist" hatası verir. **Bu değişiklik önceden açık bir
  Metro sunucusuna işlemez** — config'i okuması için sunucuyu kapatıp
  `--reset-cache` ile yeniden başlatmak gerekir.
- Expo config plugin'e gerek yok (kütüphanenin `app.plugin.js`'i yok);
  CocoaPods/Gradle otomatik linkliyor. `cd ios && pod install`.
- Doğrulama: iOS simülatöründe gerçek build (`expo run:ios`) alınıp ekran
  görüntüsüyle hem renk hem sürükle-döndür test edildi.

### Pil / performans

Gerçek zamanlı render, sprite sheet'ten daha fazla güç harcar — ekran
görünürken Filament sürekli bir render döngüsü çalıştırır; sheet ise sadece
iki görüntüyü karıştırıyordu. Sahne buna karşı hafif: 6-14 malzeme, tek araba,
post-processing yok, tek yönlü ışık + varsayılan IBL. Modern telefonlarda
(A17/A18, Snapdragon 8 Gen 3+) bu yük bir GPU'nun hissedeceği bir şey değil;
maliyet "her karede çizmek"ten geliyor, karmaşıklıktan değil. Ekran araç
sekmesinden çıkınca `<FilamentScene>` unmount olur ve render döngüsü durur —
sürekli arka planda çalışmaz. İleri bir optimizasyon olarak, kart görünür ama
etkileşimsizken kare hızını düşürmek mümkün olabilir; bu iterasyonda
uygulanmadı.
