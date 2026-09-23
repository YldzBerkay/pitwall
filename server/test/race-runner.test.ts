/**
 * Işıklar sönerken yarış TARİFİNİN dondurulması (`startRaceFor`).
 *
 * Kullanıcının şartı: herkes AYNI yarışı görmeli. Yarış durumu saklanmadığı
 * için bu şartın tek dayanağı, ışıklar söndüğü anda yazılan tarifin EKSİKSİZ
 * olmasıdır — tohum, dondurulmuş katılımlar ve sıralama yaklaşımları. Buradaki
 * testler "tarif iyi şekilli mi" diye sormaz; tarifi doğrudan `replayRace`e
 * verip gerçekten bir yarış çıkıyor mu diye sorar.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { createLobby } from '../src/lobby/lobbyRepo.ts';
import { SEAT_LADDER } from '../src/lobby/grid.ts';
import { loadRun } from '../src/lobby/raceRepo.ts';
import { loadTeamEconomy } from '../src/economy/repo.ts';
import { replayRace, type RaceSnapshot } from '../src/lobby/replay.ts';
import { startRaceFor } from '../src/lobby/runner.ts';
import { carId, type QualiRisk } from '@pitwall/shared/raceEngine';

/**
 * Paylaşılan test veritabanı: BAŞKA ajanlar da aynı şemayı kullanıyor. Bu
 * yüzden tablo geneli `delete` YOK — yalnızca burada yaratılan kimlikler
 * izlenir ve yalnızca onlar silinir.
 */
const createdLobbies: string[] = [];
const createdUsers: string[] = [];
let seq = 0;

const HUMAN = SEAT_LADDER[0];
const ASSISTANT = SEAT_LADDER[1];
const EMPTY = SEAT_LADDER[2];

/** Testin ihtiyaç duyduğu en küçük lobi: 11 koltuk + 11 ekonomi satırı. */
async function makeLobby(label = 'Runner'): Promise<string> {
  const owner = await createUserWithIdentity({
    base: 'GridHunter', provider: 'google', providerUid: `g-${label}-${++seq}-${Date.now()}`, emailHash: null,
  });
  createdUsers.push(owner.id);
  const lobby = await createLobby(owner.id, {
    region: 'EU', visibility: 'private', aiDifficulty: 'normal',
    rankMin: 1, rankMax: 10, guestsCanInvite: false, midSeasonJoin: true,
  });
  createdLobbies.push(lobby.id);
  // Bir koltuk insan (check-in yaptı), bir koltuk asistan (yapmadı), gerisi AI.
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

describe('lights out — freezing the race recipe', () => {
  before(async () => { await runMigrations(); });
  after(async () => {
    for (const id of createdLobbies) await query('delete from lobbies where id = $1', [id]);
    for (const id of createdUsers) await query('delete from users where id = $1', [id]);
    await closePool();
  });

  it('writes a race_runs row carrying a seed and a snapshot', async () => {
    const lobbyId = await makeLobby('Write');
    const started = await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });

    const row = await query<{ seed: number; snapshot: RaceSnapshot }>(
      'select seed, snapshot from race_runs where lobby_id = $1', [lobbyId],
    );
    assert.equal(row.rowCount, 1, 'exactly one run must be written');
    assert.equal(typeof row.rows[0].seed, 'number');
    assert.equal(row.rows[0].seed, started.seed);
    assert.ok(row.rows[0].snapshot, 'snapshot missing');
  });

  it('the snapshot carries risks and an entry for every occupied seat', async () => {
    const lobbyId = await makeLobby('Shape');
    const { snapshot } = await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });

    // `risks` süs değil: başlangıç grid'i ondan türer, grid de yarışı belirler.
    assert.ok(snapshot.risks, 'snapshot has no risks');
    for (const key of Object.keys(snapshot.entries)) {
      assert.ok(snapshot.risks[key], `risks missing for ${key}`);
    }
    assert.deepEqual(
      Object.keys(snapshot.entries).sort(),
      [HUMAN, ASSISTANT].sort(),
      'entries must hold exactly the occupied seats',
    );
  });

  it('freezes who is driving: human, assistant, and an empty seat that is absent', async () => {
    const lobbyId = await makeLobby('Managed');
    const { snapshot } = await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });

    assert.equal(snapshot.entries[HUMAN]?.managed, 'human');
    assert.equal(snapshot.entries[ASSISTANT]?.managed, 'assistant');
    assert.equal(snapshot.entries[EMPTY], undefined, 'an unclaimed seat must be raced by the AI');
  });

  it('the snapshot alone is enough to replay a finished race', async () => {
    const lobbyId = await makeLobby('Replay');
    const { seed, snapshot } = await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 3, now: new Date() });

    const state = replayRace({ seed, round: 3, snapshot, decisions: [] });
    assert.equal(state.finished, true, 'the recipe did not produce a finished race');
    assert.ok(state.cars.length > 0);
    assert.equal(state.lap, state.laps);
  });

  it('a dropped `risks` still runs — but produces a DIFFERENT race', async () => {
    // Tarifin sessiz ölümü budur: `risks`siz bir snapshot hâlâ "çalışır", yani
    // hiçbir şey patlamaz; yalnızca BAŞKA bir yarış üretir. İki oyuncunun
    // farklı yarış izlemesi tam olarak böyle görünür, bu yüzden testin
    // "koşuyor mu" değil "aynı mı" diye sorması gerekir.
    const lobbyId = await makeLobby('Risks');
    const { seed, snapshot } = await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 3, now: new Date() });

    // Sıralamada agresif giden takımlar olan bir tarif. (Hafta sonu seçimleri
    // sunucuya taşındığında `startRaceFor` bunu kendi üretecek; bugün varsayılan
    // herkes için 'safe' olduğundan farkı görünür kılmak için burada kuruyoruz.)
    const risks: Record<string, QualiRisk> = {};
    for (const key of Object.keys(snapshot.entries)) risks[key] = 'aggressive';
    const full = { ...snapshot, risks };
    const stripped = { ...snapshot, risks: {} };

    const a = replayRace({ seed, round: 3, snapshot: full, decisions: [] });
    const b = replayRace({ seed, round: 3, snapshot: stripped, decisions: [] });

    assert.equal(b.finished, true, 'the risk-less recipe must still run — that is why this is invisible');
    assert.notDeepEqual(
      a.cars.map((c) => `${carId(c)}@${c.position}`),
      b.cars.map((c) => `${carId(c)}@${c.position}`),
      'dropping risks left the race unchanged — this test cannot catch the real failure',
    );
  });

  it('cannot be started twice for the same (lobby, season, round)', async () => {
    const lobbyId = await makeLobby('Twice');
    await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    await assert.rejects(
      () => startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() }),
      'a second lights-out must not be possible',
    );
    const res = await query('select 1 from race_runs where lobby_id = $1', [lobbyId]);
    assert.equal(res.rowCount, 1, 'a second run row was written');
  });

  it('a finished-unclaimed upgrade sends both cars to the pit lane and improves the car', async () => {
    const lobbyId = await makeLobby('ParcFerme');
    const before = await loadTeamEconomy(lobbyId, HUMAN);
    assert.ok(before);
    // Bitmiş ama teslim alınmamış geliştirme: parça araçta, oyuncu henüz
    // almamış → tam çalışır, karşılığında pit yolundan başlanır.
    await query(
      `insert into pending_jobs (lobby_id, team_key, kind, payload, started_at, ends_at)
       values ($1, $2, 'upgrade', '{"stat":"motor"}'::jsonb, now() - interval '2 hours', now() - interval '1 minute')`,
      [lobbyId, HUMAN],
    );

    const { snapshot } = await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });

    // Alan artık tarifte İSTEĞE BAĞLI (eski koşular onsuz duruyor); ceza varken
    // yazılmış OLMASI bu testin ilk iddiası.
    const starts = snapshot.pitLaneStarts;
    assert.ok(starts, 'the recipe carries no pitLaneStarts at all');
    assert.ok(starts[`${HUMAN}:0`], 'car 0 must start from the pit lane');
    assert.ok(starts[`${HUMAN}:1`], 'car 1 must start from the pit lane');
    // Telafi gerçekten verilmiş mi: serbest başlangıç lastiği DOLDURULMUŞ olmalı,
    // yoksa oyuncu saf ceza almış olur.
    assert.ok(starts[`${HUMAN}:0`].compound, 'the free starting tyre was never granted');
    assert.ok(
      snapshot.entries[HUMAN].setup.motor > before.car.motor,
      'the finished upgrade did not reach the car',
    );
    // Cezasız takım pit yolunda olmamalı.
    assert.equal(starts[`${ASSISTANT}:0`], undefined);
  });

  it('the written recipe replays with those cars actually starting from the pit lane', async () => {
    // Yukarıdaki test tarifin cezayı YAZDIĞINI kanıtlıyor, UYGULANDIĞINI değil.
    // Fark can alıcı: alan jsonb'de dururken `replayRace` onu `startRace`e
    // geçirmezse yarış cezalıları ızgaraya geri dizer — çöken sunucudan devam
    // eden yarış, oyuncuların izlediğinden başka bir yarış olur.
    const lobbyId = await makeLobby('PitLaneReplay');
    await query(
      `insert into pending_jobs (lobby_id, team_key, kind, payload, started_at, ends_at)
       values ($1, $2, 'upgrade', '{"stat":"motor"}'::jsonb, now() - interval '2 hours', now() - interval '1 minute')`,
      [lobbyId, HUMAN],
    );

    const { seed, snapshot } = await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    const starts = snapshot.pitLaneStarts;
    assert.ok(starts && Object.keys(starts).length > 0, 'fixture must produce a penalty');

    // Izgara durumu (lap 0): yarış gürültüsü karışmadan önceki hâli.
    const grid = replayRace({ seed, round: 1, snapshot, decisions: [], uptoLap: 0 });
    const penalised = grid.cars.filter((c) => starts[carId(c)]);
    const clean = grid.cars.filter((c) => !starts[carId(c)]);
    assert.equal(penalised.length, Object.keys(starts).length);

    const worstClean = Math.max(...clean.map((c) => c.gridPosition));
    for (const car of penalised) {
      assert.ok(car.gridPosition > worstClean,
        `${carId(car)} replay içinde ${car.gridPosition}. sıradan başladı — ceza uygulanmamış`);
      // Serbest başlangıç lastiği de tarife yazılı; araca ulaşmış olmalı.
      assert.equal(car.compound, starts[carId(car)].compound);
    }

    // Cezanın gerçekten bir fark yarattığının kontrolü: aynı tarif, cezasız.
    const withoutPenalty = replayRace({
      seed, round: 1, snapshot: { ...snapshot, pitLaneStarts: undefined }, decisions: [], uptoLap: 0,
    });
    assert.notDeepEqual(
      grid.cars.map((c) => `${carId(c)}@${c.gridPosition}`),
      withoutPenalty.cars.map((c) => `${carId(c)}@${c.gridPosition}`),
      'ceza gridi hiç değiştirmedi — bu test gerçek hatayı yakalayamaz',
    );
  });

  it('the stored seed round-trips as a number for a later replay', async () => {
    const lobbyId = await makeLobby('Seed');
    const started = await startRaceFor({ lobbyId, seasonNo: 2, roundNo: 4, now: new Date() });

    const run = await loadRun(lobbyId, 2, 4);
    assert.ok(run, 'run not found');
    assert.equal(typeof run.seed, 'number', 'seed came back as something other than a number');
    assert.equal(run.seed, started.seed);
    assert.ok(Number.isInteger(run.seed) && run.seed >= 0 && run.seed <= 2147483647,
      'seed must fit a postgres integer');
    // Saklanan tohum otoriter: onunla oynatmak gerçek yarışı verir.
    const state = replayRace({ seed: run.seed, round: 4, snapshot: run.snapshot, decisions: [] });
    assert.equal(state.finished, true);
  });
});
