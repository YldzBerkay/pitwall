import { Pressable, View } from 'react-native';
import { colors, spacing } from '@/theme';
import { AppText, GlassButton, GlassCard, Icon } from '@/components/atoms';
import { haptic } from '@/lib/haptics';
import type { SeatOffer } from '@/lib/api/lobby';

export const DIFFICULTY_LABEL: Record<string, string> = {
  easy: 'Kolay AI',
  normal: 'Normal AI',
  hard: 'Zor AI',
};

export const DIFFICULTY_MULTIPLIER: Record<string, string> = {
  easy: 'rütbe ×0.7',
  normal: 'rütbe ×1.0',
  hard: 'rütbe ×1.4',
};

/** "her gün 21:00" from the server's next-race timestamp. */
export function raceTimeLabel(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `her gün ${hh}:${mm}`;
}

/**
 * One free seat, exactly as §3.3 prints it:
 *
 *     MERIDIAN GP     araç 81   hedef P5  →  850 rütbe puanı
 *
 * The objective AND what it pays are on the row on purpose — the player is
 * about to spend a slot, and they should be able to see what they are signing
 * up for before they do, not after.
 */
function SeatRow({ seat, onPick }: { seat: SeatOffer; onPick?: (teamKey: string) => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${seat.teamName} · araç ${seat.carRating} · hedef P${seat.objective} · ${seat.rankPoints} rütbe puanı`}
      disabled={!onPick}
      onPress={() => {
        haptic.medium();
        onPick?.(seat.teamKey);
      }}
      className="flex-row items-center"
      style={{
        gap: spacing.sm,
        paddingVertical: spacing.sm,
        borderTopWidth: 1,
        borderTopColor: colors.borderDefault,
        opacity: onPick ? 1 : 0.5,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <AppText variant="label" color={colors.textPrimary} uppercase numberOfLines={1}>
          {seat.teamName}
        </AppText>
        <View className="flex-row items-center" style={{ gap: spacing.sm }}>
          <AppText variant="labelSmall" color={colors.textSecondary}>
            araç {seat.carRating}
          </AppText>
          <AppText variant="labelSmall" color={colors.textSecondary}>
            hedef P{seat.objective}
          </AppText>
          <View className="flex-row items-center" style={{ gap: 3 }}>
            <Icon name="chevron" size={11} color={colors.textTertiary} />
            <AppText variant="labelSmall" color={colors.accentLime}>
              {seat.rankPoints} rütbe puanı
            </AppText>
          </View>
        </View>
      </View>
      <AppText variant="labelSmall" color={colors.accentLime} uppercase>
        Seç
      </AppText>
      <Icon name="chevron" size={16} color={colors.accentLime} />
    </Pressable>
  );
}

export interface TeamSelectProps {
  /** Lobby name, the card's headline. */
  title: string;
  /** "EU · her gün 21:00" — region and race hour. */
  meta: string;
  /** "Sezon 1 · 14/24. yarış · Zor AI (rütbe ×1.4)" */
  status: string;
  /**
   * Real seat counts. These come straight from the server's seat rows and
   * must be rendered as they arrive — never rounded up, never held back to
   * make a lobby look busier (§3.4: no fake scarcity).
   */
  occupancy?: { humans: number; ai: number };
  seats: SeatOffer[];
  onPick: (teamKey: string) => void;
  /** "Başka bul" — free and unlimited; absent when there is nothing else to find. */
  onAnother?: () => void;
  onCancel: () => void;
  busy?: boolean;
}

/**
 * The team-selection screen (§3.3). This is the commitment point of the whole
 * flow: everything before it — finding a lobby, opening one, pressing "Başka
 * bul" — costs nothing and reserves nothing. A SLOT IS SPENT ONLY WHEN A TEAM
 * IS PICKED HERE.
 */
export function TeamSelect({
  title,
  meta,
  status,
  occupancy,
  seats,
  onPick,
  onAnother,
  onCancel,
  busy,
}: TeamSelectProps) {
  return (
    <GlassCard contentStyle={{ gap: spacing.sm }}>
      <View className="flex-row items-start justify-between" style={{ gap: spacing.sm }}>
        <AppText variant="cardTitle" color={colors.textPrimary} uppercase numberOfLines={2} style={{ flex: 1 }}>
          {title}
        </AppText>
        <AppText variant="labelSmall" color={colors.textTertiary} numberOfLines={1}>
          {meta}
        </AppText>
      </View>

      <AppText variant="bodySmall" color={colors.textSecondary}>
        {status}
      </AppText>

      {occupancy && (
        <AppText variant="labelSmall" color={colors.textTertiary}>
          {occupancy.humans} insan · {occupancy.ai} AI
        </AppText>
      )}

      <AppText variant="labelSmall" color={colors.textTertiary} uppercase style={{ marginTop: spacing.xs }}>
        Sana kalan takımlar
      </AppText>
      <View>
        {seats.map((seat) => (
          <SeatRow key={seat.teamKey} seat={seat} onPick={busy ? undefined : onPick} />
        ))}
        {seats.length === 0 && (
          <AppText variant="bodySmall" color={colors.textTertiary}>
            Bu lobide boş takım kalmamış.
          </AppText>
        )}
      </View>

      <View className="flex-row" style={{ gap: spacing.sm, marginTop: spacing.xs }}>
        {onAnother && (
          <View style={{ flex: 1 }}>
            <GlassButton label="Başka bul" variant="outline" onPress={onAnother} disabled={busy} />
          </View>
        )}
        <View style={{ flex: 1 }}>
          <GlassButton label="Vazgeç" variant="outline" onPress={onCancel} disabled={busy} />
        </View>
      </View>
      <AppText variant="labelSmall" color={colors.textTertiary}>
        Slot yalnızca takım seçtiğinde harcanır. Başka bul bedava ve sınırsız.
      </AppText>
    </GlassCard>
  );
}
