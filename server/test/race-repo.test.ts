/**
 * `raceRepo` — yarış tarifinin kalıcılığı.
 *
 * Buradaki iddialar 004_race.sql'in söz verdiği değişmezlikleri JS tarafından
 * GÖRÜNÜR kılar: koşu bir kez başlar, karar günlüğü değişmezdir (ilk karar
 * geçerlidir), ödeme bir kez yazılır. Ayrıca `snapshot`ın jsonb gidiş-dönüşünü
 * birebir koruduğunu denetler — tarif bozulursa yeniden oynatma sessizce BAŞKA
 * bir yarış üretir ki bu tasarımın tek gerçek düşmanıdır.
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import {
  startRun, loadRun, appendDecision, loadDecisions, finishRun, markSettled,
} from '../src/lobby/raceRepo.ts';
import type { RaceSnapshot, DecisionLogEntry } from '../src/lobby/replay.ts';
import type { Driver } from '@pitwall/shared/teams';
import type { CompoundKey } from '@pitwall/shared/carCustomisation';

let seq = 0;

/** Testin ihtiyaç duyduğu en küçük lobi. `lobbies` name_base/name_seq ve
 *  NOT NULL creator_user_id istiyor, o yüzden önce bir kullanıcı gerekir. */
async function makeLobby(label = 'Race'): Promise<string> {
  const owner = await createUserWithIdentity({
    base: 'GridHunter', provider: 'google', providerUid: `g-${label}-${++seq}`, emailHash: null,
  });
  const res = await query<{ id: string }>(
    `insert into lobbies (name, name_base, name_seq, region, visibility, ai_difficulty,
                          rank_min, rank_max, guests_can_invite, mid_season_join,
                          creator_user_id, next_race_at)
     values ($1, $2, $3, 'EU', 'private', 'normal', 1, 10, false, true, $4,
             now() + interval '1 day')
     returning id`,
    [`${label} #${seq}`, label, seq, owner.id],
  );
  return res.rows[0].id;
}

function driver(name: string, number: number): Driver {
  return {
    name,
    number,
    skill: 82,
    stats: { pace: 84, consistency: 79, racecraft: 81, wet: 77, reaction: 80, dev: 62 },
    age: 27,
    potential: 88,
  };
}

/** Gerçekçi bir tarif: iç içe sayılar, isteğe bağlı ondalıklı alanlar, diziler. */
function makeSnapshot(): RaceSnapshot {
  return {
    entries: {
      bosphorus: {
        setup: { motor: 71, aero: 68, grip: 64, compound: 'MEDIUM', bias: -0.25 },
        reliability: 0.965,
        tactics: 'balanced',
        managed: 'human',
        pitSecondsSaved: 0.4,
        pitFailChance: 0.035,
        assistantErrorScale: 0.75,
      },
      ridgeline: {
        setup: { motor: 66, aero: 70, grip: 61, compound: 'SOFT' },
        reliability: 0.94,
        tactics: 'aggressive',
        managed: 'assistant',
        drivers: [driver('A. Kaya', 14), driver('M. Dorn', 27)],
      },
    },
    risks: { bosphorus: 'aggressive', ridgeline: 'safe' },
    standings: [
      { teamKey: 'bosphorus', points: 43, position: 1 },
      { teamKey: 'ridgeline', points: 18, position: 2 },
    ],
    aiBonus: { ridgeline: 1.5, bosphorus: 0 },
    rosters: {
      bosphorus: [driver('E. Yilmaz', 7), driver('R. Sato', 31)],
    },
  };
}

const KEY = { seasonNo: 1, roundNo: 3 };

describe('race repo', () => {
  let lobbyId: string;
  before(async () => { await runMigrations(); });
  beforeEach(async () => {
    await query('delete from lobbies');
    await query('delete from users');
    lobbyId = await makeLobby();
  });
  after(async () => { await closePool(); });

  const start = (seed = 123456) => withTransaction((c) => startRun(c, {
    lobbyId, ...KEY, seed, snapshot: makeSnapshot(), now: new Date('2026-09-23T10:00:00Z'),
  }));

  it('writes a run once and refuses a second start for the same round', async () => {
    await start();
    await assert.rejects(() => start(654321), 'a round must not be startable twice');
  });

  it('round-trips seed and snapshot through jsonb unchanged', async () => {
    await start(987654);
    const run = await loadRun(lobbyId, KEY.seasonNo, KEY.roundNo);
    assert.ok(run, 'no run written');
    assert.equal(typeof run.seed, 'number', 'seed must come back as a number, not a string');
    assert.equal(run.seed, 987654);
    assert.deepEqual(run.snapshot, makeSnapshot(), 'snapshot did not survive the jsonb round trip');
    assert.equal(run.finishedAt, null);
  });

  it('returns null for a round that never started', async () => {
    assert.equal(await loadRun(lobbyId, 1, 99), null);
  });

  it('appends a decision, and the first decision for a car+lap wins', async () => {
    await start();
    const first = await withTransaction((c) => appendDecision(c, {
      lobbyId, ...KEY, lap: 12, teamKey: 'bosphorus', driverIdx: 0, compound: 'SOFT',
      now: new Date('2026-09-23T10:05:00Z'),
    }));
    assert.equal(first, true);

    const second = await withTransaction((c) => appendDecision(c, {
      lobbyId, ...KEY, lap: 12, teamKey: 'bosphorus', driverIdx: 0, compound: 'HARD',
      now: new Date('2026-09-23T10:05:01Z'),
    }));
    assert.equal(second, false, 'a second decision for the same car+lap must return false, not throw');

    const log = await loadDecisions(lobbyId, KEY.seasonNo, KEY.roundNo);
    assert.deepEqual(log, [
      { lap: 12, teamKey: 'bosphorus', driverIdx: 0, compound: 'SOFT' },
    ], 'the later decision overwrote the first');
  });

  it('loads the decision log ordered by lap in replay shape', async () => {
    await start();
    const now = new Date('2026-09-23T10:05:00Z');
    // Kasıtlı olarak tur sırasının DIŞINDA yazılır.
    for (const d of [
      { lap: 30, teamKey: 'ridgeline', driverIdx: 1 as const, compound: 'HARD' as const },
      { lap: 5, teamKey: 'bosphorus', driverIdx: 0 as const, compound: 'MEDIUM' as const },
      { lap: 18, teamKey: 'bosphorus', driverIdx: 1 as const, compound: 'WET' as const },
      { lap: 5, teamKey: 'ridgeline', driverIdx: 0 as const, compound: 'INTERMEDIATE' as const },
    ]) {
      assert.equal(await withTransaction((c) => appendDecision(c, { lobbyId, ...KEY, ...d, now })), true);
    }
    const log = await loadDecisions(lobbyId, KEY.seasonNo, KEY.roundNo);
    assert.deepEqual(log.map((d) => d.lap), [5, 5, 18, 30], 'decisions are not ordered by lap');

    const expected: DecisionLogEntry = { lap: 18, teamKey: 'bosphorus', driverIdx: 1, compound: 'WET' };
    assert.deepEqual(log.find((d) => d.lap === 18), expected);
    // Fazla alan yok: replay'in tükettiği şeklin AYNISI olmalı.
    assert.deepEqual(Object.keys(log[0]).sort(), ['compound', 'driverIdx', 'lap', 'teamKey']);
  });

  it('throws on an invalid compound instead of swallowing it', async () => {
    await start();
    await assert.rejects(() => withTransaction((c) => appendDecision(c, {
      lobbyId, ...KEY, lap: 4, teamKey: 'bosphorus', driverIdx: 0,
      compound: 'soft' as CompoundKey,
      now: new Date('2026-09-23T10:05:00Z'),
    })), 'a lowercase compound is a caller bug and must be loud');
  });

  it('stamps finished_at', async () => {
    await start();
    const at = new Date('2026-09-23T11:30:00Z');
    await withTransaction((c) => finishRun(c, lobbyId, KEY.seasonNo, KEY.roundNo, at));
    const run = await loadRun(lobbyId, KEY.seasonNo, KEY.roundNo);
    assert.ok(run?.finishedAt, 'finished_at not stamped');
    assert.equal(run.finishedAt.getTime(), at.getTime());
  });

  /**
   * Korumanın YAZMADA olduğunun kanıtı.
   *
   * 30 eşzamanlı çağıran aynı araç+tur için karar yazmaya çalışır. Tam olarak
   * biri `true` almalı; kalan 29'u sessizce `false` almalı ve HİÇBİRİ
   * fırlatmamalı. "Önce select, sonra insert" biçiminde hepsi "satır yok"
   * görür, sonra benzersizlik indeksinde çarpışır ve yakalanmamış 23505 ile
   * patlar — bu test onu yakalar.
   */
  it('lets exactly one of 30 concurrent writers win the same car+lap', async () => {
    await start();
    const now = new Date('2026-09-23T10:05:00Z');
    // Havuzu ISIT. Bağlantı kurma gecikmesi çağıranları istemeden sıraya dizer
    // ve yarış penceresini tamamen gizler: ölçtük, ısıtmadan 30 çağıranın
    // yalnızca 1'i boş `select` görüyor, yani naif kurgu bile "geçiyor".
    // 10 bağlantı önceden açıldığında 30 çağıran gerçekten aynı anda girer.
    await Promise.all(Array.from({ length: 10 }, () => query('select 1')));
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => withTransaction((c) => appendDecision(c, {
        lobbyId, ...KEY, lap: 7, teamKey: 'bosphorus', driverIdx: 0,
        // Farklı bileşikler: kaybedenlerden biri yazabilseydi günlük çatallanırdı.
        compound: (i % 2 === 0 ? 'SOFT' : 'HARD') as CompoundKey, now,
      }))),
    );
    assert.equal(results.filter(Boolean).length, 1,
      `exactly one writer must win, got ${results.filter(Boolean).length}`);
    assert.equal((await loadDecisions(lobbyId, KEY.seasonNo, KEY.roundNo)).length, 1);
  });

  it('settles a race exactly once', async () => {
    await start();
    const at = new Date('2026-09-23T11:31:00Z');
    assert.equal(await withTransaction((c) => markSettled(c, lobbyId, KEY.seasonNo, KEY.roundNo, at)), true);
    assert.equal(await withTransaction((c) => markSettled(c, lobbyId, KEY.seasonNo, KEY.roundNo, at)), false,
      'a race must not pay out twice');
  });
});
