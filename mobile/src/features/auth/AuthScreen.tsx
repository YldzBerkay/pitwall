import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { colors, spacing } from '@/theme';
import { AppText, ConfirmDialog, GlassButton, GlassCard, Icon, ScreenHeader, SegmentTabs } from '@/components/atoms';
import type { BootstrapResponse } from '@/lib/api/identity';
import type { Region } from '@/data/regions';
import { useGameStore } from '@/store/gameStore';
import { useShellLayout } from '@/lib/useShellLayout';
import { haptic } from '@/lib/haptics';

const inputStyle = {
  color: colors.textPrimary,
  borderColor: colors.borderDefault,
  borderWidth: 1,
  borderRadius: 8,
  paddingHorizontal: 12,
  paddingVertical: 10,
  fontFamily: 'Inter_500Medium',
  fontSize: 14,
} as const;

function Field({
  label,
  value,
  onChangeText,
  secure,
  keyboardType,
  autoCapitalize,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  secure?: boolean;
  keyboardType?: 'default' | 'email-address';
  autoCapitalize?: 'none' | 'words';
}) {
  return (
    <View style={{ gap: 4 }}>
      <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
        {label}
      </AppText>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={secure}
        keyboardType={keyboardType ?? 'default'}
        autoCapitalize={autoCapitalize ?? 'none'}
        autoCorrect={false}
        placeholderTextColor={colors.textTertiary}
        style={inputStyle}
      />
    </View>
  );
}

/** Google/Apple/Facebook need a linked native SDK not wired into this build yet — see `lib/api/identity.ts`. */
function SocialRow() {
  return (
    <View style={{ gap: spacing.sm }}>
      <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
        Sosyal giriş · yakında
      </AppText>
      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        {(['Google', 'Apple', 'Facebook'] as const).map((label) => (
          <View
            key={label}
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              height: 44,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: colors.borderDefault,
              opacity: 0.4,
            }}
          >
            <AppText variant="labelSmall" color={colors.textTertiary}>
              {label}
            </AppText>
          </View>
        ))}
      </View>
    </View>
  );
}

function RegionPicker({
  regions,
  value,
  onChange,
}: {
  regions: BootstrapResponse['regions'];
  value?: Region;
  onChange: (r: Region) => void;
}) {
  return (
    <View style={{ gap: 4 }}>
      <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
        Bölge
      </AppText>
      <View style={{ gap: spacing.xs }}>
        {regions.map((r) => {
          const on = r.id === value;
          return (
            <Pressable
              key={r.id}
              onPress={() => {
                haptic.select();
                onChange(r.id);
              }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderRadius: 10,
                borderWidth: 1,
                borderColor: on ? colors.borderActive : colors.borderDefault,
                backgroundColor: on ? colors.accentSoft : 'transparent',
                paddingVertical: spacing.sm,
                paddingHorizontal: spacing.md,
              }}
            >
              <View>
                <AppText variant="label" color={on ? colors.accentLime : colors.textPrimary}>
                  {r.label}
                </AppText>
                <AppText variant="labelSmall" color={colors.textTertiary}>
                  Yarış saati: {r.hour}:00 ({r.timeZone})
                </AppText>
              </View>
              {on && <Icon name="check" size={18} color={colors.accentLime} />}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function CountryPicker({
  countries,
  value,
  onChange,
}: {
  countries: BootstrapResponse['countries'];
  value?: string;
  onChange: (code: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const selected = countries.find((c) => c.code === value);
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('tr-TR');
    if (!q) return countries.slice(0, 40);
    return countries.filter((c) => c.name.toLocaleLowerCase('tr-TR').includes(q)).slice(0, 40);
  }, [countries, query]);

  return (
    <View style={{ gap: 4 }}>
      <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
        Ülke
      </AppText>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderRadius: 8,
          borderWidth: 1,
          borderColor: colors.borderDefault,
          paddingVertical: 10,
          paddingHorizontal: 12,
        }}
      >
        <AppText variant="body" color={selected ? colors.textPrimary : colors.textTertiary}>
          {selected ? selected.name : 'Seç (opsiyonel)'}
        </AppText>
        <Icon name={open ? 'chevron-left' : 'chevron'} size={16} color={colors.textTertiary} />
      </Pressable>
      {open && (
        <View style={{ gap: spacing.xs, maxHeight: 260 }}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Ara..."
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="none"
            style={inputStyle}
          />
          <ScrollView style={{ maxHeight: 220 }} nestedScrollEnabled showsVerticalScrollIndicator={false}>
            {filtered.map((c) => (
              <Pressable
                key={c.code}
                onPress={() => {
                  haptic.select();
                  onChange(c.code);
                  setOpen(false);
                }}
                style={{ paddingVertical: 8, paddingHorizontal: 4 }}
              >
                <AppText variant="bodySmall" color={c.code === value ? colors.accentLime : colors.textPrimary}>
                  {c.name}
                </AppText>
              </Pressable>
            ))}
            {filtered.length === 0 && (
              <AppText variant="bodySmall" color={colors.textTertiary}>
                Eşleşme yok.
              </AppText>
            )}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

/**
 * Faz 1b: the server's account system (Google/Apple/e-posta, takma ad,
 * bölge — all built and tested, see `docs/FEATURES.md`) wired into the
 * client. Only e-posta+şifre is live end to end here; social buttons are
 * shown but disabled (see `SocialRow`). Signed in, this account's id also
 * becomes the online league's `managerId` (`leagueSlice.effectiveManagerId`).
 */
export function AuthScreen() {
  const shell = useShellLayout();
  const auth = useGameStore((s) => s.auth);
  const setAuthServer = useGameStore((s) => s.setAuthServer);
  const fetchBootstrap = useGameStore((s) => s.fetchBootstrap);
  const register = useGameStore((s) => s.register);
  const login = useGameStore((s) => s.login);
  const logout = useGameStore((s) => s.logout);
  const refreshMe = useGameStore((s) => s.refreshMe);
  const updateAccountProfile = useGameStore((s) => s.updateAccountProfile);

  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [serverUrl, setServerUrl] = useState(auth.baseUrl);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [region, setRegion] = useState<Region | undefined>(undefined);
  const [countryCode, setCountryCode] = useState<string | undefined>(undefined);
  const [bootstrapData, setBootstrapData] = useState<BootstrapResponse | undefined>(undefined);
  const [confirmLogout, setConfirmLogout] = useState(false);

  useEffect(() => {
    if (auth.token) void refreshMe();
    // Only on mount — re-verifying the stored session against the server once is enough here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (mode !== 'signup' || bootstrapData || auth.user) return;
    void fetchBootstrap().then((data) => {
      if (!data) return;
      setBootstrapData(data);
      setNickname(`${data.suggestedNicknames[0]?.base ?? ''}`);
      setRegion(data.suggestedRegion ?? undefined);
    });
  }, [mode, bootstrapData, auth.user, fetchBootstrap]);

  if (auth.user) {
    const u = auth.user;
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
          eyebrow="Hesap"
          icon="profile"
          title={u.nickname}
          subtitle="Bu hesap bulut kimliğin — takma ad, bölge ve rütbe puanın cihaz değişse de seninle kalır."
          right={
            <GlassButton
              label="Kapat"
              variant="ghost"
              onPress={() => {
                haptic.select();
                router.back();
              }}
            />
          }
        />

        <GlassCard contentStyle={{ gap: spacing.sm }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
              Altın
            </AppText>
            <AppText variant="label" color={colors.textPrimary} style={{ fontFamily: 'JetBrainsMono_700Bold' }}>
              {u.gold}
            </AppText>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
              Rütbe puanı
            </AppText>
            <AppText variant="label" color={colors.textPrimary} style={{ fontFamily: 'JetBrainsMono_700Bold' }}>
              {u.rankPoints}
            </AppText>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
              Bölge
            </AppText>
            <AppText variant="label" color={colors.textPrimary}>
              {u.region ?? '—'}
            </AppText>
          </View>
        </GlassCard>

        {bootstrapData ? (
          <GlassCard contentStyle={{ gap: spacing.md }}>
            <AppText variant="cardTitle" color={colors.textPrimary}>
              Bölge / ülke değiştir
            </AppText>
            <RegionPicker regions={bootstrapData.regions} value={region ?? (u.region as Region | undefined)} onChange={setRegion} />
            <CountryPicker countries={bootstrapData.countries} value={countryCode ?? u.country ?? undefined} onChange={setCountryCode} />
            {auth.error && (
              <AppText variant="bodySmall" color={colors.neonCoral}>
                {auth.error}
              </AppText>
            )}
            <GlassButton
              label="Kaydet"
              disabled={auth.status === 'loading'}
              onPress={async () => {
                const ok = await updateAccountProfile({ countryCode, region });
                if (ok) haptic.success();
                else haptic.error();
              }}
            />
          </GlassCard>
        ) : (
          <Pressable
            onPress={() => void fetchBootstrap().then((d) => d && setBootstrapData(d))}
            style={{ alignSelf: 'flex-start' }}
          >
            <AppText variant="labelSmall" color={colors.textSecondary}>
              Bölge/ülke değiştir
            </AppText>
          </Pressable>
        )}

        <GlassButton
          label="Çıkış yap"
          variant="outline"
          style={{ borderColor: colors.neonCoral }}
          onPress={() => setConfirmLogout(true)}
        />

        <ConfirmDialog
          visible={confirmLogout}
          title="Çıkış yap"
          message="Bu cihazda oturumun kapanır. Takma adın, bölgen ve rütbe puanın sunucuda saklı kalır — aynı hesapla tekrar giriş yapabilirsin."
          confirmLabel="Çıkış yap"
          destructive
          onConfirm={() => {
            setConfirmLogout(false);
            logout();
            haptic.select();
          }}
          onCancel={() => setConfirmLogout(false)}
        />
      </ScrollView>
    );
  }

  const canSubmit = email.trim().length > 0 && password.length > 0 && auth.status !== 'loading';

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
        eyebrow="Hesap"
        icon="profile"
        title="Giriş yap veya kayıt ol"
        subtitle="Hesabın takma adını, bölgeni ve rütbe puanını cihaz değişse de saklar; online ligde seni tanır."
        right={
          <GlassButton
            label="Kapat"
            variant="ghost"
            onPress={() => {
              haptic.select();
              router.back();
            }}
          />
        }
      />

      <GlassCard contentStyle={{ gap: spacing.md }}>
        <View style={{ gap: 4 }}>
          <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
            Sunucu adresi
          </AppText>
          <TextInput
            value={serverUrl}
            onChangeText={setServerUrl}
            onBlur={() => setAuthServer(serverUrl)}
            autoCapitalize="none"
            autoCorrect={false}
            style={{ ...inputStyle, fontFamily: 'JetBrainsMono_700Bold', fontSize: 12 }}
          />
        </View>

        <SegmentTabs
          items={[
            { key: 'login', label: 'Giriş yap' },
            { key: 'signup', label: 'Kayıt ol' },
          ]}
          value={mode}
          onChange={setMode}
          fill
        />

        <Field label="E-posta" value={email} onChangeText={setEmail} keyboardType="email-address" />
        <Field label="Şifre" value={password} onChangeText={setPassword} secure />

        {mode === 'signup' && (
          <>
            <Field label="Takma ad" value={nickname} onChangeText={setNickname} />
            {bootstrapData ? (
              <>
                <RegionPicker regions={bootstrapData.regions} value={region} onChange={setRegion} />
                <CountryPicker countries={bootstrapData.countries} value={countryCode} onChange={setCountryCode} />
              </>
            ) : (
              <AppText variant="labelSmall" color={colors.textTertiary}>
                Bölge/ülke önerileri sunucudan yükleniyor…
              </AppText>
            )}
          </>
        )}

        {auth.error && (
          <AppText variant="bodySmall" color={colors.neonCoral}>
            {auth.error}
          </AppText>
        )}

        <GlassButton
          label={mode === 'login' ? 'Giriş yap' : 'Hesap oluştur'}
          disabled={!canSubmit}
          onPress={async () => {
            setAuthServer(serverUrl);
            const ok =
              mode === 'login'
                ? await login({ email: email.trim(), password })
                : await register({
                    email: email.trim(),
                    password,
                    nicknameBase: nickname.trim() || undefined,
                    countryCode,
                    region,
                  });
            if (ok) haptic.success();
            else haptic.error();
          }}
        />

        <SocialRow />
      </GlassCard>
    </ScrollView>
  );
}
