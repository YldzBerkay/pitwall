import { memo } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { colors, spacing } from '@/theme';
import { AppText } from './Typography';
import { GlassCard } from './GlassCard';
import { GlassButton } from './GlassButton';

interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  message?: string;
  /** Defaults to "Onayla" — pass e.g. "Sil", "Çık" for the destructive label. */
  confirmLabel?: string;
  cancelLabel?: string;
  /** True paints the confirm button as danger instead of the accent gradient. */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Blocking confirmation for destructive/irreversible actions only (quit,
 * delete, cancel a contract). Do not use for routine choices — the guide's
 * "modal fatigue" warning applies: every one of these should be rare.
 */
export const ConfirmDialog = memo(function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel = 'Onayla',
  cancelLabel = 'Vazgeç',
  destructive,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable
        onPress={onCancel}
        style={{ flex: 1, backgroundColor: 'rgba(11,12,15,0.72)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl }}
      >
        <Pressable onPress={() => {}}>
          <GlassCard active={destructive} style={{ maxWidth: 360 }} contentStyle={{ gap: spacing.md }}>
            <AppText variant="cardTitle" color={colors.textPrimary}>
              {title}
            </AppText>
            {message && (
              <AppText variant="bodySmall" color={colors.textSecondary}>
                {message}
              </AppText>
            )}
            <View style={{ flexDirection: 'row', gap: spacing.sm, justifyContent: 'flex-end' }}>
              <GlassButton label={cancelLabel} variant="ghost" onPress={onCancel} />
              <GlassButton
                label={confirmLabel}
                variant={destructive ? 'outline' : 'primary'}
                onPress={onConfirm}
                style={destructive ? { borderColor: colors.neonCoral } : undefined}
              />
            </View>
          </GlassCard>
        </Pressable>
      </Pressable>
    </Modal>
  );
});
