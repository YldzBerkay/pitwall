import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { advanceDuePhases, CHECKIN_WINDOW_MS } from '../src/lobby/phase.ts';

let seq = 0;

/**
 * Bu paket veritabanını BAŞKA paketlerle paylaşıyor, bu yüzden hiçbir yerde
 * `delete from lobbies` gibi tablo geneli bir silme YOKTUR: yalnızca burada
 * kurulan satırların id'leri toplanır ve sonunda yalnızca onlar silinir.
 */
const madeLobbies: string[] = [];
const madeUsers: string[] = [];

/** Testin ihtiyaç duyduğu en küçük lobi (economy-repo.test.ts'teki yardımcı,
 *  faz ve yarış anını dışarıdan verebilmek için parametreli hâli). */
async function makeLobby(phase: string, nextRaceAt: Date, label = 'Phase'): Promise<string> {
  const owner = await createUserWithIdentity({
    base: 'GridHunter', provider: 'google', providerUid: `g-${label}-${++seq}`, emailHash: null,
  });
  madeUsers.push(owner.id);
  const res = await query<{ id: string }>(
    `insert into lobbies (name, name_base, name_seq, region, visibility, ai_difficulty,
                          rank_min, rank_max, guests_can_invite, mid_season_join,
                          creator_user_id, phase, next_race_at)
     values ($1, $2, $3, 'EU', 'private', 'normal', 1, 10, false, true, $4, $5, $6)
     returning id`,
    [`${label} #${seq}`, `${label}-${seq}`, seq, owner.id, phase, nextRaceAt],
  );
  madeLobbies.push(res.rows[0].id);
  return res.rows[0].id;
}

async function phaseOf(lobbyId: string): Promise<string> {
  const res = await query<{ phase: string }>('select phase from lobbies where id = $1', [lobbyId]);
  return res.rows[0].phase;
}

describe('lobby phase advancement', () => {
  before(async () => { await runMigrations(); });
  after(async () => {
    if (madeLobbies.length) await query('delete from lobbies where id = any($1::uuid[])', [madeLobbies]);
    if (madeUsers.length) await query('delete from users where id = any($1::uuid[])', [madeUsers]);
    await closePool();
  });

  it('opens check-in once the window is reached', async () => {
    const now = new Date();
    // Yarışa CHECKIN_WINDOW_MS'ten az kaldı: check-in penceresi açılmalı.
    const lobbyId = await makeLobby('open', new Date(now.getTime() + CHECKIN_WINDOW_MS - 1_000));
    await advanceDuePhases(now);
    assert.equal(await phaseOf(lobbyId), 'checkin');
  });

  it('goes live once the race instant has passed', async () => {
    const now = new Date();
    const lobbyId = await makeLobby('checkin', new Date(now.getTime() - 1_000));
    await advanceDuePhases(now);
    assert.equal(await phaseOf(lobbyId), 'live');
  });

  it('leaves a lobby whose time has not come alone', async () => {
    const now = new Date();
    // Check-in penceresinin de dışında: bir saat var.
    const lobbyId = await makeLobby('open', new Date(now.getTime() + 60 * 60 * 1000));
    await advanceDuePhases(now);
    assert.equal(await phaseOf(lobbyId), 'open');
  });

  it('catches up a lobby the server slept through — ends live, not stuck in checkin', async () => {
    const now = new Date();
    const lobbyId = await makeLobby('open', new Date(now.getTime() - 3 * 60 * 60 * 1000));
    await advanceDuePhases(now);
    assert.equal(await phaseOf(lobbyId), 'live',
      'saatler önce yarışması gereken lobi tek çağrıda live olmalı');
  });

  it('does not touch a finished lobby', async () => {
    const now = new Date();
    const lobbyId = await makeLobby('finished', new Date(now.getTime() - 3 * 60 * 60 * 1000));
    await advanceDuePhases(now);
    assert.equal(await phaseOf(lobbyId), 'finished');
  });

  it('is idempotent — a second call with the same now is a no-op', async () => {
    const now = new Date();
    const lobbyId = await makeLobby('open', new Date(now.getTime() + CHECKIN_WINDOW_MS - 1_000));

    const first = await advanceDuePhases(now);
    assert.equal(first.filter((m) => m.lobbyId === lobbyId).length, 1);
    assert.equal(await phaseOf(lobbyId), 'checkin');

    const second = await advanceDuePhases(now);
    assert.equal(second.filter((m) => m.lobbyId === lobbyId).length, 0,
      'ikinci çağrı aynı lobiyi yeniden ilerletti');
    assert.equal(await phaseOf(lobbyId), 'checkin');
  });
});
