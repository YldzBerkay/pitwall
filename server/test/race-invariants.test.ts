/**
 * Faz 3a-2'nin kapanış argümanı — spec §12'deki DEĞİŞMEZLİKLER.
 *
 * Bu dosya "yarış çalışıyor mu" diye sormaz; her testin sorduğu soru şu:
 * KURALI kaynaktan çıkarsam bu test bunu YAKALAR MI? Her testin altında bunun
 * kanıtı var — kural kırılınca testin gerçekten kırmızıya döndüğü, sonra
 * kuralın geri konulduğu ölçülmüş bir break/restore turu. Yeşil ama kırılan
 * kuralı yakalamayan bir test, hiç test olmamasından beterdir: sahte güven
 * üretir.
 *
 * Aynı veritabanı BAŞKA test dosyalarıyla PAYLAŞILIYOR — tablo geneli
 * `delete from lobbies` / `delete from users` YOK, yalnızca burada yaratılan
 * kimlikler izlenir ve yalnızca onlar silinir (bkz. `economy-repo.test.ts`,
 * `race-parcferme.test.ts`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { createLobby } from '../src/lobby/lobbyRepo.ts';
import { SEAT_LADDER, TEAM_COUNT } from '../src/lobby/grid.ts';
import { loadLobbyEconomy, loadTeamEconomy, addRp } from '../src/economy/repo.ts';
import { startJob } from '../src/economy/jobs.ts';
import { evaluateParcFerme } from '../src/lobby/parcFerme.ts';
import {
  appendDecision, loadDecisions, loadRun, advanceLastLap,
} from '../src/lobby/raceRepo.ts';
import { replayRace, type DecisionLogEntry } from '../src/lobby/replay.ts';
import { openRace, startRaceFor, RACE_TICK_MS } from '../src/lobby/runner.ts';
import { LEASE_MS, renewLease } from '../src/lobby/lease.ts';
import { settleRace, AlreadySettledError } from '../src/economy/settle.ts';
import { trackForRound } from '@pitwall/shared/tracks';

const createdLobbies: string[] = [];
const createdUsers: string[] = [];
let seq = 0;

const HUMAN = SEAT_LADDER[0];
const ASSISTANT = SEAT_LADDER[1];

/** Testin ihtiyaç duyduğu en küçük lobi: 11 koltuk + 11 ekonomi satırı
 *  (bkz. `race-runner.test.ts`). */
async function makeLobby(label = 'Inv'): Promise<string> {
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

/** `live` evresinde, kirası verilen bir lobi (bkz. `race-runner.test.ts`). */
async function liveLobby(label: string, roundNo: number, now: Date, ownerId: string): Promise<string> {
  const lobbyId = await makeLobby(label);
  await query(
    `update lobbies
        set phase = 'live', season_no = 1, round_no = $2, next_race_at = $3,
            race_owner = $4, race_lease_until = $5
      where id = $1`,
    [lobbyId, roundNo, now, ownerId, new Date(now.getTime() + LEASE_MS)],
  );
  return lobbyId;
}

const at = (t0: Date, laps: number) => new Date(t0.getTime() + laps * RACE_TICK_MS);

describe('race invariants — Faz 3a-2 §12', () => {
  before(async () => { await runMigrations(); });
  after(async () => {
    for (const id of createdLobbies) await query('delete from lobbies where id = $1', [id]);
    for (const id of createdUsers) await query('delete from users where id = $1', [id]);
    await closePool();
  });

  // ── 1. Yeniden oynatma bit düzeyinde aynıdır ─────────────────────────────
  it('1) replaying the same recipe twice gives a byte-identical race', async () => {
    const lobbyId = await makeLobby('Replay1');
    const { seed, snapshot } = await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 5, now: new Date() });
    const decisions: DecisionLogEntry[] = [
      { lap: 10, teamKey: HUMAN, driverIdx: 0, compound: 'HARD' },
    ];
    const a = replayRace({ seed, round: 5, snapshot, decisions });
    const b = replayRace({ seed, round: 5, snapshot, decisions });
    assert.equal(JSON.stringify(a), JSON.stringify(b), 'two replays of the same recipe diverged');
  });

  // ── 2. Çökme sonrası devam aynı yarışı üretir ────────────────────────────
  it('2) a race stopped at lap 40 and replayed from the log reaches the same state at lap 40', async () => {
    const t0 = new Date();
    const OWNER = 'inv2-owner';
    const ROUND = 8;
    const lobbyId = await liveLobby('Resume', ROUND, t0, OWNER);

    const live = await openRace({ lobbyId, seasonNo: 1, roundNo: ROUND, ownerId: OWNER, now: t0 });
    assert.ok(live);
    await withTransaction((c) => appendDecision(c, {
      lobbyId, seasonNo: 1, roundNo: ROUND, lap: 12, teamKey: HUMAN, driverIdx: 0,
      compound: 'SOFT', now: t0,
    }));
    for (let lap = 1; lap <= 40; lap += 1) await live.tick(at(t0, lap));
    assert.equal(live.state.lap, 40);

    const run = await loadRun(lobbyId, 1, ROUND);
    assert.ok(run);
    const oracle = replayRace({
      seed: run.seed, round: ROUND, snapshot: run.snapshot,
      decisions: await loadDecisions(lobbyId, 1, ROUND), uptoLap: 40,
    });
    assert.deepEqual(oracle, live.state, 'the replayed-from-log state at lap 40 differs from the live one');
  });

  // ── 3. Karar, onu tüketen turdan ÖNCE kalıcı olmalı ─────────────────────
  it('3) a decision for a lap that already ran is refused, not applied', async () => {
    const t0 = new Date();
    const OWNER = 'inv3-owner';
    const ROUND = 8;
    const lobbyId = await liveLobby('Gate', ROUND, t0, OWNER);
    const runner = await openRace({ lobbyId, seasonNo: 1, roundNo: ROUND, ownerId: OWNER, now: t0 });
    assert.ok(runner);
    await runner.tick(at(t0, 3));
    assert.equal(runner.state.lap, 3);

    const result = await withTransaction((c) => appendDecision(c, {
      lobbyId, seasonNo: 1, roundNo: ROUND, lap: 2, teamKey: HUMAN, driverIdx: 0,
      compound: 'SOFT', now: at(t0, 3),
    }));
    assert.equal(result, 'lap_already_run', 'a decision for an already-run lap was not refused');
    assert.equal((await loadDecisions(lobbyId, 1, ROUND)).length, 0,
      'a refused decision still reached the immutable log');
  });

  // ── 4. İkinci karar reddedilir, ilki kazanır ────────────────────────────
  it('4) a second decision for the same car+lap is refused — the first wins', async () => {
    const lobbyId = await makeLobby('SecondDecision');
    await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    const now = new Date();
    const first = await withTransaction((c) => appendDecision(c, {
      lobbyId, seasonNo: 1, roundNo: 1, lap: 9, teamKey: HUMAN, driverIdx: 0,
      compound: 'SOFT', now,
    }));
    assert.equal(first, 'written');
    const second = await withTransaction((c) => appendDecision(c, {
      lobbyId, seasonNo: 1, roundNo: 1, lap: 9, teamKey: HUMAN, driverIdx: 0,
      compound: 'HARD', now,
    }));
    assert.equal(second, 'already_decided');
    const log = await loadDecisions(lobbyId, 1, 1);
    assert.deepEqual(log, [{ lap: 9, teamKey: HUMAN, driverIdx: 0, compound: 'SOFT' }],
      'the second decision overwrote the first');
  });

  // ── 5. Muhasebe idempotent ──────────────────────────────────────────────
  it('5) settling the same race twice pays out exactly once', async () => {
    const lobbyId = await makeLobby('SettleOnce');
    await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    const before = await loadLobbyEconomy(lobbyId);
    const totalBefore = before.reduce((a, e) => a + e.rp, 0);

    await settleRace({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    const afterFirst = await loadLobbyEconomy(lobbyId);
    const totalAfterFirst = afterFirst.reduce((a, e) => a + e.rp, 0);
    assert.ok(totalAfterFirst > totalBefore, 'the first settlement paid nothing');

    await assert.rejects(
      () => settleRace({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() }),
      AlreadySettledError,
    );
    const afterSecond = await loadLobbyEconomy(lobbyId);
    const totalAfterSecond = afterSecond.reduce((a, e) => a + e.rp, 0);
    assert.equal(totalAfterSecond, totalAfterFirst, 'settling twice paid out a second time');
  });

  // ── 6. Bitmiş-claim'siz geliştirme: pit yolu VE uygulanmış iyileşme ─────
  it('6) a finished-unclaimed upgrade produces a pit-lane start AND still applies to the car', async () => {
    const lobbyId = await makeLobby('MidRow');
    const before = await loadTeamEconomy(lobbyId, HUMAN);
    assert.ok(before);
    await query(
      `insert into pending_jobs (lobby_id, team_key, kind, payload, started_at, ends_at)
       values ($1, $2, 'upgrade', '{"stat":"motor"}'::jsonb, now() - interval '2 hours', now() - interval '1 minute')`,
      [lobbyId, HUMAN],
    );

    const { snapshot } = await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    const starts = snapshot.pitLaneStarts;
    assert.ok(starts, 'no pitLaneStarts at all');

    // Söz VERİLEN promise #1: iki araç da pit yolundan.
    assert.ok(starts[`${HUMAN}:0`] && starts[`${HUMAN}:1`],
      'the finished upgrade did not send both cars to the pit lane');
    // Söz VERİLEN promise #2 — BAĞIMSIZ iddia: iyileşme gerçekten araca ulaştı.
    assert.ok(snapshot.entries[HUMAN].setup.motor > before.car.motor,
      'the finished upgrade never reached the car — the middle row broke its other promise');
  });

  // ── 7. Devam eden geliştirme aracı sakatlar ─────────────────────────────
  it('7) an in-progress upgrade still cripples the car', async () => {
    const lobbyId = await makeLobby('InProgress');
    const started = await startJob({
      lobbyId, teamKey: HUMAN, kind: 'upgrade', payload: { stat: 'motor' }, now: new Date(),
    });
    assert.equal(started.ok, true);

    const verdict = await evaluateParcFerme(lobbyId, new Date());
    const team = verdict.byTeam[HUMAN];
    assert.ok(team, 'no verdict for the team');
    assert.equal(team.crippled, true, 'an in-progress upgrade must cripple the car');
    assert.equal(team.buildingLabel, 'MOTOR');
    assert.deepEqual(verdict.pitLaneStarts, {}, 'an in-progress job must not cause a pit-lane start');
  });

  // ── 8. İki süreç aynı yarışı süremez ────────────────────────────────────
  it('8) two owners cannot both drive the same race — the lease excludes', async () => {
    const t0 = new Date();
    const OWNER_A = 'inv8-owner-a';
    const OWNER_B = 'inv8-owner-b';
    const ROUND = 8;
    // Lease sadece OWNER_A'ya verilir.
    const lobbyId = await liveLobby('Exclude', ROUND, t0, OWNER_A);

    const runnerA = await openRace({ lobbyId, seasonNo: 1, roundNo: ROUND, ownerId: OWNER_A, now: t0 });
    const runnerB = await openRace({ lobbyId, seasonNo: 1, roundNo: ROUND, ownerId: OWNER_B, now: t0 });
    assert.ok(runnerA && runnerB);

    const resultB = await runnerB.tick(at(t0, 1));
    assert.equal(resultB.owned, false, 'a process without the lease drove the race anyway');
    assert.equal(runnerB.state.lap, 0, 'the excluded process advanced the shared race');

    const resultA = await runnerA.tick(at(t0, 1));
    assert.equal(resultA.owned, true, 'the leaseholder could not drive its own race');
    assert.equal(runnerA.state.lap, 1);
  });

  // ── 9. Eski uçlar yok, lobi yarışları çalışıyor ─────────────────────────
  it('9) legacy single-league endpoints are gone; lobby races still run end to end', async () => {
    process.env.SESSION_SECRET ??= 'a'.repeat(32);
    process.env.EMAIL_HASH_PEPPER ??= 'test-pepper-value';
    process.env.PORT ??= '8798';
    const base = `http://127.0.0.1:${process.env.PORT}`;

    await import('../src/index.ts');
    for (let i = 0; i < 100; i += 1) {
      try { await fetch(`${base}/onboarding/bootstrap`); break; } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    for (const path of ['/join', '/weekend', '/checkin', '/pit', '/state']) {
      const res = await fetch(`${base}${path}`, { method: 'POST', body: '{}' });
      assert.equal(res.status, 404, `legacy ${path} must be gone`);
    }

    // Lobi yarışı gerçekten uçtan uca çalışıyor: ışıklar söner, tik ilerler,
    // bayrakla biter.
    const t0 = new Date();
    const OWNER = 'inv9-owner';
    const ROUND = 1;
    const lobbyId = await liveLobby('EndToEnd', ROUND, t0, OWNER);
    const laps = trackForRound(ROUND).laps;
    const runner = await openRace({ lobbyId, seasonNo: 1, roundNo: ROUND, ownerId: OWNER, now: t0 });
    assert.ok(runner);
    const result = await runner.tick(at(t0, laps));
    assert.equal(result.finished, true, 'a lobby race did not reach the flag');
  });

  // ── 10. Muhasebe damgayla ATOMIK ────────────────────────────────────────
  it('10) settlement is atomic with the finished flag — a mid-way throw leaves the run unflagged', async () => {
    const t0 = new Date();
    const OWNER = 'inv10-owner';
    const ROUND = 8;
    const lobbyId = await liveLobby('Atomic', ROUND, t0, OWNER);
    const laps = trackForRound(ROUND).laps;

    const runner = await openRace({
      lobbyId, seasonNo: 1, roundNo: ROUND, ownerId: OWNER, now: t0,
      settleDeps: {
        addRp: async (client, l, t, amount) => {
          await addRp(client, l, t, amount);
          throw new Error('boom-mid-settlement');
        },
      },
    });
    assert.ok(runner);

    await assert.rejects(() => runner.tick(at(t0, laps)), /boom-mid-settlement/);

    const run = await loadRun(lobbyId, 1, ROUND);
    assert.ok(run, 'run vanished');
    assert.equal(run.finishedAt, null,
      'finishRun committed even though settlement threw — the transaction did not roll back');
    const phase = await query<{ phase: string }>('select phase from lobbies where id = $1', [lobbyId]);
    assert.equal(phase.rows[0].phase, 'live', 'the lobby moved to result despite the failed settlement');
    const settled = await query(
      'select 1 from race_settlements where lobby_id = $1 and season_no = 1 and round_no = $2',
      [lobbyId, ROUND],
    );
    assert.equal(settled.rowCount, 0, 'a settlement row survived the rollback');
  });
});
