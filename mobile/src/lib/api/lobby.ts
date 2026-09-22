/**
 * Client for the server's slot/lobby/invite endpoints
 * (`server/src/lobby/routes.ts`). Same base URL and the same session token as
 * the identity client — one process serves both (`server/src/index.ts`).
 *
 * Every shape here mirrors a server response one-to-one. In particular the
 * `humans`/`ai` counts and the `seats` list on a preview card are the real
 * seat rows: the client must render them as they arrive and must never pad,
 * round or withhold a number to make a lobby look busier (spec §3.4).
 */
import type { Region } from '@/data/regions';
import { request, type ApiResult } from './identity';

export type AiDifficulty = 'easy' | 'normal' | 'hard';
export type Visibility = 'public' | 'private';
export type LobbyPhase = 'open' | 'checkin' | 'live' | 'result' | 'finished';

export interface LobbyView {
  id: string;
  name: string;
  region: Region;
  visibility: Visibility;
  aiDifficulty: AiDifficulty;
  rankMin: number;
  rankMax: number;
  guestsCanInvite: boolean;
  midSeasonJoin: boolean;
  seasonNo: number;
  roundNo: number;
  totalRounds: number;
  phase: LobbyPhase;
  nextRaceAt: string;
}

/** One row of "Sana kalan takımlar" — car, objective and what it pays. */
export interface SeatOffer {
  teamKey: string;
  teamName: string;
  carRating: number;
  /** Season objective as a finishing position: 5 → "hedef P5". */
  objective: number;
  /** Rank points for meeting it, AI-difficulty multiplier already applied. */
  rankPoints: number;
}

export interface SeatView {
  teamKey: string;
  userId: string | null;
  managed: 'human' | 'assistant' | 'ai';
  nickname: string | null;
  countryCode: string | null;
}

export interface SlotLobbyView {
  id: string;
  name: string;
  region: string;
  aiDifficulty: AiDifficulty;
  seasonNo: number;
  roundNo: number;
  totalRounds: number;
  phase: LobbyPhase;
  nextRaceAt: string;
  teamKey: string | null;
  teamName: string | null;
}

export interface SlotView {
  slotIndex: number;
  unlocked: boolean;
  lobbyId: string | null;
  lobby: SlotLobbyView | null;
}

export interface SlotsResponse {
  gold: number;
  slotPrice: number;
  slots: SlotView[];
}

export interface CandidateCard {
  lobby: LobbyView;
  /** Seats really held by a person. */
  humans: number;
  /** Seats really driven by the AI. */
  ai: number;
  occupancy: { topPair: boolean; car3: boolean; car4: boolean };
  seats: SeatOffer[];
}

export interface QuickMatchResponse {
  /** null means "nothing in the pool" — the client offers a fresh lobby. */
  candidate: CandidateCard | null;
}

export interface CreateLobbyResponse {
  lobby: LobbyView;
  /** All eleven, because the creator picks first (§3.2). */
  seats: SeatOffer[];
}

export interface JoinResponse {
  lobby: LobbyView;
  slotIndex: number;
  teamKey: string;
  seats: SeatView[];
}

export interface InviteView {
  id: string;
  lobby: LobbyView;
  inviter: string | null;
  expiresAt: string;
  seats: SeatOffer[];
}

export interface LobbySettingsInput {
  region?: Region;
  visibility?: Visibility;
  aiDifficulty?: AiDifficulty;
  rankMin?: number;
  rankMax?: number;
  guestsCanInvite?: boolean;
  midSeasonJoin?: boolean;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const jsonAuth = (token: string) => ({ 'content-type': 'application/json', ...auth(token) });

const post = <T>(baseUrl: string, token: string, path: string, body: unknown): Promise<ApiResult<T>> =>
  request<T>(baseUrl, path, { method: 'POST', headers: jsonAuth(token), body: JSON.stringify(body) });

export function getSlots(baseUrl: string, token: string): Promise<ApiResult<SlotsResponse>> {
  return request(baseUrl, '/slots', { method: 'GET', headers: auth(token) });
}

export function unlockSlot(
  baseUrl: string,
  token: string,
  slotIndex: number,
): Promise<ApiResult<{ gold: number; slots: SlotView[] }>> {
  return post(baseUrl, token, '/slots/unlock', { slotIndex });
}

export function createLobby(
  baseUrl: string,
  token: string,
  settings: LobbySettingsInput,
): Promise<ApiResult<CreateLobbyResponse>> {
  return post(baseUrl, token, '/lobby/create', settings);
}

/** `exclude` carries the ids already shown, so "Başka bul" moves on. */
export function quickMatch(
  baseUrl: string,
  token: string,
  exclude: string[],
): Promise<ApiResult<QuickMatchResponse>> {
  return post(baseUrl, token, '/lobby/quick-match', { exclude });
}

export function joinLobby(
  baseUrl: string,
  token: string,
  input: { lobbyId: string; teamKey: string; slotIndex?: number },
): Promise<ApiResult<JoinResponse>> {
  return post(baseUrl, token, '/lobby/join', input);
}

export function getLobby(
  baseUrl: string,
  token: string,
  lobbyId: string,
): Promise<ApiResult<{ lobby: LobbyView; seats: SeatView[] }>> {
  return request(baseUrl, `/lobby?id=${encodeURIComponent(lobbyId)}`, { method: 'GET', headers: auth(token) });
}

/** Invites by FULL `Nickname#1234` tag — partial search does not exist (§5). */
export function inviteToLobby(
  baseUrl: string,
  token: string,
  input: { lobbyId: string; nickname: string },
): Promise<ApiResult<{ inviteId: string; expiresAt: string }>> {
  return post(baseUrl, token, '/lobby/invite', input);
}

export function getInvites(baseUrl: string, token: string): Promise<ApiResult<{ invites: InviteView[] }>> {
  return request(baseUrl, '/invites', { method: 'GET', headers: auth(token) });
}
