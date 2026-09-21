import {
  bootstrap,
  getMe,
  loginWithPassword,
  patchMe,
  registerWithPassword,
  type BootstrapResponse,
  type OnboardingFields,
  type PublicProfile,
} from '@/lib/api/identity';
import type { Region } from '@/data/regions';
import type { SliceCreator } from './types';

export const DEFAULT_AUTH_SERVER = 'http://localhost:8787';

/**
 * The account layer (Faz 1a on the server, wired to the client here): a
 * signed-in player has a real, cross-device identity — a nickname, a
 * region, gold and rank points that live in Postgres, not just on this
 * device. Only `baseUrl`/`token`/`user` persist (see `gameStore.ts`'s
 * `partialize`); a stored token is a 30-day server session
 * (`server/src/auth/jwt.ts`) and is never assumed valid — `refreshMe`
 * re-checks it and logs out silently if the server rejects it.
 *
 * Google/Apple/Facebook sign-in is NOT wired here: it needs a linked native
 * SDK per platform (client IDs, bundle identifiers, device testing) that is
 * out of scope for this pass, even though the server side already accepts
 * and verifies those tokens (`server/src/auth/providers/*`). Only
 * email+password is live end to end.
 */
export interface AuthSlice {
  auth: {
    baseUrl: string;
    token?: string;
    user?: PublicProfile;
    status: 'idle' | 'loading';
    error?: string;
  };
  setAuthServer: (url: string) => void;
  fetchBootstrap: () => Promise<BootstrapResponse | undefined>;
  register: (input: OnboardingFields & { email: string; password: string }) => Promise<boolean>;
  login: (input: { email: string; password: string }) => Promise<boolean>;
  logout: () => void;
  /** Re-checks the stored token against the server; clears it silently on a 401. */
  refreshMe: () => Promise<void>;
  updateAccountProfile: (patch: { countryCode?: string; region?: Region }) => Promise<boolean>;
}

const ERROR_LABEL: Record<string, string> = {
  invalid_credentials: 'E-posta veya şifre yanlış.',
  email_taken: 'Bu e-posta zaten kayıtlı — giriş yapmayı dener misin?',
  invalid_email: 'Geçerli bir e-posta adresi gir.',
  password_too_short: 'Şifre çok kısa.',
  password_too_long: 'Şifre çok uzun.',
  nickname_too_short: 'Takma ad çok kısa.',
  nickname_too_long: 'Takma ad çok uzun.',
  nickname_invalid_chars: 'Takma adda geçersiz karakter var.',
  nickname_blocked: 'Bu takma ad kullanılamaz, başka bir tane dene.',
  invalid_country: 'Geçersiz ülke.',
  invalid_region: 'Geçersiz bölge.',
  timeout: 'Sunucu yanıt vermedi — adres doğru mu?',
  network_error: 'Sunucuya ulaşılamadı — adres ve bağlantını kontrol et.',
};

const errorText = (code: string): string => ERROR_LABEL[code] ?? `Hata: ${code}`;

export const createAuthSlice: SliceCreator<AuthSlice> = (set, get) => ({
  auth: { baseUrl: DEFAULT_AUTH_SERVER, status: 'idle' },

  setAuthServer: (url) => set((s) => ({ auth: { ...s.auth, baseUrl: url.trim(), error: undefined } })),

  fetchBootstrap: async () => {
    const { baseUrl } = get().auth;
    const res = await bootstrap(baseUrl);
    if (!res.ok) {
      set((s) => ({ auth: { ...s.auth, error: errorText(res.error) } }));
      return undefined;
    }
    return res.data;
  },

  register: async (input) => {
    const { baseUrl } = get().auth;
    set((s) => ({ auth: { ...s.auth, status: 'loading', error: undefined } }));
    const res = await registerWithPassword(baseUrl, input);
    if (!res.ok) {
      set((s) => ({ auth: { ...s.auth, status: 'idle', error: errorText(res.error) } }));
      return false;
    }
    set((s) => ({ auth: { ...s.auth, status: 'idle', error: undefined, token: res.data.token, user: res.data.user } }));
    return true;
  },

  login: async (input) => {
    const { baseUrl } = get().auth;
    set((s) => ({ auth: { ...s.auth, status: 'loading', error: undefined } }));
    const res = await loginWithPassword(baseUrl, input);
    if (!res.ok) {
      set((s) => ({ auth: { ...s.auth, status: 'idle', error: errorText(res.error) } }));
      return false;
    }
    set((s) => ({ auth: { ...s.auth, status: 'idle', error: undefined, token: res.data.token, user: res.data.user } }));
    return true;
  },

  logout: () => set((s) => ({ auth: { baseUrl: s.auth.baseUrl, status: 'idle' } })),

  refreshMe: async () => {
    const { baseUrl, token } = get().auth;
    if (!token) return;
    const res = await getMe(baseUrl, token);
    if (!res.ok) {
      // A rejected token (expired, or the server rotated its secret) means
      // this session is over — log out quietly rather than leaving the UI
      // stuck showing a profile the server no longer recognises.
      if (res.status === 401) set((s) => ({ auth: { baseUrl: s.auth.baseUrl, status: 'idle' } }));
      return;
    }
    set((s) => ({ auth: { ...s.auth, user: res.data } }));
  },

  updateAccountProfile: async (patch) => {
    const { baseUrl, token } = get().auth;
    if (!token) return false;
    set((s) => ({ auth: { ...s.auth, status: 'loading', error: undefined } }));
    const res = await patchMe(baseUrl, token, patch);
    if (!res.ok) {
      set((s) => ({ auth: { ...s.auth, status: 'idle', error: errorText(res.error) } }));
      return false;
    }
    set((s) => ({ auth: { ...s.auth, status: 'idle', error: undefined, user: res.data } }));
    return true;
  },
});
