import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';
import { colors, spacing } from '@/theme';
import { AppText, GlassButton, GlassCard, NeonStatChip, Cols, ScreenHeader, SegmentTabs } from '@/components/atoms';
import { useShellLayout } from '@/lib/useShellLayout';
import { haptic } from '@/lib/haptics';
import { sfx } from '@/lib/sfx';
import { useGameStore } from '@/store/gameStore';
import { Chip } from '@/features/raceweek/shared';
import { ADS_PER_DAY, goldPacks, goldPrices, rpPrices } from '@pitwall/shared/economy';
import { hiringFee, staffRoles, type StaffRole } from '@pitwall/shared/staff';
import { SPY_COOLDOWN_MS, SPY_RESOLVE_MS, agentProfiles, type AgentKind } from '@pitwall/shared/espionage';
import { formatDuration } from '@pitwall/shared/carCustomisation';
import {
  contractTerms,
  contractWage,
  driverStatKeys,
  renewalCost,
  signingCost,
  trainingGain,
  saleValue,
  SQUAD_MIN,
  SQUAD_MAX,
  type DriverStatKey,
  type StatKey,
} from '@pitwall/shared/driverMarket';
import { overallOf, teams, teamByKey } from '@pitwall/shared/teams';
import { explainPace } from '@pitwall/shared/raceEngine';
import { trackForRound } from '@pitwall/shared/tracks';
import { adsAvailable, showRewardedAd } from '@/lib/monetization/ads';
import { fetchPackPrices, iapAvailable, purchaseGoldPack } from '@/lib/monetization/iap';

type Section = 'staff' | 'intel' | 'drivers' | 'gold';

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'staff', label: 'Personel' },
  { key: 'drivers', label: 'Sürücüler' },
  { key: 'intel', label: 'İstihbarat' },
  { key: 'gold', label: 'Altın' },
];

const sectionHint: Record<Section, string> = {
  staff: 'Mekanik, stratejist ve pit şefi işe al; iyi personel geliştirmeyi, brifingi ve pit stopu güçlendirir.',
  drivers: 'Sürücüleri antrenmanla geliştir, pazardan al, sakatlığa karşı yedek tut.',
  intel: 'Rakibin güçlü statını casusla öğren: sonraki geliştirmen ×1.5. Garajını gizleyip kendini koru.',
  gold: 'Altın yalnızca reklam veya satın almayla gelir; daha hızlı ve güvenli seçenekleri açar.',
};

/**
 * The paddock: who works for the team and what they cost. Four sections,
 * each reading its own store slice — staff, drivers, intelligence, gold.
 */
export function PaddockScreen() {
  const shell = useShellLayout();
  const [section, setSection] = useState<Section>('staff');
  const gold = useGameStore((s) => s.gold);
  const news = useGameStore((s) => s.paddockNews);
  const staff = useGameStore((s) => s.staff);
  const squad = useGameStore((s) => s.squad);
  const eyebrowFor: Record<Section, string> = {
    staff: `3 kadro · ${(['mechanic', 'strategist', 'pitCrew'] as const).filter((r) => staff[r]).length} dolu`,
    drivers: `${2 + squad.length} sürücü · ${squad.length ? `${squad.length} yedek` : 'yedek yok'}`,
    intel: 'Casusluk ve garaj gizleme',
    gold: `${gold} Altın`,
  };
  const staffCount = { mechanic: 1, strategist: 1, pitCrew: 1, filled: (['mechanic', 'strategist', 'pitCrew'] as const).filter((r) => staff[r]).length };

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
        eyebrow={eyebrowFor[section]}
        icon="paddock"
        title="Padok"
        subtitle={sectionHint[section]}
        right={
          <SegmentTabs<Section>
            items={SECTIONS.map((s) => ({ key: s.key, label: s.label }))}
            value={section}
            onChange={setSection}
            fill
          />
        }
      />

      {news.length > 0 && (
        <View className="rounded-md border border-border-default px-3 py-2" style={{ gap: 2 }}>
          {news.slice(0, 3).map((n, i) => (
            <AppText key={i} variant="labelSmall" color={i === 0 ? colors.textSecondary : colors.textTertiary}>
              {n}
            </AppText>
          ))}
        </View>
      )}

      {section === 'staff' && <StaffSection />}
      {section === 'drivers' && <DriversSection />}
      {section === 'intel' && <IntelSection />}
      {section === 'gold' && <GoldSection />}
    </ScrollView>
  );
}

// ── Staff ──────────────────────────────────────────────────────────────────

function StaffSection() {
  const staff = useGameStore((s) => s.staff);
  const marketFn = useGameStore((s) => s.staffMarket);
  const effectsFn = useGameStore((s) => s.effects);
  const hireStaff = useGameStore((s) => s.hireStaff);
  const releaseStaff = useGameStore((s) => s.releaseStaff);
  const rp = useGameStore((s) => s.rp);
  const [confirm, setConfirm] = useState<string | undefined>(undefined);
  const market = marketFn();
  const fx = effectsFn();

  const onHire = (id: string, role: StaffRole) => {
    const result = hireStaff(id, confirm === id);
    if (result === 'seatTaken') {
      setConfirm(id);
      haptic.warning();
      return;
    }
    setConfirm(undefined);
    if (result === 'ok') {
      haptic.success();
      sfx.play('partFitted');
    } else {
      haptic.error();
      sfx.play('denied');
    }
    void role;
  };

  return (
    <View style={{ gap: spacing.lg }}>
      <Cols>
        {staffRoles.map((role) => {
          const m = staff[role.key];
          return (
            <GlassCard key={role.key} active={Boolean(m)} className="flex-1" contentStyle={{ gap: spacing.xs }}>
              <View className="flex-row items-center justify-between">
                <AppText variant="cardTitle" color={colors.textPrimary}>
                  {role.label}
                </AppText>
                <AppText variant="statSmall" color={m ? colors.accentLime : colors.textTertiary}>
                  {m ? `beceri ${m.skill}` : 'Boş'}
                </AppText>
              </View>
              <AppText variant="labelSmall" color={m ? colors.textPrimary : colors.textTertiary}>
                {m ? `${m.name} · ${m.wage} RP/yarış · ${m.contractRounds} yarış kaldı` : 'Kadro boş: aşağıdaki pazardan işe al. Boş kadro beceri 40 sayılır.'}
              </AppText>
              <AppText variant="labelSmall" color={colors.textTertiary}>
                {role.description}
              </AppText>
              {m && (
                <Pressable onPress={() => { haptic.warning(); releaseStaff(role.key); }} className="mt-1 self-start rounded-md border border-border-default px-2.5 py-1">
                  <AppText variant="labelSmall" color={colors.textSecondary}>
                    Sözleşmeyi bitir
                  </AppText>
                </Pressable>
              )}
            </GlassCard>
          );
        })}
      </Cols>

      <GlassCard contentStyle={{ gap: spacing.xs }}>
        <AppText variant="cardTitle" color={colors.textPrimary}>
          Personelin bugünkü etkisi
        </AppText>
        <AppText variant="labelSmall" color={colors.textSecondary}>
          Geliştirme başına +{(2 + fx.upgradeBonus).toFixed(1)} stat · güvenilirlik +{Math.round(fx.reliabilityBonus * 100)}% · brifing doğruluğu %{Math.round(fx.briefAccuracy * 100)} · yağmur tahmini ±{Math.round(fx.forecastBand * 100)} · pit −{fx.pitSecondsSaved.toFixed(1)} sn, hata %{Math.round(fx.pitFailChance * 100)} · yardımcı bot hatası ×{fx.assistantErrorScale.toFixed(2)}
        </AppText>
      </GlassCard>

      <GlassCard contentStyle={{ gap: spacing.sm }}>
        <View style={{ gap: 2 }}>
          <AppText variant="cardTitle" color={colors.textPrimary}>
            Personel pazarı
          </AppText>
          <AppText variant="labelSmall" color={colors.textTertiary}>
            Her yarış günü yenilenir · işe alım ücreti iki yarışlık maaş · dolu kadroya alırsan eskisi gider
          </AppText>
        </View>
        {market.map((c) => {
          const role = staffRoles.find((r) => r.key === c.role)!;
          const fee = hiringFee(c);
          const asking = confirm === c.id;
          return (
            <View key={c.id} className="flex-row items-center gap-3 py-1">
              <View className="w-9 items-center rounded-sm border border-border-default py-1">
                <AppText variant="labelSmall" color={colors.textSecondary} style={{ fontFamily: 'JetBrainsMono_700Bold' }}>
                  {role.glyph}
                </AppText>
              </View>
              <View className="flex-1">
                <AppText variant="label" color={colors.textPrimary} numberOfLines={1}>
                  {c.name}
                </AppText>
                <AppText variant="labelSmall" color={colors.textSecondary}>
                  {role.label} · beceri {c.skill}
                </AppText>
                <AppText variant="labelSmall" color={colors.textTertiary}>
                  {c.wage} RP/yarış · {c.contractRounds} yarışlık sözleşme
                </AppText>
              </View>
              <Pressable
                onPress={() => onHire(c.id, c.role)}
                className="items-center rounded-md border px-3 py-1.5"
                style={{ minWidth: 76, borderColor: asking ? colors.neonCoral : rp >= fee ? colors.borderActive : colors.borderDefault, backgroundColor: asking ? 'rgba(255,59,92,0.15)' : colors.accentSoft, opacity: rp >= fee ? 1 : 0.5 }}
              >
                <AppText variant="labelSmall" color={asking ? colors.neonCoral : colors.accentLime} style={{ fontFamily: 'Inter_600SemiBold' }} numberOfLines={1}>
                  {asking ? 'Onayla' : 'İşe al'}
                </AppText>
                <AppText variant="labelSmall" color={asking ? colors.neonCoral : colors.textSecondary} numberOfLines={1} style={{ fontSize: 10 }}>
                  {asking ? `${staff[c.role]?.name?.split(' ').pop()} gider` : `${fee} RP`}
                </AppText>
              </Pressable>
            </View>
          );
        })}
      </GlassCard>
    </View>
  );
}

// ── Drivers ────────────────────────────────────────────────────────────────

function DriversSection() {
  const rp = useGameStore((s) => s.rp);
  const drivers = useGameStore((s) => s.drivers);
  const squad = useGameStore((s) => s.squad);
  const injuries = useGameStore((s) => s.injuries);
  const training = useGameStore((s) => s.training);
  const startTraining = useGameStore((s) => s.startTraining);
  const collectTraining = useGameStore((s) => s.collectTraining);
  const marketFn = useGameStore((s) => s.driverMarket);
  const signDriver = useGameStore((s) => s.signDriver);
  const renewDriver = useGameStore((s) => s.renewDriver);
  const sellDriver = useGameStore((s) => s.sellDriver);
  const driverAt = useGameStore((s) => s.driverAt);
  const squadSize = useGameStore((s) => s.squadSize);
  const contracts = useGameStore((s) => s.contracts);
  const rumoursFn = useGameStore((s) => s.transferRumours);
  const transferNews = useGameStore((s) => s.transferNews);
  const setupFn = useGameStore((s) => s.setup);
  const round = useGameStore((s) => s.round);
  const [stat, setStat] = useState<DriverStatKey>('pace');
  // Koltuk numarası: 0-1 asıl, 2+ kadro (squad[seat - 2]), 'reserve' = pazardan
  // yedek olarak imzala.
  const [seat, setSeat] = useState<number | 'reserve'>(0);
  const trainingAt = typeof seat === 'number' ? driverAt(seat) : undefined;
  const [term, setTerm] = useState(2);
  const [now, setNow] = useState(() => Date.now());
  const market = marketFn();
  const track = trackForRound(round);
  const rumours = rumoursFn();

  // Refresh the countdown once a minute; the clock lives in state so render stays pure.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const done = training && now >= training.endsAt;
  const remainingMin = training ? Math.max(0, Math.ceil((training.endsAt - now) / 60_000)) : 0;

  return (
    <View style={{ gap: spacing.lg }}>
      <Cols>
        {drivers.map((d, i) => {
          const idx = i as 0 | 1;
          const pace = explainPace(setupFn(), d, track);
          return (
            <GlassCard key={d.number} className="flex-1" contentStyle={{ gap: spacing.xs }}>
              <View className="flex-row items-center justify-between">
                <AppText variant="cardTitle" color={colors.textPrimary}>
                  #{d.number} {d.name}
                </AppText>
                <AppText variant="statSmall" color={colors.accentLime}>
                  {overallOf(d.stats)}
                </AppText>
              </View>
              <AppText variant="labelSmall" color={injuries[idx] > 0 ? colors.neonCoral : colors.textTertiary}>
                Genel {overallOf(d.stats)} · potansiyel {d.potential} · {d.age} yaş{injuries[idx] > 0 ? ` · SAKAT, ${injuries[idx]} yarış dışında` : ''}
              </AppText>
              <AppText variant="labelSmall" color={contracts[idx].seasonsLeft <= 1 ? colors.solarAmber : colors.textSecondary}>
                Sözleşme: {contracts[idx].seasonsLeft <= 1 ? 'SON SEZON' : `${contracts[idx].seasonsLeft} sezon`} · {contracts[idx].wage} RP/yarış
                {contracts[idx].seasonsLeft <= 1 ? ' — uzatılmazsa kışın rakiplere gider' : ''}
              </AppText>
              <View className="flex-row flex-wrap gap-1.5">
                {driverStatKeys.map((k) => (
                  <NeonStatChip key={k.key} value={`${k.label} ${Math.round(d.stats[k.key])}`} tone="neutral" glowing={false} />
                ))}
              </View>
              <AppText variant="labelSmall" color={colors.textSecondary}>
                {track.gp}: hız payı araç {String(pace.carShare).replace('.', ',')} + sürücü {String(pace.driverShare).replace('.', ',')}. Aracın 1 puanı turda {String(pace.secPerCarPoint).replace('.', ',')} sn, sürücünün 1 hız puanı {String(pace.secPerDriverPoint).replace('.', ',')} sn kazandırır.
              </AppText>
              {contracts[idx].seasonsLeft <= 1 && (
                <View className="mt-1 flex-row flex-wrap items-center gap-1.5">
                  {contractTerms.map((t) => (
                    <Pressable
                      key={t.seasons}
                      onPress={() => {
                        const r = renewDriver(idx, t.seasons);
                        if (r === 'ok') {
                          haptic.success();
                          sfx.play('partFitted');
                        } else {
                          haptic.error();
                          sfx.play('denied');
                        }
                      }}
                      className="rounded-md border px-2.5 py-1.5"
                      style={{
                        borderColor: rp >= renewalCost(d, t.seasons) ? colors.borderActive : colors.borderDefault,
                        opacity: rp >= renewalCost(d, t.seasons) ? 1 : 0.5,
                      }}
                    >
                      <AppText variant="labelSmall" color={colors.accentLime} uppercase>
                        +{t.seasons} sezon · {renewalCost(d, t.seasons)} RP · {contractWage(d, t.seasons)}/yarış
                      </AppText>
                    </Pressable>
                  ))}
                </View>
              )}
            </GlassCard>
          );
        })}
      </Cols>

      <Cols>
        <GlassCard active className="flex-1" contentStyle={{ gap: spacing.sm }}>
          <AppText variant="cardTitle" color={colors.textPrimary}>
            Antrenman · 6 saat
          </AppText>
          {training ? (
            <>
              <AppText variant="bodySmall" color={colors.textSecondary}>
                {drivers[training.driverIdx].name} · {driverStatKeys.find((k) => k.key === training.stat)?.label} ·{' '}
                {done ? 'tamamlandı' : `${Math.floor(remainingMin / 60)} sa ${remainingMin % 60} dk kaldı`}
              </AppText>
              <GlassButton
                label={done ? 'Sonucu Al' : 'Sürüyor…'}
                disabled={!done}
                onPress={() => {
                  const r = collectTraining();
                  if (r) {
                    haptic.success();
                    sfx.play('partFitted');
                  }
                }}
              />
            </>
          ) : (
            <>
              <View className="flex-row flex-wrap gap-1.5">
                {drivers.map((d, i) => (
                  <Chip key={d.number} label={d.name.split(' ').pop() ?? d.name} selected={seat === i} onPress={() => setSeat(i as 0 | 1)} />
                ))}
                {squad.map((m, i) => (
                  <Chip
                    key={m.driver.number}
                    label={`${m.driver.name.split(' ').pop() ?? m.driver.name} (yedek)`}
                    selected={seat === i + 2}
                    onPress={() => setSeat(i + 2)}
                  />
                ))}
              </View>
              <View className="flex-row flex-wrap gap-1.5">
                {driverStatKeys.map((k) => (
                  <Chip key={k.key} label={k.label} compact selected={stat === k.key} onPress={() => setStat(k.key)} />
                ))}
              </View>
              <AppText variant="bodySmall" color={colors.textTertiary}>
                Beklenen kazanç +{trainingAt ? trainingGain(trainingAt, stat) : 0} · gençler ve potansiyeli yüksekler daha hızlı gelişir, 33+ gelişmez.
              </AppText>
              <AppText variant="labelSmall" color={colors.solarAmber}>
                Antrenmandaki sürücü yarışamaz. Asıl koltuktakini çalıştırırsan yerine kadrodan biri geçer; kadron yoksa o araç 55 seviyesinde geçici bir sürücüyle çıkar.
              </AppText>
              <GlassButton
                label="Antrenmanı Başlat"
                onPress={() => {
                  // Asıl koltuktaki sürücüyü çalıştırmak, yedek yoksa o aracı
                  // yarıştan çıkarır. Bunu sormadan yapma.
                  if (typeof seat === 'number' && seat < 2 && squad.length === 0) {
                    Alert.alert(
                      'Bu sürücü yarışamaz',
                      `${drivers[seat as 0 | 1].name} antrenmandayken koltuğa oturamaz ve yerine geçecek yedeğin yok — o araç 55 seviyesinde geçici bir sürücüyle yarışır.\n\nAntrenman 6 saat sürer; 30 Altınla hızlandırılabilir.`,
                      [
                        { text: 'Vazgeç', style: 'cancel' },
                        { text: 'Yine de başlat', style: 'destructive', onPress: () => { if (startTraining(seat as number, stat)) { haptic.medium(); sfx.play('wrench'); } } },
                      ],
                    );
                    return;
                  }
                  if (startTraining(seat as number, stat)) {
                    haptic.medium();
                    sfx.play('wrench');
                  }
                }}
              />
            </>
          )}
        </GlassCard>

        <GlassCard className="flex-1" contentStyle={{ gap: spacing.xs }}>
          <AppText variant="cardTitle" color={colors.textPrimary}>
            Kadro · {squadSize()}/{SQUAD_MAX}
          </AppText>
          {squad.length ? (
            <>
              {squad.map((m) => (
                <View key={m.driver.number} style={{ gap: 2 }}>
                  <AppText variant="labelSmall" color={colors.textPrimary}>
                    #{m.driver.number} {m.driver.name} · {overallOf(m.driver.stats)} · {m.driver.age} yaş · maaş {m.contract.wage}
                  </AppText>
                  <Pressable
                    onPress={() => {
                      if (squadSize() <= SQUAD_MIN) { haptic.warning(); return; }
                      haptic.warning();
                      sellDriver(m.driver.number);
                    }}
                    disabled={squadSize() <= SQUAD_MIN}
                    className="mt-1 self-start rounded-sm border border-border-default px-2 py-1"
                  >
                    <AppText variant="labelSmall" color={squadSize() <= SQUAD_MIN ? colors.textTertiary : colors.neonCoral} uppercase>
                      Sat · +{saleValue(m.driver)} RP
                    </AppText>
                  </Pressable>
                </View>
              ))}
              <AppText variant="labelSmall" color={colors.textTertiary}>
                Yedekler sakatlanan ya da antrenmandaki sürücünün yerine geçer. Satışta %20 menajer komisyonu kesilir.
              </AppText>
            </>
          ) : (
            <AppText variant="labelSmall" color={colors.textTertiary}>
              Yedek yok. Sakatlıkta — ve asıl sürücülerinden biri antrenmandayken — 55 seviyesinde geçici bir sürücü koşar. Pazardan yarı ücretle yedek al.
            </AppText>
          )}
        </GlassCard>
      </Cols>

      <GlassCard contentStyle={{ gap: spacing.sm }}>
        <View style={{ gap: 2 }}>
          <AppText variant="cardTitle" color={colors.textPrimary}>
            Sürücü pazarı
          </AppText>
          <AppText variant="labelSmall" color={colors.textTertiary}>
            Her yarış günü yenilenir. Önce hangi koltuğa alacağını ve sözleşme süresini seç.
          </AppText>
        </View>
        <View className="flex-row flex-wrap items-center gap-1.5">
          <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
            Koltuk
          </AppText>
          <Chip label={`1 · ${drivers[0].name.split(' ').pop()}`} compact selected={seat === 0} onPress={() => setSeat(0)} />
          <Chip label={`2 · ${drivers[1].name.split(' ').pop()}`} compact selected={seat === 1} onPress={() => setSeat(1)} />
          <Chip
            label={squadSize() >= SQUAD_MAX ? `Yedek · kadro dolu ${squadSize()}/${SQUAD_MAX}` : 'Yedek (yarı ücret)'}
            compact
            selected={seat === 'reserve'}
            onPress={() => setSeat('reserve')}
          />
        </View>
        <View className="flex-row flex-wrap items-center gap-1.5">
          <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
            Sözleşme süresi
          </AppText>
          {contractTerms.map((t) => (
            <Chip key={t.seasons} label={t.label} compact selected={term === t.seasons} onPress={() => setTerm(t.seasons)} />
          ))}
          <AppText variant="labelSmall" color={colors.textTertiary} style={{ flexBasis: '100%' }}>
            {term === 1
              ? 'Kısa deneme: imza ucuz, yarış başı maaş %25 pahalı.'
              : term === 3
                ? 'Uzun bağ: imza pahalı, maaş %15 ucuz — ama koltuk üç sezon kilitli.'
                : 'Dengeli: piyasa fiyatına imza, piyasa maaşı.'}
          </AppText>
        </View>
        {market.map((d) => {
          const full = signingCost(d, term);
          const fee = seat === 'reserve' ? Math.round(full / 2) : full;
          const wage = seat === 'reserve' ? Math.round(contractWage(d, term) / 2) : contractWage(d, term);
          return (
            <View key={d.id} className="flex-row items-center gap-3 py-1">
              <View className="flex-1" style={{ gap: 1 }}>
                <AppText variant="label" color={colors.textPrimary} numberOfLines={1}>
                  {d.name}
                </AppText>
                <AppText variant="labelSmall" color={colors.textSecondary}>
                  Genel {overallOf(d.stats)} · potansiyel {d.potential} · {d.age} yaş
                </AppText>
                <AppText variant="labelSmall" color={colors.textTertiary}>
                  Hız {d.stats.pace} · Tutarlılık {d.stats.consistency} · Yarış zekâsı {d.stats.racecraft} · Yağmur {d.stats.wet} · Refleks {d.stats.reaction}
                </AppText>
                <AppText variant="labelSmall" color={colors.textTertiary}>
                  {term} sezon · {wage} RP/yarış
                </AppText>
              </View>
              <Pressable
                onPress={() => {
                  const target = seat === 'reserve' ? 'reserve' : (seat as 0 | 1);
                  const r = signDriver(d.id, target, term);
                  if (r === 'ok') {
                    haptic.success();
                    sfx.play('partFitted');
                    return;
                  }
                  haptic.error();
                  sfx.play('denied');
                  if (r === 'full') {
                    Alert.alert('Kadro dolu', `En fazla ${SQUAD_MAX} sürücü tutabilirsin. Önce birini sat.`);
                  }
                }}
                className="items-center rounded-md border px-3 py-1.5"
                style={{ minWidth: 76, borderColor: rp >= fee ? colors.borderActive : colors.borderDefault, backgroundColor: colors.accentSoft, opacity: rp >= fee ? 1 : 0.5 }}
              >
                <AppText variant="labelSmall" color={colors.accentLime} style={{ fontFamily: 'Inter_600SemiBold' }} numberOfLines={1}>
                  {seat === 'reserve' ? 'Yedek al' : `${(seat as number) + 1}. koltuğa al`}
                </AppText>
                <AppText variant="labelSmall" color={colors.textSecondary} numberOfLines={1} style={{ fontSize: 10 }}>
                  {fee} RP imza
                </AppText>
              </Pressable>
            </View>
          );
        })}
      </GlassCard>

      <GlassCard contentStyle={{ gap: spacing.sm }}>
        <AppText variant="cardTitle" color={colors.textPrimary}>
          Transfer piyasası
        </AppText>
        <AppText variant="bodySmall" color={colors.textTertiary}>
          Sözleşmeler sezon sonunda işler. Son yılına giren her sürücü kışın serbest kalır: bizimkini uzatmazsak bir rakip alır,
          rakibinkini de biz pazardan değil, ancak o serbest kalınca kapabiliriz.
        </AppText>
        {rumours.length === 0 ? (
          <AppText variant="labelSmall" color={colors.textTertiary}>
            Bu kış gridde sözleşmesi biten sürücü yok.
          </AppText>
        ) : (
          rumours.map((r) => (
            <View key={`${r.teamKey}-${r.seat}`} className="flex-row items-center gap-2 py-0.5">
              <View className="h-3 w-1 rounded-sm" style={{ backgroundColor: teamByKey(r.teamKey)?.colour ?? colors.textTertiary }} />
              <AppText variant="labelSmall" color={r.ours ? colors.solarAmber : colors.textSecondary} className="flex-1">
                {r.driver.name} · {teamByKey(r.teamKey)?.name ?? r.teamKey} · {overallOf(r.driver.stats)} · {r.driver.age} yaş
              </AppText>
              <AppText variant="labelSmall" color={r.ours ? colors.solarAmber : colors.textTertiary} uppercase>
                {r.ours ? 'bizim · son sezon' : 'son sezon'}
              </AppText>
            </View>
          ))
        )}
        {transferNews.length > 0 && (
          <View className="mt-1 border-t border-border-default pt-2" style={{ gap: 2 }}>
            <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
              Geçen kış
            </AppText>
            {transferNews.map((n, i) => (
              <AppText key={i} variant="labelSmall" color={colors.textSecondary}>
                {n}
              </AppText>
            ))}
          </View>
        )}
      </GlassCard>
    </View>
  );
}

// ── Intelligence ───────────────────────────────────────────────────────────

const STATS: { key: StatKey; label: string }[] = [
  { key: 'motor', label: 'MOTOR' },
  { key: 'aero', label: 'AERO' },
  { key: 'grip', label: 'GRIP' },
];

function IntelSection() {
  const missions = useGameStore((s) => s.missions);
  const boosts = useGameStore((s) => s.upgradeBoosts);
  const news = useGameStore((s) => s.intelNews);
  const nextMissionAtFn = useGameStore((s) => s.nextMissionAt);
  const skipMission = useGameStore((s) => s.skipMission);
  const skipMissionCost = useGameStore((s) => s.skipMissionCost);
  const startMission = useGameStore((s) => s.startMission);
  const hideGarage = useGameStore((s) => s.hideGarage);
  const isHiddenFn = useGameStore((s) => s.isHidden);
  const hide = useGameStore((s) => s.hide);
  const gold = useGameStore((s) => s.gold);
  const [target, setTarget] = useState(teams.find((t) => !t.isPlayer)!.key);
  const [stat, setStat] = useState<StatKey>('aero');
  const [agent, setAgent] = useState<AgentKind>('free');
  const [message, setMessage] = useState<string | undefined>(undefined);

  const pending = missions.find((m) => !m.outcome);
  const nextMissionAt = nextMissionAtFn();
  // Geri sayımlar her dakika tazelenir; saniye hassasiyeti gerekmiyor.
  const [spyNow, setSpyNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setSpyNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const hidden = isHiddenFn();
  const profile = agentProfiles[agent];

  const onStart = () => {
    const r = startMission(target, stat, agent);
    const text: Record<string, string> = {
      ok: 'Ajan yola çıktı. Rapor bir gün sonra.',
      cooldown: `Bekleme süresi: ${formatDuration(nextMissionAt - Date.now())} kaldı.`,
      noGold: 'Yeterli altın yok.',
      noRp: 'Yeterli RP yok (25 RP).',
      pending: 'Zaten sahada bir ajan var.',
    };
    setMessage(text[r]);
    if (r === 'ok') {
      haptic.medium();
      sfx.play('spark');
    } else {
      haptic.error();
    }
  };

  return (
    <View style={{ gap: spacing.lg }}>
      <Cols align="flex-start">
        <GlassCard active className="flex-1" contentStyle={{ gap: spacing.sm }}>
          <View className="flex-row items-center justify-between">
            <AppText variant="cardTitle" color={colors.textPrimary}>
              Casusluk Görevi
            </AppText>
            <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
              Rapor {SPY_RESOLVE_MS / 3_600_000} saatte gelir · sonraki görev {SPY_COOLDOWN_MS / 3_600_000} saat sonra
            </AppText>
          </View>
          <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
            Hedef takım
          </AppText>
          <View className="flex-row flex-wrap gap-1.5">
            {teams.filter((t) => !t.isPlayer).map((t) => (
              <Chip key={t.key} label={t.short} compact selected={target === t.key} tint={t.colour} onPress={() => setTarget(t.key)} />
            ))}
          </View>
          <Cols wide={false}>
            <View className="flex-1">
              <AppText variant="labelSmall" color={colors.textTertiary} uppercase className="mb-1.5">
                Stat
              </AppText>
              <View className="flex-row gap-1.5">
                {STATS.map((s) => (
                  <Chip key={s.key} label={s.label} selected={stat === s.key} onPress={() => setStat(s.key)} />
                ))}
              </View>
            </View>
            <View className="flex-1">
              <AppText variant="labelSmall" color={colors.textTertiary} uppercase className="mb-1.5">
                Ajan
              </AppText>
              <View className="flex-row gap-1.5">
                <Chip label="ÜCRETSİZ · 25 RP" selected={agent === 'free'} onPress={() => setAgent('free')} />
                <Chip label={`PROFESYONEL · ${goldPrices.premiumAgent} ALTIN`} selected={agent === 'premium'} tint={colors.solarAmber} onPress={() => setAgent('premium')} />
              </View>
            </View>
          </Cols>
          <AppText variant="bodySmall" color={colors.textTertiary}>
            Başarı %{Math.round(profile.success * 100)} · yakalanma %{Math.round(profile.caught * 100)} · yanlış istihbarat %{Math.round(profile.badIntel * 100)}. Başarı: {teamByKey(target).short} o statta bizden güçlüyse bir sonraki {stat.toUpperCase()} geliştirmesi ×1.5. Yakalanma: RP cezası ve hedefe bedava güç.
          </AppText>
          <GlassButton
            label={
              pending
                ? `Ajan sahada · rapor ${formatDuration(pending.endsAt - spyNow)}`
                : spyNow < nextMissionAt
                  ? `Bekleme · ${formatDuration(nextMissionAt - spyNow)}`
                  : 'Ajanı Gönder'
            }
            disabled={Boolean(pending) || spyNow < nextMissionAt || (agent === 'premium' && gold < goldPrices.premiumAgent)}
            onPress={onStart}
          />
          {pending && (
            <GlassButton
              label={`Raporu hemen al · ${skipMissionCost()} Altın`}
              disabled={gold < skipMissionCost()}
              onPress={() => { haptic.success(); skipMission(); }}
            />
          )}
          {message && (
            <AppText variant="labelSmall" color={colors.accentLime}>
              {message}
            </AppText>
          )}
        </GlassCard>

        <View className="flex-1" style={{ gap: spacing.lg }}>
          <GlassCard contentStyle={{ gap: spacing.sm }}>
            <View className="flex-row items-center justify-between">
              <AppText variant="cardTitle" color={colors.textPrimary}>
                Garajı Gizle
              </AppText>
              <AppText variant="labelSmall" color={hidden ? colors.matrixGreen : colors.textTertiary} uppercase>
                {hidden ? `Gizli · ${hide!.untilRound}. tura kadar` : 'Açık'}
              </AppText>
            </View>
            <AppText variant="bodySmall" color={colors.textTertiary}>
              {"Tabloda ilk 4'teysen rakipler her gün %20 ihtimalle sızmayı dener. Gizliyken hiçbiri başaramaz."}
            </AppText>
            <View className="flex-row gap-1.5">
              <Chip label={`1 GÜN · ${rpPrices.hide1Day} RP`} selected={false} onPress={() => { if (hideGarage(1)) haptic.success(); else haptic.error(); }} />
              <Chip label={`3 GÜN · ${goldPrices.hide3Days} ALTIN`} selected={false} tint={colors.solarAmber} onPress={() => { if (hideGarage(3)) haptic.success(); else haptic.error(); }} />
              <Chip label={`7 GÜN · ${goldPrices.hide7Days} ALTIN`} selected={false} tint={colors.solarAmber} onPress={() => { if (hideGarage(7)) haptic.success(); else haptic.error(); }} />
            </View>
          </GlassCard>

          <GlassCard contentStyle={{ gap: spacing.xs }}>
            <AppText variant="cardTitle" color={colors.textPrimary}>
              Bekleyen Güçlendirmeler
            </AppText>
            {Object.keys(boosts).length === 0 ? (
              <AppText variant="labelSmall" color={colors.textTertiary}>
                Yok. Başarılı görev sonraki geliştirmeyi ×1.5 yapar.
              </AppText>
            ) : (
              STATS.filter((s) => boosts[s.key]).map((s) => (
                <AppText key={s.key} variant="labelSmall" color={(boosts[s.key] ?? 1) > 1 ? colors.matrixGreen : colors.neonCoral}>
                  {s.label}: sonraki geliştirme ×{boosts[s.key]}
                </AppText>
              ))
            )}
          </GlassCard>
        </View>
      </Cols>

      <GlassCard contentStyle={{ gap: 2 }}>
        <AppText variant="cardTitle" color={colors.textPrimary} className="mb-1">
          İstihbarat Günlüğü
        </AppText>
        {news.length === 0 && (
          <AppText variant="labelSmall" color={colors.textTertiary}>
            Henüz rapor yok.
          </AppText>
        )}
        {news.map((n, i) => (
          <AppText key={i} variant="labelSmall" color={i === 0 ? colors.textSecondary : colors.textTertiary}>
            {n}
          </AppText>
        ))}
      </GlassCard>
    </View>
  );
}

// ── Gold ───────────────────────────────────────────────────────────────────

function GoldSection() {
  const gold = useGameStore((s) => s.gold);
  const adsLeftFn = useGameStore((s) => s.adsLeft);
  const watchAd = useGameStore((s) => s.watchAd);
  const buyGold = useGameStore((s) => s.buyGold);
  const adsLeft = adsLeftFn();
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const ads = adsAvailable();
  const iap = iapAvailable();

  useEffect(() => {
    if (!iap) return;
    void fetchPackPrices(goldPacks.map((p) => p.sku)).then(setPrices);
  }, [iap]);

  const onAd = async () => {
    if (adsLeft === 0 || busy) return;
    setBusy('ad');
    setNote(undefined);
    const earned = ads ? await showRewardedAd() : false;
    setBusy(undefined);
    if (earned && watchAd()) {
      haptic.success();
      sfx.play('partFitted');
      setNote('+1 Altın eklendi.');
    } else {
      haptic.error();
      setNote(ads ? 'Reklam tamamlanmadı; altın verilmedi.' : 'Reklam modülü bu derlemede yok.');
    }
  };

  const onBuy = async (packKey: string, sku: string) => {
    if (busy) return;
    setBusy(packKey);
    setNote(undefined);
    const ok = iap ? await purchaseGoldPack(sku) : false;
    setBusy(undefined);
    if (ok && buyGold(packKey)) {
      haptic.success();
      sfx.play('partFitted');
      setNote('Satın alma tamamlandı.');
    } else {
      haptic.error();
      setNote(iap ? 'Mağaza satın almayı onaylamadı; ürünler mağazada tanımlı olmalı.' : 'Ödeme modülü bu derlemede yok.');
    }
  };

  return (
    <Cols align="flex-start">
      <GlassCard active className="flex-1" contentStyle={{ gap: spacing.sm }}>
        <AppText variant="cardTitle" color={colors.textPrimary}>
          Altın · {gold}
        </AppText>
        <AppText variant="bodySmall" color={colors.textSecondary}>
          Altın yalnızca reklam izleyerek ve satın alarak gelir. Profesyonel ajan ({goldPrices.premiumAgent}), garaj gizleme (3 gün {goldPrices.hide3Days}, 7 gün {goldPrices.hide7Days}) altınla alınır. Her şey RP ile de yapılabilir; altın daha hızlı ve daha güvenli olanı satın alır.
        </AppText>
        <GlassButton
          label={busy === 'ad' ? 'Reklam yükleniyor…' : adsLeft > 0 ? `Reklam İzle · +1 Altın (bugün ${adsLeft}/${ADS_PER_DAY})` : 'Günlük reklam hakkı bitti'}
          disabled={adsLeft === 0 || Boolean(busy)}
          onPress={() => void onAd()}
        />
        {note && (
          <AppText variant="labelSmall" color={colors.accentLime}>
            {note}
          </AppText>
        )}
      </GlassCard>
      <GlassCard className="flex-1" contentStyle={{ gap: spacing.sm }}>
        <AppText variant="cardTitle" color={colors.textPrimary}>
          Paketler
        </AppText>
        {goldPacks.map((p) => (
          <View key={p.key} className="flex-row items-center justify-between py-1">
            <AppText variant="labelSmall" color={colors.textPrimary}>
              {p.gold} Altın
            </AppText>
            <Pressable
              onPress={() => void onBuy(p.key, p.sku)}
              disabled={Boolean(busy)}
              className="rounded-md border border-border-active bg-accent-soft px-3 py-1.5"
              style={{ opacity: busy ? 0.5 : 1 }}
            >
              <AppText variant="labelSmall" color={colors.accentLime} uppercase>
                {busy === p.key ? '…' : prices[p.sku] ?? p.priceLabel}
              </AppText>
            </Pressable>
          </View>
        ))}
        <AppText variant="labelSmall" color={colors.textTertiary}>
          {ads ? 'Reklamlar Google test birimiyle çalışır.' : 'Reklam modülü yok.'} {iap ? 'Ödeme mağaza üzerinden; ürünler mağazada tanımlanmalı.' : 'Ödeme modülü yok.'}
        </AppText>
      </GlassCard>
    </Cols>
  );
}
