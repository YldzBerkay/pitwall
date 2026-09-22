import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';
import { createLobby, takeSeat, type LobbySettings } from '../src/lobby/lobbyRepo.ts';
import { loadLobbyEconomy, loadTeamEconomy } from '../src/economy/repo.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';

let seq = 0;
const makeUser = (base: string) =>
  createUserWithIdentity({
    base,
    provider: 'google',
    providerUid: `g-seat-${++seq}-${Date.now()}`,
    emailHash: null,
  });

const SETTINGS: LobbySettings = {
  region: 'EU',
  visibility: 'public',
  aiDifficulty: 'normal',
  rankMin: 1,
  rankMax: 10,
  guestsCanInvite: true,
  midSeasonJoin: true,
};

describe('economy follows the seat', () => {
  before(async () => {
    await runMigrations();
  });
  beforeEach(async () => {
    await query('delete from lobbies');
    await query('delete from users');
  });
  after(async () => {
    await closePool();
  });

  it('gives all 11 teams an economy row when the lobby is created', async () => {
    const owner = await makeUser('GridHunter');
    const lobby = await createLobby(owner.id, SETTINGS);
    const lobbyId = lobby.id;
    const rows = await loadLobbyEconomy(lobbyId);
    assert.equal(rows.length, 11, 'AI seats must have an economy too');
    for (const r of rows) {
      assert.ok(r.rp > 0, `${r.teamKey} seeded with no rp`);
      assert.ok(r.car.motor > 0, `${r.teamKey} seeded with no car`);
    }
  });

  it('leaves the economy untouched when a human takes over an AI seat', async () => {
    const owner = await makeUser('TurboKral');
    const lobby = await createLobby(owner.id, SETTINGS);
    const lobbyId = lobby.id;

    // O takımın ekonomisini "yaşamış" hale getir.
    await query(`update lobby_economy set rp = 42 where lobby_id = $1 and team_key = 'ridgeline'`, [lobbyId]);

    const joiner = await makeUser('DrsZone');
    const taken = await takeSeat({ userId: joiner.id, lobbyId, teamKey: 'ridgeline', rankLevel: 5 });
    assert.equal(taken.ok, true, `takeSeat failed: ${JSON.stringify(taken)}`);

    assert.equal(
      (await loadTeamEconomy(lobbyId, 'ridgeline'))!.rp,
      42,
      'taking over an AI seat reset its economy',
    );
  });

  it('seeds an economy for a lobby that predates this change', async () => {
    // Faz 2'de kurulmuş lobilerin ekonomi satırı yok; takeSeat onu doğurmalı.
    const owner = await makeUser('DrsZone2');
    const lobby = await createLobby(owner.id, SETTINGS);
    const lobbyId = lobby.id;
    await query('delete from lobby_economy where lobby_id = $1', [lobbyId]);

    const joiner = await makeUser('FastLapPro');
    const taken = await takeSeat({ userId: joiner.id, lobbyId, teamKey: 'bosphorus', rankLevel: 5 });
    assert.equal(taken.ok, true);

    const econ = await loadTeamEconomy(lobbyId, 'bosphorus');
    assert.ok(econ, 'takeSeat did not seed a missing economy');
    assert.ok(econ!.rp > 0);
  });

  // NOT: createLobby'nin gerçek imzasında lobi kaydı 11 koltuk INSERT'inden
  // ÖNCE tek bir INSERT ile yazılıyor ve isim çakışması bu ilk INSERT'te
  // (unique violation) oluşuyor — yani koltuklar ve ekonomi satırları henüz
  // yazılmadan önce transaction zaten patlıyor ve `createLobby` bunu retry
  // ediyor (name_seq'i artırarak), hata fırlatmıyor. Üstelik `createLobby`
  // kamu API'si dışarıdan (name_base, name_seq) çiftini seçmeye izin vermiyor,
  // bu yüzden "koltuklar zaten yazıldıktan SONRA" bir hata tetiklemenin
  // üretim kodunu değiştirmeden bir yolu yok. Bu testi atlıyorum ve
  // raporluyorum.
});
