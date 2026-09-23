/**
 * HTTP + WebSocket front for per-lobby races.
 *
 *   GET  /slots · POST /slots/unlock  account slots (spec §4.1)
 *   POST /lobby/create · /lobby/quick-match · /lobby/join   lobbies (spec §3)
 *   POST /lobby/invite · GET /invites lobby invites (spec §3.6)
 *   POST /race/checkin {lobbyId} · POST /race/pit {lobbyId, driverIdx, compound, lap?}
 *   WS   /race/live                   per-lobby rooms: {type:'subscribe'|'unsubscribe', lobbyId, token}
 *
 * Environment: PORT (8787), TICK_MS (2500), CHECKIN_SECONDS (300),
 * INTERVAL_SECONDS (86400), RACE_IN_SECONDS (first race after boot, 3600).
 */

import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Router } from './http/router.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import { registerIdentityRoutes } from './identity/routes.ts';
import { registerLobbyRoutes } from './lobby/routes.ts';
import { registerGoldRoutes } from './gold/routes.ts';
import { registerEconomyRoutes } from './economy/routes.ts';
import { registerCheckinRoutes } from './lobby/checkin.ts';
import { createLiveHub, LIVE_PATH } from './lobby/live.ts';
import { createRaceSweep } from './lobby/sweep.ts';
import { RACE_TICK_MS } from './lobby/runner.ts';
import { runMigrations } from './db/migrate.ts';

const env = (key: string, fallback: number) => Number(process.env[key] ?? fallback);

const identityRouter = new Router();
registerAuthRoutes(identityRouter);
registerIdentityRoutes(identityRouter);
registerLobbyRoutes(identityRouter);
registerGoldRoutes(identityRouter);
registerEconomyRoutes(identityRouter);
registerCheckinRoutes(identityRouter);

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  if (await identityRouter.handle(req, res)) return;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST' });
    return res.end();
  }
  return json(res, 404, { error: 'not found' });
});

// ── WebSocket: lobi başına odalara bölünen tek yayın ───────────────────────
// `noServer`: `ws`, `{ server, path }` ile kurulduğunda yola UYMAYAN her
// yükseltmeyi 400 ile DÜŞÜRÜR. Yükseltmeyi tek elden biz dağıtıyoruz.
const liveHub = createLiveHub();
const liveWss = new WebSocketServer({ noServer: true });
liveWss.on('connection', (socket) => liveHub.attach(socket));

server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  const target = path === LIVE_PATH ? liveWss : null;
  // Tanımadığımız bir yola gelen yükseltme sessizce kapatılır: yarım açık bir
  // soketi tutmak, bağlantı başına bellek harcayan ucuz bir DoS yüzeyidir.
  if (!target) return socket.destroy();
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
});

const port = env('PORT', 8787);

// ── Lobi başına yarış süpürücüsü ───────────────────────────────────────────
// `openRace`i ve `hub.publish`i gerçekten ÇAĞIRAN tek yer burasıdır (Faz
// 3a-2'ye kadar ikisi de yalnızca testlerden çağrılıyordu). Zamanlayıcı MODÜL
// YÜKLENİRKEN DEĞİL, sunucu gerçekten dinlemeye başladığında kurulur — testin
// `sweepOnce`i gerçek bir zamanlayıcı olmadan doğrudan çağırabilmesi bunun
// koşuludur (bkz. `lobby/sweep.ts` docblock'u).
const raceSweepOwnerId = randomUUID();
const raceSweep = createRaceSweep(raceSweepOwnerId, liveHub);
let raceSweepTimer: NodeJS.Timeout | null = null;

/**
 * Kapanışta: zamanlayıcı durur ve elimizdeki her kira HEMEN bırakılır. Bunu
 * atlarsak yeniden başlayan bir süreç, sürdüğümüz her lobi için `LEASE_MS`
 * (15 sn) beklemek zorunda kalır — kısa bir deploy bile oyunculara donmuş bir
 * ekran gibi görünür.
 */
async function shutdown(signal: string): Promise<void> {
  console.log(`[pit-wall] ${signal} alındı, kapanılıyor…`);
  if (raceSweepTimer) clearInterval(raceSweepTimer);
  try {
    await raceSweep.releaseAll();
  } catch (err) {
    console.error('[pit-wall] kapanışta kiraları bırakırken hata:', err);
  }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// We must not serve any request against a half-applied schema, so
// migrations run to completion before the server starts listening. A
// migration failure is fatal: log it and exit rather than silently falling
// back to whatever schema state happens to exist.
runMigrations()
  .then(() => {
    server.listen(port, () => {
      console.log(`[pit-wall] listening on :${port}`);
      // `now` HER ATIŞTA burada, `new Date()` ile örneklenir — süpürücünün
      // kendisi saati asla okumaz (server/README.md §"now sadece route'ta
      // örneklenir"). Atış aralığı tur uzunluğuyla (`RACE_TICK_MS`) aynı:
      // daha seyrek olsaydı yayın turun gerisinde kalırdı, daha sık olsaydı
      // aynı turu boşuna yeniden sorgulardık.
      raceSweepTimer = setInterval(() => {
        void raceSweep.sweepOnce(new Date()).catch((err: unknown) => {
          console.error('[pit-wall] yarış süpürmesi patladı:', err);
        });
      }, RACE_TICK_MS);
    });
  })
  .catch((err: unknown) => {
    console.error('[pit-wall] migrations failed, refusing to start:', err);
    process.exit(1);
  });
