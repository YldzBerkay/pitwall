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
  return (
    <Text
      style={[typeScale[variant], { color }, uppercase && { textTransform: 'uppercase' }, style]}
      {...rest}
    >
      {children}
    </Text>
  );
});
