import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { colors, spacing } from '@/theme';
import { AppText, GlassButton, GlassCard, Icon, ScreenHeader, type IconName } from '@/components/atoms';
import { useGameStore } from '@/store/gameStore';
import { useShellLayout } from '@/lib/useShellLayout';
import { haptic } from '@/lib/haptics';
import type { AiDifficulty, LobbySettingsInput, Visibility } from '@/lib/api/lobby';
import { DIFFICULTY_LABEL, DIFFICULTY_MULTIPLIER, TeamSelect, raceTimeLabel } from './TeamSelect';

/**
 * GENEL EKRAN (§4.2) — the screen onboarding lands on and the dropdown's last
 * row returns to: Hızlı oyun bul · Lobi kur · Davetler · Arkadaşlar · Mağaza.
 *
 * The last two are placeholders on purpose. Friends are Faz 5 and the shop is
 * its own piece of work; they are shown disabled rather than hidden so the
 * shape of the screen does not shift under the player when they land.
 *
 * There is deliberately NO lobby list or search here (§9): a player reaches a
 * lobby by quick match or by invitation, and by nothing else.
 */
export function LobbyHomeScreen() {
  const shell = useShellLayout();
  const authUser = useGameStore((s) => s.auth.user);
  const lobby = useGameStore((s) => s.lobby);
  const refreshSlots = useGameStore((s) => s.refreshSlots);
  const refreshInvites = useGameStore((s) => s.refreshInvites);
  const findGame = useGameStore((s) => s.findGame);
  const endSearch = useGameStore((s) => s.endSearch);
  const openLobby = useGameStore((s) => s.openLobby);
  const takeTeam = useGameStore((s) => s.takeTeam);
  const chooseTeamIn = useGameStore((s) => s.chooseTeamIn);

  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!authUser) return;
    void refreshSlots();
    void refreshInvites();
  }, [authUser, refreshSlots, refreshInvites]);

  const freeSlots = useMemo(
    () => lobby.slots.filter((s) => s.unlocked && !s.lobbyId).length,
    [lobby.slots],
  );

  const pick = useCallback(
    async (lobbyId: string, teamKey: string) => {
      const ok = await takeTeam(lobbyId, teamKey);
      if (ok) router.replace('/');
    },
    [takeTeam],
  );

  if (!authUser) {
    return (
      <Shell shell={shell}>
        <ScreenHeader
          title="Genel ekran"
          subtitle="Lobiler hesaba bağlıdır — önce giriş yap."
          eyebrow="Pit Wall"
          icon="league"
        />
        <GlassButton label="Giriş yap" onPress={() => router.push('/auth')} />
      </Shell>
    );
  }

  // A candidate card or a just-created lobby both land on the same screen:
  // choosing a team is the one committing action either way (§3.3).
  const candidate = lobby.candidate;
  const choice = lobby.teamChoice;

  if (choice) {
    return (
      <Shell shell={shell}>
        <ScreenHeader
          title="Takımını seç"
          subtitle="Slot yalnızca takım seçtiğinde harcanır."
          eyebrow="Genel ekran"
          icon="league"
        />
        <TeamSelect
          title={choice.lobbyName}
          meta=""
          status={choice.note}
          seats={choice.seats}
          onPick={(teamKey) => void pick(choice.lobbyId, teamKey)}
          onCancel={endSearch}
          busy={lobby.status === 'loading'}
        />
        {lobby.error && <ErrorNote text={lobby.error} />}
      </Shell>
    );
  }

  if (candidate) {
    const { lobby: view, humans, ai, seats } = candidate;
    return (
      <Shell shell={shell}>
        <ScreenHeader
          title="Takımını seç"
          subtitle="Slot yalnızca takım seçtiğinde harcanır — beğenmezsen başka bul."
          eyebrow="Hızlı oyun bul"
          icon="league"
        />
        <TeamSelect
          title={view.name}
          meta={`${view.region} · ${raceTimeLabel(view.nextRaceAt)}`}
          status={`Sezon ${view.seasonNo} · ${view.roundNo}/${view.totalRounds}. yarış · ${DIFFICULTY_LABEL[view.aiDifficulty]} (${DIFFICULTY_MULTIPLIER[view.aiDifficulty]})`}
          occupancy={{ humans, ai }}
          seats={seats}
          onPick={(teamKey) => void pick(view.id, teamKey)}
          onAnother={() => void findGame(true)}
          onCancel={endSearch}
          busy={lobby.status === 'loading'}
        />
        {lobby.error && <ErrorNote text={lobby.error} />}
      </Shell>
    );
  }

  if (creating) {
    return (
      <Shell shell={shell}>
        <ScreenHeader
          title="Lobi kur"
          subtitle="Ayarları sen belirlersin; adı bölge havuzundan otomatik gelir."
          eyebrow="Genel ekran"
          icon="league"
        />
        <CreateLobbyForm
          busy={lobby.status === 'loading'}
          onCancel={() => setCreating(false)}
          onSubmit={async (settings) => {
            const ok = await openLobby(settings);
            if (ok) setCreating(false);
          }}
        />
        {lobby.error && <ErrorNote text={lobby.error} />}
      </Shell>
    );
  }

  return (
    <Shell shell={shell}>
      <ScreenHeader
        title="Genel ekran"
        subtitle={`${authUser.nickname} · ${freeSlots} boş slot`}
        eyebrow="Pit Wall"
        icon="league"
      />

      <Action
        icon="target"
        label="Hızlı oyun bul"
        hint="Sunucu sana bir lobi önerir. Beğenmezsen başka bul — bedava."
        disabled={freeSlots === 0 || lobby.status === 'loading'}
        onPress={() => void findGame(false)}
      />
      <Action
        icon="league"
        label="Lobi kur"
        hint="Kendi bölgeni, AI zorluğunu ve rütbe kapını seç."
        disabled={freeSlots === 0}
        onPress={() => setCreating(true)}
      />
      <Action
        icon="profile"
        label={`Davetler${lobby.invites.length ? ` (${lobby.invites.length})` : ''}`}
        hint={lobby.invites.length ? 'Seni bekleyen davetler aşağıda.' : 'Bekleyen davetin yok — yenilemek için dokun.'}
        onPress={() => void refreshInvites()}
      />

      {lobby.invites.map((invite) => (
        <GlassCard key={invite.id} contentStyle={{ gap: spacing.xs }}>
          <AppText variant="cardTitle" color={colors.textPrimary} uppercase>
            {invite.lobby.name}
          </AppText>
          <AppText variant="labelSmall" color={colors.textTertiary}>
            {invite.inviter ?? 'Bir oyuncu'} davet etti · {invite.lobby.region} ·{' '}
            {DIFFICULTY_LABEL[invite.lobby.aiDifficulty]}
          </AppText>
          {/* An invite reserves no seat (§3.6) — this is what is free now. */}
          <AppText variant="labelSmall" color={colors.textTertiary}>
            Şu an {invite.seats.length} takım boş. Davet koltuk ayırmaz.
          </AppText>
          <GlassButton
            label="Takım seç"
            disabled={freeSlots === 0}
            onPress={() => {
              haptic.select();
              chooseTeamIn({
                lobbyId: invite.lobby.id,
                lobbyName: invite.lobby.name,
                note: `${invite.inviter ?? 'Bir oyuncu'} davet etti · ${DIFFICULTY_LABEL[invite.lobby.aiDifficulty]}`,
                seats: invite.seats,
              });
            }}
          />
        </GlassCard>
      ))}

      {lobby.slots.some((s) => s.lobby) && (
        <>
          <AppText variant="labelSmall" color={colors.textTertiary} uppercase style={{ marginTop: spacing.sm }}>
            Lobilerin
          </AppText>
          {lobby.slots
            .filter((s) => s.lobby)
            .map((s) => (
              <InviteCard key={s.slotIndex} slotIndex={s.slotIndex} lobbyId={s.lobby!.id} name={s.lobby!.name} />
            ))}
        </>
      )}

      {/* Faz 5 ve mağaza ayrı işler; yerleri şimdiden duruyor. */}
      <Action icon="paddock" label="Arkadaşlar" hint="Yakında — arkadaş sistemi Faz 5." disabled />
      <Action icon="gold" label="Mağaza" hint="Yakında." disabled />

      {freeSlots === 0 && (
        <AppText variant="bodySmall" color={colors.solarAmber}>
          Boş slotun yok. Üst bardaki hesap menüsünden yeni bir slot açabilirsin.
        </AppText>
      )}
      {lobby.error && <ErrorNote text={lobby.error} />}
    </Shell>
  );
}

/**
 * Inviting a friend into a lobby you are seated in (§3.6).
 *
 * The full `Takma#1234` tag, nothing shorter: there is no partial search
 * anywhere in this game, so a tag cannot be guessed at by prefix (§5).
 */
function InviteCard({ slotIndex, lobbyId, name }: { slotIndex: number; lobbyId: string; name: string }) {
  const invite = useGameStore((s) => s.invite);
  const [tag, setTag] = useState('');
  const [sent, setSent] = useState(false);

  return (
    <GlassCard contentStyle={{ gap: spacing.xs }}>
      <AppText variant="label" color={colors.textPrimary} uppercase numberOfLines={1}>
        {slotIndex} · {name}
      </AppText>
      <View className="flex-row items-center" style={{ gap: spacing.sm }}>
        <TextInput
          value={tag}
          onChangeText={(v) => {
            setTag(v);
            setSent(false);
          }}
          placeholder="Takma#1234"
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          style={{
            flex: 1,
            color: colors.textPrimary,
            borderColor: colors.borderDefault,
            borderWidth: 1,
            borderRadius: 8,
            paddingHorizontal: 10,
            paddingVertical: 8,
            fontFamily: 'JetBrainsMono_700Bold',
            fontSize: 12,
          }}
        />
        <GlassButton
          label={sent ? 'Gönderildi' : 'Davet et'}
          variant="outline"
          disabled={tag.trim().length === 0}
          onPress={async () => {
            const ok = await invite(lobbyId, tag.trim());
            if (ok) {
              setSent(true);
              setTag('');
            }
          }}
        />
      </View>
      <AppText variant="labelSmall" color={colors.textTertiary}>
        Davet koltuk ayırmaz — davetli geldiğinde kalanlardan seçer.
      </AppText>
    </GlassCard>
  );
}

function Shell({ shell, children }: { shell: ReturnType<typeof useShellLayout>; children: React.ReactNode }) {
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bgDeepSpace }}
      contentContainerStyle={{
        padding: spacing.lg,
        paddingTop: shell.insets.top + spacing.lg,
        paddingBottom: shell.insets.bottom + spacing.xl,
        gap: spacing.md,
      }}
    >
      {children}
    </ScrollView>
  );
}

function ErrorNote({ text }: { text: string }) {
  return (
    <AppText variant="bodySmall" color={colors.neonCoral}>
      {text}
    </AppText>
  );
}

function Action({
  icon,
  label,
  hint,
  onPress,
  disabled,
}: {
  icon: IconName;
  label: string;
  hint: string;
  onPress?: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={() => {
        haptic.select();
        onPress?.();
      }}
      className="flex-row items-center rounded-lg border"
      style={{
        gap: spacing.sm,
        padding: spacing.md,
        borderColor: colors.borderDefault,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Icon name={icon} size={20} color={colors.accentLime} />
      <View style={{ flex: 1, gap: 2 }}>
        <AppText variant="label" color={colors.textPrimary}>
          {label}
        </AppText>
        <AppText variant="labelSmall" color={colors.textTertiary}>
          {hint}
        </AppText>
      </View>
      {!disabled && <Icon name="chevron" size={18} color={colors.textTertiary} />}
    </Pressable>
  );
}

const DIFFICULTIES: AiDifficulty[] = ['easy', 'normal', 'hard'];

/** Spec §3.1's settings table, one control per row. */
function CreateLobbyForm({
  onSubmit,
  onCancel,
  busy,
}: {
  onSubmit: (settings: LobbySettingsInput) => void | Promise<void>;
  onCancel: () => void;
  busy?: boolean;
}) {
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [aiDifficulty, setAiDifficulty] = useState<AiDifficulty>('normal');
  const [rankMin, setRankMin] = useState('1');
  const [rankMax, setRankMax] = useState('10');
  const [guestsCanInvite, setGuestsCanInvite] = useState(true);
  const [midSeasonJoin, setMidSeasonJoin] = useState(true);

  return (
    <GlassCard contentStyle={{ gap: spacing.md }}>
      <Row label="Görünürlük" hint="Herkese açık lobi hızlı ara havuzuna girer.">
        <Choice
          options={[
            { value: 'public', label: 'Herkese açık' },
            { value: 'private', label: 'Özel' },
          ]}
          value={visibility}
          onChange={setVisibility}
        />
      </Row>

      <Row label="AI zorluğu" hint="Zorluk kazanılan rütbe puanını da çarpar (§3.5).">
        <Choice
          options={DIFFICULTIES.map((d) => ({ value: d, label: `${DIFFICULTY_LABEL[d]} · ${DIFFICULTY_MULTIPLIER[d]}` }))}
          value={aiDifficulty}
          onChange={setAiDifficulty}
        />
      </Row>

      <Row label="Rütbe kapısı" hint="1-10 arası; kimlerin katılabileceğini belirler.">
        <View className="flex-row items-center" style={{ gap: spacing.sm }}>
          <RankInput value={rankMin} onChange={setRankMin} />
          <AppText variant="labelSmall" color={colors.textTertiary}>
            –
          </AppText>
          <RankInput value={rankMax} onChange={setRankMax} />
        </View>
      </Row>

      <Row label="Sezon ortası katılım" hint="Kapalıysa ilk yarıştan sonra yeni katılım yok.">
        <Choice
          options={[
            { value: true, label: 'Açık' },
            { value: false, label: 'Kapalı' },
          ]}
          value={midSeasonJoin}
          onChange={setMidSeasonJoin}
        />
      </Row>

      <Row label="Davetli davet edebilir" hint="Kapalıysa yalnızca kurucu davet eder.">
        <Choice
          options={[
            { value: true, label: 'Açık' },
            { value: false, label: 'Kapalı' },
          ]}
          value={guestsCanInvite}
          onChange={setGuestsCanInvite}
        />
      </Row>

      <AppText variant="labelSmall" color={colors.textTertiary}>
        Bölge ve günlük yarış saati profilindeki bölgeden gelir. Lobi adını sen yazmazsın.
      </AppText>

      <View className="flex-row" style={{ gap: spacing.sm }}>
        <View style={{ flex: 1 }}>
          <GlassButton
            label="Lobiyi kur"
            disabled={busy}
            onPress={() =>
              void onSubmit({
                visibility,
                aiDifficulty,
                rankMin: clampRank(rankMin, 1),
                rankMax: clampRank(rankMax, 10),
                guestsCanInvite,
                midSeasonJoin,
              })
            }
          />
        </View>
        <View style={{ flex: 1 }}>
          <GlassButton label="Vazgeç" variant="outline" onPress={onCancel} disabled={busy} />
        </View>
      </View>
    </GlassCard>
  );
}

/** Keeps a typed rank inside 1-10; an empty or junk field falls back. */
function clampRank(raw: string, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(10, Math.max(1, n));
}

function RankInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <TextInput
      value={value}
      onChangeText={(v) => onChange(v.replace(/[^0-9]/g, '').slice(0, 2))}
      keyboardType="number-pad"
      style={{
        width: 56,
        color: colors.textPrimary,
        borderColor: colors.borderDefault,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        fontFamily: 'JetBrainsMono_700Bold',
        fontSize: 13,
        textAlign: 'center',
      }}
    />
  );
}

function Row({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: spacing.xs }}>
      <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
        {label}
      </AppText>
      {children}
      <AppText variant="labelSmall" color={colors.textTertiary}>
        {hint}
      </AppText>
    </View>
  );
}

function Choice<T extends string | boolean>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View className="flex-row flex-wrap" style={{ gap: spacing.xs }}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            onPress={() => {
              haptic.select();
              onChange(option.value);
            }}
            className="rounded-md border"
            style={{
              paddingHorizontal: spacing.sm,
              paddingVertical: 6,
              borderColor: on ? colors.accentLime : colors.borderDefault,
              backgroundColor: on ? colors.accentSoft : 'transparent',
            }}
          >
            <AppText variant="labelSmall" color={on ? colors.accentLime : colors.textSecondary}>
              {option.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}
