# Pit Wall — Design System (2026 "Ferah & Canlı")

**Estetik:** Spatial Motorsport — Apple Vision Pro ferahlığı + EA Sports FC dinamizmi. Katı siyahlar yerine derin, ışık geçiren frosted-glass yüzeyler ve canlı neon vurgular. Bilgi yoğun ama "nefes alan" ekranlar.

Bu doküman tasarım kararlarını **koddaki karşılıklarıyla** birlikte listeler. Token'lar `mobile/src/theme/` altında yaşar.

---

## 1. Renk Paleti

`mobile/src/theme/colors.ts`

| Rol | Token | Değer |
|-----|-------|-------|
| Ana arka plan (Deep Space) | `bgDeepSpace` | `#090B14` |
| Yükseltilmiş yüzey | `bgElevated` | `#0F1424` |
| Sidebar zemin | `bgSidebar` | `rgba(15,23,42,0.65)` |
| Cam yüzey | `glass` | `rgba(255,255,255,0.04)` |
| Vurgu mavisi | `accentBlue` | `#2563EB` |
| Vurgu mavisi (açık) | `accentBlueLight` | `#60A5FA` |
| Elektrik camgöbeği | `electricCyan` | `#00F0FF` |
| Neon coral (uyarı) | `neonCoral` | `#FF3366` |
| Matrix yeşili (başarı) | `matrixGreen` | `#00FF87` |
| Solar amber (dikkat) | `solarAmber` | `#FFB800` |
| Cyber purple (akademi) | `cyberPurple` | `#9D4EDD` |
| Metin ana | `textPrimary` | `#FFFFFF` |
| Metin ikincil | `textSecondary` | `#A1B0CC` |
| Kenarlık (default) | `borderDefault` | `rgba(255,255,255,0.08)` |
| Kenarlık (aktif) | `borderActive` | `rgba(37,99,235,0.6)` |

**Ambient Mesh Gradient:** `AmbientBackground` atomu, Skia ile iki ağır bulanık (blur 90) blob'u ekran arkasında yavaşça (16 sn döngü) hareket ettirir; deep-space ekranların düz/boğucu görünmesini engeller.

Gradient setleri `gradients` altında: `accent`, `cyan`, `coral`, `green`, `purple`, `amber`, `ambient`.

---

## 2. Tipografi

`mobile/src/theme/typography.ts` — line-height'lar klostrofobiyi engellemek için **~%15 artırıldı** (`LINE_HEIGHT_BOOST = 1.15`).

| Kullanım | Font | Örnek variant |
|----------|------|---------------|
| Başlıklar (uppercase, tracking 1.5) | Barlow Condensed Bold/ExtraBold | `hero`, `pageTitle`, `sectionTitle`, `cardTitle` |
| Gövde / etiket | Inter Regular/Medium/SemiBold | `body`, `label`, `labelSmall` |
| Rakam / süre / para | JetBrains Mono Bold | `statLarge`, `stat`, `statSmall` |

Tüm metin tek bir primitive üzerinden geçer: `AppText` (`variant`, `color`, `uppercase`). Fontlar `app/_layout.tsx` içinde `@expo-google-fonts/*` ile yüklenir.

---

## 3. Yüzeyler, Boşluk, Glow

`mobile/src/theme/index.ts`

- `spacing` — 4 / 8 / 12 / 16 / 24 / 32 / 48
- `radius` — sm 8 · md 14 · lg 20 · xl 28 · pill 999
- `blur` — glass 24 · sidebar 40 · bar 30
- `glow` — blue / cyan / coral / green (iOS shadow + Android elevation dışa parlama presetleri)

Cam yüzeyler gerçek `backdrop blur` için `expo-blur` `BlurView` kullanır; arkadaki içerik flulaşarak görünür.

---

## 4. Bileşen Kütüphanesi (Atomic Design)

```
mobile/src/components/
├── atoms/
│   ├── Typography (AppText)        # tek tipli metin primitive
│   ├── GlassCard                   # frosted-glass yüzey (aktif=mavi glow)
│   ├── GlassButton                 # blur + gradient + spring press + haptic
│   ├── NeonStatChip                # +/- parlayan pill (5 ton)
│   ├── PulseDot                    # sıfıra yaklaştıkça hızlanan nabız
│   ├── LiquidProgressBar           # Skia sıvı gradient dolum barı
│   └── AmbientBackground           # Skia mesh gradient backdrop
├── molecules/
│   ├── CarStatCard                 # LED fit + LiquidProgressBar + RP maliyeti
│   ├── PilotAvatar                 # gradient ring + kategori rozeti
│   └── TimelineNode                # dikey enerji hattı + node
└── organisms/
    ├── NextRaceWidget              # geri sayımlı hero (pulse hızlanır)
    ├── RPEconomyCard               # devasa glow'lu RP sayacı
    └── FloatingTabBar              # yüzen cam kapsül alt sekme
```

Ekranlar: `mobile/src/features/manager/ManagerHomeScreen.tsx` (bayrak ekran) + `features/common/PlaceholderScreen`.

---

## 5. Navigasyon (Spatial)

`expo-router` (React Navigation v7 üzerine kurulu) + özel **FloatingTabBar**:
- Ekrana yapışık değil; sağ/sol 16px, altta güvenli alan boşluklu **yüzen cam kapsül**.
- Şeffaf glassmorphism + 1px parlak üst kenarlık.
- Sekmeler: **Race Week · Manager · League · Profile** (varsayılan: Manager).
- Her sekme değişiminde `expo-haptics` selection feedback.

---

## 6. Geliştirme Metodolojisi & Stack

| Alan | Seçim |
|------|-------|
| Çatı | Expo SDK 57 · React Native 0.86 · React 19 · **New Architecture (Fabric)** |
| Navigasyon | expo-router (React Navigation v7) |
| Animasyon | react-native-reanimated v4 (worklets) |
| Grafik | @shopify/react-native-skia (liquid bar, ambient mesh, blur) |
| Liste | @shopify/flash-list |
| State | Zustand (`src/store/gameStore.ts`) |
| Veri çekme | TanStack Query (`src/lib/queryClient.ts`) |
| Haptics | expo-haptics (`src/lib/haptics.ts`) |
| Stil | **NativeWind v4 (Tailwind)** — `className`; dinamik/animasyonlu/Skia kısımlar `style` |
| Klasör | Feature-based / domain-driven (`src/features/*`) |

> **Stil katmanı — NativeWind v4:** Statik yerleşim/renk/kenarlık `className` ile yazılır. Tema token'ları `tailwind.config.js` içine taşındı (renkler `bg-deepspace`, `text-text-secondary`, `border-border-active`; fontlar `font-display`, `font-mono` vb.). Animasyonlu değerler (Reanimated), gradient (expo-linear-gradient), gerçek blur (expo-blur) ve Skia çizimleri `style`/prop üzerinden yönetilir — bunlar `className` ile ifade edilemez.
>
> **Sürüm notu:** NativeWind 4.2.6 çalışma zamanında Tailwind **v3** motoruna dayanır; Tailwind v4 henüz desteklenmediğinden `tailwindcss@3.4.19` (en son v3) sabitlendi.

---

## 7. Sonraki Adımlar

- My Garage (parallax 3D izometrik araç, timeline)
- Pilots (tam ekran swipe carousel, Skia fluid barlar)
- Factory (spring accordion, 2.5D ikonlar)
- Pre-Season Testing (sinematik seçim + ripple + haptic)
- Teknik Toplantı & Motor Jetonları (sliding pill, floating RP rozetleri)
- League (FlashList 60fps liderboard)
