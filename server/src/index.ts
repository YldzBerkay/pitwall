/**
 * HTTP + WebSocket front for one league.
 *
 *   GET  /state                       public league state
 *   POST /join     {teamKey, managerId}
 *   POST /weekend  {teamKey, managerId, setup?, tactics?, risk?, reliability?}
 *   POST /checkin  {teamKey, managerId}          only inside the window
 *   POST /pit      {teamKey, managerId, driverIdx, compound|null}
 *   WS   /live                        {type:'phase'|'lap'|'result', ...} as they happen
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

const wss = new WebSocketServer({ server, path: '/live' });
wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'phase', state: league.publicState() }));
  if (league.race) socket.send(JSON.stringify({ type: 'lap', race: league.race }));
});
league.subscribe((event) => {
  const payload = JSON.stringify(event);
  for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(payload);
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
