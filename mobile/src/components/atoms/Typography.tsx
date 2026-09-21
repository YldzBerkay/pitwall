import { memo } from 'react';
import { StyleProp, Text, TextProps, TextStyle } from 'react-native';
import { colors, typeScale, type TypeVariant } from '@/theme';
import { useGameStore } from '@/store/gameStore';

interface AppTextProps extends TextProps {
  variant?: TypeVariant;
  color?: string;
  uppercase?: boolean;
  style?: StyleProp<TextStyle>;
}

/**
 * Single typed text primitive. All copy in the app should go through this so
 * fonts, line-heights and tracking stay consistent with the design system.
 * Also applies the user's Ayarlar → text scale preference (accessibility).
 */
export const AppText = memo(function AppText({
  variant = 'body',
  color = colors.textPrimary,
  uppercase,
  style,
  children,
  ...rest
}: AppTextProps) {
  const textScale = useGameStore((s) => s.textScale);
  // iOS `textTransform` follows the system locale and turns "i" into "I"
  // (dotless) for Turkish words; do it ourselves with the Turkish rules.
  const upper = (c: unknown): unknown =>
    typeof c === 'string' ? c.toLocaleUpperCase('tr-TR') : Array.isArray(c) ? c.map(upper) : c;
  const plain = typeof children === 'string' || (Array.isArray(children) && children.every((c) => typeof c === 'string' || typeof c === 'number'));
  const content = uppercase && plain ? (upper(children) as typeof children) : children;
  const base = typeScale[variant];
  const scaled = textScale === 1 ? base : { ...base, fontSize: base.fontSize * textScale, lineHeight: base.lineHeight * textScale };
  return (
    <Text
      style={[scaled, { color }, uppercase && !plain && { textTransform: 'uppercase' }, style]}
      {...rest}
    >
      {content}
    </Text>
  );
});
