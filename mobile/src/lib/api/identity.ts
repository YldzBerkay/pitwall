/**
 * Thin client for the server's identity/auth endpoints
 * (`server/src/auth/routes.ts`, `server/src/identity/routes.ts`). Same base
 * URL as the league server (`server/src/index.ts` serves both from one
 * process) — the address the player already enters to join a league.
 */
import type { Region } from '@pitwall/shared/regions';

export interface PublicProfile {
  id: string;
  nickname: string;
  nicknameBase: string;
  nicknameTag: string;
  country: string | null;
  region: Region | null;
  gold: number;
  rankPoints: number;
  createdAt: string;
}

export interface BootstrapResponse {
  suggestedNicknames: { base: string; tag: string }[];
  suggestedRegion: Region | null;
  regions: { id: Region; label: string; timeZone: string; hour: number }[];
  countries: { code: string; name: string; region: Region }[];
}

export interface AuthResponse {
  token: string;
  isNew: boolean;
  user: PublicProfile;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

const TIMEOUT_MS = 8000;

/**
 * Shared fetch wrapper: an 8-second timeout, JSON in and out, and a network
 * or parse failure turned into an `ApiResult` rather than a thrown error, so
 * callers have exactly one shape to branch on. Exported for the lobby client
 * (`./lobby.ts`), which talks to the same server with the same session.
 */
export async function request<T>(baseUrl: string, path: string, init: RequestInit): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, { ...init, signal: controller.signal });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, status: res.status, error: typeof body.error === 'string' ? body.error : 'unknown_error' };
    }
    return { ok: true, data: body as T };
  } catch (e) {
    const message = e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'network_error';
    return { ok: false, status: 0, error: message };
  } finally {
    clearTimeout(timer);
  }
}

const jsonHeaders = { 'content-type': 'application/json' };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export function bootstrap(baseUrl: string): Promise<ApiResult<BootstrapResponse>> {
  return request(baseUrl, '/onboarding/bootstrap', { method: 'GET' });
}

export interface OnboardingFields {
  nicknameBase?: string;
  countryCode?: string;
  region?: Region;
}

export function registerWithPassword(
  baseUrl: string,
  input: OnboardingFields & { email: string; password: string },
): Promise<ApiResult<AuthResponse>> {
  return request(baseUrl, '/auth/password/register', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
}

export function loginWithPassword(
  baseUrl: string,
  input: { email: string; password: string },
): Promise<ApiResult<AuthResponse>> {
  return request(baseUrl, '/auth/password/login', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
}

/**
 * Native Google/Apple/Facebook sign-in needs a linked native SDK (client
 * IDs, bundle identifiers, device testing) that isn't wired into this build
 * yet — the buttons in `AuthScreen` stay disabled until that lands. This
 * function exists so the plumbing on the server side (already built and
 * tested) has a client-side counterpart ready to call the moment it is.
 */
export function loginWithSocial(
  baseUrl: string,
  input: OnboardingFields & { provider: 'google' | 'apple' | 'facebook'; token: string },
): Promise<ApiResult<AuthResponse>> {
  return request(baseUrl, '/auth/social', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
}

export function getMe(baseUrl: string, token: string): Promise<ApiResult<PublicProfile>> {
  return request(baseUrl, '/me', { method: 'GET', headers: bearer(token) });
}

export function patchMe(
  baseUrl: string,
  token: string,
  patch: { countryCode?: string; region?: Region },
): Promise<ApiResult<PublicProfile>> {
  return request(baseUrl, '/me', {
    method: 'PATCH',
    headers: { ...jsonHeaders, ...bearer(token) },
    body: JSON.stringify(patch),
  });
}
