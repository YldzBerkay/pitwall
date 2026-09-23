import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { acquireDueLobbies, renewLease, releaseLease, LEASE_MS } from '../src/lobby/lease.ts';

let seq = 0;

/** Bu testin yarattığı lobiler. Depo başka ajanlarla PAYLAŞILDIĞI için
 *  `delete from lobbies` gibi toptan temizlik yapmıyoruz; yalnızca kendi
 *  satırlarımızı topluyor ve sonunda yalnızca onları siliyoruz. */
const made: string[] = [];

/** Testin ihtiyaç duyduğu en küçük lobi (economy-repo.test.ts'ten). */
async function makeLobby(opts: { phase?: string; dueMs?: number; label?: string } = {}): Promise<string> {
  const label = opts.label ?? 'Lease';
  const owner = await createUserWithIdentity({
    base: 'GridHunter', provider: 'google', providerUid: `g-${label}-${++seq}-${Date.now()}`, emailHash: null,
  });
  const res = await query<{ id: string }>(
    `insert into lobbies (name, name_base, name_seq, region, visibility, ai_difficulty,
                          rank_min, rank_max, guests_can_invite, mid_season_join,
                          creator_user_id, phase, next_race_at)
     values ($1, $2, $3, 'EU', 'private', 'normal', 1, 10, false, true, $4, $5,
             now() + ($6 || ' milliseconds')::interval)
     returning id`,
    [`${label} #${seq}`, label, seq, owner.id, opts.phase ?? 'checkin', String(opts.dueMs ?? -60_000)],
  );
  const id = res.rows[0].id;
  made.push(id);
  return id;
}

async function leaseRow(lobbyId: string) {
  const res = await query<{ race_owner: string | null; race_lease_until: Date | null }>(
    `select race_owner, race_lease_until from lobbies where id = $1`, [lobbyId],
  );
  return res.rows[0];
}

/** Havuzu ısıt: soğuk `pool.connect()` gecikmesi eşzamanlı çağıranları
 *  sıraya SOKAR ve yarış penceresi hiç oluşmaz — bozuk bir uygulama bile
 *  geçer. Isıtma olmadan bu testin kanıt değeri yoktur. */
async function warmPool(n = 10): Promise<void> {
  await Promise.all(Array.from({ length: n }, () => query('select 1')));
}

describe('race lease', () => {
  before(async () => { await runMigrations(); });
  after(async () => {
    if (made.length) await query(`delete from lobbies where id = any($1::uuid[])`, [made]);
    await closePool();
  });

  it('claims a due lobby and stamps owner + expiry', async () => {
    const lobbyId = await makeLobby();
    const now = new Date();
    const claimed = await acquireDueLobbies('owner-A', now, 100);
    assert.ok(claimed.some((l) => l.lobbyId === lobbyId), 'due lobby was not claimed');

    const row = await leaseRow(lobbyId);
    assert.equal(row.race_owner, 'owner-A');
    assert.ok(row.race_lease_until, 'no lease expiry written');
    assert.equal(row.race_lease_until!.getTime(), now.getTime() + LEASE_MS);
  });

  it('does not claim a lobby whose race is not due yet', async () => {
    const lobbyId = await makeLobby({ dueMs: 60 * 60_000 });
    const claimed = await acquireDueLobbies('owner-A', new Date(), 100);
    assert.ok(!claimed.some((l) => l.lobbyId === lobbyId), 'claimed a lobby that is not due');
    assert.equal((await leaseRow(lobbyId)).race_owner, null);
  });

  it('lets exactly one of many concurrent owners hold a lobby', async () => {
    const lobbyId = await makeLobby();
    await warmPool();

    const OWNERS = 12;
    const marks: { owner: string; startedAt: number; finishedAt: number; won: boolean }[] = [];
    await Promise.all(Array.from({ length: OWNERS }, async (_unused, i) => {
      const owner = `race-owner-${i}`;
      const startedAt = performance.now();
      const claimed = await acquireDueLobbies(owner, new Date(), 100);
      marks.push({
        owner, startedAt, finishedAt: performance.now(),
        won: claimed.some((l) => l.lobbyId === lobbyId),
      });
    }));

    const winners = marks.filter((m) => m.won);
    assert.equal(winners.length, 1, `${winners.length} owners claimed the same lobby`);

    // Araçsallaştırma: kazanan işini bitirdiğinde kaç çağıran gerçekten
    // uçuştaydı? Bu sayı 1 ise test eşzamanlılığı hiç sınamamıştır.
    const contended = marks.filter((m) => m.startedAt < winners[0].finishedAt).length;
    console.log(`[lease] contention: ${contended}/${OWNERS} callers in flight at the winner's commit`);
    assert.ok(contended > 1, `only ${contended}/${OWNERS} callers reached the contended window`);

    assert.equal((await leaseRow(lobbyId)).race_owner, winners[0].owner);
  });

  it('lets another owner take over an expired lease', async () => {
    const lobbyId = await makeLobby();
    const now = new Date();
    await acquireDueLobbies('owner-A', now, 100);
    await query(`update lobbies set race_lease_until = $2 where id = $1`,
      [lobbyId, new Date(now.getTime() - 1_000)]);

    const claimed = await acquireDueLobbies('owner-B', now, 100);
    assert.ok(claimed.some((l) => l.lobbyId === lobbyId), 'expired lease was not taken over');
    assert.equal((await leaseRow(lobbyId)).race_owner, 'owner-B');
  });

  it('refuses to take over a live lease', async () => {
    const lobbyId = await makeLobby();
    const now = new Date();
    await acquireDueLobbies('owner-A', now, 100);

    const claimed = await acquireDueLobbies('owner-B', now, 100);
    assert.ok(!claimed.some((l) => l.lobbyId === lobbyId), 'stole a live lease');
    assert.equal((await leaseRow(lobbyId)).race_owner, 'owner-A');
  });

  it('renews only for the owner', async () => {
    const lobbyId = await makeLobby();
    const now = new Date();
    await acquireDueLobbies('owner-A', now, 100);

    const later = new Date(now.getTime() + 1_000);
    assert.equal(await renewLease('owner-B', lobbyId, later), false, 'a non-owner renewed');
    assert.equal((await leaseRow(lobbyId)).race_lease_until!.getTime(), now.getTime() + LEASE_MS,
      'a non-owner moved the expiry');

    assert.equal(await renewLease('owner-A', lobbyId, later), true);
    assert.equal((await leaseRow(lobbyId)).race_lease_until!.getTime(), later.getTime() + LEASE_MS);
  });

  it('releases only for the owner', async () => {
    const lobbyId = await makeLobby();
    await acquireDueLobbies('owner-A', new Date(), 100);

    assert.equal(await releaseLease('owner-B', lobbyId), false, 'a non-owner released');
    assert.equal((await leaseRow(lobbyId)).race_owner, 'owner-A');

    assert.equal(await releaseLease('owner-A', lobbyId), true);
    const row = await leaseRow(lobbyId);
    assert.equal(row.race_owner, null);
    assert.equal(row.race_lease_until, null);
  });
});
