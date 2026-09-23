/**
 * Parc fermé değerlendirmesi — ışıklar söndüğünde açık işlerin araca etkisi.
 *
 * Tablo (kullanıcının kararı, gerçek F1 kuralına göre):
 *   devam eden iş        → pişen stat yarıya iner, DNF riski katlanır, normal start
 *   bitmiş, claim YOK    → geliştirme TAM uygulanır, araç PİT YOLUNDAN başlar
 *   bitmiş ve claim'li   → tam uygulanır, normal start
 *   spy                  → araca etkisi yok, normal start
 *
 * Orta satır iki AYRI söz veriyor: ceza VE telafi. İkisi de ayrı ayrı
 * sınanmalı, yoksa telafi sessizce kaybolabilir ve elde saf ceza kalır.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { seedTeamEconomy, loadTeamEconomy } from '../src/economy/repo.ts';
import { startJob, claimJob } from '../src/economy/jobs.ts';
import { evaluateParcFerme } from '../src/lobby/parcFerme.ts';

let seq = 0;

/** Bu testin yarattığı kayıtlar — SADECE bunlar silinir. Veritabanını başka
 *  ajanlar da kullanıyor; tablo geneli `delete` yasak. */
const madeLobbies: string[] = [];
const madeUsers: string[] = [];

/** Testin ihtiyaç duyduğu en küçük lobi (economy-repo.test.ts'ten). */
async function makeLobby(label = 'ParcFerme'): Promise<string> {
  const owner = await createUserWithIdentity({
    base: 'GridHunter', provider: 'google', providerUid: `g-${label}-${++seq}-${Date.now()}`, emailHash: null,
  });
  madeUsers.push(owner.id);
  const res = await query<{ id: string }>(
    `insert into lobbies (name, name_base, name_seq, region, visibility, ai_difficulty,
                          rank_min, rank_max, guests_can_invite, mid_season_join,
                          creator_user_id, next_race_at)
     values ($1, $2, $3, 'EU', 'private', 'normal', 1, 10, false, true, $4,
             now() + interval '1 day')
     returning id`,
    [`${label} #${seq}`, label, seq, owner.id],
  );
  madeLobbies.push(res.rows[0].id);
  return res.rows[0].id;
}

const TEAM = 'bosphorus';
/** İşlerin başlatıldığı an. */
const STARTED = new Date('2026-01-01T00:00:00Z');
/** Işıkların söndüğü an — her işin süresinden çok sonra. */
const LIGHTS_OUT = new Date('2026-01-05T00:00:00Z');
/** Hiçbir işin bitmediği an. */
const EARLY = new Date('2026-01-01T01:00:00Z');

async function seed(lobbyId: string): Promise<void> {
  await withTransaction((c) => seedTeamEconomy(c, lobbyId, TEAM));
}

describe('parc fermé', () => {
  let lobbyId: string;
  before(async () => { await runMigrations(); });
  beforeEach(async () => { lobbyId = await makeLobby(); });
  after(async () => {
    if (madeLobbies.length) {
      await query(`delete from lobbies where id = any($1::uuid[])`, [madeLobbies]);
    }
    if (madeUsers.length) {
      await query(`delete from users where id = any($1::uuid[])`, [madeUsers]);
    }
    await closePool();
  });

  it('1) devam eden geliştirme aracı sakatlar ama pit yoluna göndermez', async () => {
    await seed(lobbyId);
    const before = (await loadTeamEconomy(lobbyId, TEAM))!.car;
    const started = await startJob({
      lobbyId, teamKey: TEAM, kind: 'upgrade', payload: { stat: 'motor' }, now: STARTED,
    });
    assert.equal(started.ok, true);

    const verdict = await evaluateParcFerme(lobbyId, EARLY);
    const team = verdict.byTeam[TEAM];
    assert.ok(team, 'takım için karar yok');
    assert.equal(team.buildingLabel, 'MOTOR', 'pişen stat etiketi yok');
    assert.equal(team.crippled, true);
    // Devam eden iş aracı BÜYÜTMEZ; sakatlamayı motorun crippleSetup'ı yapar.
    assert.deepEqual(team.car, before, 'devam eden iş arabayı değiştirdi');
    assert.deepEqual(verdict.pitLaneStarts, {}, 'devam eden iş pit yolu cezası verdi');
  });

  it('2) biten ama claim edilmemiş araç geliştirmesi: iyileşme TAM, iki araç da pit yolundan', async () => {
    await seed(lobbyId);
    const before = (await loadTeamEconomy(lobbyId, TEAM))!.car;
    const started = await startJob({
      lobbyId, teamKey: TEAM, kind: 'upgrade', payload: { stat: 'motor' }, now: STARTED,
    });
    assert.equal(started.ok, true);

    const verdict = await evaluateParcFerme(lobbyId, LIGHTS_OUT);
    const team = verdict.byTeam[TEAM];
    assert.ok(team, 'takım için karar yok');

    // (a) TELAFİ: iş fiziken araçta — iyileşme gerçekten orada olmalı.
    assert.equal(team.car.motor, before.motor + 1,
      'biten geliştirme etkin araca uygulanmamış (oyuncu emeğini kaybetti)');
    assert.equal(team.car.aero, before.aero, 'ilgisiz stat değişti');
    assert.equal(team.car.grip, before.grip, 'ilgisiz stat değişti');
    // Depodaki araç hâlâ ESKİ: claim sadece oyuncunun eylemidir.
    assert.deepEqual((await loadTeamEconomy(lobbyId, TEAM))!.car, before,
      'değerlendirme lobby_economy.car üzerine yazdı');
    assert.equal(team.crippled, false, 'biten iş aracı sakatlamamalı');
    assert.equal(team.buildingLabel, undefined);

    // (b) CEZA: araç geliştirmesi takımın İKİ aracını da vurur.
    assert.deepEqual(
      Object.keys(verdict.pitLaneStarts).sort(),
      [`${TEAM}:0`, `${TEAM}:1`],
      'araç geliştirmesi iki aracı da pit yoluna göndermedi',
    );

    // İş HÂLÂ claim edilmemiş olmalı: değerlendirme pending_jobs'a yazmaz.
    const rows = await query<{ claimed_at: Date | null }>(
      `select claimed_at from pending_jobs where lobby_id = $1 and team_key = $2`,
      [lobbyId, TEAM],
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].claimed_at, null, 'değerlendirme işi otomatik claim etti');
  });

  it('3) biten ama claim edilmemiş pilot çalışması: yalnız o pilotun aracı', async () => {
    await seed(lobbyId);
    const before = (await loadTeamEconomy(lobbyId, TEAM))!.car;
    const started = await startJob({
      lobbyId, teamKey: TEAM, kind: 'training', payload: { driverIdx: 1 }, now: STARTED,
    });
    assert.equal(started.ok, true);

    const verdict = await evaluateParcFerme(lobbyId, LIGHTS_OUT);
    assert.deepEqual(Object.keys(verdict.pitLaneStarts), [`${TEAM}:1`],
      'pilot çalışması yanlış sayıda aracı cezalandırdı');
    assert.deepEqual(verdict.byTeam[TEAM].car, before, 'çalışma araç statlarına dokundu');
  });

  it('4) claim edilmiş iş ceza vermez', async () => {
    await seed(lobbyId);
    const started = await startJob({
      lobbyId, teamKey: TEAM, kind: 'upgrade', payload: { stat: 'aero' }, now: STARTED,
    });
    assert.equal(started.ok, true);
    assert.ok(started.ok);
    const claimed = await claimJob({ lobbyId, teamKey: TEAM, jobId: started.jobId, now: LIGHTS_OUT });
    assert.equal(claimed.ok, true);

    const stored = (await loadTeamEconomy(lobbyId, TEAM))!.car;
    const verdict = await evaluateParcFerme(lobbyId, LIGHTS_OUT);
    assert.deepEqual(verdict.pitLaneStarts, {}, 'claim edilmiş iş ceza verdi');
    assert.equal(verdict.byTeam[TEAM].crippled, false);
    // Claim zaten `lobby_economy.car`'ı yükseltti; etkin araç odur.
    assert.deepEqual(verdict.byTeam[TEAM].car, stored);
  });

  it('5) casusluk raporu araca dokunmaz, ceza vermez', async () => {
    await seed(lobbyId);
    const before = (await loadTeamEconomy(lobbyId, TEAM))!.car;
    const started = await startJob({
      lobbyId, teamKey: TEAM, kind: 'spy', payload: { target: 'aurelia' }, now: STARTED,
    });
    assert.equal(started.ok, true);

    const verdict = await evaluateParcFerme(lobbyId, LIGHTS_OUT);
    assert.deepEqual(verdict.pitLaneStarts, {}, 'casusluk ceza verdi');
    assert.equal(verdict.byTeam[TEAM].crippled, false);
    assert.deepEqual(verdict.byTeam[TEAM].car, before, 'casusluk aracı değiştirdi');
  });

  it('6) hiç işi olmayan takım: ceza yok, araç aynı', async () => {
    await seed(lobbyId);
    const before = (await loadTeamEconomy(lobbyId, TEAM))!.car;
    const verdict = await evaluateParcFerme(lobbyId, LIGHTS_OUT);
    assert.deepEqual(verdict.pitLaneStarts, {});
    assert.equal(verdict.byTeam[TEAM].crippled, false);
    assert.equal(verdict.byTeam[TEAM].buildingLabel, undefined);
    assert.deepEqual(verdict.byTeam[TEAM].car, before);
  });
});
