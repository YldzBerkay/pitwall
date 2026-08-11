import { memo } from 'react';
import { View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, gradients } from '@/theme';
import { AppText } from '@/components/atoms';
import type { Driver } from '@/data/mock';

const categoryColor: Record<Driver['category'], string> = {
  ROOKIE: colors.matrixGreen,
  EXPERIENCED: colors.electricCyan,
  ELITE: colors.cyberPurple,
};

interface PilotAvatarProps {
  driver: Driver;
  size?: number;
}

/** Circular avatar (initials) with a gradient ring and category badge. */
export const PilotAvatar = memo(function PilotAvatar({ driver, size = 56 }: PilotAvatarProps) {
  const initials = driver.name
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const badge = categoryColor[driver.category];

  return (
    <View style={{ width: size, height: size }}>
      <LinearGradient
        colors={gradients.cyan}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <View
          className="items-center justify-center bg-elevated"
          style={{ width: size - 4, height: size - 4, borderRadius: (size - 4) / 2 }}
        >
          <AppText variant="cardTitle" color={colors.textPrimary}>
            {initials}
          </AppText>
        </View>
      </LinearGradient>
      <View
        className="absolute bottom-0 right-0 h-3.5 w-3.5 rounded-full border-2 border-deepspace"
        style={{
          backgroundColor: badge,
          shadowColor: badge,
          shadowOpacity: 0.8,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 0 },
          elevation: 4,
        }}
      />
    </View>
  );
});
