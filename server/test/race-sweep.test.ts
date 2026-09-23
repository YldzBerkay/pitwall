/**
 * Yarış SÜPÜRME DÖNGÜSÜ — evre, kira, koşucu, yayın ve muhasebeyi tek bir
 * atışa bağlayan telin testi.
 *
 * Buraya kadarki her parça (`phase.ts`, `lease.ts`, `runner.ts`, `live.ts`,
 * `settle.ts`) kendi başına sınanıyordu ama hiçbiri diğerini çağırmıyordu —
 * `openRace` yalnızca testlerden çağrılıyor, `hub.publish` HİÇ çağrılmıyordu.
 * Bu dosyanın derdi "her parça doğru mu" değil (onu zaten kanıtladılar),
 * "hepsi birlikte GERÇEKTEN yürüyor mu".
 *
 * PAYLAŞILAN test veritabanı: BAŞKA ajanlar da aynı şemayı kullanıyor. Bu
 * yüzden tablo geneli `delete` YOK — yalnızca burada yaratılan kimlikler
 * izlenir ve yalnızca onlar silinir (`race-runner.test.ts`/`race-live.test.ts`
 * ile aynı desen).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { signSession } from '../src/auth/jwt.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';
import { createLobby } from '../src/lobby/lobbyRepo.ts';
import { SEAT_LADDER } from '../src/lobby/grid.ts';
import { RACE_TICK_MS } from '../src/lobby/runner.ts';
import { createLiveHub, LIVE_PATH, type LiveHub } from '../src/lobby/live.ts';
import { createRaceSweep } from '../src/lobby/sweep.ts';
import { trackForRound } from '@pitwall/shared/tracks';

const createdLobbies: string[] = [];
const createdUsers: string[] = [];
let seq = 0;

const HUMAN = SEAT_LADDER[0];
/** Kısa bir yarış: az tur, testleri bayrağa çabuk götürsün. */
const ROUND = trackKeyWithFewestLaps();

function trackKeyWithFewestLaps(): number {
  let best = 1;
  let bestLaps = trackForRound(1).laps;
  for (let r = 2; r <= 20; r += 1) {
    const laps = trackForRound(r).laps;
    if (laps < bestLaps) { best = r; bestLaps = laps; }
  }
  return best;
}
const LAPS = trackForRound(ROUND).laps;

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  seq += 1;
  const user = await createUserWithIdentity({
    base: 'GridHunter', provider: 'google', providerUid: `sweep-${tag}-${seq}-${Date.now()}`, emailHash: null,
  });
  createdUsers.push(user.id);
  return { id: user.id, token: await signSession(user.id) };
}

/** Testin ihtiyaç duyduğu en küçük lobi: bir insan koltuğu, gerisi AI. */
async function makeLobby(tag: string): Promise<{ lobbyId: string; token: string }> {
  const owner = await makeUser(`own-${tag}`);
  const lobby = await createLobby(owner.id, {
    region: 'EU', visibility: 'private', aiDifficulty: 'normal',
    rankMin: 1, rankMax: 10, guestsCanInvite: false, midSeasonJoin: true,
  });
  createdLobbies.push(lobby.id);
  const seatUser = await makeUser(`seat-${tag}`);
  await query(
    `update lobby_seats set user_id = $3, managed = 'human', joined_at = now()
     where lobby_id = $1 and team_key = $2`,
    [lobby.id, HUMAN, seatUser.id],
  );
  return { lobbyId: lobby.id, token: seatUser.token };
}

/** Lobiyi vakti gelmiş, `open` evresinde bırakır — süpürmenin ele alacağı hâl. */
async function setDueOpen(lobbyId: string, now: Date): Promise<void> {
  await query(
    `update lobbies set phase = 'open', season_no = 1, round_no = $2, next_race_at = $3,
                        race_owner = null, race_lease_until = null
      where id = $1`,
    [lobbyId, ROUND, now],
  );
}

/** Lobiyi çok İLERİDE bir yarışla, dokunulmaması gereken hâlde bırakır. */
async function setNotDue(lobbyId: string, now: Date): Promise<void> {
  await query(
    `update lobbies set phase = 'open', season_no = 1, round_no = $2,
                        next_race_at = $3, race_owner = null, race_lease_until = null
      where id = $1`,
    [lobbyId, ROUND, new Date(now.getTime() + 24 * 60 * 60 * 1000)],
  );
}

async function raceRunsRow(lobbyId: string) {
  const res = await query<{ last_lap: number; finished_at: Date | null }>(
    'select last_lap, finished_at from race_runs where lobby_id = $1 and season_no = 1 and round_no = $2',
    [lobbyId, ROUND],
  );
  return res.rows[0] ?? null;
}

async function lobbyPhase(lobbyId: string): Promise<string> {
  const res = await query<{ phase: string }>('select phase from lobbies where id = $1', [lobbyId]);
  return res.rows[0].phase;
}

async function settlementCount(lobbyId: string): Promise<number> {
  const res = await query(
    'select 1 from race_settlements where lobby_id = $1 and season_no = 1 and round_no = $2',
    [lobbyId, ROUND],
  );
  return res.rowCount ?? 0;
}

const at = (t0: Date, laps: number) => new Date(t0.getTime() + laps * RACE_TICK_MS + 5);

describe('race sweep — the loop that drives everything', () => {
  before(async () => {
    process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'a'.repeat(32);
    process.env.EMAIL_HASH_PEPPER = process.env.EMAIL_HASH_PEPPER ?? 'test-pepper-value';
    await runMigrations();
  });
  after(async () => {
    for (const id of createdLobbies) await query('delete from lobbies where id = $1', [id]);
    for (const id of createdUsers) await query('delete from users where id = $1', [id]);
    await closePool();
  });

  it('one sweep advances a due open lobby all the way to a started race', async () => {
    const hub = createLiveHub();
    const sweep = createRaceSweep('owner-1', hub);
    const { lobbyId } = await makeLobby('start');
    const t0 = new Date();
    await setDueOpen(lobbyId, t0);

    const result = await sweep.sweepOnce(t0);
    assert.ok(result.phaseAdvances >= 1, 'no phase advanced');
    assert.equal(await lobbyPhase(lobbyId), 'live', 'lobby never reached live');

    const run = await raceRunsRow(lobbyId);
    assert.ok(run, 'no race_runs row was written — the race was never started');
  });

  it('repeated sweeps advance the race lap by lap', async () => {
    const hub = createLiveHub();
    const sweep = createRaceSweep('owner-2', hub);
    const { lobbyId } = await makeLobby('laps');
    const t0 = new Date();
    await setDueOpen(lobbyId, t0);

    await sweep.sweepOnce(t0);
    let run = await raceRunsRow(lobbyId);
    assert.ok(run);
    const lap0 = run!.last_lap;

    await sweep.sweepOnce(at(t0, 1));
    run = await raceRunsRow(lobbyId);
    assert.ok(run!.last_lap > lap0, 'the race did not advance a lap');

    await sweep.sweepOnce(at(t0, 2));
    const run2 = await raceRunsRow(lobbyId);
    assert.ok(run2!.last_lap > run!.last_lap, 'the second sweep did not advance the race further');
  });

  it('a finished race is settled exactly once even if the sweep runs again afterwards', async () => {
    const hub = createLiveHub();
    const sweep = createRaceSweep('owner-3', hub);
    const { lobbyId } = await makeLobby('finish');
    const t0 = new Date();
    await setDueOpen(lobbyId, t0);

    await sweep.sweepOnce(t0);
    // Yarış saatini bayrağın ötesine geçir: tek atışta yetişip bitmeli.
    const flagResult = await sweep.sweepOnce(at(t0, LAPS + 2));
    assert.ok(flagResult.finished >= 1, 'the race never reached the flag');
    assert.equal(await lobbyPhase(lobbyId), 'result');
    assert.equal(await settlementCount(lobbyId), 1, 'race was not settled exactly once');

    // Bittikten sonra süpürme tekrar geçse bile: `result` evresi
    // `acquireDueLobbies`in taradığı evrelerden biri değil, dokunulmamalı.
    const again = await sweep.sweepOnce(at(t0, LAPS + 3));
    assert.equal(again.claimed, 0, 'a settled, finished lobby was claimed again');
    assert.equal(await settlementCount(lobbyId), 1, 'a second sweep paid the race again');
  });

  it('two sweeps with different owner ids do not both drive the same race', async () => {
    const hub = createLiveHub();
    const sweepA = createRaceSweep('owner-a', hub);
    const sweepB = createRaceSweep('owner-b', hub);
    const { lobbyId } = await makeLobby('exclude');
    const t0 = new Date();
    await setDueOpen(lobbyId, t0);

    // A önce vardır, kirayı alır ve yarışı başlatır.
    const resultA1 = await sweepA.sweepOnce(t0);
    assert.equal(resultA1.claimed, 1);

    // B aynı anda dener: kira A'da ve süresi dolmamış, B hiçbir şey almamalı.
    const resultB = await sweepB.sweepOnce(at(t0, 1));
    assert.equal(resultB.claimed, 0, 'a second owner claimed an already-leased lobby');

    // A ilerlemeye devam eder — sürücü onun elinde saklı kaldığı için.
    const resultA2 = await sweepA.sweepOnce(at(t0, 1));
    assert.ok(resultA2.ticked >= 1, 'the owning sweep did not advance the race');

    const run = await raceRunsRow(lobbyId);
    assert.ok(run, 'no race run found');
    // Yarış BİR sürücü tarafından ilerledi, ikisi tarafından değil: kira
    // dışlaması olmasaydı B de aynı turu koşar, günlük/duruma göre last_lap
    // sıçrardı ya da yarış aynı anda iki kez tiklenirdi.
    assert.equal(await lobbyPhase(lobbyId), 'live');
  });

  it('a lobby that is not due is untouched', async () => {
    const hub = createLiveHub();
    const sweep = createRaceSweep('owner-4', hub);
    const { lobbyId } = await makeLobby('untouched');
    const t0 = new Date();
    await setNotDue(lobbyId, t0);

    const result = await sweep.sweepOnce(t0);
    assert.equal(result.claimed, 0, 'a not-due lobby was claimed');
    assert.equal(await lobbyPhase(lobbyId), 'open', 'a not-due lobby changed phase');
    const run = await raceRunsRow(lobbyId);
    assert.equal(run, null, 'a not-due lobby got a race_runs row');
  });

  // ── 6. Abone istemciler yayını gerçekten alır ────────────────────────────

  describe('publishing to subscribers', () => {
    let server: Server;
    let wss: WebSocketServer;
    let hub: LiveHub;
    let base: string;
    const serverSockets: WebSocket[] = [];

    before(async () => {
      hub = createLiveHub();
      wss = new WebSocketServer({ noServer: true });
      wss.on('connection', (socket) => {
        serverSockets.push(socket);
        hub.attach(socket);
      });
      server = createServer((_req, res) => { res.writeHead(404).end(); });
      server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== LIVE_PATH) return socket.destroy();
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      });
      await new Promise<void>((resolve) => {
        server.listen(0, () => {
          base = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
          resolve();
        });
      });
    });

    after(async () => {
      for (const s of serverSockets) s.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('a subscribed client receives the laps the sweep advances', async () => {
      const sweep = createRaceSweep('owner-5', hub);
      const { lobbyId, token } = await makeLobby('publish');
      const t0 = new Date();
      await setDueOpen(lobbyId, t0);

      const ws = new WebSocket(`${base}${LIVE_PATH}`);
      const queue: any[] = [];
      let waiting: ((msg: any) => void) | null = null;
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (waiting) { const w = waiting; waiting = null; w(msg); } else queue.push(msg);
      });
      const next = (): Promise<any> => new Promise((resolve) => {
        const head = queue.shift();
        if (head !== undefined) resolve(head);
        else waiting = resolve;
      });
      await once(ws, 'open');

      ws.send(JSON.stringify({ type: 'subscribe', lobbyId, token }));
      const ack = await next();
      assert.equal(ack.type, 'state');

      // İlk atış yarışı başlatır (lap 0); yayın gerekmiyor. İkinci atış bir
      // tur ilerletir ve BUNU yayınlamalıdır.
      await sweep.sweepOnce(t0);
      await sweep.sweepOnce(at(t0, 1));

      const lap = await next();
      assert.equal(lap.type, 'lap');
      assert.equal(lap.lobbyId, lobbyId);
      assert.ok(lap.race.lap >= 1, 'the subscriber never saw the lobby advance a lap');

      ws.close();
      await once(ws, 'close');
    });
  });
});
