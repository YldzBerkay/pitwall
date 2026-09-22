/**
 * One league: eleven teams, a calendar, and a race clock that waits for nobody.
 *
 * The server owns the truth. It runs the SAME race engine the app ships
 * (`mobile/src/data`), so a client can replay any lap it receives and get the
 * identical state. Managers claim a team, submit their weekend choices, and
 * must CHECK IN inside the window before lights out; a team that does not is
 * driven by the assistant on its preset tactics. Teams nobody claimed are AI.
 *
 * Lifecycle per round:
 *   open ──(T − CHECKIN_SECONDS)──▶ checkin ──(T)──▶ live ──(flag)──▶ result ──▶ open (next round)
 */

import { advanceLap, finishRace, simulateQualifying, startRace, weatherFor, type CarSetup, type Decisions, type Entries, type QualiRisk, type RaceResult, type RaceState, type TacticPreset } from '@pitwall/shared/raceEngine';
import { freshStandings, SEASON_ROUNDS } from '@pitwall/shared/season';
import { playerTeam, teams, type TeamStanding } from '@pitwall/shared/teams';
import { trackForRound } from '@pitwall/shared/tracks';

export type Phase = 'open' | 'checkin' | 'live' | 'result';

export interface TeamSlot {
  teamKey: string;
  managerId?: string;
  setup: CarSetup;
  tactics: TacticPreset;
  risk: QualiRisk;
  reliability: number;
  checkedIn: boolean;
}

export interface LeagueConfig {
  /** Real milliseconds per lap. */
  tickMs: number;
  /** Check-in window before lights out, ms. */
  checkinMs: number;
  /** Time from one race's result to the next race's lights out, ms. */
  intervalMs: number;
  /** First race: lights out this long after boot, ms. */
  firstRaceInMs: number;
}

export interface PublicState {
  season: number;
  round: number;
  phase: Phase;
  raceStartAt: number;
  checkinOpensAt: number;
  track: { key: string; gp: string; circuit: string; laps: number };
  standings: TeamStanding[];
  teams: { teamKey: string; claimed: boolean; checkedIn: boolean }[];
  lap?: number;
  laps?: number;
}

export type Listener = (event: { type: 'phase'; state: PublicState } | { type: 'lap'; race: RaceState } | { type: 'result'; result: RaceResult }) => void;

const defaultSetup = (): CarSetup => ({ motor: 67, aero: 58, grip: 72, compound: 'MEDIUM', bias: 0 });

export class League {
  season = 1;
  round = 1;
  phase: Phase = 'open';
  standings: TeamStanding[] = freshStandings();
  slots = new Map<string, TeamSlot>();
  raceStartAt: number;
  race?: RaceState;
  result?: RaceResult;
  private decisions: Decisions = {};
  private clock?: ReturnType<typeof setInterval>;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private listeners = new Set<Listener>();

  constructor(public cfg: LeagueConfig, now = Date.now()) {
    for (const t of teams) {
      this.slots.set(t.key, { teamKey: t.key, setup: defaultSetup(), tactics: 'balanced', risk: 'safe', reliability: 0.3, checkedIn: false });
    }
    this.raceStartAt = now + cfg.firstRaceInMs;
    this.schedule();
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(event: Parameters<Listener>[0]) {
    for (const l of this.listeners) l(event);
  }

  get track() {
    return trackForRound(this.round);
  }

  publicState(): PublicState {
    const t = this.track;
    return {
      season: this.season,
      round: this.round,
      phase: this.phase,
      raceStartAt: this.raceStartAt,
      checkinOpensAt: this.raceStartAt - this.cfg.checkinMs,
      track: { key: t.key, gp: t.gp, circuit: t.circuit, laps: t.laps },
      standings: this.standings,
      teams: [...this.slots.values()].map((s) => ({ teamKey: s.teamKey, claimed: Boolean(s.managerId), checkedIn: s.checkedIn })),
      lap: this.race?.lap,
      laps: this.race?.laps,
    };
  }

  // ── Manager actions ──────────────────────────────────────────────────────

  join(teamKey: string, managerId: string): 'ok' | 'taken' | 'unknown' {
    const slot = this.slots.get(teamKey);
    if (!slot) return 'unknown';
    if (slot.managerId && slot.managerId !== managerId) return 'taken';
    slot.managerId = managerId;
    this.emit({ type: 'phase', state: this.publicState() });
    return 'ok';
  }

  private owns(teamKey: string, managerId: string): TeamSlot | undefined {
    const slot = this.slots.get(teamKey);
    return slot && slot.managerId === managerId ? slot : undefined;
  }

  setWeekend(teamKey: string, managerId: string, choices: Partial<Pick<TeamSlot, 'setup' | 'tactics' | 'risk' | 'reliability'>>): boolean {
    const slot = this.owns(teamKey, managerId);
    if (!slot || this.phase === 'live') return false;
    Object.assign(slot, choices);
    return true;
  }

  /** Only inside the window: too early is refused, too late is refused. */
  checkIn(teamKey: string, managerId: string, now = Date.now()): 'ok' | 'closed' | 'notOwner' {
    const slot = this.owns(teamKey, managerId);
    if (!slot) return 'notOwner';
    if (this.phase !== 'checkin' || now >= this.raceStartAt) return 'closed';
    slot.checkedIn = true;
    this.emit({ type: 'phase', state: this.publicState() });
    return 'ok';
  }

  /** A pit call for the next lap. Ignored unless the race is live and the manager checked in. */
  pit(teamKey: string, managerId: string, driverIdx: 0 | 1, compound: CarSetup['compound'] | null): boolean {
    const slot = this.owns(teamKey, managerId);
    if (!slot || !slot.checkedIn || this.phase !== 'live') return false;
    const id = `${teamKey}:${driverIdx}`;
    if (compound) this.decisions[id] = { compound };
    else delete this.decisions[id];
    return true;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  private schedule() {
    this.clearTimers();
    const now = Date.now();
    this.timers.push(setTimeout(() => this.openCheckIn(), Math.max(0, this.raceStartAt - this.cfg.checkinMs - now)));
    this.timers.push(setTimeout(() => this.lightsOut(), Math.max(0, this.raceStartAt - now)));
    this.emit({ type: 'phase', state: this.publicState() });
  }

  private clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private openCheckIn() {
    if (this.phase !== 'open') return;
    this.phase = 'checkin';
    this.emit({ type: 'phase', state: this.publicState() });
  }

  private entries(): Entries {
    const out: Entries = {};
    for (const slot of this.slots.values()) {
      if (!slot.managerId) continue; // unclaimed → AI
      out[slot.teamKey] = {
        setup: slot.setup,
        reliability: slot.reliability,
        tactics: slot.tactics,
        managed: slot.checkedIn ? 'human' : 'assistant',
      };
    }
    return out;
  }

  lightsOut() {
    if (this.phase === 'live') return;
    this.phase = 'live';
    const seed = this.season * 1000 + this.round;
    const track = this.track;
    const weather = weatherFor(track, seed);
    const entries = this.entries();
    const risks = Object.fromEntries([...this.slots.values()].filter((s) => s.managerId).map((s) => [s.teamKey, s.risk]));
    const qualifying = simulateQualifying({ track, entries, wet: weather.wetAtStart, risks, round: this.round, seed });
    this.race = startRace({ standings: this.standings, track, entries, weather, grid: qualifying.grid, round: this.round, seed });
    this.decisions = {};
    this.emit({ type: 'phase', state: this.publicState() });
    this.emit({ type: 'lap', race: this.race });
    this.clock = setInterval(() => this.tick(), this.cfg.tickMs);
  }

  private tick() {
    if (!this.race) return;
    this.race = advanceLap(this.race, this.track, this.decisions);
    this.decisions = {};
    this.emit({ type: 'lap', race: this.race });
    if (this.race.finished) this.flag();
  }

  private flag() {
    if (this.clock) clearInterval(this.clock);
    this.clock = undefined;
    if (!this.race) return;
    this.result = finishRace(this.race);
    this.standings = this.result.standings;
    this.phase = 'result';
    this.emit({ type: 'result', result: this.result });
    // Next round: reset check-ins, roll the calendar, reopen.
    for (const slot of this.slots.values()) slot.checkedIn = false;
    this.round += 1;
    if (this.round > SEASON_ROUNDS) {
      this.round = 1;
      this.season += 1;
      this.standings = freshStandings();
    }
    this.race = undefined;
    this.raceStartAt = Date.now() + this.cfg.intervalMs;
    this.phase = 'open';
    this.schedule();
  }

  stop() {
    this.clearTimers();
    if (this.clock) clearInterval(this.clock);
  }
}

/** The team the app's single-player save controls; the default claim target. */
export const DEFAULT_TEAM = playerTeam.key;
