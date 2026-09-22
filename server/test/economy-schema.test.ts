import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';

describe('economy schema', () => {
  before(async () => { await runMigrations(); });
  after(async () => { await closePool(); });

  it('creates the four economy tables', async () => {
    const res = await query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = res.rows.map((r) => r.table_name);
    for (const t of ['lobby_economy', 'pending_jobs', 'gold_grants', 'daily_caps']) {
      assert.ok(names.includes(t), `${t} missing`);
    }
  });

  it('refuses a negative rp', async () => {
    await assert.rejects(
      () => query(
        `insert into lobby_economy (lobby_id, team_key, rp, car)
         values ('00000000-0000-0000-0000-000000000000', 'x', -1, '{}')`,
      ),
      /lobby_economy_rp_check|foreign key/,
    );
  });

  it('refuses an unknown job kind', async () => {
    await assert.rejects(
      () => query(
        `insert into pending_jobs (lobby_id, team_key, kind, payload, ends_at)
         values ('00000000-0000-0000-0000-000000000000', 'x', 'teleport', '{}', now())`,
      ),
      /pending_jobs_kind_check|foreign key/,
    );
  });

  it('refuses the same gold grant twice', async () => {
    const userId = (await query<{ id: string }>(
      `insert into users (nickname_base, nickname_tag) values ('GoldProbe', '9001') returning id`,
    )).rows[0].id;
    await query(
      `insert into gold_grants (user_id, source, external_id, gold) values ($1, 'ad', 'dup-test', 1)`,
      [userId],
    );
    await assert.rejects(
      () => query(
        `insert into gold_grants (user_id, source, external_id, gold) values ($1, 'ad', 'dup-test', 1)`,
        [userId],
      ),
      /duplicate key/,
    );
    await query('delete from users where id = $1', [userId]);
  });

  it('allows the same external id under a different source', async () => {
    const userId = (await query<{ id: string }>(
      `insert into users (nickname_base, nickname_tag) values ('GoldProbe', '9003') returning id`,
    )).rows[0].id;
    await query(`insert into gold_grants (user_id, source, external_id, gold) values ($1, 'ad', 'same-id', 1)`, [userId]);
    await query(`insert into gold_grants (user_id, source, external_id, gold) values ($1, 'iap', 'same-id', 60)`, [userId]);
    const n = await query<{ n: string }>(`select count(*) as n from gold_grants where user_id = $1`, [userId]);
    assert.equal(n.rows[0].n, '2');
    await query('delete from users where id = $1', [userId]);
  });

  it('keeps one daily cap row per user per day', async () => {
    const userId = (await query<{ id: string }>(
      `insert into users (nickname_base, nickname_tag) values ('CapProbe', '9002') returning id`,
    )).rows[0].id;
    await query(`insert into daily_caps (user_id, day) values ($1, '2026-01-01')`, [userId]);
    await assert.rejects(
      () => query(`insert into daily_caps (user_id, day) values ($1, '2026-01-01')`, [userId]),
      /duplicate key/,
    );
    await query('delete from users where id = $1', [userId]);
  });

  it('allows only one open job of a kind per team', async () => {
    const creatorId = (await query<{ id: string }>(
      `insert into users (nickname_base, nickname_tag) values ('SchemaCreator', '9004') returning id`,
    )).rows[0].id;
    const lobbyId = (await query<{ id: string }>(
      `insert into lobbies (name, name_base, name_seq, region, visibility, ai_difficulty, rank_min, rank_max,
                            guests_can_invite, mid_season_join, creator_user_id, next_race_at)
       values ('Schema #1', 'Schema', 1, 'EU', 'private', 'normal', 1, 10, false, true, $1, now() + interval '1 day')
       returning id`,
      [creatorId],
    )).rows[0].id;

    await query(
      `insert into pending_jobs (lobby_id, team_key, kind, ends_at)
       values ($1, 'bosphorus', 'upgrade', now() + interval '22 hours')`, [lobbyId],
    );
    await assert.rejects(
      () => query(
        `insert into pending_jobs (lobby_id, team_key, kind, ends_at)
         values ($1, 'bosphorus', 'upgrade', now() + interval '22 hours')`, [lobbyId],
      ),
      /duplicate key/,
      'a team must not have two open upgrades at once',
    );

    // Farklı tür serbest: tek tezgah parça için, antrenman ayrı.
    await query(
      `insert into pending_jobs (lobby_id, team_key, kind, ends_at)
       values ($1, 'bosphorus', 'training', now() + interval '6 hours')`, [lobbyId],
    );

    // Claim edilmiş iş yolu açar: kısmi indeks yalnızca AÇIK işleri kapsar.
    await query(`update pending_jobs set claimed_at = now() where lobby_id = $1 and kind = 'upgrade'`, [lobbyId]);
    await query(
      `insert into pending_jobs (lobby_id, team_key, kind, ends_at)
       values ($1, 'bosphorus', 'upgrade', now() + interval '22 hours')`, [lobbyId],
    );

    await query('delete from lobbies where id = $1', [lobbyId]);
    await query('delete from users where id = $1', [creatorId]);
  });

  it('drops a lobby economy and its jobs with the lobby', async () => {
    const creatorId = (await query<{ id: string }>(
      `insert into users (nickname_base, nickname_tag) values ('SchemaCreator', '9005') returning id`,
    )).rows[0].id;
    const lobbyId = (await query<{ id: string }>(
      `insert into lobbies (name, name_base, name_seq, region, visibility, ai_difficulty, rank_min, rank_max,
                            guests_can_invite, mid_season_join, creator_user_id, next_race_at)
       values ('Schema #2', 'Schema', 2, 'EU', 'private', 'normal', 1, 10, false, true, $1, now() + interval '1 day')
       returning id`,
      [creatorId],
    )).rows[0].id;
    await query(`insert into lobby_economy (lobby_id, team_key, rp, car) values ($1, 'bosphorus', 100, '{}')`, [lobbyId]);
    await query(`insert into pending_jobs (lobby_id, team_key, kind, ends_at) values ($1, 'bosphorus', 'spy', now())`, [lobbyId]);

    await query('delete from lobbies where id = $1', [lobbyId]);

    const econ = await query(`select 1 from lobby_economy where lobby_id = $1`, [lobbyId]);
    const jobs = await query(`select 1 from pending_jobs where lobby_id = $1`, [lobbyId]);
    assert.equal(econ.rowCount, 0);
    assert.equal(jobs.rowCount, 0);
    await query('delete from users where id = $1', [creatorId]);
  });
});
