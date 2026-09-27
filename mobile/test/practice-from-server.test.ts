/**
 * Tests for practice sessions reaching the client
 * (`mobile/src/store/slices/raceSlice.ts`'s new `practice` field and
 * `displayPractice` selector, plus `raceSocket.ts`'s new `practice` frame).
 *
 * The server (`server/src/lobby/sweep.ts`) now announces a completed
 * practice session over the same `/race/live` socket the phase/lap frames
 * already use — a bare event (`lobbyId`, `seasonNo`, `roundNo`, `sessionNo`),
 * never the timesheet itself (mirrors `phase`'s own "announce, don't carry
 * the recipe" shape). The slice reacts to that event by fetching the whole
 * completed-sessions list from `GET /lobby/practice`
 * (`mobile/src/lib/api/practice.ts`) and stores it.
 *
 * Two rules this file exists to prove, both called out in the task brief as
 * previously-bitten bugs:
 *  - a `lap` frame (a FULL replacement of `race`) must not wipe the stored
 *    practice sessions — mirrors the historical bug where a `lap` frame wiped
 *    the stored qualifying result;
 *  - a `practice` frame must not wipe `phase`/`qualifying` either, and must
 *    not itself be wiped by one — same structural guarantee `phase`/
 *    `qualifying` already get from being on their own frame type.
 *
 * NO LOCAL FALLBACK: `displayPractice` takes no local-sheet argument at all
 * (unlike `displayRace`/`displayQualifying`, which still serve the legacy
 * solo weekend) — the old `PracticePanel.tsx` already had its local
 * `runPractice`/`simulatePractice` calls removed when the server took over
 * the weekend, so there is no local sheet left to fall back to. With no
 * lobby, the selector says so plainly.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { create } from 'zustand';
import type { ApiResult } from '@/lib/api/identity';
import type { PracticeSession, PracticeSessionsResponse } from '@/lib/api/practice';
import type { QualifyingResult } from '@pitwall/shared/raceEngine';
import type { ConnectionStatus, LobbyPhase, RaceSocket, RaceSocketState, SerialisedRace } from '@/lib/api/raceSocket';
import {
  createRaceSlice,
  displayPractice,
  type RaceSlice,
  type RaceSliceDeps,
  type RaceSliceState,
} from '@/store/slices/raceSlice';

const TOKEN = 'session-token-abc';
const LOBBY_ID = 'lobby-1';

function makeRace(lap: number): SerialisedRace {
  return {
    lap,
    laps: 58,
    finished: false,
    wet: false,
    trackKey: 'fictional-1',
    round: 1,
    session: 'race',
    cars: [],
    events: [],
    control: { yellow: 0, vsc: 0, sc: 0, red: 0 },
    fastestLap: undefined,
    weather: { forecast: 0.1, wetAtStart: false },
    neutralised: undefined,
  };
}

function makeSessions(): PracticeSession[] {
  return [
    {
      sessionNo: 1,
      wet: false,
      result: {
        order: [{ teamKey: 'ferrari', driverIdx: 0, driver: 'A. Rossi', sec: 91.234 }],
      },
    },
  ];
}

/** A hand-driven `RaceSocket` stand-in carrying the full `RaceSocketState`
 *  shape (status/race/qualifying/phase/season/round/practiceEvent) — needed
 *  here (unlike `race-slice.test.ts`'s narrower fake) because these tests
 *  exercise phase/qualifying/practice preservation across frame types. */
function makeFakeSocket() {
  let status: ConnectionStatus = 'connecting';
  let race: SerialisedRace | null = null;
  let qualifying: QualifyingResult | undefined;
  let phase: LobbyPhase | undefined;
  let seasonNo: number | undefined;
  let roundNo: number | undefined;
  let practiceEvent: RaceSocketState['practiceEvent'];
  const listeners = new Set<(s: RaceSocketState) => void>();

  const socket: RaceSocket = {
    getState: () => ({ status, race, qualifying, phase, seasonNo, roundNo, practiceEvent }),
    addListener: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {},
  };

  const emit = (next: Partial<RaceSocketState>) => {
    if (next.status !== undefined) status = next.status;
    if ('race' in next) race = next.race ?? null;
    if ('qualifying' in next) qualifying = next.qualifying;
    if ('phase' in next) phase = next.phase;
    if ('seasonNo' in next) seasonNo = next.seasonNo;
    if ('roundNo' in next) roundNo = next.roundNo;
    if ('practiceEvent' in next) practiceEvent = next.practiceEvent;
    const snapshot: RaceSocketState = { status, race, qualifying, phase, seasonNo, roundNo, practiceEvent };
    for (const l of [...listeners]) l(snapshot);
  };

  return { socket, emit };
}

interface PracticeCall {
  baseUrl: string;
  token: string;
  lobbyId: string;
}

function setup(sessionsResult: ApiResult<PracticeSessionsResponse> = { ok: true, data: { sessions: makeSessions() } }) {
  const fake = makeFakeSocket();
  const practiceCalls: PracticeCall[] = [];

  const createSocket = () => fake.socket;
  const practiceApi = async (baseUrl: string, token: string, lobbyId: string): Promise<ApiResult<PracticeSessionsResponse>> => {
    practiceCalls.push({ baseUrl, token, lobbyId });
    return sessionsResult;
  };

  const useStore = create<RaceSlice & RaceSliceDeps>()((set, get) => ({
    auth: { baseUrl: 'http://example.test', token: TOKEN },
    ...createRaceSlice(set as never, get as never, { createSocket, practiceApi }),
  }));

  return { useStore, fake, practiceCalls };
}

// ── 7. Completed sessions land in the store ────────────────────────────────

test('a practice-completion event fetches and stores the completed sessions', async () => {
  const { useStore, fake, practiceCalls } = setup();
  useStore.getState().connectRace(LOBBY_ID);

  fake.emit({ status: 'connected', race: null });
  assert.deepEqual(useStore.getState().race.practice, [], 'practice must start empty, not fabricated');

  fake.emit({ practiceEvent: { seasonNo: 1, roundNo: 1, sessionNo: 1 } });
  // The fetch this event triggers is async; give the microtask queue a turn.
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(practiceCalls.length, 1, 'the practice-completion event never triggered a fetch');
  assert.equal(practiceCalls[0].lobbyId, LOBBY_ID);
  assert.deepEqual(useStore.getState().race.practice, makeSessions(), 'the fetched sessions never landed in the store');
});

// ── 8a. A lap frame (full replacement of `race`) does not wipe practice ────

test('a lap frame does not wipe the stored practice sessions', async () => {
  const { useStore, fake } = setup();
  useStore.getState().connectRace(LOBBY_ID);

  fake.emit({ practiceEvent: { seasonNo: 1, roundNo: 1, sessionNo: 1 } });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(useStore.getState().race.practice, makeSessions());

  fake.emit({ status: 'connected', race: makeRace(1) });
  assert.deepEqual(useStore.getState().race.practice, makeSessions(), 'a lap frame wiped the stored practice sessions');

  fake.emit({ race: makeRace(2) });
  assert.deepEqual(useStore.getState().race.practice, makeSessions(), 'a second lap frame wiped the stored practice sessions');
});

// ── 8b. A practice frame does not wipe phase or qualifying ─────────────────

test('a practice-completion event does not wipe the stored phase or qualifying', async () => {
  const { useStore, fake } = setup();
  useStore.getState().connectRace(LOBBY_ID);

  const qualifying = { grid: [] } as unknown as QualifyingResult;
  fake.emit({ status: 'connected', race: null, qualifying, phase: 'open', seasonNo: 1, roundNo: 1 });
  assert.equal(useStore.getState().race.phase, 'open');
  assert.equal(useStore.getState().race.qualifying, qualifying);

  fake.emit({ practiceEvent: { seasonNo: 1, roundNo: 1, sessionNo: 2 } });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(useStore.getState().race.phase, 'open', 'a practice event wiped the stored phase');
  assert.equal(useStore.getState().race.qualifying, qualifying, 'a practice event wiped the stored qualifying');
});

// ── 9. No lobby: the selector says so, no local sheet ──────────────────────

test('displayPractice: with no lobby, there is no local sheet to fall back to', () => {
  const race: Pick<RaceSliceState, 'lobbyId' | 'practice'> = {
    lobbyId: undefined,
    practice: makeSessions(),
  };

  const result = displayPractice(race);
  assert.deepEqual(result, { kind: 'no-lobby' });
  assert.notEqual((result as { kind: string }).kind, 'ready', 'must not surface a sheet with no lobby seated');
});

test('displayPractice: seated in a lobby, the fetched sessions are surfaced as-is', () => {
  const sessions = makeSessions();
  const race: Pick<RaceSliceState, 'lobbyId' | 'practice'> = {
    lobbyId: LOBBY_ID,
    practice: sessions,
  };

  const result = displayPractice(race);
  assert.deepEqual(result, { kind: 'ready', sessions });
});
