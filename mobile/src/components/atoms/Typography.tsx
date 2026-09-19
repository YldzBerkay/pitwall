import { memo } from 'react';
import { StyleProp, Text, TextProps, TextStyle } from 'react-native';
import { colors, typeScale, type TypeVariant } from '@/theme';

interface AppTextProps extends TextProps {
  variant?: TypeVariant;
  color?: string;
  uppercase?: boolean;
  style?: StyleProp<TextStyle>;
}

/**
 * Single typed text primitive. All copy in the app should go through this so
 * fonts, line-heights and tracking stay consistent with the design system.
 */
export const AppText = memo(function AppText({
  variant = 'body',
  color = colors.textPrimary,
  uppercase,
  style,
  children,
  ...rest
}: AppTextProps) {
  // iOS `textTransform` follows the system locale and turns "i" into "I"
  // (dotless) for Turkish words; do it ourselves with the Turkish rules.
  const upper = (c: unknown): unknown =>
    typeof c === 'string' ? c.toLocaleUpperCase('tr-TR') : Array.isArray(c) ? c.map(upper) : c;
  const plain = typeof children === 'string' || (Array.isArray(children) && children.every((c) => typeof c === 'string' || typeof c === 'number'));
  const content = uppercase && plain ? (upper(children) as typeof children) : children;
  return (
    <Text
      style={[typeScale[variant], { color }, uppercase && !plain && { textTransform: 'uppercase' }, style]}
      {...rest}
    >
      {content}
    </Text>
  );
});
