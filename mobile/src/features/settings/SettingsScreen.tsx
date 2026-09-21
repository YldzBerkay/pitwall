import { Pressable, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { colors, spacing } from '@/theme';
import { COLORBLIND_MODES, colorblindModeLabels, semanticColors } from '@/theme/colors';
import { AppText, GlassButton, GlassCard, Icon, ScreenHeader, SegmentTabs } from '@/components/atoms';
import { TEXT_SCALES, type TextScale } from '@/store/slices/settingsSlice';
import { useGameStore } from '@/store/gameStore';
import { useShellLayout } from '@/lib/useShellLayout';
import { haptic } from '@/lib/haptics';

const scaleLabel: Record<TextScale, string> = { 1: 'Normal', 1.15: 'Büyük', 1.3: 'En büyük' };

/**
 * Accessibility and display preferences. Session-only for now — there is no
 * save/load persistence yet (`docs/FEATURES.md`), so these reset on restart
 * until that lands.
 */
export function SettingsScreen() {
  const shell = useShellLayout();
  const colorblindMode = useGameStore((s) => s.colorblindMode);
  const setColorblindMode = useGameStore((s) => s.setColorblindMode);
  const textScale = useGameStore((s) => s.textScale);
  const setTextScale = useGameStore((s) => s.setTextScale);
  const hudCompact = useGameStore((s) => s.hudCompact);
  const setHudCompact = useGameStore((s) => s.setHudCompact);
  const semantic = semanticColors(colorblindMode);

  return (
    <ScrollView
      className="flex-1"
      contentContainerStyle={{
        paddingTop: shell.contentTop,
        paddingLeft: shell.contentPaddingLeft,
        paddingRight: shell.contentPaddingRight,
        paddingBottom: shell.contentPaddingBottom,
        gap: spacing.lg,
      }}
      showsVerticalScrollIndicator={false}
    >
      <ScreenHeader
        eyebrow="Görüntü ve erişilebilirlik"
        icon="settings"
        title="Ayarlar"
        subtitle="Renk körü modu, yazı boyutu ve HUD yoğunluğu — hepsi anında uygulanır."
        right={
          <GlassButton
            label="Kapat"
            variant="ghost"
            onPress={() => {
              haptic.select();
              router.back();
            }}
          />
        }
      />

      <GlassCard contentStyle={{ gap: spacing.md }}>
        <View style={{ gap: 2 }}>
          <AppText variant="cardTitle" color={colors.textPrimary}>
            Renk körü modu
          </AppText>
          <AppText variant="bodySmall" color={colors.textSecondary}>
            Bayrak, lastik aşınması ve pit uyarılarındaki tehlike/dikkat/onay renklerini değiştirir. Renk hiçbir zaman tek başına anlam
            taşımaz — ikon ve metin her zaman eşlik eder.
          </AppText>
        </View>
        <View style={{ gap: spacing.sm }}>
          {COLORBLIND_MODES.map((mode) => (
            <Pressable
              key={mode}
              onPress={() => {
                haptic.select();
                setColorblindMode(mode);
              }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderRadius: 12,
                borderWidth: 1,
                borderColor: mode === colorblindMode ? colors.borderActive : colors.borderDefault,
                backgroundColor: mode === colorblindMode ? colors.accentSoft : 'transparent',
                paddingVertical: spacing.sm,
                paddingHorizontal: spacing.md,
              }}
            >
              <AppText variant="label" color={mode === colorblindMode ? colors.accentLime : colors.textPrimary}>
                {colorblindModeLabels[mode]}
              </AppText>
              {mode === colorblindMode && <Icon name="check" size={18} color={colors.accentLime} />}
            </Pressable>
          ))}
        </View>
        <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
          <Swatch label="Tehlike" color={semantic.danger} />
          <Swatch label="Dikkat" color={semantic.attention} />
          <Swatch label="Onay" color={semantic.positive} />
          <Swatch label="Rekor" color={semantic.record} />
          <Swatch label="Bilgi" color={semantic.info} />
        </View>
      </GlassCard>

      <GlassCard contentStyle={{ gap: spacing.md }}>
        <AppText variant="cardTitle" color={colors.textPrimary}>
          Yazı boyutu
        </AppText>
        <SegmentTabs
          items={TEXT_SCALES.map((s) => ({ key: String(s), label: scaleLabel[s] }))}
          value={String(textScale)}
          onChange={(k) => setTextScale(Number(k) as TextScale)}
          fill
        />
      </GlassCard>

      <GlassCard contentStyle={{ gap: spacing.md }}>
        <View style={{ gap: 2 }}>
          <AppText variant="cardTitle" color={colors.textPrimary}>
            HUD yoğunluğu
          </AppText>
          <AppText variant="bodySmall" color={colors.textSecondary}>
            Sade modda canlı yarış ekranında yalnızca konum, tur ve pit uyarısı kalır; ikincil ayrıntılar (aşınma yüzdesi, pit sayısı)
            gizlenir.
          </AppText>
        </View>
        <SegmentTabs
          items={[
            { key: 'full', label: 'Tam' },
            { key: 'compact', label: 'Sade' },
          ]}
          value={hudCompact ? 'compact' : 'full'}
          onChange={(k) => setHudCompact(k === 'compact')}
          fill
        />
      </GlassCard>
    </ScrollView>
  );
}

function Swatch({ label, color }: { label: string; color: string }) {
  return (
    <View style={{ alignItems: 'center', gap: 4, width: 64 }}>
      <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: color, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }} />
      <AppText variant="labelSmall" color={colors.textTertiary} style={{ textAlign: 'center' }}>
        {label}
      </AppText>
    </View>
  );
}
