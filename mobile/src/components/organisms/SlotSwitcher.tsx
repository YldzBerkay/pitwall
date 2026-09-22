import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { colors, spacing } from '@/theme';
import { AppText, Icon } from '@/components/atoms';
import { useGameStore } from '@/store/gameStore';
import { haptic } from '@/lib/haptics';
import type { SlotView } from '@/lib/api/lobby';

/**
 * The account dropdown from §4.2 — five real slots, in order:
 *
 *   1 ▸ SCUDERIA ROSSA     Sezon 1 · 6/24 · Anadolu #3
 *   2 ▸ boş
 *   3 ▸ APEX RACING        Sezon 2 · 19/24 · Nordschleife #7
 *   4 ▸ 🪙 250 · slot aç
 *   5 ▸ 🪙 250 · slot aç
 *   ───────────────────────
 *   ▸ Genel ekran
 *
 * This replaces the old single-address connect/leave modal outright. There is
 * no server address to type any more: a slot IS the lobby, the server knows
 * which team the account holds in it, and the app follows.
 *
 * An empty slot leads to the general screen rather than doing anything by
 * itself — finding or opening a lobby is that screen's job, and the slot is
 * only spent once a team is chosen there (§3.3).
 */
export function SlotSwitcher({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const authUser = useGameStore((s) => s.auth.user);
  const lobby = useGameStore((s) => s.lobby);
  const refreshSlots = useGameStore((s) => s.refreshSlots);
  const buySlot = useGameStore((s) => s.buySlot);
  const setActiveSlot = useGameStore((s) => s.setActiveSlot);
  const gold = useGameStore((s) => s.gold);
  const [buying, setBuying] = useState<number | undefined>();

  useEffect(() => {
    if (visible && authUser) void refreshSlots();
  }, [visible, authUser, refreshSlots]);

  const go = (path: '/' | '/lobby' | '/auth') => {
    onClose();
    router.push(path);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{ flex: 1, backgroundColor: 'rgba(11,12,15,0.72)', justifyContent: 'center', padding: spacing.lg }}
      >
        <Pressable onPress={() => {}}>
          <View
            className="overflow-hidden rounded-lg border bg-elevated"
            style={{ borderColor: colors.borderDefault }}
          >
            {!authUser ? (
              <Row
                onPress={() => go('/auth')}
                left={<Icon name="profile" size={17} color={colors.textSecondary} />}
                title="Giriş yap"
                subtitle="Slotlar hesaba bağlıdır."
              />
            ) : (
              lobby.slots.map((slot) => (
                <SlotRow
                  key={slot.slotIndex}
                  slot={slot}
                  price={lobby.slotPrice}
                  gold={gold}
                  active={slot.slotIndex === lobby.activeSlotIndex}
                  busy={buying === slot.slotIndex}
                  onOpenGame={() => {
                    setActiveSlot(slot.slotIndex);
                    go('/');
                  }}
                  onFindGame={() => go('/lobby')}
                  onBuy={async () => {
                    setBuying(slot.slotIndex);
                    haptic.medium();
                    await buySlot(slot.slotIndex);
                    setBuying(undefined);
                  }}
                />
              ))
            )}

            <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.borderDefault }} />
            <Row
              onPress={() => go('/lobby')}
              left={<Icon name="chevron" size={17} color={colors.accentLime} />}
              title="Genel ekran"
              subtitle="Hızlı oyun bul · Lobi kur · Davetler"
            />
            {lobby.error && (
              <AppText variant="labelSmall" color={colors.neonCoral} style={{ paddingHorizontal: 14, paddingBottom: 12 }}>
                {lobby.error}
              </AppText>
            )}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function SlotRow({
  slot,
  price,
  gold,
  active,
  busy,
  onOpenGame,
  onFindGame,
  onBuy,
}: {
  slot: SlotView;
  price: number;
  gold: number;
  active: boolean;
  busy: boolean;
  onOpenGame: () => void;
  onFindGame: () => void;
  onBuy: () => void;
}) {
  const index = (
    <AppText variant="labelSmall" color={active ? colors.accentLime : colors.textTertiary}>
      {slot.slotIndex}
    </AppText>
  );

  // Locked slot: price and "slot aç". The 4th and 5th are the only things in
  // the game that Gold alone buys (§1.3) — the price is stated plainly, and
  // the row says when the balance is short rather than failing on tap.
  if (!slot.unlocked) {
    const affordable = gold >= price;
    return (
      <Row
        onPress={affordable && !busy ? onBuy : undefined}
        left={index}
        title={`${price} Altın · slot aç`}
        subtitle={affordable ? 'Kalıcı olarak açılır.' : `Altının yetmiyor (${gold}).`}
        titleColor={affordable ? colors.solarAmber : colors.textTertiary}
        icon="gold"
      />
    );
  }

  // Empty slot.
  if (!slot.lobby) {
    return <Row onPress={onFindGame} left={index} title="boş" subtitle="Oyun bul ya da lobi kur." titleColor={colors.textTertiary} />;
  }

  const { lobby } = slot;
  return (
    <Row
      onPress={onOpenGame}
      left={index}
      title={(lobby.teamName ?? '—').toLocaleUpperCase('tr-TR')}
      subtitle={`Sezon ${lobby.seasonNo} · ${lobby.roundNo}/${lobby.totalRounds} · ${lobby.name}`}
      titleColor={active ? colors.accentLime : colors.textPrimary}
    />
  );
}

function Row({
  left,
  title,
  subtitle,
  onPress,
  titleColor,
  icon,
}: {
  left: React.ReactNode;
  title: string;
  subtitle: string;
  onPress?: () => void;
  titleColor?: string;
  icon?: 'gold';
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title} — ${subtitle}`}
      accessibilityState={{ disabled: !onPress }}
      disabled={!onPress}
      onPress={() => {
        haptic.select();
        onPress?.();
      }}
      className="flex-row items-center px-3.5 py-3"
      style={{ gap: spacing.sm, opacity: onPress ? 1 : 0.55 }}
    >
      <View style={{ width: 14, alignItems: 'center' }}>{left}</View>
      {icon && <Icon name={icon} size={15} color={colors.solarAmber} />}
      <View style={{ flex: 1, gap: 2 }}>
        <AppText variant="label" color={titleColor ?? colors.textPrimary} numberOfLines={1}>
          {title}
        </AppText>
        <AppText variant="labelSmall" color={colors.textTertiary} numberOfLines={1}>
          {subtitle}
        </AppText>
      </View>
    </Pressable>
  );
}
