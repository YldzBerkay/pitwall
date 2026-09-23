/**
 * Lobi check-in ve CANLI pit çağrısı uç noktaları.
 *
 * Bu iki uç nokta yarış TARİFİNİN oyuncuya bakan tarafıdır: check-in "bu
 * yarışı kendim süreceğim" der (ışıklar sönerken donar), pit çağrısı ise
 * DEĞİŞMEZ karar günlüğüne tek satır yazar. Buradaki testlerin tamamı tek bir
 * şartın etrafında döner: herkes AYNI yarışı görmeli. Bir karar, onu tüketen
 * tur koşulduktan SONRA günlüğe düşerse canlı yarış o kararı yok sayar ama
 * sonraki her yeniden oynatma uygular — iki farklı yarış. Günlük silinemediği
 * için tek savunma yazmayı REDDETMEKTİR.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Router } from '../src/http/router.ts';
import { registerCheckinRoutes } from '../src/lobby/checkin.ts';
import { signSession } from '../src/auth/jwt.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';
import { createLobby } from '../src/lobby/lobbyRepo.ts';
import { SEAT_LADDER } from '../src/lobby/grid.ts';
import { loadDecisions, loadRun } from '../src/lobby/raceRepo.ts';
import { replayRace } from '../src/lobby/replay.ts';
import { openRace, startRaceFor, RACE_TICK_MS } from '../src/lobby/runner.ts';
import { LEASE_MS } from '../src/lobby/lease.ts';

/**
 * PAYLAŞILAN test veritabanı: başka ajanlar da aynı şemayı kullanıyor. Tablo
 * geneli `delete` YOK — yalnızca burada yaratılan kimlikler izlenir ve
 * yalnızca onlar silinir.
 */
const createdLobbies: string[] = [];
const createdUsers: string[] = [];
let seq = 0;

const TEAM_A = SEAT_LADDER[0];
const TEAM_B = SEAT_LADDER[1];

let server: Server;
let base: string;

interface Res { status: number; body: any }

async function post(path: string, token: string | null, payload: Record<string, unknown>): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(payload) });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* bırak null */ }
  return { status: res.status, body };
}

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  seq += 1;
  const user = await createUserWithIdentity({
    base: 'GridHunter', provider: 'google', providerUid: `pit-${tag}-${seq}-${Date.now()}`, emailHash: null,
  });
  createdUsers.push(user.id);
  return { id: user.id, token: await signSession(user.id) };
}

/** Testin ihtiyaç duyduğu en küçük lobi: 11 koltuk + 11 ekonomi satırı. */
async function makeLobby(tag: string): Promise<string> {
  const owner = await makeUser(`own-${tag}`);
  const lobby = await createLobby(owner.id, {
    region: 'EU', visibility: 'private', aiDifficulty: 'normal',
    rankMin: 1, rankMax: 10, guestsCanInvite: false, midSeasonJoin: true,
  });
  createdLobbies.push(lobby.id);
  return lobby.id;
}

async function seat(lobbyId: string, teamKey: string, managed: 'human' | 'assistant', tag: string) {
  const user = await makeUser(tag);
  await query(
    `update lobby_seats set user_id = $3, managed = $4, joined_at = now()
     where lobby_id = $1 and team_key = $2`,
    [lobbyId, teamKey, user.id, managed],
  );
  return user;
}

async function setPhase(lobbyId: string, phase: string) {
  await query('update lobbies set phase = $2 where id = $1', [lobbyId, phase]);
}

async function seatManaged(lobbyId: string, teamKey: string): Promise<string> {
  const res = await query<{ managed: string }>(
    'select managed from lobby_seats where lobby_id = $1 and team_key = $2', [lobbyId, teamKey],
  );
  return res.rows[0].managed;
}

/**
 * Yarış saatini geriye kurar: tarif `lapsAgo` tur önce başlamış gibi yazılır,
 * yani uç noktanın kendi `new Date()`ine göre o anki tur `lapsAgo` olur.
 * Böylece "koşulmuş tura karar yazılamaz" kuralı gerçek zamanlıyıcı
 * beklemeden sınanır.
 */
async function lightsOut(lobbyId: string, lapsAgo: number): Promise<Date> {
  const startedAt = new Date(Date.now() - lapsAgo * RACE_TICK_MS - 500);
  await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: startedAt });
  return startedAt;
}

/**
 * `live` evresinde, kirası bu teste ait bir lobi + ışıkları sönmüş bir yarış.
 *
 * Kirayı `acquireDueLobbies` ile ALMIYORUZ bilerek: paylaşılan test
 * veritabanında o tarama başka ajanların lobilerini de üstlenir. Kira sütunları
 * tam da o fonksiyonun yazdığı gibi elle kuruluyor.
 */
const RUNNER_OWNER = 'test-checkin-owner';

async function liveRace(lobbyId: string, startedAt: Date): Promise<void> {
  await query(
    `update lobbies
        set phase = 'live', season_no = 1, round_no = 1,
            race_owner = $2, race_lease_until = $3
      where id = $1`,
    [lobbyId, RUNNER_OWNER, new Date(Date.now() + LEASE_MS)],
  );
  await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: startedAt });
}

function startServer(): Promise<void> {
  const router = new Router();
  registerCheckinRoutes(router);
  server = createServer(async (req, res) => {
    if (await router.handle(req, res)) return;
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not_found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
}

describe('race check-in and the live pit call', () => {
  before(async () => {
    process.env.SESSION_SECRET = 'a'.repeat(32);
    process.env.EMAIL_HASH_PEPPER = 'test-pepper-value';
    await runMigrations();
    await startServer();
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const id of createdLobbies) await query('delete from lobbies where id = $1', [id]);
    for (const id of createdUsers) await query('delete from users where id = $1', [id]);
    await closePool();
  });

  // ── 1. Check-in yalnızca `checkin` evresinde ──────────────────────────────

  it('check-in works in the checkin phase and marks the seat human', async () => {
    const lobbyId = await makeLobby('ci-ok');
    const user = await seat(lobbyId, TEAM_A, 'assistant', 'ci-ok-a');
    await setPhase(lobbyId, 'checkin');

    const res = await post('/race/checkin', user.token, { lobbyId });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.teamKey, TEAM_A);
    assert.equal(await seatManaged(lobbyId, TEAM_A), 'human');
  });

  it('check-in is rejected in the open phase and the seat stays as it was', async () => {
    const lobbyId = await makeLobby('ci-open');
    const user = await seat(lobbyId, TEAM_A, 'assistant', 'ci-open-a');
    await setPhase(lobbyId, 'open');

    const res = await post('/race/checkin', user.token, { lobbyId });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'wrong_phase');
    assert.equal(await seatManaged(lobbyId, TEAM_A), 'assistant');
  });

  it('check-in is rejected once the race is live — entries froze at lights out', async () => {
    const lobbyId = await makeLobby('ci-live');
    const user = await seat(lobbyId, TEAM_A, 'assistant', 'ci-live-a');
    await setPhase(lobbyId, 'live');

    const res = await post('/race/checkin', user.token, { lobbyId });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'wrong_phase');
    assert.equal(await seatManaged(lobbyId, TEAM_A), 'assistant');
  });

  // ── 2. Pit çağrısı yalnızca canlı yarışta ─────────────────────────────────

  it('a pit call in the live phase is persisted before the answer comes back', async () => {
    const lobbyId = await makeLobby('pit-ok');
    const user = await seat(lobbyId, TEAM_A, 'human', 'pit-ok-a');
    await setPhase(lobbyId, 'live');
    await lightsOut(lobbyId, 3);

    const res = await post('/race/pit', user.token, { lobbyId, driverIdx: 0, compound: 'SOFT' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.lap > 3, `decision lap ${res.body.lap} must be ahead of the current lap`);

    // `ok` cevabı, yazmanın TAMAMLANDIĞI anlamına gelmek zorunda: cevap
    // yazmadan önce dönerse canlı yarış kararı göremeden turu koşabilir.
    const log = await loadDecisions(lobbyId, 1, 1);
    assert.equal(log.length, 1, 'a 200 was answered without the decision being in the log');
    assert.equal(log[0].teamKey, TEAM_A);
    assert.equal(log[0].compound, 'SOFT');
    assert.equal(log[0].lap, res.body.lap);

    // Aynı araç+tur için ikinci çağrı MUTLAKA reddedilmeli: reddediliyorsa ilk
    // yazma, kendi cevabı dönmeden önce TAAHHÜT EDİLMİŞ demektir. Bu, "günlüğü
    // hemen oku" denemesinin zamanlamaya bağlı olmayan biçimidir.
    const again = await post('/race/pit', user.token, {
      lobbyId, driverIdx: 0, compound: 'HARD', lap: res.body.lap,
    });
    assert.equal(again.status, 409, 'the first write had not committed when its ok came back');
    assert.equal(again.body.error, 'already_decided');
  });

  it('a pit call outside the live phase is refused and writes nothing', async () => {
    const lobbyId = await makeLobby('pit-phase');
    const user = await seat(lobbyId, TEAM_A, 'human', 'pit-phase-a');
    await setPhase(lobbyId, 'checkin');

    const res = await post('/race/pit', user.token, { lobbyId, driverIdx: 0, compound: 'SOFT' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'wrong_phase');

    await setPhase(lobbyId, 'live');
    await lightsOut(lobbyId, 2);
    await setPhase(lobbyId, 'result');
    const after = await post('/race/pit', user.token, { lobbyId, driverIdx: 0, compound: 'SOFT' });
    assert.equal(after.status, 409);
    assert.equal((await loadDecisions(lobbyId, 1, 1)).length, 0, 'a decision was written outside a live race');
  });

  // ── 3. KOŞULMUŞ TURA KARAR YAZILAMAZ ──────────────────────────────────────

  it('a pit call for a lap that has already run is refused and nothing is written', async () => {
    const lobbyId = await makeLobby('pit-stale');
    const user = await seat(lobbyId, TEAM_A, 'human', 'pit-stale-a');
    await setPhase(lobbyId, 'live');
    await lightsOut(lobbyId, 8); // yarış saati 8. turda

    for (const lap of [1, 5, 8]) {
      const res = await post('/race/pit', user.token, { lobbyId, driverIdx: 0, compound: 'SOFT', lap });
      assert.equal(res.status, 409, `lap ${lap} must be refused`);
      assert.equal(res.body.error, 'lap_already_run');
    }
    assert.equal((await loadDecisions(lobbyId, 1, 1)).length, 0,
      'a decision for an already simulated lap reached the immutable log');

    // Saatin ÖNÜNDEKİ bir tur kabul edilir — kural "ileri" demek, "hiç" değil.
    const ahead = await post('/race/pit', user.token, { lobbyId, driverIdx: 0, compound: 'SOFT', lap: 12 });
    assert.equal(ahead.status, 200, JSON.stringify(ahead.body));
    assert.equal((await loadDecisions(lobbyId, 1, 1))[0].lap, 12);
  });

  /**
   * ── KOŞAN TUR SAKLANAN BİR OLGUDUR, SAATİN TAHMİNİ DEĞİL ────────────────
   *
   * Yukarıdaki test saatin kapısını sınıyor. Ama saat iki yerde AYRI
   * hesaplanıyordu (uç nokta ve tik döngüsü) ve aralarında kilit yoktu: tik
   * günlüğü okuduktan SONRA, N. turu simüle etmeden ÖNCE gelen bir karar
   * saatin kapısından GEÇER, canlı yarışça görülmez, sonraki her yeniden
   * oynatmaca uygulanırdı — iki farklı yarış. Aşağıdaki testler o aralığı
   * uykuyla değil, sırayı elle sürerek kuruyor: koşucuyu saatin ÖNÜNE
   * geçiriyoruz, böylece "reddeden şey saat mi, saklanan olgu mu" sorusunun
   * cevabı tek bir şeye indirgeniyor.
   */
  it('refuses a lap the runner has already simulated, even though the clock has not reached it', async () => {
    const lobbyId = await makeLobby('pit-stamped');
    const user = await seat(lobbyId, TEAM_A, 'human', 'pit-stamped-a');
    // Yarış saati AZ ÖNCE başladı: saate göre henüz tek tur bile koşmadı.
    const startedAt = new Date(Date.now() - 500);
    await liveRace(lobbyId, startedAt);

    // Koşucu kendi `now`uyla üç tur koşuyor — duvardaki saat hâlâ 0. turda.
    const runner = await openRace({ lobbyId, seasonNo: 1, roundNo: 1, ownerId: RUNNER_OWNER, now: startedAt });
    assert.ok(runner);
    await runner.tick(new Date(startedAt.getTime() + 3 * RACE_TICK_MS));
    assert.equal(runner.state.lap, 3, 'fixture: three laps must have been simulated');
    assert.equal((await loadRun(lobbyId, 1, 1))?.lastLap, 3, 'fixture: the tick must have stamped');

    // Saat "0. turdayız" diyor; OLGU "3. tur koştu" diyor. Otorite olgudur.
    for (const lap of [1, 2, 3]) {
      const res = await post('/race/pit', user.token, { lobbyId, driverIdx: 0, compound: 'SOFT', lap });
      assert.equal(res.status, 409, `lap ${lap} has been simulated — the clock must not open it`);
      assert.equal(res.body.error, 'lap_already_run');
    }
    assert.equal((await loadDecisions(lobbyId, 1, 1)).length, 0,
      'a decision for an already simulated lap reached the immutable log');

    // Varsayılan tur da saklanan olgudan türer: saat 0 derken 4. tura yazmalı.
    const next = await post('/race/pit', user.token, { lobbyId, driverIdx: 0, compound: 'SOFT' });
    assert.equal(next.status, 200, JSON.stringify(next.body));
    assert.equal(next.body.lap, 4, 'the default lap ignored the stored progress');
  });

  it('a decision the endpoint accepts is one the live race actually consumes', async () => {
    // Tasarımın tek şartı, uçtan uca: KABUL EDİLEN karar canlı yarışta görünür.
    const lobbyId = await makeLobby('pit-consumed');
    const user = await seat(lobbyId, TEAM_A, 'human', 'pit-consumed-a');
    const startedAt = new Date(Date.now() - 500);
    await liveRace(lobbyId, startedAt);

    const runner = await openRace({ lobbyId, seasonNo: 1, roundNo: 1, ownerId: RUNNER_OWNER, now: startedAt });
    assert.ok(runner);
    await runner.tick(new Date(startedAt.getTime() + 3 * RACE_TICK_MS));

    const accepted = await post('/race/pit', user.token, { lobbyId, driverIdx: 0, compound: 'SOFT', lap: 4 });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

    await runner.tick(new Date(startedAt.getTime() + 6 * RACE_TICK_MS));

    // Kontrol AYNI tarifin saf oynatmasıdır: başka bir lobi başka bir tohum,
    // yani farkı karar değil tohum gösterirdi.
    const run = await loadRun(lobbyId, 1, 1);
    assert.ok(run);
    const log = await loadDecisions(lobbyId, 1, 1);
    assert.equal(log.length, 1, 'the accepted decision is not in the immutable log');
    const oracle = (decisions: typeof log) => JSON.stringify(replayRace({
      seed: run.seed, round: 1, snapshot: run.snapshot, decisions, uptoLap: 6,
    }).cars);
    assert.equal(JSON.stringify(runner.state.cars), oracle(log),
      'the live race did not apply the decision the endpoint accepted');
    assert.notEqual(JSON.stringify(runner.state.cars), oracle([]),
      'the accepted decision changed nothing — this test cannot catch the real failure');
  });

  // ── 4. Check-in yapmayan pit çağıramaz ────────────────────────────────────

  it('a player who did not check in cannot make a pit call', async () => {
    const lobbyId = await makeLobby('pit-assist');
    const user = await seat(lobbyId, TEAM_A, 'assistant', 'pit-assist-a');
    await setPhase(lobbyId, 'live');
    await lightsOut(lobbyId, 2);

    const res = await post('/race/pit', user.token, { lobbyId, driverIdx: 0, compound: 'SOFT' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'not_checked_in');
    assert.equal((await loadDecisions(lobbyId, 1, 1)).length, 0,
      'the engine ignores assistant cars — such a write would be a silent no-op');
  });

  // ── 5. Takım anahtarı KOLTUKTAN gelir ─────────────────────────────────────

  it('a teamKey in the body is ignored — the seat decides', async () => {
    const lobbyId = await makeLobby('pit-team');
    const user = await seat(lobbyId, TEAM_A, 'human', 'pit-team-a');
    await seat(lobbyId, TEAM_B, 'human', 'pit-team-b');
    await setPhase(lobbyId, 'live');
    await lightsOut(lobbyId, 1);

    const res = await post('/race/pit', user.token, {
      lobbyId, driverIdx: 0, compound: 'HARD', teamKey: TEAM_B,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const log = await loadDecisions(lobbyId, 1, 1);
    assert.equal(log.length, 1);
    assert.equal(log[0].teamKey, TEAM_A, 'the body steered the decision onto another team');
    assert.equal(res.body.teamKey, TEAM_A);
  });

  // ── 6. İlk karar geçerli ──────────────────────────────────────────────────

  it('a second decision for the same car on the same lap is refused, the first survives', async () => {
    const lobbyId = await makeLobby('pit-dup');
    const user = await seat(lobbyId, TEAM_A, 'human', 'pit-dup-a');
    await setPhase(lobbyId, 'live');
    await lightsOut(lobbyId, 1);

    const first = await post('/race/pit', user.token, { lobbyId, driverIdx: 0, compound: 'SOFT', lap: 9 });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const second = await post('/race/pit', user.token, { lobbyId, driverIdx: 0, compound: 'HARD', lap: 9 });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'already_decided');
    assert.notEqual(second.status, 500);

    const log = await loadDecisions(lobbyId, 1, 1);
    assert.equal(log.length, 1);
    assert.equal(log[0].compound, 'SOFT', 'the immutable log was overwritten');
  });

  // ── 7. Oturum ve koltuk ───────────────────────────────────────────────────

  it('no session is 401, a session without a seat in that lobby is 403', async () => {
    const lobbyId = await makeLobby('pit-auth');
    await seat(lobbyId, TEAM_A, 'human', 'pit-auth-a');
    const outsider = await makeUser('pit-auth-out');
    await setPhase(lobbyId, 'live');
    await lightsOut(lobbyId, 1);

    assert.equal((await post('/race/pit', null, { lobbyId, driverIdx: 0, compound: 'SOFT' })).status, 401);
    assert.equal((await post('/race/checkin', null, { lobbyId })).status, 401);
    assert.equal((await post('/race/pit', outsider.token, { lobbyId, driverIdx: 0, compound: 'SOFT' })).status, 403);
    assert.equal((await post('/race/checkin', outsider.token, { lobbyId })).status, 403);
    assert.equal((await loadDecisions(lobbyId, 1, 1)).length, 0);
  });

  // ── 8. Bozuk bileşik istemci hatasıdır, 500 değil ─────────────────────────

  it('an invalid compound is a client error, never a 500', async () => {
    const lobbyId = await makeLobby('pit-comp');
    const user = await seat(lobbyId, TEAM_A, 'human', 'pit-comp-a');
    await setPhase(lobbyId, 'live');
    await lightsOut(lobbyId, 1);

    for (const compound of ['soft', 'ULTRASOFT', 42, null]) {
      const res = await post('/race/pit', user.token, { lobbyId, driverIdx: 0, compound });
      assert.equal(res.status, 400, `compound ${String(compound)} must be a 400, got ${res.status}`);
      assert.equal(res.body.error, 'invalid_request');
    }
    for (const driverIdx of [2, -1, 'left', undefined]) {
      const res = await post('/race/pit', user.token, { lobbyId, driverIdx, compound: 'SOFT' });
      assert.equal(res.status, 400, `driverIdx ${String(driverIdx)} must be a 400`);
    }
    assert.equal((await loadDecisions(lobbyId, 1, 1)).length, 0);
  });
});
