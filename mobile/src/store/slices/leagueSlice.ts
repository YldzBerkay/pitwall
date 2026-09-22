import type { CarSetup, QualiRisk, RaceResult, RaceState, TacticPreset } from '@/data/raceEngine';
import type { TeamStanding } from '@/data/teams';
import type { SliceCreator } from './types';

/** Mirror of the server's public state (see server/src/league.ts). */
export interface LeaguePublicState {
  season: number;
  round: number;
  phase: 'open' | 'checkin' | 'live' | 'result';
  raceStartAt: number;
  checkinOpensAt: number;
  track: { key: string; gp: string; circuit: string; laps: number };
  standings: TeamStanding[];
  teams: { teamKey: string; claimed: boolean; checkedIn: boolean }[];
}

/**
 * Online mode. When connected, the server owns the race: it broadcasts every
 * lap over a WebSocket and this slice writes it into `weekend.race`, so the
 * live screen draws exactly what it draws offline. Pit calls go to the
 * server instead of the local engine. Check-in is a plain POST inside the
 * window the server announces; miss it and the assistant drives.
 */
export interface LeagueSlice {
  league: {
    url?: string;
    connected: boolean;
    /**
     * The team this device drives in the live room. It comes from the active
     * slot's seat (`lobbySlice.setActiveSlot`), which is the server's record
     * of which team this account actually holds — it used to be a hard-coded
     * constant back when there was exactly one lobby and one team.
     */
    teamKey: string;
    managerId: string;
    state?: LeaguePublicState;
    checkedIn: boolean;
    lastResult?: RaceResult;
    error?: string;
  };
  connectLeague: (url: string, teamKey?: string) => Promise<void>;
  disconnectLeague: () => void;
  /** Send this weekend's choices (setup, tactics, risk, reliability) to the server. */
  syncLeagueWeekend: () => Promise<void>;
  leagueCheckIn: () => Promise<'ok' | 'closed' | 'notOwner' | 'offline'>;
  leaguePit: (driverIdx: 0 | 1, compound: CarSetup['compound'] | null) => Promise<void>;
  /** True while the league race is being mirrored into the weekend. */
  isLeagueLive: () => boolean;
  /**
   * The id sent to the league server as `managerId`. A signed-in account
   * (`authSlice`) uses its real, cross-device user id so the manager's
   * league identity survives a reinstall; otherwise falls back to the
   * random per-install id below.
   */
  effectiveManagerId: () => string;
}

let socket: WebSocket | undefined;

const post = async (url: string, path: string, body: unknown): Promise<Record<string, unknown>> => {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await res.json()) as Record<string, unknown>;
};

const randomId = () => `mgr-${Math.random().toString(36).slice(2, 10)}`;

/** Fallback for a device that has not activated a slot yet. */
const DEFAULT_TEAM_KEY = 'bosphorus';

export const createLeagueSlice: SliceCreator<LeagueSlice> = (set, get) => ({
  league: { connected: false, teamKey: DEFAULT_TEAM_KEY, managerId: randomId(), checkedIn: false },

  effectiveManagerId: () => get().auth.user?.id ?? get().league.managerId,

  connectLeague: async (url, teamKey) => {
    const base = url.replace(/\/$/, '');
    const managerId = get().effectiveManagerId();
    const team = teamKey ?? get().league.teamKey;
    set((s) => ({ league: { ...s.league, teamKey: team } }));
    try {
      const joined = await post(base, '/join', { teamKey: team, managerId });
      if (joined.result !== 'ok') {
        set((s) => ({ league: { ...s.league, url: base, error: `Katılım başarısız: ${String(joined.result)}` } }));
        return;
      }
      set((s) => ({ league: { ...s.league, url: base, connected: false, error: undefined, state: joined.state as LeaguePublicState } }));
      await get().syncLeagueWeekend();

      socket?.close();
      socket = new WebSocket(`${base.replace(/^http/, 'ws')}/live`);
      socket.onopen = () => set((s) => ({ league: { ...s.league, connected: true } }));
      socket.onclose = () => set((s) => ({ league: { ...s.league, connected: false } }));
      socket.onerror = () => set((s) => ({ league: { ...s.league, error: 'Bağlantı hatası' } }));
      socket.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as
          | { type: 'phase'; state: LeaguePublicState }
          | { type: 'lap'; race: RaceState }
          | { type: 'result'; result: RaceResult };
        if (msg.type === 'phase') {
          const mine = msg.state.teams.find((t) => t.teamKey === team);
          set((s) => ({ league: { ...s.league, state: msg.state, checkedIn: Boolean(mine?.checkedIn) } }));
        } else if (msg.type === 'lap') {
          // Mirror the server's race into the weekend so the live screen just works.
          set((s) => ({
            weekend: { ...s.weekend, race: msg.race, prevRace: s.weekend.race, phase: 'race', pending: [undefined, undefined] },
          }));
        } else if (msg.type === 'result') {
          // The server has paid the league; locally the weekend just steps back
          // to practice so the offline flow stays usable.
          set((s) => ({
            league: { ...s.league, lastResult: msg.result, checkedIn: false },
            weekend: { ...s.weekend, race: undefined, prevRace: undefined, phase: s.weekend.qualifying ? 'grid' : 'practice' },
          }));
        }
      };
    } catch (e) {
      set((s) => ({ league: { ...s.league, url: base, error: `Sunucuya ulaşılamadı: ${String((e as Error).message)}` } }));
    }
  },

  disconnectLeague: () => {
    socket?.close();
    socket = undefined;
    set((s) => ({ league: { ...s.league, connected: false, state: undefined, checkedIn: false } }));
  },

  syncLeagueWeekend: async () => {
    const s = get();
    if (!s.league.url) return;
    const levels = Object.fromEntries(s.departments.map((d) => [d.code, d.level]));
    const reliability = Math.min(1, ((levels.manufacturing ?? 0) + (levels.engine_lab ?? 0)) / 10 + s.effects().reliabilityBonus);
    await post(s.league.url, '/weekend', {
      teamKey: s.league.teamKey,
      managerId: s.effectiveManagerId(),
      setup: { ...s.setup(), compound: s.weekend.raceCompound } satisfies CarSetup,
      tactics: s.weekend.tactics satisfies TacticPreset,
      risk: s.weekend.risk satisfies QualiRisk,
      reliability,
    });
  },

  leagueCheckIn: async () => {
    const s = get();
    if (!s.league.url) return 'offline';
    await s.syncLeagueWeekend();
    const r = await post(s.league.url, '/checkin', { teamKey: s.league.teamKey, managerId: s.effectiveManagerId() });
    const result = r.result as 'ok' | 'closed' | 'notOwner';
    if (result === 'ok') set((st) => ({ league: { ...st.league, checkedIn: true, state: r.state as LeaguePublicState } }));
    return result;
  },

  leaguePit: async (driverIdx, compound) => {
    const s = get();
    if (!s.league.url) return;
    await post(s.league.url, '/pit', { teamKey: s.league.teamKey, managerId: s.effectiveManagerId(), driverIdx, compound });
  },

  isLeagueLive: () => {
    const { league } = get();
    return league.connected && league.state?.phase === 'live';
  },
});
