import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { colors, spacing } from '@/theme';
import type { FactoryDepartment } from '@/data/mock';
import { AppText, GlassCard, Cols, ScreenHeader, SegmentTabs } from '@/components/atoms';
import { CarUpgradeStage, type CarUpgradeStageHandle, type UpgradeZone } from '@/components/organisms';
import { UPGRADE_MAX_MS, describeSpec, formatDuration, tierOf, tierUnlocks } from '@/data/carCustomisation';
import { useGameStore } from '@/store/gameStore';
import { haptic } from '@/lib/haptics';
import { statName } from '@/components/molecules/CarStatCard';
import { sfx } from '@/lib/sfx';
import { useShellLayout } from '@/lib/useShellLayout';
import { CustomisationPanel } from './CustomisationPanel';

type Tab = 'upgrade' | 'garage';

/**
 * Geliştirme — the car, its upgrades and its garage customisation.
 *
 * Buying an upgrade pays the RP and puts a part on the fabrication bench: the
 * first build of a stat takes six hours, every later one 1.5x longer, and only
 * one part is ever in build. Fitting the finished part runs the repair beat on
 * the stage (rattle gun, sparks, the bodywork blooming) and, when it crosses a
 * tier line, a new part is physically fitted and named in the banner.
 */
export function DevelopmentScreen() {
  const shell = useShellLayout();
  const {
    rp,
    carStats,
    departments,
    build,
    buildTimeFor,
    startUpgrade,
    collectUpgrade,
    upgradeDepartment,
    livery,
    compound,
    rim,
    spokes,
    sponsorships,
  } = useGameStore();
  const [stageWidth, setStageWidth] = useState(0);
  const [tab, setTab] = useState<Tab>('upgrade');
  const [now, setNow] = useState(() => Date.now());
  const stage = useRef<CarUpgradeStageHandle>(null);

  // Refresh the countdown once a minute; the clock lives in state so render stays pure.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const buildDone = !!build && now >= build.endsAt;

  const stat = (label: string) => carStats.find((s) => s.label === label)?.value ?? 50;
  const motor = stat('MOTOR');
  const aero = stat('AERO');
  const grip = stat('GRIP');
  const spec = describeSpec(motor, aero, grip);

  const onStartUpgrade = (label: string) => {
    const started = startUpgrade(label);
    if (started !== 'ok') {
      stage.current?.reject();
      haptic.error();
      return;
    }
    haptic.medium();
    sfx.play('wrench');
    stage.current?.play(
      label as UpgradeZone,
      `${statName[label] ?? label} üretimde · ${formatDuration(buildTimeFor(label))}`,
    );
  };

  const onCollectUpgrade = () => {
    // Read the label first: collecting clears the bench.
    const label = build?.label ?? '';
    const result = collectUpgrade();
    if (!result) {
      stage.current?.reject();
      return;
    }
    haptic.success();
    sfx.play('partFitted');
    const unlock = result.tierUp ? tierUnlocks[label]?.[tierOf(result.value) as 2 | 3] : undefined;
    stage.current?.play(label as UpgradeZone, unlock ?? `${statName[label] ?? label} +2 → ${result.value}`);
  };

  const onUpgradeDept = (dept: FactoryDepartment) => {
    const ok = upgradeDepartment(dept.code);
    if (!ok) {
      stage.current?.reject();
      return;
    }
    stage.current?.play('FACTORY', `${dept.name} seviye ${dept.level + 1}`);
  };

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
        eyebrow={`Harcanabilir ${rp} RP`}
        icon="development"
        title="Geliştirme"
        subtitle={tab === 'upgrade'
          ? 'Her yükseltme +2 verir ama fabrikada üretilir: ilk yükseltme 6 saat, aynı değerin her yenisi 1,5 kat uzun.'
          : 'Boya, jant ve lastik görünüşü. Performansı etkilemez; takımının kimliği.'}
        right={
          <SegmentTabs<Tab>
            items={[{ key: 'upgrade', label: 'Yükseltme' }, { key: 'garage', label: 'Görünüm' }]}
            value={tab}
            onChange={setTab}
          />
        }
      />

      <Cols align="flex-start">
        {/* Car stage + performance */}
        <View style={{ flex: 1.3, gap: spacing.md + 2 }}>
          <View
            className="overflow-hidden rounded-lg border border-border-default"
            style={{ backgroundColor: '#050506' }}
            onLayout={(e) => setStageWidth(e.nativeEvent.layout.width)}
          >
            {stageWidth > 0 && (
              <CarUpgradeStage
                ref={stage}
                mode="3d"
                motor={motor}
                aero={aero}
                grip={grip}
                width={stageWidth}
                height={240}
                livery={livery}
                compound={compound}
                rim={rim}
                spokes={spokes}
                sponsorships={sponsorships}
              />
            )}
            <View className="absolute left-4 top-3 flex-row items-center gap-2">
              <View className="rounded-sm border border-border-active bg-accent-soft px-2 py-1">
                <AppText variant="labelSmall" color={colors.accentLime} uppercase>
                  Kademe {spec.spec}
                </AppText>
              </View>
              <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
                Şasi PW-01
              </AppText>
            </View>
          </View>

          {tab === 'upgrade' ? (
            <GlassCard contentStyle={{ gap: spacing.md }}>
              <AppText variant="cardTitle" color={colors.textPrimary}>
                Araç performansı
              </AppText>
              {carStats.map((s) => (
                <StatRow
                  key={s.label}
                  label={s.label}
                  value={s.value}
                  cost={s.cost}
                  affordable={rp >= s.cost}
                  buildMs={buildTimeFor(s.label)}
                  building={build?.label === s.label}
                  busy={!!build && build.label !== s.label}
                  remainingMs={build?.label === s.label ? build.endsAt - now : 0}
                  done={buildDone && build?.label === s.label}
                  onUpgrade={() => onStartUpgrade(s.label)}
                  onCollect={onCollectUpgrade}
                />
              ))}
            </GlassCard>
          ) : (
            <GlassCard contentStyle={{ gap: spacing.md }}>
              <AppText variant="cardTitle" color={colors.textPrimary}>
                Görünüm ve özelleştirme
              </AppText>
              <CustomisationPanel />
            </GlassCard>
          )}
        </View>

        {/* Factory departments */}
        <View className="flex-1" style={{ gap: spacing.md - 2 }}>
          <AppText variant="cardTitle" color={colors.textPrimary}>
            Fabrika departmanları
          </AppText>
          {departments.map((dept) => (
            <DepartmentCard
              key={dept.code}
              dept={dept}
              affordable={rp >= dept.cost}
              onUpgrade={() => onUpgradeDept(dept)}
            />
          ))}
        </View>
      </Cols>
    </ScrollView>
  );
}

interface StatRowProps {
  label: string;
  value: number;
  cost: number;
  affordable: boolean;
  /** How long this stat's next build takes. */
  buildMs: number;
  /** This stat is on the bench right now. */
  building: boolean;
  /** Another stat is on the bench — the factory is taken. */
  busy: boolean;
  remainingMs: number;
  done: boolean;
  onUpgrade: () => void;
  onCollect: () => void;
}

function StatRow({
  label,
  value,
  cost,
  affordable,
  buildMs,
  building,
  busy,
  remainingMs,
  done,
  onUpgrade,
  onCollect,
}: StatRowProps) {
  const tier = tierOf(value);
  // Distance to the next part unlock, so the player can see what they're buying.
  const nextGate = tier === 1 ? 60 : tier === 2 ? 70 : null;
  const nextUnlock = nextGate ? tierUnlocks[label]?.[(tier + 1) as 2 | 3] : null;

  return (
    <View style={{ gap: 6 }}>
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-baseline gap-2">
          <AppText variant="label" color={colors.textPrimary}>
            {statName[label] ?? label}
          </AppText>
          <AppText variant="labelSmall" color={colors.textTertiary}>
            Kademe {tier === 3 ? 'A' : tier === 2 ? 'B' : 'C'}
          </AppText>
        </View>
        <AppText variant="statSmall" color={colors.textPrimary}>
          {value}
        </AppText>
      </View>
      <View className="flex-row items-center gap-3">
        <View className="h-2 flex-1 overflow-hidden rounded-full" style={{ backgroundColor: 'rgba(255,255,255,0.06)' }}>
          <View className="h-full rounded-full bg-accent" style={{ width: `${value}%` }} />
        </View>
        {building ? (
          <Pressable
            className="flex-row items-center gap-1 rounded-md border px-2.5 py-1.5"
            style={{
              borderColor: done ? colors.borderActive : colors.borderDefault,
              backgroundColor: done ? colors.accentSoft : 'transparent',
              opacity: done ? 1 : 0.6,
            }}
            disabled={!done}
            onPress={onCollect}
          >
            <AppText
              variant="labelSmall"
              color={done ? colors.accentLime : colors.solarAmber}
              style={{ fontFamily: 'Inter_600SemiBold', fontSize: 11 }}
            >
              {done ? 'Parçayı Tak' : `Üretimde · ${formatDuration(remainingMs)}`}
            </AppText>
          </Pressable>
        ) : (
          <Pressable
            className="flex-row items-center gap-1 rounded-md border px-2.5 py-1.5"
            style={{
              borderColor: affordable && !busy ? colors.borderActive : colors.borderDefault,
              backgroundColor: affordable && !busy ? colors.accentSoft : 'transparent',
              opacity: affordable && !busy ? 1 : 0.5,
            }}
            disabled={busy}
            onPress={onUpgrade}
          >
            <AppText variant="labelSmall" color={colors.accentLime} style={{ fontFamily: 'Inter_600SemiBold', fontSize: 11 }}>
              Yükselt
            </AppText>
            <AppText variant="statSmall" color={colors.accentLime} style={{ fontSize: 12 }}>
              {cost}
            </AppText>
            <AppText variant="labelSmall" color={colors.textSecondary} style={{ fontSize: 10 }}>
              RP
            </AppText>
          </Pressable>
        )}
      </View>
      <AppText variant="labelSmall" color={building ? colors.solarAmber : colors.textTertiary} style={{ fontSize: 10 }}>
        {building
          ? done
            ? 'Parça hazır — araca takılmayı bekliyor.'
            : `Fabrikada üretiliyor · toplam ${formatDuration(buildMs)}`
          : busy
            ? 'Fabrika başka bir parçayı üretiyor.'
            : `Üretim süresi ${formatDuration(buildMs)}${buildMs >= UPGRADE_MAX_MS ? ' · üst sınır' : ' · sonraki yükseltme 1,5 kat uzun'}`}
      </AppText>
      {nextUnlock && (
        <AppText variant="labelSmall" color={colors.textTertiary} style={{ fontSize: 10 }}>
          {nextGate}&apos;e ulaşınca araca yeni görsel parçalar takılır: {nextUnlock}
        </AppText>
      )}
    </View>
  );
}

interface DepartmentCardProps {
  dept: FactoryDepartment;
  affordable: boolean;
  onUpgrade: () => void;
}

function DepartmentCard({ dept, affordable, onUpgrade }: DepartmentCardProps) {
  return (
    <View
      className="rounded-md border bg-elevated px-4 py-3.5"
      style={{
        gap: spacing.sm,
        borderColor: dept.upgradable ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.05)',
      }}
    >
      <View className="flex-row items-center justify-between">
        <View className="mr-2 flex-1 flex-row items-center gap-2">
          <AppText
            variant="label"
            color={colors.textPrimary}
            numberOfLines={1}
            style={{ fontFamily: 'BarlowCondensed_700Bold', letterSpacing: 0.4 }}
          >
            {dept.name}
          </AppText>
          <View
            className="rounded-sm px-1.5 py-0.5"
            style={{
              borderWidth: 1,
              borderColor: 'rgba(155,92,255,0.4)',
              backgroundColor: 'rgba(155,92,255,0.12)',
            }}
          >
            <AppText variant="labelSmall" color={colors.accentViolet} style={{ fontSize: 10 }}>
              Seviye {dept.level}
            </AppText>
          </View>
        </View>
        {dept.upgradable ? (
          <Pressable
            className="flex-row items-center gap-1 rounded-sm border px-2.5 py-1.5"
            style={{
              borderColor: affordable ? colors.borderActive : colors.borderDefault,
              backgroundColor: affordable ? colors.accentSoft : 'transparent',
              opacity: affordable ? 1 : 0.5,
            }}
            onPress={onUpgrade}
          >
            <AppText variant="statSmall" color={colors.accentLime} style={{ fontSize: 12 }}>
              {dept.cost}
            </AppText>
            <AppText variant="labelSmall" color={colors.textSecondary} uppercase style={{ fontSize: 10 }}>
              RP
            </AppText>
          </Pressable>
        ) : (
          <View className="rounded-sm border border-border-default px-2.5 py-1.5">
            <AppText variant="labelSmall" color={colors.textTertiary} uppercase style={{ fontSize: 10 }}>
              MAKS
            </AppText>
          </View>
        )}
      </View>

      <AppText variant="bodySmall" color={colors.textSecondary} numberOfLines={2}>
        {dept.current}
      </AppText>
      <View className="flex-row items-center gap-1.5">
        <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
          Sıradaki ·
        </AppText>
        <AppText variant="labelSmall" color={colors.accentLime} numberOfLines={1} className="flex-1">
          {dept.next}
        </AppText>
      </View>
    </View>
  );
}
