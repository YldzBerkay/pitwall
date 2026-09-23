/**
 * Lobi başına canlı yayın odaları (`src/lobby/live.ts`).
 *
 * TEK ŞART: her oyuncu KENDİ yarışını görmeli — ne eksik ne fazla. Tek bir
 * global yayın (bugünkü `/live`) bunu iki yönden birden kırar: oyuncu başka
 * lobilerin turlarını alır ve hangisinin kendi yarışı olduğunu ayırt edemez.
 * Buradaki testlerin çekirdeği bu yüzden 2 numaralı testtir: A lobisine abone
 * bir istemci, B lobisinin tek bir turunu bile GÖRMEMELİDİR.
 *
 * GERÇEK ZAMANLAYICI YOK: yarış durumu `openRace(...).tick(now)` ile çağıranın
 * verdiği `now`a göre üretilir, yayın ise testin kendi `publish` çağrısıyla
 * tetiklenir. Hiçbir test duvar saati beklemesine dayanmaz; tek beklenen şey
 * soket olaylarıdır.
 *
 * PAYLAŞILAN test veritabanı: başka ajanlar da aynı şemayı kullanıyor. Tablo
 * geneli `delete` YOK — yalnızca burada yaratılan kimlikler izlenir ve
 * yalnızca onlar silinir.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { signSession } from '../src/auth/jwt.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';
import { createLobby } from '../src/lobby/lobbyRepo.ts';
import { SEAT_LADDER } from '../src/lobby/grid.ts';
import { LEASE_MS } from '../src/lobby/lease.ts';
import { openRace, startRaceFor, RACE_TICK_MS, type OpenedRace } from '../src/lobby/runner.ts';
import { LIVE_PATH, createLiveHub, type LiveHub } from '../src/lobby/live.ts';

const createdLobbies: string[] = [];
const createdUsers: string[] = [];
let seq = 0;

const TEAM_A = SEAT_LADDER[0];
const RUNNER_OWNER = 'test-live-owner';

let server: Server;
let wss: WebSocketServer;
let hub: LiveHub;
let base: string;
/** Sunucu tarafındaki soketler — kapanışı OLAYLA beklemek için. */
const serverSockets: WebSocket[] = [];

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  seq += 1;
  const user = await createUserWithIdentity({
    base: 'GridHunter', provider: 'google', providerUid: `live-${tag}-${seq}-${Date.now()}`, emailHash: null,
  });
  createdUsers.push(user.id);
  return { id: user.id, token: await signSession(user.id) };
}

async function makeLobby(tag: string): Promise<string> {
  const owner = await makeUser(`own-${tag}`);
  const lobby = await createLobby(owner.id, {
    region: 'EU', visibility: 'private', aiDifficulty: 'normal',
    rankMin: 1, rankMax: 10, guestsCanInvite: false, midSeasonJoin: true,
  });
  createdLobbies.push(lobby.id);
  return lobby.id;
}

async function seat(lobbyId: string, teamKey: string, tag: string) {
  const user = await makeUser(tag);
  await query(
    `update lobby_seats set user_id = $3, managed = 'human', joined_at = now()
     where lobby_id = $1 and team_key = $2`,
    [lobbyId, teamKey, user.id],
  );
  return user;
}

/**
 * `live` evresinde, kirası bu teste ait, ışıkları `lapsAgo` tur önce sönmüş
 * bir lobi. Kirayı `acquireDueLobbies` ile ALMIYORUZ: paylaşılan veritabanında
 * o tarama başka ajanların lobilerini de üstlenirdi.
 */
async function liveRace(tag: string, lapsAgo: number): Promise<{
  lobbyId: string; token: string; runner: OpenedRace; startedAt: Date;
}> {
  const lobbyId = await makeLobby(tag);
  const user = await seat(lobbyId, TEAM_A, `${tag}-seat`);
  const startedAt = new Date(Date.now() - lapsAgo * RACE_TICK_MS - 500);
  await query(
    `update lobbies
        set phase = 'live', season_no = 1, round_no = 1,
            race_owner = $2, race_lease_until = $3
      where id = $1`,
    [lobbyId, RUNNER_OWNER, new Date(Date.now() + LEASE_MS)],
  );
  await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: startedAt });
  const runner = await openRace({
    lobbyId, seasonNo: 1, roundNo: 1, ownerId: RUNNER_OWNER, now: startedAt,
  });
  assert.ok(runner, 'openRace returned null for a live lobby');
  return { lobbyId, token: user.token, runner, startedAt };
}

function at(base: Date, laps: number): Date {
  return new Date(base.getTime() + laps * RACE_TICK_MS + 10);
}

interface Client {
  ws: WebSocket;
  /** Sıradaki mesaj — gelmişse kuyruktan, gelmemişse geldiğinde. */
  next(): Promise<any>;
  close(): Promise<void>;
}

function connect(): Promise<Client> {
  const ws = new WebSocket(`${base}${LIVE_PATH}`);
  const queue: any[] = [];
  let waiting: ((msg: any) => void) | null = null;
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (waiting) { const w = waiting; waiting = null; w(msg); } else queue.push(msg);
  });
  const client: Client = {
    ws,
    next: () => new Promise((resolve) => {
      const head = queue.shift();
      if (head !== undefined) resolve(head);
      else waiting = resolve;
    }),
    close: async () => { ws.close(); await once(ws, 'close'); },
  };
  return once(ws, 'open').then(() => client);
}

/** Abone ol ve sunucunun ilk cevabını (durum görüntüsü) döndür. */
async function subscribe(client: Client, lobbyId: string, token: string): Promise<any> {
  client.ws.send(JSON.stringify({ type: 'subscribe', lobbyId, token }));
  return client.next();
}

function startServer(): Promise<void> {
  hub = createLiveHub();
  wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (socket) => {
    serverSockets.push(socket);
    hub.attach(socket);
  });
  server = createServer((_req, res) => { res.writeHead(404).end(); });
  // `src/index.ts` ile aynı el yordamı: yükseltme yoluna göre dağıtılır.
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== LIVE_PATH) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      base = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
}

describe('per-lobby live race rooms', () => {
  before(async () => {
    process.env.SESSION_SECRET = 'a'.repeat(32);
    process.env.EMAIL_HASH_PEPPER = 'test-pepper-value';
    await runMigrations();
    await startServer();
  });

  after(async () => {
    for (const s of serverSockets) s.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const id of createdLobbies) await query('delete from lobbies where id = $1', [id]);
    for (const id of createdUsers) await query('delete from users where id = $1', [id]);
    await closePool();
  });

  // ── 1. Koltuğu olan abone, kendi lobisinin turlarını alır ────────────────

  it('a seated client subscribes and receives that lobby laps', async () => {
    const race = await liveRace('own', 0);
    const client = await connect();

    const ack = await subscribe(client, race.lobbyId, race.token);
    assert.equal(ack.type, 'state');
    assert.equal(ack.lobbyId, race.lobbyId);

    const ticked = await race.runner.tick(at(race.startedAt, 2));
    assert.ok(ticked.advanced > 0, 'the runner did not advance a lap');
    hub.publish(race.lobbyId, ticked.state);

    const lap = await client.next();
    assert.equal(lap.type, 'lap');
    assert.equal(lap.lobbyId, race.lobbyId);
    assert.equal(lap.race.lap, ticked.state.lap);

    await client.close();
  });

  // ── 2. BAŞLIK TEST: iki lobinin yayını asla karışmaz ─────────────────────

  it('a client subscribed to lobby A never receives lobby B laps', async () => {
    const a = await liveRace('iso-a', 0);
    const b = await liveRace('iso-b', 0);
    const clientA = await connect();
    const clientB = await connect();

    await subscribe(clientA, a.lobbyId, a.token);
    await subscribe(clientB, b.lobbyId, b.token);

    // ÖNCE B yayınlanır. Soket başına sıra korunduğu için, A'nın istemcisine
    // sızan bir B turu A'nınkinden ÖNCE gelirdi ve aşağıdaki iddia patlardı.
    const tickedB = await b.runner.tick(at(b.startedAt, 3));
    hub.publish(b.lobbyId, tickedB.state);
    const tickedA = await a.runner.tick(at(a.startedAt, 5));
    hub.publish(a.lobbyId, tickedA.state);

    const seenByA = await clientA.next();
    assert.equal(seenByA.lobbyId, a.lobbyId, 'lobby A client saw another lobby race');
    assert.equal(seenByA.race.lap, tickedA.state.lap);

    const seenByB = await clientB.next();
    assert.equal(seenByB.lobbyId, b.lobbyId, 'lobby B client saw another lobby race');
    assert.equal(seenByB.race.lap, tickedB.state.lap);

    await clientA.close();
    await clientB.close();
  });

  // ── 3. Koltuğu olmayan reddedilir ────────────────────────────────────────

  it('a client with no seat in the lobby is refused', async () => {
    const race = await liveRace('gate', 0);
    const outsider = await makeUser('gate-outsider');
    const client = await connect();

    const res = await subscribe(client, race.lobbyId, outsider.token);
    assert.equal(res.type, 'error');
    assert.equal(res.error, 'forbidden');
    assert.equal(hub.roomSize(race.lobbyId), 0, 'a refused client was put in the room anyway');

    // Ve reddedilen soket, sonraki turları da almaz.
    const ticked = await race.runner.tick(at(race.startedAt, 2));
    hub.publish(race.lobbyId, ticked.state);

    const seated = await seat(race.lobbyId, SEAT_LADDER[1], 'gate-seated');
    const ack = await subscribe(client, race.lobbyId, seated.token);
    assert.equal(ack.type, 'state', 'the refused socket received a lap it should never have seen');

    await client.close();
  });

  // ── 4. Geç gelen önce o anki durumu alır ─────────────────────────────────

  it('a late subscriber receives the current state before subsequent laps', async () => {
    const race = await liveRace('late', 0);
    const ticked = await race.runner.tick(at(race.startedAt, 4));
    assert.ok(ticked.state.lap >= 4, 'the race did not reach lap 4');

    const client = await connect();
    const ack = await subscribe(client, race.lobbyId, race.token);
    assert.equal(ack.type, 'state');
    // Saklanan `last_lap`e hizalı: geç gelen sonraki turu beklemez.
    assert.equal(ack.race.lap, ticked.state.lap);

    const next = await race.runner.tick(at(race.startedAt, 5));
    hub.publish(race.lobbyId, next.state);
    const lap = await client.next();
    assert.equal(lap.type, 'lap');
    assert.equal(lap.race.lap, next.state.lap);

    await client.close();
  });

  // ── 5. Abonelikten çıkmak akışı durdurur ─────────────────────────────────

  it('unsubscribing stops the flow', async () => {
    const race = await liveRace('unsub', 0);
    const client = await connect();
    await subscribe(client, race.lobbyId, race.token);
    assert.equal(hub.roomSize(race.lobbyId), 1);

    client.ws.send(JSON.stringify({ type: 'unsubscribe', lobbyId: race.lobbyId }));
    const bye = await client.next();
    assert.equal(bye.type, 'unsubscribed');
    assert.equal(hub.roomSize(race.lobbyId), 0);

    const ticked = await race.runner.tick(at(race.startedAt, 2));
    hub.publish(race.lobbyId, ticked.state);

    // Zamanlayıcı beklemeden kanıt: yeniden abone olunca gelmesi GEREKEN ilk
    // mesaj `state`tir. Yukarıdaki tur sızsaydı sıradaki mesaj `lap` olurdu.
    const ack = await subscribe(client, race.lobbyId, race.token);
    assert.equal(ack.type, 'state', 'a lap arrived after unsubscribing');

    await client.close();
  });

  // ── 6. Kapanan soket odadan düşer, oda birikmez ──────────────────────────

  it('a closed socket is removed from the room and the room is not retained', async () => {
    const race = await liveRace('leak', 0);
    const client = await connect();
    await subscribe(client, race.lobbyId, race.token);
    assert.equal(hub.roomSize(race.lobbyId), 1);

    const serverSide = serverSockets[serverSockets.length - 1];
    await client.close();
    if (serverSide.readyState !== WebSocket.CLOSED) await once(serverSide, 'close');

    assert.equal(hub.roomSize(race.lobbyId), 0, 'a closed socket stayed in the room');
    assert.ok(!hub.hasRoom(race.lobbyId), 'the empty room was retained');

    // Boş odaya yayın yapmak patlamamalı.
    const ticked = await race.runner.tick(at(race.startedAt, 2));
    hub.publish(race.lobbyId, ticked.state);
  });

  // ── 7. Yayın hava durumu taşır ────────────────────────────────────────────

  it('a broadcast frame carries weather and its forecast content survives intact', async () => {
    const race = await liveRace('weather', 0);
    const client = await connect();
    await subscribe(client, race.lobbyId, race.token);

    const ticked = await race.runner.tick(at(race.startedAt, 2));
    hub.publish(race.lobbyId, ticked.state);
    const lap = await client.next();

    assert.ok(lap.race.weather, 'yayın hava planını taşımıyor');
    assert.deepEqual(lap.race.weather, ticked.state.weather);
    assert.equal(typeof lap.race.weather.forecast, 'number');
    assert.equal(lap.race.weather.forecast, ticked.state.weather.forecast);

    await client.close();
  });

  // ── 8. Yayın nötralizasyon durumunu taşır ─────────────────────────────────

  it('a broadcast frame carries neutralised state when present, and behaves sensibly when absent', async () => {
    const race = await liveRace('neutral', 0);
    const client = await connect();
    await subscribe(client, race.lobbyId, race.token);

    const ticked = await race.runner.tick(at(race.startedAt, 2));
    hub.publish(race.lobbyId, ticked.state);
    const lap = await client.next();

    // `neutralised` opsiyonel: yeşil bayrakta yok. Frame yine de alanı
    // devlet nesnesiyle BİREBİR eşleşmeli — ne icat etmeli ne yutmalı.
    assert.deepEqual(lap.race.neutralised, ticked.state.neutralised);
    if (ticked.state.neutralised) {
      assert.equal(typeof ticked.state.neutralised.untilLap, 'number');
    }

    await client.close();
  });

  // ── 9. Tarif nesneleri yayına SIZMAZ ──────────────────────────────────────

  it('the frame does not carry standings, entries or rosters', async () => {
    const race = await liveRace('leak-recipe', 0);
    const client = await connect();
    await subscribe(client, race.lobbyId, race.token);

    const ticked = await race.runner.tick(at(race.startedAt, 2));
    hub.publish(race.lobbyId, ticked.state);
    const lap = await client.next();

    assert.equal('standings' in lap.race, false, 'yayın standings taşıyor — tarif sızıyor');
    assert.equal('entries' in lap.race, false, 'yayın entries taşıyor — tarif sızıyor');
    assert.equal('rosters' in lap.race, false, 'yayın rosters taşıyor — tarif sızıyor');

    await client.close();
  });

  // ── 10. serialise() aldığı durumu DEĞİŞTİRMEZ ─────────────────────────────

  it('serialise() (via publish) does not mutate the state it was given', async () => {
    const race = await liveRace('no-mutate', 0);
    const client = await connect();
    await subscribe(client, race.lobbyId, race.token);

    const ticked = await race.runner.tick(at(race.startedAt, 2));
    // `structuredClone`: JSON tur-turu `undefined` alanları (örn. `neutralised`)
    // sessizce düşürür ve karşılaştırmayı yanlış pozitif kırar.
    const before = structuredClone(ticked.state);
    hub.publish(race.lobbyId, ticked.state);
    await client.next();

    assert.deepEqual(ticked.state, before, 'serialise() paylaşılan durumu değiştirdi');

    await client.close();
  });
});
