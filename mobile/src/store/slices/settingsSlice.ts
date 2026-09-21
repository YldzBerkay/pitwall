import { COLORBLIND_MODES, semanticColors, type ColorblindMode, type SemanticColors } from '@/theme/colors';
import type { SliceCreator } from './types';

export const TEXT_SCALES = [1, 1.15, 1.3] as const;
export type TextScale = (typeof TEXT_SCALES)[number];

/**
 * Erişilebilirlik ve görüntü tercihleri — cihazda kalıcı bir kayıt/yükleme
 * (persist) sistemi henüz yok (`docs/FEATURES.md`), bu yüzden şimdilik
 * oturum ömürlü. Tercihler `Ayarlar` ekranından değiştirilir.
 */
export interface SettingsSlice {
  colorblindMode: ColorblindMode;
  textScale: TextScale;
  /** HUD'da ikincil bilgiyi (sektör/tur geçmişi gibi) sadeleştir — "az/çok" tercihi. */
  hudCompact: boolean;
  setColorblindMode: (mode: ColorblindMode) => void;
  setTextScale: (scale: TextScale) => void;
  setHudCompact: (compact: boolean) => void;
  /** Aktif renk körü moduna göre çözümlenmiş anlam renkleri — bileşenler bunu okur. */
  semantic: () => SemanticColors;
}

export const createSettingsSlice: SliceCreator<SettingsSlice> = (set, get) => ({
  colorblindMode: 'none',
  textScale: 1,
  hudCompact: false,

  setColorblindMode: (mode) => {
    if (!COLORBLIND_MODES.includes(mode)) return;
    set({ colorblindMode: mode });
  },
  setTextScale: (scale) => set({ textScale: scale }),
  setHudCompact: (compact) => set({ hudCompact: compact }),

  semantic: () => semanticColors(get().colorblindMode),
});
