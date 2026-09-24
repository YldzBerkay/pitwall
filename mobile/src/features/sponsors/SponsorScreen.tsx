import { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { colors, spacing } from '@/theme';
import { AppText, GlassCard, Cols, ScreenHeader } from '@/components/atoms';
import { CarIllustration } from '@/components/organisms';
import {
  brandByKey,
  durationRate,
  slotByKey,
  sponsorSlots,
  streakMultiplier,
  standingFactor,
  tierRank,
  type SlotKey,
  type SponsorOffer,
} from '@pitwall/shared/sponsors';
import { useGameStore } from '@/store/gameStore';
import { displaySponsors } from '@/store/slices/sponsorsDisplay';
import { haptic } from '@/lib/haptics';
import { sfx } from '@/lib/sfx';
import { useShellLayout } from '@/lib/useShellLayout';

/**
 * Server error codes from `/sponsors/sign` and `/sponsors/release`, kept
 * distinct - never flattened into one generic failure string
 * (`sponsorsApiSlice.ts`'s own rule). `slot_taken` ("someone signed that
 * position first") and `offer_not_found` ("that offer rolled off your
 * table - the round moved on") need different words: the second one is a
 * normal, expected thing that happens when the round rolls over, not a
 * bug. Falls back to the raw code for anything unmapped.
 */
const sponsorErrorText: Record<string, string> = {
  slot_taken: 'O alanı biri senden önce aldı.',
  offer_not_found: 'Bu teklif artık masanda değil - sıra yenilendi.',
  not_signed: 'Bu alanda sözleşmen yok.',
  no_lobby: 'Lig bulunamadı.',
  forbidden: 'Bu takımda yetkin yok.',
  invalid_request: 'Geçersiz istek.',
  not_signed_in: 'Oturum açık değil.',
};

const tierLabel: Record<string, string> = {
  title: 'ana sponsor',
  primary: 'ana alan',
  secondary: 'yan alan',
  minor: 'küçük alan',
};

const prestigeLabel: Record<string, string> = {
  global: 'Küresel',
  national: 'Ulusal',
  regional: 'Bölgesel',
  local: 'Yerel',
};

/**
 * Sponsorluk — the commercial side of the team.
 *
 * The car shows which of its eight branding slots are sold. Offers arrive each
 * race weekend; both who offers and how much they pay follow the team's
 * championship position, so climbing the table is what unlocks the big money.
 */
export function SponsorScreen() {
  const shell = useShellLayout();
  // The app's own "are we seated in a lobby" signal - the same one
  // `raceSlice.ts`'s `displayRace`/`displayQualifying` and
  // `factoryDisplay.ts`'s `displayFactory` key off, not
  // `sponsorsApi.lobbyId` (only set after the first successful call).
  const lobbyId = useGameStore((s) => s.race.lobbyId);
  const sponsorsApi = useGameStore((s) => s.sponsorsApi);
  const {
    championshipPosition,
    lastSettlement,
    livery,
    compound,
    rim,
    spokes,
    round,
    totalRounds,
    season,
  } = useGameStore();
  const [carWidth, setCarWidth] = useState(0);
  const [message, setMessage] = useState<string | undefined>(undefined);
  // Declining an offer has no server counterpart - there's nothing to sign
  // or pay for, so it's a purely local "hide this from my sheet this
  // session" preference, not economy state. Kept in component state rather
  // than the store for exactly that reason: it carries no money and
  // doesn't need to survive a remount.
  const [declinedIds, setDeclinedIds] = useState<string[]>([]);

  useEffect(() => {
    if (lobbyId) void useGameStore.getState().sponsorsApi.hydrateOffers(lobbyId);
  }, [lobbyId]);

  const display = displaySponsors(lobbyId, sponsorsApi);

  const sheet: SponsorOffer[] = display.kind === 'ready'
    ? display.offers.filter((o) => !declinedIds.includes(o.id))
    : [];
  // `sponsorships` is `null` until a sign/release response has landed this
  // session - `GET /sponsors/offers` doesn't return them (see
  // `sponsorsDisplay.ts`'s doc comment on that server gap). Treated as
  // "none known yet", never as "none signed".
  const sponsorships = display.kind === 'ready' ? display.sponsorships ?? [] : [];
  const income = sponsorships.reduce((sum, s) => sum + s.perRace, 0);
  const potential = sponsorships.reduce((sum, s) => sum + s.perRace + s.bonus, 0);
  const factor = standingFactor(championshipPosition);

  const onSign = async (offer: SponsorOffer) => {
    if (!lobbyId) return;
    const outcome = await useGameStore.getState().sponsorsApi.sign(lobbyId, offer.id);
    if (outcome.ok) {
      haptic.success();
      sfx.play('partFitted');
      setMessage(undefined);
    } else {
      haptic.error();
      sfx.play('denied');
      setMessage(sponsorErrorText[outcome.error] ?? outcome.error);
    }
  };

  const onDecline = (offer: SponsorOffer) => {
    haptic.select();
    setDeclinedIds((ids) => [...ids, offer.id]);
  };

  const onRelease = async (slot: SlotKey) => {
    if (!lobbyId) return;
    haptic.warning();
    sfx.play('denied');
    const outcome = await useGameStore.getState().sponsorsApi.release(lobbyId, slot);
    if (!outcome.ok) setMessage(sponsorErrorText[outcome.error] ?? outcome.error);
  };

  // Paid out by the race weekend (RaceWeekScreen); this screen only shows it.
  const settlement = lastSettlement
    ? `Son yarış (${lastSettlement.round}.): +${lastSettlement.income} RP, ${lastSettlement.prize} RP'si yarış ödülü` +
      (lastSettlement.bonusesEarned.length
        ? ` · hedef bonusu: ${lastSettlement.bonusesEarned.map((k) => brandByKey(k)?.short).filter(Boolean).join(', ')}`
        : '') +
      (lastSettlement.streaksBroken.length
        ? ` · seri bozuldu: ${lastSettlement.streaksBroken.map((k) => brandByKey(k)?.short).filter(Boolean).join(', ')}`
        : '') +
      (lastSettlement.expired.length ? ` · ${lastSettlement.expired.length} sözleşme bitti` : '')
    : null;

  // NO LOCAL FALLBACK: outside a lobby there is no server sheet to ask for,
  // and this screen must say so rather than render the old local
  // `sponsorships`/`offers()` numbers - see `sponsorsDisplay.ts`'s doc
  // comment for why that would be the exact second-reality bug this
  // migration exists to remove.
  if (display.kind === 'no-lobby') {
    return (
      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingTop: shell.contentTop,
          paddingLeft: shell.contentPaddingLeft,
          paddingRight: shell.contentPaddingRight,
          paddingBottom: shell.contentPaddingBottom,
          gap: spacing.lg,
        }}
        showsVerticalScrollIndicator={false}
      >
        <ScreenHeader icon="sponsors" title="Sponsorluk" subtitle="Bir lige katılınca sponsorluk masası burada açılır." />
        <GlassCard>
          <AppText variant="bodySmall" color={colors.textSecondary}>
            Şu anda bir lige bağlı değilsin. Sponsorluk teklifleri ve sözleşmeler sunucudan, ligin kendi
            sıralamasına göre gelir - bir lige katıldığında burada görünecekler.
          </AppText>
        </GlassCard>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      className="flex-1"
      contentContainerStyle={{
        paddingTop: shell.contentTop,
        paddingLeft: shell.contentPaddingLeft,
        paddingRight: shell.contentPaddingRight,
        paddingBottom: shell.contentPaddingBottom,
        gap: spacing.lg,
      }}
      showsVerticalScrollIndicator={false}
    >
      <ScreenHeader
        eyebrow={`Sezon ${season} · ${round}/${totalRounds} yarış · araçta ${sponsorships.length}/${sponsorSlots.length} reklam alanı dolu`}
        icon="sponsors"
        title="Sponsorluk"
        subtitle="Ücret her yarış koşulsuz ödenir; hedefi tutturursan bonus gelir. Sıran yükseldikçe teklifler büyür."
      />
      <View className="flex-row flex-wrap" style={{ gap: 8 }}>
        <Metric label="Şampiyonada" value={`${championshipPosition}.`} />
        <Metric label="Sponsor teklif çarpanı" value={`×${factor.toFixed(2).replace('.', ',')}`} />
        <Metric label="Yarış başına garanti" value={`${income} RP`} tint={colors.accentLime} />
        <Metric label="Hedef tutarsa" value={`${potential} RP`} />
      </View>

      {settlement && (
        <View className="rounded-md border border-border-active bg-accent-soft px-3 py-2">
          <AppText variant="labelSmall" color={colors.accentLime}>
            {settlement}
          </AppText>
        </View>
      )}

      {message && (
        <View className="rounded-md border border-border-default px-3 py-2">
          <AppText variant="labelSmall" color={colors.neonCoral}>
            {message}
          </AppText>
        </View>
      )}

      {display.kind === 'loading' && (
        <GlassCard>
          <AppText variant="bodySmall" color={colors.textSecondary}>
            Sponsorluk masası yükleniyor…
          </AppText>
        </GlassCard>
      )}

      {/* Car with the sold slots marked */}
      <View
        className="items-center overflow-hidden rounded-lg border border-border-default py-3"
        style={{ backgroundColor: '#050506' }}
        onLayout={(e) => setCarWidth(e.nativeEvent.layout.width)}
      >
        {carWidth > 0 && (
          <CarIllustration
            motor={67}
            aero={58}
            grip={72}
            width={Math.min(carWidth - spacing.lg * 2, 560)}
            livery={livery}
            compound={compound}
            rim={rim}
            spokes={spokes}
            sponsorships={sponsorships}
          />
        )}
      </View>

      <Cols align="flex-start" weights={[1.25, 1]}>
        {/* Offer sheet */}
        <View style={{ flex: 1, gap: spacing.sm }}>
          <AppText variant="cardTitle" color={colors.textPrimary}>
            Bu hafta gelen teklifler
          </AppText>
          {sheet.length === 0 ? (
            <GlassCard>
              <AppText variant="bodySmall" color={colors.textSecondary}>
                Bu hafta yeni teklif yok. Tüm alanlar dolu ya da mevcut sıralamada marka
                ilgisi düşük — sıralamayı yükseltmek daha iyi teklifler getirir.
              </AppText>
            </GlassCard>
          ) : (
            sheet.map((offer) => (
              <OfferCard
                key={offer.id}
                offer={offer}
                onSign={() => onSign(offer)}
                onDecline={() => onDecline(offer)}
              />
            ))
          )}
        </View>

        {/* Slot map */}
        <View className="flex-1" style={{ gap: spacing.sm }}>
          <AppText variant="cardTitle" color={colors.textPrimary}>
            Araç üzerindeki alanlar
          </AppText>
          {[...sponsorSlots]
            .sort((a, b) => tierRank[b.tier] - tierRank[a.tier])
            .map((slot) => {
              const deal = sponsorships.find((s) => s.slot === slot.key);
              const brand = deal ? brandByKey(deal.brandKey) : undefined;
              return (
                <View
                  key={slot.key}
                  className="flex-row items-center gap-2.5 rounded-md border bg-elevated px-3 py-2.5"
                  style={{
                    borderColor: deal ? colors.borderActive : colors.borderDefault,
                  }}
                >
                  <View
                    className="h-7 w-7 items-center justify-center rounded-sm"
                    style={{ backgroundColor: brand?.color ?? 'rgba(255,255,255,0.06)' }}
                  >
                    <AppText
                      variant="labelSmall"
                      color={brand ? colors.onAccent : colors.textTertiary}
                      style={{ fontSize: 10 }}
                    >
                      {brand ? brand.name.slice(0, 2) : '—'}
                    </AppText>
                  </View>
                  <View className="flex-1">
                    <AppText variant="labelSmall" color={colors.textPrimary} uppercase numberOfLines={1}>
                      {slot.label}
                    </AppText>
                    <AppText variant="labelSmall" color={colors.textTertiary} style={{ fontSize: 10 }}>
                      {tierLabel[slot.tier]}
                      {brand ? ` · ${brand.name}` : ' · boş'}
                      {/* A running streak is the thing worth protecting: it is
                          what turns the next target finish into real money. */}
                      {deal && deal.streak > 0 ? ` · seri ${deal.streak}/${deal.streakTarget}` : ''}
                    </AppText>
                  </View>
                  {deal ? (
                    <>
                      <View className="items-end">
                        <AppText variant="statSmall" color={colors.accentLime} style={{ fontSize: 12 }}>
                          {deal.perRace}
                        </AppText>
                        <AppText variant="labelSmall" color={colors.textTertiary} style={{ fontSize: 9 }}>
                          {deal.expiresRound}. yarışa kadar
                        </AppText>
                      </View>
                      <Pressable
                        onPress={() => onRelease(slot.key)}
                        hitSlop={6}
                        className="rounded-sm border border-border-default px-2 py-1"
                      >
                        <AppText variant="labelSmall" color={colors.neonCoral} style={{ fontSize: 9 }}>
                          BİTİR
                        </AppText>
                      </Pressable>
                    </>
                  ) : (
                    <AppText variant="labelSmall" color={colors.textTertiary} style={{ fontSize: 10 }}>
                      {slot.baseValue} temel
                    </AppText>
                  )}
                </View>
              );
            })}
        </View>
      </Cols>
    </ScrollView>
  );
}

function Metric({ label, value, tint = colors.textPrimary }: { label: string; value: string; tint?: string }) {
  return (
    <View className="rounded-md px-3 py-2" style={{ minWidth: '47%', flexGrow: 1, backgroundColor: 'rgba(255,255,255,0.04)' }}>
      <AppText variant="statSmall" color={tint} style={{ fontSize: 16 }}>
        {value}
      </AppText>
      <AppText variant="labelSmall" color={colors.textTertiary} style={{ fontSize: 11 }}>
        {label}
      </AppText>
    </View>
  );
}

interface OfferCardProps {
  offer: SponsorOffer;
  onSign: () => void;
  onDecline: () => void;
}

function OfferCard({ offer, onSign, onDecline }: OfferCardProps) {
  const brand = brandByKey(offer.brandKey);
  const slots = offer.slots.map(slotByKey);
  if (!brand) return null;

  const total = offer.signing + offer.perRace * offer.rounds;
  const headline = slots[0];

  return (
    <View
      className="rounded-md border bg-elevated px-4 py-3"
      style={{ gap: spacing.sm, borderColor: colors.borderDefault }}
    >
      {offer.renewalOf && (
        <View className="flex-row">
          <View
            className="rounded-sm px-2 py-0.5"
            style={{ backgroundColor: colors.accentSoft }}
          >
            <AppText variant="labelSmall" color={colors.accentLime} uppercase style={{ fontSize: 9 }}>
              Yenileme teklifi
            </AppText>
          </View>
        </View>
      )}
      <View className="flex-row items-center gap-2.5">
        <View
          className="h-9 w-9 items-center justify-center rounded-sm"
          style={{ backgroundColor: brand.color }}
        >
          <AppText variant="labelSmall" color={colors.onAccent} style={{ fontSize: 11 }}>
            {brand.name.slice(0, 2)}
          </AppText>
        </View>
        <View className="flex-1">
          <AppText variant="label" color={colors.textPrimary} numberOfLines={1}>
            {brand.name}
          </AppText>
          <AppText variant="labelSmall" color={colors.textTertiary} style={{ fontSize: 10 }}>
            {brand.sector} · {prestigeLabel[brand.prestige]} ·{' '}
            {slots.length > 1 ? `${slots.length} reklam alanı ister` : `${headline.label} (${tierLabel[headline.tier]})`}
          </AppText>
        </View>
        <View className="items-end">
          <AppText variant="statSmall" color={colors.accentLime}>
            {total}
          </AppText>
          <AppText variant="labelSmall" color={colors.textTertiary} uppercase style={{ fontSize: 9 }}>
            toplam RP
          </AppText>
        </View>
      </View>

      {/* Which positions the contract takes, and what each one is worth — a
          package is indivisible, so the player has to see the whole bill. */}
      <View className="flex-row flex-wrap" style={{ gap: spacing.xs }}>
        {slots.map((slot, i) => (
          <View
            key={slot.key}
            className="rounded-sm px-2 py-1"
            style={{ backgroundColor: colors.bgSurface2 }}
          >
            <AppText variant="labelSmall" color={colors.textSecondary} style={{ fontSize: 10 }}>
              {slot.label}
            </AppText>
            <AppText variant="labelSmall" color={colors.textTertiary} style={{ fontSize: 9 }}>
              {offer.perSlot[i]} RP · {tierLabel[slot.tier]}
            </AppText>
          </View>
        ))}
      </View>

      <View className="flex-row flex-wrap" style={{ gap: spacing.sm }}>
        <Term label="İmza parası" value={`${offer.signing} RP`} />
        <Term label="Yarış başına" value={`${offer.perRace} RP`} tint={colors.accentLime} />
        {/* A short contract costs the brand more per race, so it pays more —
            the flexibility is what the player is selling. */}
        <Term
          label="Süre · kısa sözleşme çarpanı"
          value={`${offer.rounds} yarış · ×${String(durationRate(offer.rounds)).replace('.', ',')}`}
        />
        <Term label="Hedef bitiş" value={offer.targetPosition <= 3 ? 'Podyum' : `${offer.targetPosition}. ve üstü`} tint={colors.solarAmber} />
        <Term label="Hedef tutarsa bonus" value={`+${offer.bonus} RP`} tint={colors.accentLime} />
        <Term
          label={`${offer.streakTarget} yarış üst üste tutarsa`}
          value={`bonus ×${String(streakMultiplier(offer.streakTarget, offer.streakTarget)).replace('.', ',')}`}
        />
      </View>

      <View className="flex-row gap-2">
        <Pressable
          onPress={onSign}
          className="flex-1 items-center rounded-sm border border-border-active bg-accent-soft py-2"
        >
          <AppText variant="labelSmall" color={colors.accentLime} uppercase>
            İmzala
          </AppText>
        </Pressable>
        <Pressable
          onPress={onDecline}
          className="items-center rounded-sm border border-border-default px-4 py-2"
        >
          <AppText variant="labelSmall" color={colors.textSecondary} uppercase>
            Reddet
          </AppText>
        </Pressable>
      </View>
    </View>
  );
}

function Term({ label, value, tint = colors.textSecondary }: { label: string; value: string; tint?: string }) {
  return (
    <View className="rounded-sm border border-border-default px-2 py-1">
      <AppText variant="labelSmall" color={colors.textTertiary} uppercase style={{ fontSize: 9 }}>
        {label}
      </AppText>
      <AppText variant="labelSmall" color={tint} style={{ fontSize: 11 }}>
        {value}
      </AppText>
    </View>
  );
}
