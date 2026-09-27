/**
 * Client for the server's practice read path
 * (`server/src/lobby/routes.ts`'s `GET /lobby/practice`, backed by
 * `server/src/lobby/practice.ts`'s frozen `practice_runs`).
 *
 * ONE route, `GET /lobby/practice?id=` — matching `GET /lobby`/`GET
 * /lobby/standings`'s own `?id=` precedent (`server/src/lobby/routes.ts`'s
 * doc comment: exact path, no path parameters). Read-only: the server route
 * calls neither `freezePracticeSession` nor anything else that writes.
 *
 * Returns every session FROZEN SO FAR for the lobby's current season/round,
 * each already carrying its derived `PracticeResult` — the lap-time sheet
 * (`TimedEntry[]`), which is drawing data (team, driver, lap time), never
 * the frozen `Entries` snapshot the server used to produce it. Two different
 * seated players calling this for the same lobby get byte-identical
 * `sessions`, because the server derives the result from the same immutable
 * recipe every time (`derivePracticeResult` is pure and seeded).
 */
import { request, type ApiResult } from './identity';
import type { PracticeResult } from '@pitwall/shared/raceEngine';

const PRACTICE_PATH = '/lobby/practice';

/** One frozen session, exactly as `server/src/lobby/routes.ts`'s
 *  `handleGetPractice` returns it. */
export interface PracticeSession {
  sessionNo: 1 | 2 | 3;
  wet: boolean;
  result: PracticeResult;
}

export interface PracticeSessionsResponse {
  sessions: PracticeSession[];
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** `GET /lobby/practice?id=` — every session frozen so far, oldest first. */
export function practiceSessions(baseUrl: string, token: string, lobbyId: string): Promise<ApiResult<PracticeSessionsResponse>> {
  return request<PracticeSessionsResponse>(baseUrl, `${PRACTICE_PATH}?id=${encodeURIComponent(lobbyId)}`, {
    method: 'GET',
    headers: auth(token),
  });
}
