/**
 * Kadroların yarış tarifine dondurulması (Faz 3b-2, rosters-in-recipe).
 *
 * Şart: `driverOf` (raceEngine.ts) her koltuk için sırayla `entries` (per-race
 * override — server hiç kullanmıyor), `rosters[teamKey]`, sonra `teams.ts`nin
 * sabit varsayılanına bakar. Tohumlanan kadro (`drivers/repo.ts`
 * `seedTeamDrivers`) `teams.ts`nin varsayılanının BİREBİR AYNISI
 * (`drivers-repo.test.ts` "driver stats round-trip byte-identical" bunu
 * tabaka düzeyinde zaten ispatlıyor). Dolayısıyla taze bir lobide kadroyu
 * kablolamak yarışı DEĞİŞTİRMEMELİ — yalnızca bir sürücü varsayılanından
 * SAPTIĞINDA (antrenman, imza) fark yaratmalı. Buradaki testler bu iki yönlü
 * iddiayı birlikte kanıtlıyor.
 *
 * Paylaşılan test veritabanı: yalnızca burada yaratılan kimlikler izlenir ve
 * yalnızca onlar silinir (bkz. `race-runner.test.ts`nin aynı kuralı — bu
 * dosyanın `makeLobby`/`claimSeat` çifti oradan birebir kopyalandı).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { signSession } from '../src/auth/jwt.ts';
import { createLobby } from '../src/lobby/lobbyRepo.ts';
import { SEAT_LADDER } from '../src/lobby/grid.ts';
import { loadRun } from '../src/lobby/raceRepo.ts';
import { replayRace } from '../src/lobby/replay.ts';
import { openRace, startRaceFor, RACE_TICK_MS } from '../src/lobby/runner.ts';
import { LEASE_MS } from '../src/lobby/lease.ts';
import { LIVE_PATH, createLiveHub, type LiveHub } from '../src/lobby/live.ts';
import {
  derivePracticeResult, freezePracticeSession, loadPracticeRun,
} from '../src/lobby/practice.ts';
import { loadLobbyRosters } from '../src/drivers/repo.ts';
import { carId } from '@pitwall/shared/raceEngine';

const createdLobbies: string[] = [];
const createdUsers: string[] = [];
let seq = 0;

const HUMAN = SEAT_LADDER[0];
const ASSISTANT = SEAT_LADDER[1];

/** En küçük lobi: bir insan, bir asistan koltuğu, gerisi AI — `race-runner.test.ts`ten birebir. */
async function makeLobby(label = 'Roster'): Promise<string> {
  const owner = await createUserWithIdentity({
    base: 'GridHunter', provider: 'google', providerUid: `g-${label}-${++seq}-${Date.now()}`, emailHash: null,
  });
  createdUsers.push(owner.id);
  const lobby = await createLobby(owner.id, {
    region: 'EU', visibility: 'private', aiDifficulty: 'normal',
    rankMin: 1, rankMax: 10, guestsCanInvite: false, midSeasonJoin: true,
  });
  createdLobbies.push(lobby.id);
  await claimSeat(lobby.id, HUMAN, 'human', `${label}-h-${seq}`);
  await claimSeat(lobby.id, ASSISTANT, 'assistant', `${label}-a-${seq}`);
  return lobby.id;
}

async function claimSeat(lobbyId: string, teamKey: string, managed: 'human' | 'assistant', tag: string) {
  const user = await createUserWithIdentity({
    base: 'Racer', provider: 'google', providerUid: `g-${tag}-${Date.now()}`, emailHash: null,
  });
  createdUsers.push(user.id);
  await query(
    `update lobby_seats set user_id = $3, managed = $4, joined_at = now()
     where lobby_id = $1 and team_key = $2`,
    [lobbyId, teamKey, user.id, managed],
  );
}

/** Bir takımın bir koltuğunun `pace`ini doğrudan değiştirir — testin "antrenman/imza" durumu. */
async function bumpPace(lobbyId: string, teamKey: string, seat: 0 | 1, pace: number) {
  await query(
    `update lobby_drivers set stats = jsonb_set(stats, '{pace}', $3::text::jsonb) where lobby_id = $1 and id = $2`,
    [lobbyId, `${teamKey}:${seat}`, String(pace)],
  );
}

describe('rosters freeze into the race recipe', () => {
  before(async () => {
    process.env.SESSION_SECRET ??= 'a'.repeat(32);
    process.env.EMAIL_HASH_PEPPER ??= 'test-pepper-value';
    await runMigrations();
  });
  after(async () => {
    for (const id of createdLobbies) await query('delete from lobbies where id = $1', [id]);
    for (const id of createdUsers) await query('delete from users where id = $1', [id]);
    await closePool();
  });

  it('the frozen recipe carries the lobby\'s real rosters', async () => {
    const lobbyId = await makeLobby('Carries');
    const liveRosters = await loadLobbyRosters(lobbyId);
    assert.ok(Object.keys(liveRosters).length > 0, 'fixture produced no rosters at all');

    const { snapshot } = await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    assert.deepEqual(snapshot.rosters, liveRosters, 'the recipe did not carry the lobby\'s live rosters');
  });

  it('a freshly seeded lobby\'s race is byte-identical with real rosters and with rosters: {}', async () => {
    const lobbyId = await makeLobby('Identical');
    const { seed, snapshot } = await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 2, now: new Date() });
    assert.ok(Object.keys(snapshot.rosters).length > 0, 'fixture must actually carry rosters for this to prove anything');

    const withReal = replayRace({ seed, round: 2, snapshot, decisions: [] });
    const withEmpty = replayRace({ seed, round: 2, snapshot: { ...snapshot, rosters: {} }, decisions: [] });

    assert.deepEqual(withReal.cars, withEmpty.cars, 'a freshly seeded roster changed the race — it is not the engine\'s default');
    assert.deepEqual(withReal.events, withEmpty.events);
    assert.equal(withReal.finished, true);
  });

  it('changing one driver\'s stats changes the race', async () => {
    const lobbyId = await makeLobby('Changed');
    await bumpPace(lobbyId, 'aurelia', 0, 99);

    const { seed, snapshot } = await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 3, now: new Date() });
    assert.equal(snapshot.rosters.aurelia?.[0].stats.pace, 99, 'the changed stat never reached the frozen recipe');

    const withReal = replayRace({ seed, round: 3, snapshot, decisions: [] });
    const withDefault = replayRace({ seed, round: 3, snapshot: { ...snapshot, rosters: {} }, decisions: [] });

    assert.notDeepEqual(
      withReal.cars.map((c) => `${carId(c)}@${c.position}`),
      withDefault.cars.map((c) => `${carId(c)}@${c.position}`),
      'a driver 49 points faster than the default left the race identical — rosters are not reaching the engine',
    );
  });

  it('a driver changed after lights-out does not change that race\'s replay', async () => {
    const lobbyId = await makeLobby('Frozen');
    const { seed, snapshot } = await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 4, now: new Date() });
    const before = replayRace({ seed, round: 4, snapshot, decisions: [] });

    // Işıklar söndükten SONRA bir imza/antrenman: aurelia'nın 0. koltuğu artık çok daha hızlı.
    await bumpPace(lobbyId, 'aurelia', 0, 99);

    const run = await loadRun(lobbyId, 1, 4);
    assert.ok(run, 'run missing');
    const after = replayRace({ seed: run.seed, round: 4, snapshot: run.snapshot, decisions: [] });

    assert.deepEqual(after.cars, before.cars, 'a post-lights-out roster change reached a race already run');
    assert.deepEqual(after.events, before.events);
  });

  it('a practice session freezes rosters too', async () => {
    const lobbyId = await makeLobby('Practice');
    await bumpPace(lobbyId, 'aurelia', 0, 99);
    const liveRosters = await loadLobbyRosters(lobbyId);

    const now = new Date();
    const ok = await freezePracticeSession(lobbyId, 1, 5, 1, now);
    assert.equal(ok, true, 'the fixture failed to freeze a practice session');

    const run = await loadPracticeRun(lobbyId, 1, 5, 1);
    assert.ok(run, 'no frozen practice run to read back');
    assert.deepEqual(run.rosters, liveRosters, 'the practice recipe did not carry the lobby\'s live rosters');

    const withReal = derivePracticeResult(run);
    const withDefault = derivePracticeResult({ ...run, rosters: {} });
    assert.notDeepEqual(
      withReal.order.map((o) => o.sec),
      withDefault.order.map((o) => o.sec),
      'the boosted driver left the practice classification identical — practice is not reading the frozen rosters',
    );

    // Aynı belirlenimcilik pratik için de geçerli: seans dondu, sonra SPA'sı
    // değişse de klasman değişmemeli. `run` zaten donma ANINDAKİ kadroyu
    // taşıyor (yukarıdaki bumpPace donmadan ÖNCE oldu); burada sonradan bir
    // değişiklik daha yaparak "donan tarif değişmez" iddiasını tazeliyoruz.
    await bumpPace(lobbyId, 'aurelia', 0, 5);
    const runAfterFurtherChange = await loadPracticeRun(lobbyId, 1, 5, 1);
    assert.ok(runAfterFurtherChange);
    assert.deepEqual(runAfterFurtherChange.rosters, run.rosters, 'a stored practice roster changed after freezing');
  });

  // ── Feed sözleşmesi: rosters hiçbir çerçeveye sızmaz ──────────────────────

  describe('the live feed', () => {
    let server: Server;
    let wss: WebSocketServer;
    let hub: LiveHub;
    let base: string;
    const serverSockets: WebSocket[] = [];

    before(async () => {
      hub = createLiveHub();
      wss = new WebSocketServer({ noServer: true });
      wss.on('connection', (socket) => { serverSockets.push(socket); hub.attach(socket); });
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

    it('no socket frame carries rosters', async () => {
      const lobbyId = await makeLobby('Feed');
      const OWNER = 'test-roster-feed-owner';
      const t0 = new Date();
      await query(
        `update lobbies
            set phase = 'live', season_no = 1, round_no = 1,
                race_owner = $2, race_lease_until = $3
          where id = $1`,
        [lobbyId, OWNER, new Date(t0.getTime() + LEASE_MS)],
      );
      await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: t0 });
      const runner = await openRace({ lobbyId, seasonNo: 1, roundNo: 1, ownerId: OWNER, now: t0 });
      assert.ok(runner, 'openRace returned null for a live lobby');

      const humanUser = await createUserWithIdentity({
        base: 'FeedRacer', provider: 'google', providerUid: `g-feed-${++seq}-${Date.now()}`, emailHash: null,
      });
      createdUsers.push(humanUser.id);
      await query(
        `update lobby_seats set user_id = $3, managed = 'human', joined_at = now()
         where lobby_id = $1 and team_key = $2`,
        [lobbyId, HUMAN, humanUser.id],
      );
      const token = await signSession(humanUser.id);

      const ws = new WebSocket(`${base}${LIVE_PATH}`);
      await once(ws, 'open');
      const queue: any[] = [];
      let waiting: ((msg: any) => void) | null = null;
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (waiting) { const w = waiting; waiting = null; w(msg); } else queue.push(msg);
      });
      const next = () => new Promise<any>((resolve) => {
        const head = queue.shift();
        if (head !== undefined) resolve(head);
        else waiting = resolve;
      });

      ws.send(JSON.stringify({ type: 'subscribe', lobbyId, token }));
      const stateMsg = await next();
      assert.equal(stateMsg.type, 'state');
      assert.equal('rosters' in stateMsg.race, false, 'the state frame carries rosters — the recipe is leaking');
      assert.equal('entries' in stateMsg.race, false);
      assert.equal('standings' in stateMsg.race, false);
      await next(); // the subscription's own `phase` message

      const ticked = await runner.tick(new Date(t0.getTime() + RACE_TICK_MS + 10));
      hub.publish(lobbyId, ticked.state);
      const lapMsg = await next();
      assert.equal(lapMsg.type, 'lap');
      assert.equal('rosters' in lapMsg.race, false, 'the lap frame carries rosters — the recipe is leaking');
      assert.equal('entries' in lapMsg.race, false);
      assert.equal('standings' in lapMsg.race, false);

      ws.close();
      await once(ws, 'close');
    });
  });
});
