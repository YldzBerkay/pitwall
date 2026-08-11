# Pit Wall

F1 Manager mobil oyunu — takım yönet, aracı geliştir, pilotları büyüt, ligde yarış.

2026 **"Ferah & Canlı" Spatial Motorsport** tasarım diline sahip bir React Native (Expo) uygulaması.

## Stack

| Alan | Teknoloji |
|------|-----------|
| Çatı | Expo SDK 57 · React Native 0.86 · React 19 · New Architecture (Fabric) |
| Navigasyon | expo-router (React Navigation v7) |
| Animasyon | react-native-reanimated v4 |
| Grafik | @shopify/react-native-skia |
| Liste | @shopify/flash-list |
| Stil | NativeWind v4 (Tailwind v3.4) |
| State | Zustand |
| Veri | TanStack Query |
| Haptics | expo-haptics |

## Kurulum

```bash
cd mobile
npm install --legacy-peer-deps
npm start           # Expo dev server (QR / simulator)
# veya
npm run ios
npm run android
```

Faydalı komutlar:

```bash
npm run typecheck   # tsc --noEmit
npx expo export --platform ios   # bundle doğrulama
```

## Proje Yapısı

```
pit-wall/
├── mobile/                 # Expo uygulaması
│   ├── app/                # expo-router rotaları
│   │   ├── _layout.tsx     # providers + fontlar + ambient background
│   │   └── (tabs)/         # Race Week · Manager · League · Profile
│   └── src/
│       ├── theme/          # renk + tipografi + spacing/glow tokenları
│       ├── components/      # atoms / molecules / organisms
│       ├── features/        # manager, common, (garage/pilots/factory...)
│       ├── store/           # Zustand game store
│       ├── lib/             # haptics, queryClient
│       └── data/            # mock domain verisi
└── docs/
    └── design-system.md    # 2026 tasarım sistemi (token ↔ kod eşlemesi)
```

## Dokümantasyon

- [Tasarım Sistemi](docs/design-system.md)

## Durum

- ✅ Tasarım sistemi (tema token'ları, tipografi)
- ✅ Atomic bileşen kütüphanesi (GlassCard, GlassButton, NeonStatChip, PulseDot, LiquidProgressBar, AmbientBackground)
- ✅ Floating tab bar navigasyonu
- ✅ Manager Home bayrak ekranı
- ⏳ Garage · Pilots · Factory · Pre-Season · League ekranları
