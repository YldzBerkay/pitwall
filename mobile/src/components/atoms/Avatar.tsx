import { memo } from 'react';
import { View } from 'react-native';
import { colors } from '@/theme';
import { AppText } from './Typography';

interface AvatarProps {
  /** "A. Kayacan" → "AK". */
  name: string;
  /** Team colour; used as the ring and the tinted fill. */
  colour: string;
  size?: number;
  /** Racing number shown as a small badge. */
  number?: number;
}

/**
 * A driver mark: a squircle tinted with the team colour, initials inside, a
 * number badge on the corner. The reference standings use photo avatars with
 * team badges; without licensed photos, the initials-plus-colour mark reads
 * the same way and stays legal.
 */
export const Avatar = memo(function Avatar({ name, colour, size = 36, number }: AvatarProps) {
  const initials = name
    .replace('.', '')
    .split(' ')
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <View style={{ width: size, height: size }}>
      <View
        className="items-center justify-center"
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.32,
          backgroundColor: `${colour}22`,
          borderWidth: 1.5,
          borderColor: `${colour}AA`,
        }}
      >
        <AppText variant="labelSmall" color={colors.textPrimary} style={{ fontFamily: 'Inter_600SemiBold', fontSize: size * 0.34, lineHeight: size * 0.4 }}>
          {initials}
        </AppText>
      </View>
      {number !== undefined && (
        <View
          className="absolute items-center justify-center rounded-full"
          style={{ right: -4, bottom: -4, minWidth: size * 0.42, height: size * 0.42, paddingHorizontal: 3, backgroundColor: colour, borderWidth: 2, borderColor: colors.bgElevated }}
        >
          <AppText variant="labelSmall" color={colors.onAccent} style={{ fontFamily: 'JetBrainsMono_700Bold', fontSize: size * 0.22, lineHeight: size * 0.26 }}>
            {number}
          </AppText>
        </View>
      )}
    </View>
  );
});
