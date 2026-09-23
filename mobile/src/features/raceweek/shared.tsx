import { Pressable, View } from 'react-native';
import { colors } from '@/theme';
import { AppText } from '@/components/atoms';
import { compoundByKey, compounds, type CompoundKey } from '@pitwall/shared/carCustomisation';
import { teamByKey } from '@pitwall/shared/teams';
import { haptic } from '@/lib/haptics';
import type { GridEntry } from '@pitwall/shared/raceEngine';

/** One option in a segmented choice. */
export function Chip({
  label,
  selected,
  onPress,
  tint = colors.accentLime,
  disabled,
  compact,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  tint?: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={() => {
        haptic.select();
        onPress();
      }}
      className={`items-center justify-center rounded-md border ${compact ? 'px-2.5 py-1.5' : 'flex-1 px-1 py-2.5'}`}
      style={{
        borderColor: selected ? tint : colors.borderDefault,
        backgroundColor: selected ? `${tint}1F` : 'transparent',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <AppText
        variant="labelSmall"
        color={selected ? tint : colors.textSecondary}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.75}
        style={{ fontFamily: 'Inter_600SemiBold' }}
      >
        {label}
      </AppText>
    </Pressable>
  );
}

/** Chip labels: full names wrap in a narrow card, so use the paddock shorthand. */
export const compoundLabel: Record<CompoundKey, string> = {
  SOFT: 'Yumuşak',
  MEDIUM: 'Orta',
  HARD: 'Sert',
  INTERMEDIATE: 'Geçiş',
  WET: 'Yağmur',
};

/** The five compounds as coloured chips. */
export function CompoundPicker({
  value,
  onChange,
  compact,
}: {
  value: CompoundKey;
  onChange: (key: CompoundKey) => void;
  compact?: boolean;
}) {
  return (
    <View className="flex-row gap-1.5">
      {compounds.map((c) => (
        <Chip
          key={c.key}
          label={compact ? c.short : compoundLabel[c.key]}
          selected={c.key === value}
          tint={c.band}
          compact={compact}
          onPress={() => onChange(c.key)}
        />
      ))}
    </View>
  );
}

/** Small coloured letter for a compound in a timing row. */
export function CompoundDot({ compound }: { compound: CompoundKey }) {
  const c = compoundByKey(compound);
  return (
    <View
      className="h-4 w-4 items-center justify-center rounded-full"
      style={{ borderWidth: 1.5, borderColor: c.band }}
    >
      <AppText variant="labelSmall" color={c.band} style={{ fontSize: 9, lineHeight: 11, fontFamily: 'Inter_600SemiBold' }}>
        {c.short}
      </AppText>
    </View>
  );
}

/** Team colour bar + driver name, the unit every list on the weekend is built from. */
export function DriverCell({ entry, dim, showTeam = true, surname }: { entry: GridEntry; dim?: boolean; showTeam?: boolean; surname?: boolean }) {
  const team = teamByKey(entry.teamKey);
  const name = surname ? entry.driver.split(' ').slice(1).join(' ') || entry.driver : entry.driver;
  return (
    <View className="flex-1 flex-row items-center gap-2">
      <View className="h-3.5 w-1 rounded-full" style={{ backgroundColor: team.colour, opacity: dim ? 0.4 : 1 }} />
      <AppText
        variant="labelSmall"
        color={team.isPlayer ? colors.accentLime : dim ? colors.textTertiary : colors.textPrimary}
        numberOfLines={1}
        style={{ flex: 1 }}
      >
        {name}
      </AppText>
      {showTeam && (
        <AppText variant="labelSmall" color={colors.textTertiary} style={{ fontFamily: 'JetBrainsMono_700Bold', fontSize: 10 }}>
          {team.short}
        </AppText>
      )}
    </View>
  );
}

/** Position number, monospaced, lit for the player. */
export function Pos({ n, lit, width = 24 }: { n: number | string; lit?: boolean; width?: number }) {
  return (
    <AppText
      variant="labelSmall"
      color={lit ? colors.accentLime : colors.textSecondary}
      style={{ width, fontFamily: 'JetBrainsMono_700Bold' }}
    >
      {n}
    </AppText>
  );
}

export const fmtSec = (sec: number): string => {
  if (!Number.isFinite(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m > 0 ? `${m}:${s.toFixed(3).padStart(6, '0')}` : s.toFixed(3);
};

export const fmtGap = (sec?: number): string =>
  sec === undefined ? 'DNF' : sec === 0 ? 'LİDER' : `+${sec.toFixed(1)}`;

/**
 * Player-facing text for a rejected `/race/weekend-choices` (or check-in)
 * call. `wrong_phase` is the rule working — the lights are already out for
 * this weekend, so the choice can no longer reach the frozen race recipe —
 * not an error the player caused, and it must never be shown as "something
 * went wrong" (that reads as retriable, and it isn't).
 */
export const weekendChoiceErrorText = (code: string): string => {
  switch (code) {
    case 'wrong_phase':
      return 'Işıklar zaten söndü — bu hafta sonu için tercih artık değişmez.';
    case 'not_signed_in':
      return 'Oturumun yok — bu tercih kaydedilmedi.';
    case 'forbidden':
      return 'Bu lobide koltuğun yok.';
    default:
      return `Tercih kaydedilemedi: ${code}`;
  }
};
