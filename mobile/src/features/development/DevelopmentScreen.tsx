import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { colors, spacing } from '@/theme';
import { DEPARTMENT_MAX_LEVEL, departmentCost, factoryDepartments, type FactoryDepartment } from '@pitwall/shared/factory';
import { AppText, GlassCard, Cols, ScreenHeader, SegmentTabs } from '@/components/atoms';
import { CarUpgradeStage, type CarUpgradeStageHandle, type UpgradeZone } from '@/components/organisms';
import { describeSpec, formatDuration, tierOf, tierUnlocks } from '@pitwall/shared/carCustomisation';
import { useGameStore } from '@/store/gameStore';
import { displayFactory, STAT_LABEL_TO_SERVER } from '@/store/slices/factoryDisplay';
import { haptic } from '@/lib/haptics';
import { statName } from '@/components/molecules/CarStatCard';
import { sfx } from '@/lib/sfx';
import { useShellLayout } from '@/lib/useShellLayout';
import { CustomisationPanel } from './CustomisationPanel';

/**
 * Server error codes, distinct — never flattened into one generic failure
 * string (`economyApiSlice.ts`'s own rule). Falls back to the raw code for
 * anything not called out explicitly, so an unmapped code is still visible
 * rather than silently swallowed.
 */
const economyErrorText: Record<string, string> = {
  not_enough_rp: 'RP yetersiz.',
  not_enough_gold: 'Altın yetersiz.',
  cap_reached: 'Bugünkü tavana ulaştın.',
  already_running: 'Fabrika zaten dolu.',
  already_claimed: 'Bu iş zaten alınmış.',
  not_ready: 'İş henüz bitmedi.',
  not_found: 'İş bulunamadı.',
  bad_payload: 'Geçersiz istek.',
  no_economy: 'Ekonomi verisi yok.',
  not_signed_in: 'Oturum açık değil.',
};

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
  const { livery, compound, rim, spokes, sponsorships } = useGameStore();
  // The server-backed economy (`economyApiSlice.ts`), not the local
  // `economySlice.ts`/`gameStore.ts` upgrade logic — this screen is the one
  // being migrated onto it (see this task's brief). `race.lobbyId` is the
  // app's own "are we seated in a lobby" signal, the same one
  // `raceSlice.ts`'s `displayRace`/`displayQualifying` already key off; NOT
  // `economyApi.lobbyId`, which only appears after the first successful
  // call — see `factoryDisplay.ts`'s doc comment.
  const lobbyId = useGameStore((s) => s.race.lobbyId);
  const economyApi = useGameStore((s) => s.economyApi);
  const [stageWidth, setStageWidth] = useState(0);
  const [tab, setTab] = useState<Tab>('upgrade');
  const [message, setMessage] = useState<string | undefined>(undefined);
  const stage = useRef<CarUpgradeStageHandle>(null);
  // A render pulse only — the countdown math itself reads the slice's
  // monotonic anchor (`displayFactory`/`economyClock.ts`), never
  // `Date.now()`. This just makes the screen re-render often enough for
  // that derived number to visibly tick down.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (lobbyId) void useGameStore.getState().economyApi.hydrate(lobbyId);
  }, [lobbyId]);

  const display = displayFactory(lobbyId, economyApi);

  const statValue = (label: string): number =>
    display.kind === 'ready' ? display.carStats.find((s) => s.label === label)?.value ?? 50 : 50;
  const motor = statValue('MOTOR');
  const aero = statValue('AERO');
  const grip = statValue('GRIP');
  const spec = describeSpec(motor, aero, grip);

  const currentUpgrade = display.kind === 'ready' ? display.currentUpgrade : undefined;
  const buildDone = Boolean(currentUpgrade?.ready);

  /** Departments to draw: `factoryDepartments`'s static catalog (name, icon,
   * description text — level-independent, see `shared/factory.ts`) with the
   * LIVE level merged in from the server when a lobby is seated. Without a
   * lobby there is no server level to merge, so the catalog's own seed
   * level is shown as-is (the pre-migration, purely-local display). */
  const departmentList: FactoryDepartment[] = factoryDepartments.map((d) => ({
    ...d,
    level: display.kind === 'ready' ? display.factoryLevels[d.code] ?? 0 : d.level,
  }));

  const onStartUpgrade = async (label: string) => {
    if (!lobbyId) return;
    const serverLabel = STAT_LABEL_TO_SERVER[label] ?? label.toLowerCase();
    const result = await useGameStore.getState().economyApi.startUpgrade(lobbyId, serverLabel);
    if (!result.ok) {
      stage.current?.reject();
      haptic.error();
      setMessage(economyErrorText[result.error] ?? result.error);
      return;
    }
    setMessage(undefined);
    haptic.medium();
    sfx.play('wrench');
    // The real duration is only known now that the server actually started
    // the job — never predicted ahead of time (see `factoryDisplay.ts`'s doc
    // comment on why a pre-start estimate is not shown at all).
    const fresh = displayFactory(lobbyId, useGameStore.getState().economyApi);
    const remainingMs = fresh.kind === 'ready' ? fresh.currentUpgrade?.remainingMs : undefined;
    stage.current?.play(
      label as UpgradeZone,
      remainingMs !== undefined
        ? `${statName[label] ?? label} üretimde · ${formatDuration(remainingMs)}`
        : `${statName[label] ?? label} üretimde`,
    );
  };

  const onCollectUpgrade = async () => {
    if (!lobbyId || !currentUpgrade) return;
    const label = currentUpgrade.label;
    const oldValue = statValue(label);
    const result = await useGameStore.getState().economyApi.claimUpgrade(lobbyId, currentUpgrade.jobId);
    if (!result.ok) {
      stage.current?.reject();
      setMessage(economyErrorText[result.error] ?? result.error);
      return;
    }
    setMessage(undefined);
    haptic.success();
    sfx.play('partFitted');
    const fresh = displayFactory(lobbyId, useGameStore.getState().economyApi);
    const newValue = fresh.kind === 'ready' ? fresh.carStats.find((s) => s.label === label)?.value ?? oldValue : oldValue;
    const tierUp = tierOf(newValue) !== tierOf(oldValue);
    const unlock = tierUp ? tierUnlocks[label]?.[tierOf(newValue) as 2 | 3] : undefined;
    stage.current?.play(label as UpgradeZone, unlock ?? `${statName[label] ?? label} ${oldValue} → ${newValue}`);
  };

  const onSkipUpgrade = async () => {
    if (!lobbyId || !currentUpgrade) return;
    const result = await useGameStore.getState().economyApi.skipUpgrade(lobbyId, currentUpgrade.jobId);
    if (!result.ok) {
      setMessage(economyErrorText[result.error] ?? result.error);
      return;
    }
    setMessage(undefined);
    haptic.success();
  };

  const onUpgradeDept = async (dept: FactoryDepartment) => {
    if (!lobbyId) return;
    const result = await useGameStore.getState().economyApi.upgradeFactory(lobbyId, dept.code);
    if (!result.ok) {
      stage.current?.reject();
      setMessage(economyErrorText[result.error] ?? result.error);
      return;
    }
    setMessage(undefined);
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
        eyebrow={display.kind === 'ready' ? `Harcanabilir ${display.rp} RP` : '—'}
        icon="development"
        title="Geliştirme"
        subtitle={tab === 'upgrade'
          ? 'Yükseltme fabrikada üretilir; süre ve maliyet işi başlatınca sunucudan gelir.'
          : 'Boya, jant ve lastik görünüşü. Performansı etkilemez; takımının kimliği.'}
        right={
          <SegmentTabs<Tab>
            items={[{ key: 'upgrade', label: 'Yükseltme' }, { key: 'garage', label: 'Görünüm' }]}
            value={tab}
            onChange={setTab}
          />
        }
      />

      <Cols align="flex-start" weights={[1.3, 1]}>
        {/* Car stage + performance */}
        <View style={{ flex: 1, gap: spacing.md + 2 }}>
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
              {display.kind === 'no-lobby' && (
                <AppText variant="bodySmall" color={colors.textTertiary}>
                  Bu ekran bir lig lobisine bağlı değil; araç geliştirme çevrimiçi lig içindir.
                </AppText>
              )}
              {display.kind === 'loading' && (
                <AppText variant="bodySmall" color={colors.textTertiary}>
                  Fabrika verisi yükleniyor…
                </AppText>
              )}
              {display.kind === 'ready' &&
                display.carStats.map((s) => (
                  <StatRow
                    key={s.label}
                    label={s.label}
                    value={s.value}
                    building={currentUpgrade?.label === s.label}
                    busy={!!currentUpgrade && currentUpgrade.label !== s.label}
                    remainingMs={currentUpgrade?.label === s.label ? currentUpgrade.remainingMs : 0}
                    done={buildDone && currentUpgrade?.label === s.label}
                    skipGold={currentUpgrade?.label === s.label ? currentUpgrade.skipCostGold : 0}
                    canSkip={currentUpgrade?.label === s.label && display.gold >= currentUpgrade.skipCostGold}
                    onSkip={() => void onSkipUpgrade()}
                    onUpgrade={() => void onStartUpgrade(s.label)}
                    onCollect={() => void onCollectUpgrade()}
                  />
                ))}
              {message && (
                <AppText variant="labelSmall" color={colors.solarAmber}>
                  {message}
                </AppText>
              )}
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
          {departmentList.map((dept) => (
            <DepartmentCard
              key={dept.code}
              dept={dept}
              affordable={display.kind === 'ready' && display.rp >= departmentCost(dept.level)}
              onUpgrade={() => void onUpgradeDept(dept)}
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
  /** This stat is on the bench right now. */
  building: boolean;
  /** Another stat is on the bench — the factory is taken. */
  busy: boolean;
  remainingMs: number;
  done: boolean;
  onUpgrade: () => void;
  onCollect: () => void;
  /** Kalan süreyi satın almanın Altın fiyatı — sunucunun kendi rakamı
   * (`SlotStateJob.skipCostGold`), yalnızca bir iş üretimdeyken bilinir. */
  skipGold: number;
  canSkip: boolean;
  onSkip: () => void;
}

function StatRow({
  label,
  value,
  building,
  busy,
  remainingMs,
  done,
  onUpgrade,
  onCollect,
  skipGold,
  canSkip,
  onSkip,
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
        ) : building ? null : (
          <Pressable
            className="flex-row items-center gap-1 rounded-md border px-2.5 py-1.5"
            style={{
              borderColor: !busy ? colors.borderActive : colors.borderDefault,
              backgroundColor: !busy ? colors.accentSoft : 'transparent',
              opacity: !busy ? 1 : 0.5,
            }}
            disabled={busy}
            onPress={onUpgrade}
          >
            <AppText variant="labelSmall" color={colors.accentLime} style={{ fontFamily: 'Inter_600SemiBold', fontSize: 11 }}>
              Yükselt
            </AppText>
          </Pressable>
        )}
      </View>
      {building && !done && (
        <Pressable
          className="self-start rounded-md border px-2.5 py-1.5"
          style={{
            borderColor: canSkip ? colors.borderActive : colors.borderDefault,
            backgroundColor: canSkip ? colors.accentSoft : 'transparent',
            opacity: canSkip ? 1 : 0.5,
          }}
          disabled={!canSkip}
          onPress={onSkip}
        >
          <AppText variant="labelSmall" color={colors.solarAmber} style={{ fontFamily: 'Inter_600SemiBold', fontSize: 11 }}>
            Hızlandır · {skipGold} Altın
          </AppText>
        </Pressable>
      )}
      <AppText variant="labelSmall" color={building ? colors.solarAmber : colors.textTertiary} style={{ fontSize: 10 }}>
        {building
          ? done
            ? 'Parça hazır — araca takılmayı bekliyor.'
            : 'Fabrikada üretiliyor.'
          : busy
            ? 'Fabrika başka bir parçayı üretiyor.'
            /* Maliyet ve süre sunucudan gelir; iş başlamadan önce bilinmez
             * — bkz. `factoryDisplay.ts`'in "WHAT THIS DELIBERATELY DOES NOT
             * COMPUTE" bölümü. */
            : 'Maliyet ve süre işi başlatınca sunucudan gelir.'}
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
        borderColor: dept.level < DEPARTMENT_MAX_LEVEL ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.05)',
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
        {dept.level < DEPARTMENT_MAX_LEVEL ? (
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
              {departmentCost(dept.level)}
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
