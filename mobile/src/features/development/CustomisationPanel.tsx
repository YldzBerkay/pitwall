import { Pressable, ScrollView, View } from 'react-native';
import { colors, spacing } from '@/theme';
import { AppText } from '@/components/atoms';
import {
  compounds,
  liveries,
  liveryByKey,
  resolveRimColor,
  rims,
  spokeStyles,
  type CompoundKey,
  type SpokeStyle,
} from '@pitwall/shared/carCustomisation';
import { useGameStore } from '@/store/gameStore';
import { haptic } from '@/lib/haptics';
import { sfx } from '@/lib/sfx';

/**
 * Garage customisation: livery, tyre compound, rim finish and spoke pattern.
 * Every choice repaints the car on the stage immediately — the swatches show
 * the actual colours that will be used, including the compound sidewall
 * colours F1 uses (red soft, yellow medium, white hard, green inter, blue wet).
 */
export function CustomisationPanel() {
  const { livery, compound, rim, spokes, setLivery, setCompound, setRim, setSpokes } =
    useGameStore();
  const activeLivery = liveryByKey(livery);

  const pick = (fn: () => void) => {
    haptic.select();
    sfx.play('spark');
    fn();
  };

  return (
    <View style={{ gap: spacing.md }}>
      <Row label="Renk düzeni">
        {liveries.map((l) => (
          <Swatch
            key={l.key}
            selected={l.key === livery}
            onPress={() => pick(() => setLivery(l.key))}
            label={l.label}
          >
            <View className="flex-row overflow-hidden rounded-full" style={{ width: 34, height: 18 }}>
              <View style={{ flex: 2, backgroundColor: l.primary }} />
              <View style={{ flex: 1, backgroundColor: l.secondary }} />
              <View style={{ flex: 1, backgroundColor: l.accent }} />
            </View>
          </Swatch>
        ))}
      </Row>

      <Row label="Lastik bileşimi">
        {compounds.map((c) => (
          <Swatch
            key={c.key}
            selected={c.key === compound}
            onPress={() => pick(() => setCompound(c.key as CompoundKey))}
            label={c.label}
          >
            <View
              className="items-center justify-center rounded-full"
              style={{
                width: 26,
                height: 26,
                borderWidth: 4,
                borderColor: c.band,
                backgroundColor: '#141518',
              }}
            >
              <AppText variant="labelSmall" color={c.band} style={{ fontSize: 9 }}>
                {c.short}
              </AppText>
            </View>
          </Swatch>
        ))}
      </Row>

      <Row label="Jant rengi">
        {rims.map((r) => (
          <Swatch
            key={r.key}
            selected={r.key === rim}
            onPress={() => pick(() => setRim(r.key))}
            label={r.label}
          >
            <View
              className="rounded-full"
              style={{
                width: 24,
                height: 24,
                borderWidth: 4,
                borderColor: resolveRimColor(r, activeLivery),
                backgroundColor: '#0E0F12',
              }}
            />
          </Swatch>
        ))}
      </Row>

      <Row label="Jant deseni">
        {spokeStyles.map((s) => (
          <Swatch
            key={s.key}
            selected={s.key === spokes}
            onPress={() => pick(() => setSpokes(s.key as SpokeStyle))}
            label={s.label}
          >
            <SpokePreview
              count={s.count}
              color={resolveRimColor(rims.find((r) => r.key === rim) ?? rims[0], activeLivery)}
            />
          </Swatch>
        ))}
      </Row>
    </View>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: spacing.sm }}>
      <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
        {label}
      </AppText>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: spacing.sm, paddingRight: spacing.sm }}
      >
        {children}
      </ScrollView>
    </View>
  );
}

interface SwatchProps {
  selected: boolean;
  onPress: () => void;
  label: string;
  children: React.ReactNode;
}

function Swatch({ selected, onPress, label, children }: SwatchProps) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      className="items-center gap-1 rounded-md border px-2.5 py-2"
      style={{
        borderColor: selected ? colors.accentLime : colors.borderDefault,
        backgroundColor: selected ? colors.accentSoft : 'transparent',
        minWidth: 58,
      }}
    >
      {children}
      <AppText
        variant="labelSmall"
        color={selected ? colors.accentLime : colors.textTertiary}
        numberOfLines={1}
        style={{ fontSize: 9 }}
      >
        {label}
      </AppText>
    </Pressable>
  );
}

/** Tiny spoke-star preview so the pattern choice is visible before applying. */
function SpokePreview({ count, color }: { count: number; color: string }) {
  const size = 24;
  const half = size / 2;
  return (
    <View style={{ width: size, height: size }}>
      <View
        className="absolute rounded-full"
        style={{ width: size, height: size, borderWidth: 2, borderColor: color }}
      />
      {Array.from({ length: count }, (_, i) => {
        const angle = (180 * i) / count;
        return (
          <View
            key={i}
            style={{
              position: 'absolute',
              left: half - 0.6,
              top: 2,
              width: 1.2,
              height: size - 4,
              backgroundColor: color,
              transform: [{ rotate: `${angle}deg` }],
            }}
          />
        );
      })}
    </View>
  );
}
