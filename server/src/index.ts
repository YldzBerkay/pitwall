/**
 * HTTP + WebSocket front for one league.
 *
 *   GET  /slots · POST /slots/unlock  account slots (spec §4.1)
 *   POST /lobby/create · /lobby/quick-match · /lobby/join   lobbies (spec §3)
 *   POST /lobby/invite · GET /invites lobby invites (spec §3.6)
 *   GET  /state                       public league state
 *   POST /join     {teamKey, managerId}
 *   POST /weekend  {teamKey, managerId, setup?, tactics?, risk?, reliability?}
 *   POST /race/checkin {lobbyId} · POST /race/pit {lobbyId, driverIdx, compound, lap?}
 *   POST /checkin  {teamKey, managerId}          only inside the window
 *   POST /pit      {teamKey, managerId, driverIdx, compound|null}
 *   WS   /live                        legacy single-league feed (unchanged)
 *   WS   /race/live                   per-lobby rooms: {type:'subscribe'|'unsubscribe', lobbyId, token}
 *
 * Environment: PORT (8787), TICK_MS (2500), CHECKIN_SECONDS (300),
 * INTERVAL_SECONDS (86400), RACE_IN_SECONDS (first race after boot, 3600).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import { League } from './league.ts';
import { Router } from './http/router.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import { registerIdentityRoutes } from './identity/routes.ts';
import { registerLobbyRoutes } from './lobby/routes.ts';
import { registerGoldRoutes } from './gold/routes.ts';
import { registerEconomyRoutes } from './economy/routes.ts';
import { registerCheckinRoutes } from './lobby/checkin.ts';
import { createLiveHub, LIVE_PATH } from './lobby/live.ts';
import { runMigrations } from './db/migrate.ts';

const env = (key: string, fallback: number) => Number(process.env[key] ?? fallback);

const league = new League({
  tickMs: env('TICK_MS', 2500),
  checkinMs: env('CHECKIN_SECONDS', 300) * 1000,
  intervalMs: env('INTERVAL_SECONDS', 86_400) * 1000,
  firstRaceInMs: env('RACE_IN_SECONDS', 3600) * 1000,
});

const identityRouter = new Router();
registerAuthRoutes(identityRouter);
registerIdentityRoutes(identityRouter);
registerLobbyRoutes(identityRouter);
registerGoldRoutes(identityRouter);
registerEconomyRoutes(identityRouter);
// Lobi yarışı: check-in ve canlı pit çağrısı. Yollar `/race/...` çünkü
// aşağıdaki ESKİ tek ligli `/checkin` ve `/pit` uçları hâlâ ayakta ve
// yönlendirici onlardan önce çalışıyor — aynı adı almak eskisini sessizce
// gölgelerdi (eski uçların kaldırılması ayrı bir görev).
registerCheckinRoutes(identityRouter);

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
};

const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });

const server = createServer(async (req, res) => {
  if (await identityRouter.handle(req, res)) return;

  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST' });
    return res.end();
  }
  if (req.method === 'GET' && url.pathname === '/state') return json(res, 200, league.publicState());
  if (req.method !== 'POST') return json(res, 404, { error: 'not found' });

  const body = await readBody(req);
  const teamKey = String(body.teamKey ?? '');
  const managerId = String(body.managerId ?? '');
  if (!teamKey || !managerId) return json(res, 400, { error: 'teamKey and managerId required' });

  switch (url.pathname) {
    case '/join':
      return json(res, 200, { result: league.join(teamKey, managerId), state: league.publicState() });
    case '/weekend': {
      const { setup, tactics, risk, reliability } = body as Record<string, never>;
      return json(res, 200, { ok: league.setWeekend(teamKey, managerId, { setup, tactics, risk, reliability }) });
    }
    case '/checkin':
      return json(res, 200, { result: league.checkIn(teamKey, managerId), state: league.publicState() });
    case '/pit': {
      const driverIdx = Number(body.driverIdx) === 1 ? 1 : 0;
      const compound = (body.compound ?? null) as never;
      return json(res, 200, { ok: league.pit(teamKey, managerId, driverIdx, compound) });
    }
    default:
      return json(res, 404, { error: 'not found' });
  }
});

// ── WebSocket: iki ayrı yayın, iki ayrı yol ────────────────────────────────
// ESKİ `/live` tek ligin her turunu bağlı HERKESE yolluyor; yeni `/race/live`
// ise lobi başına odalara bölüyor. Aynı yolu paylaşamazlar — karışmaları tam
// da odaların düzelttiği hata olurdu — bu yüzden yeni yayın `/race/live`
// adını alıyor (`/race/checkin`, `/race/pit` ile aynı aile). Eski uç ve eski
// uç noktalar KALDIRILMADI; o ayrı bir görev.
//
// İkisi de `noServer`: `ws`, `{ server, path }` ile kurulduğunda yola UYMAYAN
// her yükseltmeyi 400 ile DÜŞÜRÜR. İki sunucu aynı HTTP sunucusuna böyle
// bağlansaydı, hangisi önce dinleyici eklediyse diğerinin soketini kapatırdı.
// Bu yüzden yükseltmeyi tek elden biz dağıtıyoruz.
const legacyWss = new WebSocketServer({ noServer: true });
legacyWss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'phase', state: league.publicState() }));
  if (league.race) socket.send(JSON.stringify({ type: 'lap', race: league.race }));
});
league.subscribe((event) => {
  const payload = JSON.stringify(event);
  for (const client of legacyWss.clients) if (client.readyState === client.OPEN) client.send(payload);
});

const liveHub = createLiveHub();
const liveWss = new WebSocketServer({ noServer: true });
liveWss.on('connection', (socket) => liveHub.attach(socket));

server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  const target = path === LIVE_PATH ? liveWss : path === '/live' ? legacyWss : null;
  // Tanımadığımız bir yola gelen yükseltme sessizce kapatılır: yarım açık bir
  // soketi tutmak, bağlantı başına bellek harcayan ucuz bir DoS yüzeyidir.
  if (!target) return socket.destroy();
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
});

const port = env('PORT', 8787);

// We must not serve any request — league or identity — against a
// half-applied schema, so migrations run to completion before the server
// starts listening. A migration failure is fatal: log it and exit rather
// than silently falling back to whatever schema state happens to exist.
runMigrations()
  .then(() => {
    server.listen(port, () => {
      const s = league.publicState();
      console.log(`[pit-wall] league on :${port} · ${s.track.gp} · lights out ${new Date(s.raceStartAt).toISOString()} · check-in opens ${new Date(s.checkinOpensAt).toISOString()}`);
    });
  })
  .catch((err: unknown) => {
    console.error('[pit-wall] migrations failed, refusing to start:', err);
    process.exit(1);
  });
