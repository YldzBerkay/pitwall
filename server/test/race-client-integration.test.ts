/**
 * Uçtan uca kanıt: mobil istemcinin KENDİ yarış modülleri
 * (`mobile/src/lib/api/race.ts`, `mobile/src/lib/api/raceSocket.ts`) gerçek,
 * canlı bir sunucuya karşı çalışıyor mu — hiçbir sahte (`fetch` stub'ı, sahte
 * `WebSocket` sunucusu) olmadan.
 *
 * NEDEN BU DOSYA `server/test/`DE: `race.ts`/`raceSocket.ts` her ikisi de
 * `mobile/`in kendi test koşucusunda (`tsx --test`) zaten test ediliyor, ama
 * o testler istemci TARAFINI kanıtlıyor — HTTP başlıkları doğru mu,
 * `WebSocket` çerçeveleri doğru yorumlanıyor mu — hep sahte bir `http.Server`
 * ya da sahte bir `WebSocket`e karşı. Buradaki soru FARKLI: istemcinin
 * ürettiği gerçek istek, sunucunun GERÇEK yönlendiricisinden geçip GERÇEK
 * Postgres'e mi yazıyor, ve sunucunun gerçek soket odası istemcinin
 * beklediği çerçeveleri mi yolluyor. Bunu kanıtlamanın tek yolu ikisini de
 * canlı çalıştırmak — ve gerçek sunucuyu ayağa kaldıran kod zaten
 * `server/src/index.ts`, `mobile/`den değil.
 *
 * İki paketin ayrı `tsconfig`/test koşucusu olması yüzünden bu dosya mobil
 * dosyalarını GÖRELİ YOLLA içeri alıyor (`../../mobile/src/lib/api/...`),
 * `mobile`in `@/...` takma adından geçmeden. Bu güvenli: `race.ts`in tek
 * dışa bağımlılığı `./identity` (göreli) ve `@pitwall/shared/*` (sunucunun
 * KENDİ `node_modules`unda zaten var, aynı `file:../shared` bağımlılığı);
 * `raceSocket.ts`in HİÇ dışa bağımlılığı yok — ikisi de zaten React
 * Native/Expo'dan arınık yazılmıştı (plan gerekçesi: `mobile/README.md`).
 * `@/` takma adına dayanan hiçbir dosya burada içeri alınmıyor.
 *
 * SUNUCU GERÇEKTEN AYAKTA: `src/index.ts`in kendi HTTP sunucusu, WebSocket
 * sunucusu ve süpürme zamanlayıcısı çalışıyor — evre geçişini (`checkin` →
 * `live`) ve tur yayınını bu testin KENDİSİ değil, gerçek üretim kod yolu
 * (`sweep.ts`) yapıyor. Bu yüzden bu test gerçek zamanlayıcı ATIŞLARINI
 * bekliyor (`RACE_TICK_MS = 2500`); diğer sunucu testlerinin aksine bu
 * KASITLI — amaç sahte bir saatle değil, sunucunun kendi kalp atışıyla
 * kanıtlamak.
 *
 * KAPANIŞ: `shutdown()` çağrılmazsa alt süreç hiç bitmez ve `node --test`
 * `--test-concurrency=1` ile sırayla koştuğu için bu dosyadan SONRAKİ hiçbir
 * test dosyası çalışmaz (server/README.md sözleşme #5). `after()` bunu
 * güvenceye alıyor.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { signSession } from '../src/auth/jwt.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { query, closePool } from '../src/db/pool.ts';
import { createLobby } from '../src/lobby/lobbyRepo.ts';
import { SEAT_LADDER } from '../src/lobby/grid.ts';
import { RACE_TICK_MS } from '../src/lobby/runner.ts';

// Mobil istemcinin KENDİ modülleri — göreli yol, `@/` takma adı yok (yukarı
// bakın). Bunlar test edilen ŞEY, burada yeniden yazılmıyor.
import { checkin, pit, weekendChoices } from '../../mobile/src/lib/api/race.ts';
import { createRaceSocket, type RaceSocketState } from '../../mobile/src/lib/api/raceSocket.ts';

process.env.SESSION_SECRET ??= 'a'.repeat(32);
process.env.EMAIL_HASH_PEPPER ??= 'test-pepper-value';
process.env.PORT ??= '8796';

const httpBase = `http://127.0.0.1:${process.env.PORT}`;
const wsBase = `ws://127.0.0.1:${process.env.PORT}/race/live`;

const TEAM_A = SEAT_LADDER[0];

const createdLobbies: string[] = [];
const createdUsers: string[] = [];
let seq = 0;

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  seq += 1;
  const user = await createUserWithIdentity({
    base: 'GridHunter', provider: 'google', providerUid: `client-int-${tag}-${seq}-${Date.now()}`, emailHash: null,
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

/** `managed = 'assistant'` — koltuk sahiplenilmiş ama check-in henüz yapılmamış
 * durumu taklit eder; `checkin()` çağrısı bunu `human`a çevirecek (asıl test
 * ettiğimiz yol). */
async function seat(lobbyId: string, teamKey: string, tag: string) {
  const user = await makeUser(tag);
  await query(
    `update lobby_seats set user_id = $3, managed = 'assistant', joined_at = now()
       where lobby_id = $1 and team_key = $2`,
    [lobbyId, teamKey, user.id],
  );
  return user;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `checkinThreshold`/`next_race_at` gerçek sunucunun kendi süpürücüsünü
 * (`sweep.ts`) tetikleyecek şekilde yakın bir gelecekte kurulur — bu testte
 * evreyi ELLE ilerletmiyoruz, gerçek `src/index.ts` zamanlayıcısının
 * yapmasını bekliyoruz. */
async function pollUntil<T>(fn: () => Promise<T | null>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fn();
    if (res !== null) return res;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await sleep(150);
  }
}

interface LobbyRow { phase: string }

describe('mobile race client against a real, live server', () => {
  let stopServer: (() => Promise<void>) | null = null;

  before(async () => {
    const app = await import('../src/index.ts');
    stopServer = app.shutdown;
    await app.ready;
  });

  after(async () => {
    await stopServer?.();
    for (const id of createdLobbies) await query('delete from lobbies where id = $1', [id]);
    for (const id of createdUsers) await query('delete from users where id = $1', [id]);
    await closePool();
  });

  it('weekend choices, check-in, a live socket frame, and a pit call all round-trip through the real server', async () => {
    const lobbyId = await makeLobby('e2e');
    const driver = await seat(lobbyId, TEAM_A, 'e2e-seat');

    // Lobi `checkin` evresinde, yarış birkaç saniye sonra — gerçek
    // süpürücünün (`sweep.ts`) kısa sürede `live`e taşıması için.
    const raceAt = new Date(Date.now() + 2_000);
    await query(`update lobbies set phase = 'checkin', next_race_at = $2 where id = $1`, [lobbyId, raceAt]);

    // ── 1. Hafta sonu tercihleri istemciden gidiyor, sunucuda görünüyor ────
    const weekendRes = await weekendChoices(httpBase, driver.token, {
      lobbyId, compound: 'MEDIUM', bias: 0.4, tactics: 'aggressive', qualiRisk: 'safe',
    });
    assert.equal(weekendRes.ok, true, `weekend-choices reddedildi: ${JSON.stringify(weekendRes)}`);

    const seatRow = await query<{ compound: string; bias: string; tactics: string; quali_risk: string }>(
      `select compound, bias, tactics, quali_risk from lobby_seats where lobby_id = $1 and team_key = $2`,
      [lobbyId, TEAM_A],
    );
    assert.equal(seatRow.rows[0]?.compound, 'MEDIUM', 'istemcinin gönderdiği bileşik sunucuda yok');
    assert.equal(seatRow.rows[0]?.tactics, 'aggressive');
    assert.equal(seatRow.rows[0]?.quali_risk, 'safe');
    assert.equal(Number(seatRow.rows[0]?.bias), 0.4);

    // ── 2. Check-in yalnızca `checkin` evresinde kabul ediliyor ────────────
    const checkinRes = await checkin(httpBase, driver.token, lobbyId);
    assert.equal(checkinRes.ok, true, `check-in reddedildi: ${JSON.stringify(checkinRes)}`);
    if (!checkinRes.ok) throw new Error('unreachable');
    assert.equal(checkinRes.data.teamKey, TEAM_A);

    // ── 3. `live`e geçiş: gerçek sunucunun kendi süpürücüsü yapıyor ────────
    await pollUntil(async () => {
      const row = await query<LobbyRow>('select phase from lobbies where id = $1', [lobbyId]);
      return row.rows[0]?.phase === 'live' ? true : null;
    }, 10_000, `lobby ${lobbyId} evreye live geçişi`);

    // ── 4. Soket gerçekten bağlanıp bir `state` çerçevesi alıyor ───────────
    const socket = createRaceSocket(
      { url: wsBase, lobbyId, token: driver.token },
      { WebSocketImpl: WebSocket as unknown as new (url: string) => any },
    );
    try {
      const connected = await pollUntil(async () => {
        const s = socket.getState();
        return s.status === 'connected' && s.race ? s : null;
      }, 15_000, 'raceSocket bağlanıp bir state çerçevesi alması');
      assert.equal(connected.status, 'connected');
      assert.ok(connected.race, 'soket bir yarış görüntüsü almadı');
      assert.equal(connected.race?.trackKey !== undefined, true);

      // Gerçek süpürücünün en az bir tur ilerlettiğinden emin ol — pit
      // çağrısının hedefleyeceği tur hesaba katılabilsin diye.
      await sleep(RACE_TICK_MS + 500);

      const runRow = await query<{ last_lap: number; started_at: Date }>(
        `select last_lap, started_at from race_runs
          where lobby_id = $1 order by season_no desc, round_no desc limit 1`,
        [lobbyId],
      );
      const lastLap = runRow.rows[0]?.last_lap ?? 0;
      assert.ok(runRow.rows[0], 'race_runs tarifi yazılmamış');

      // ── 5. Kabul edilen pit çağrısı: koşulmuş turdan kesin ileride ───────
      const futureLap = lastLap + 5;
      const pitOk = await pit(httpBase, driver.token, {
        lobbyId, driverIdx: 0, compound: 'HARD', lap: futureLap,
      });
      assert.equal(pitOk.ok, true, `ileri bir tura pit çağrısı reddedildi: ${JSON.stringify(pitOk)}`);
      if (!pitOk.ok) throw new Error('unreachable');
      assert.equal(pitOk.data.lap, futureLap);

      // ── 6. Koşulmuş bir tura pit çağrısı `lap_already_run` ile reddedilir ─
      const pastLap = Math.max(1, lastLap); // `last_lap` ZATEN koşulmuş kabul edilir (raceRepo.ts).
      const pitRejected = await pit(httpBase, driver.token, {
        lobbyId, driverIdx: 0, compound: 'SOFT', lap: pastLap,
      });
      assert.equal(pitRejected.ok, false, 'koşulmuş bir tura pit çağrısı kabul edildi');
      if (pitRejected.ok) throw new Error('unreachable');
      assert.equal(pitRejected.error, 'lap_already_run');
    } finally {
      socket.close();
    }
  });
});
