import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';

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

/** Postgres hata kodunu döndürür; sorgu BAŞARILI olursa testi düşürür.
 *  Kısıtın "ısırdığını" kanıtlamak, sadece katalogda görünmesinden farklıdır. */
async function expectViolation(sql: string, params: unknown[]): Promise<string> {
  try {
    await query(sql, params);
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
  assert.fail(`expected a constraint violation, but the insert succeeded: ${sql}`);
}

async function insertRun(lobbyId: string, season = 1, round = 1): Promise<void> {
  await query(
    `insert into race_runs (lobby_id, season_no, round_no, seed, snapshot)
     values ($1, $2, $3, $4, $5)`,
    [lobbyId, season, round, 4242, JSON.stringify({ entries: [] })],
  );
}

const INSERT_DECISION = `insert into race_decisions
  (lobby_id, season_no, round_no, lap, team_key, driver_idx, compound)
  values ($1, $2, $3, $4, $5, $6, $7)`;

const INSERT_SETTLEMENT = `insert into race_settlements
  (lobby_id, season_no, round_no) values ($1, $2, $3)`;

describe('race schema', () => {
  let lobbyId: string;
  before(async () => { await runMigrations(); });
  beforeEach(async () => {
    await query('delete from lobbies');
    await query('delete from users');
    lobbyId = await makeLobby();
  });
  after(async () => { await closePool(); });

  it('adds race ownership columns to lobbies', async () => {
    const res = await query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name = 'lobbies' and column_name in ('race_owner', 'race_lease_until')`,
    );
    const cols = res.rows.map((r) => r.column_name).sort();
    assert.deepEqual(cols, ['race_lease_until', 'race_owner']);

    // Kira gerçekten yazılabilmeli: tarama sorgusu bu iki alanı güncelleyecek.
    await query(
      `update lobbies set race_owner = $2, race_lease_until = now() + interval '30 seconds'
       where id = $1`,
      [lobbyId, 'runner-1'],
    );
    const owned = await query<{ race_owner: string }>(
      'select race_owner from lobbies where id = $1', [lobbyId],
    );
    assert.equal(owned.rows[0].race_owner, 'runner-1');
  });

  it('creates the three race tables', async () => {
    const res = await query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public'
         and table_name in ('race_runs', 'race_decisions', 'race_settlements')`,
    );
    assert.deepEqual(res.rows.map((r) => r.table_name).sort(),
      ['race_decisions', 'race_runs', 'race_settlements']);
  });

  it('refuses to start the same round twice', async () => {
    await insertRun(lobbyId, 1, 1);
    // Farklı tur aynı lobide serbest olmalı — anahtar sadece lobiye bakmıyor.
    await insertRun(lobbyId, 1, 2);
    await insertRun(lobbyId, 2, 1);

    const code = await expectViolation(
      `insert into race_runs (lobby_id, season_no, round_no, seed, snapshot)
       values ($1, 1, 1, 99, '{}'::jsonb)`,
      [lobbyId],
    );
    assert.equal(code, '23505', 'a second run for the same round was accepted');
  });

  it('rejects a second decision for the same car on the same lap', async () => {
    await insertRun(lobbyId);
    await query(INSERT_DECISION, [lobbyId, 1, 1, 12, 'bosphorus', 0, 'soft']);

    // Günlük tur tur büyümeli: aynı araç başka turlarda karar verebilir...
    await query(INSERT_DECISION, [lobbyId, 1, 1, 20, 'bosphorus', 0, 'hard']);
    // ...ve aynı turda takım arkadaşı ayrı bir satırdır.
    await query(INSERT_DECISION, [lobbyId, 1, 1, 12, 'bosphorus', 1, 'medium']);
    await query(INSERT_DECISION, [lobbyId, 1, 1, 12, 'ravensworth', 0, 'soft']);

    // ...ama aynı araç + aynı tur ikinci kez yazılamaz: yeniden oynatmanın
    // deterministik kalması için İLK karar geçerlidir.
    const code = await expectViolation(INSERT_DECISION,
      [lobbyId, 1, 1, 12, 'bosphorus', 0, 'hard']);
    assert.equal(code, '23505', 'a duplicate decision on the same lap was accepted');
  });

  it('accepts only driver_idx 0 or 1', async () => {
    await insertRun(lobbyId);
    await query(INSERT_DECISION, [lobbyId, 1, 1, 5, 'aurelia', 0, 'soft']);
    await query(INSERT_DECISION, [lobbyId, 1, 1, 5, 'aurelia', 1, 'soft']);

    for (const bad of [2, -1]) {
      const code = await expectViolation(INSERT_DECISION,
        [lobbyId, 1, 1, 5, 'aurelia', bad, 'soft']);
      assert.equal(code, '23514', `driver_idx ${bad} was accepted`);
    }
  });

  it('refuses to pay out the same race twice', async () => {
    await insertRun(lobbyId, 1, 1);
    await insertRun(lobbyId, 1, 2);
    await query(INSERT_SETTLEMENT, [lobbyId, 1, 1]);
    // Aynı lobinin ikinci turu ayrı bir ödemedir.
    await query(INSERT_SETTLEMENT, [lobbyId, 1, 2]);

    const code = await expectViolation(INSERT_SETTLEMENT, [lobbyId, 1, 1]);
    assert.equal(code, '23505', 'the same race was settled twice');
  });

  it('cascades every race row away when the lobby is deleted', async () => {
    await insertRun(lobbyId);
    await query(INSERT_DECISION, [lobbyId, 1, 1, 7, 'northgate', 1, 'medium']);
    await query(INSERT_SETTLEMENT, [lobbyId, 1, 1]);

    await query('delete from lobbies where id = $1', [lobbyId]);

    for (const table of ['race_runs', 'race_decisions', 'race_settlements']) {
      const res = await query<{ n: string }>(`select count(*)::text as n from ${table}`);
      assert.equal(res.rows[0].n, '0', `${table} kept rows after the lobby was deleted`);
    }
  });
});
