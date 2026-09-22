import { memo } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { colors, spacing } from '@/theme';
import { AppText } from '@/components/atoms';
import { teamByKey } from '@pitwall/shared/teams';

interface GridCar {
  teamKey: string;
  driverIdx: number;
  driver: string;
  position: number;
  isPlayer: boolean;
}

interface GridIntroProps {
  cars: GridCar[];
  onDismiss: () => void;
}

/**
 * The grid presentation: starting order, driver names, team colours — the
 * daldırma moment before lights out. Auto-dismisses on its own timer
 * (`LiveRacePanel`); tapping anywhere closes it early.
 */
export const GridIntro = memo(function GridIntro({ cars, onDismiss }: GridIntroProps) {
  const grid = [...cars].sort((a, b) => a.position - b.position);
  return (
    <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(200)} style={StyleSheet.absoluteFill}>
      <Pressable onPress={onDismiss} style={{ flex: 1, backgroundColor: 'rgba(11,12,15,0.94)', paddingTop: spacing.xxl }}>
        <View style={{ alignItems: 'center', gap: 4, marginBottom: spacing.lg }}>
          <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
            Işıklar sönüyor
          </AppText>
          <AppText variant="sectionTitle" color={colors.textPrimary} uppercase>
            Başlangıç gridi
          </AppText>
        </View>
        <ScrollView contentContainerStyle={{ paddingHorizontal: spacing.xl, gap: 6, paddingBottom: spacing.xxl }} showsVerticalScrollIndicator={false}>
          {grid.map((c) => {
            const team = teamByKey(c.teamKey);
            return (
              <View
                key={`${c.teamKey}-${c.driverIdx}`}
                className="flex-row items-center gap-3 rounded-md px-3 py-2"
                style={{ backgroundColor: c.isPlayer ? 'rgba(212,255,61,0.10)' : 'rgba(255,255,255,0.03)' }}
              >
                <AppText variant="label" color={c.isPlayer ? colors.accentLime : colors.textSecondary} style={{ width: 28, fontFamily: 'JetBrainsMono_700Bold' }}>
                  {c.position}
                </AppText>
                <View className="h-4 w-1 rounded-full" style={{ backgroundColor: team.colour }} />
                <AppText variant="label" color={c.isPlayer ? colors.accentLime : colors.textPrimary} style={{ flex: 1 }} numberOfLines={1}>
                  {c.driver}
                </AppText>
                <AppText variant="labelSmall" color={colors.textTertiary}>
                  {team.short}
                </AppText>
              </View>
            );
          })}
        </ScrollView>
        <AppText variant="labelSmall" color={colors.textTertiary} style={{ textAlign: 'center', marginBottom: spacing.lg }} uppercase>
          Devam etmek için dokun
        </AppText>
      </Pressable>
    </Animated.View>
  );
});
