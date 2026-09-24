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
import { registerSponsorRoutes } from './economy/sponsorRoutes.ts';
import { registerCheckinRoutes } from './lobby/checkin.ts';
import { registerWeekendChoiceRoutes } from './lobby/weekendChoices.ts';
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
registerSponsorRoutes(identityRouter);
registerCheckinRoutes(identityRouter);
registerWeekendChoiceRoutes(identityRouter);

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
 * Süreci canlı tutan HER ŞEYİ durdurur: süpürme zamanlayıcısı, açık soketler,
 * dinleyen sunucu — ve elimizdeki her kira HEMEN bırakılır. Kirayı bırakmayı
 * atlarsak yeniden başlayan bir süreç, sürdüğümüz her lobi için `LEASE_MS`
 * (15 sn) beklemek zorunda kalır; kısa bir deploy bile oyunculara donmuş bir
 * ekran gibi görünür.
 *
 * `process.exit` ÇAĞIRMAZ ve bu bilinçlidir. Bu modülü içeri alan bir test,
 * gerçek bir sunucuya ihtiyaç duyduğu için alır; kapatma yolu yoksa alt süreç
 * olay döngüsü boşalmadığı için hiç bitmez ve `node --test` sırayla koştuğu
 * için ondan sonraki hiçbir dosya çalışmaz. Sinyal işleyicileri çıkışı kendisi
 * yapar; testler sadece `shutdown()` çağırıp doğal kapanışa bırakır.
 *
 * Tekrar çağrılabilir: ikinci çağrı ilkinin sözünü döndürür.
 */
let shutdownPromise: Promise<void> | null = null;
export function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    if (raceSweepTimer) clearInterval(raceSweepTimer);
    raceSweepTimer = null;
    try {
      await raceSweep.releaseAll();
    } catch (err) {
      console.error('[pit-wall] kapanışta kiraları bırakırken hata:', err);
    }
    // Açık soketler tek başlarına olay döngüsünü canlı tutar; `close()` yeni
    // bağlantıyı reddeder ama mevcutları beklerdi.
    for (const socket of liveWss.clients) socket.terminate();
    await new Promise<void>((resolve) => liveWss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  })();
  return shutdownPromise;
}

function shutdownOnSignal(signal: string): void {
  console.log(`[pit-wall] ${signal} alındı, kapanılıyor…`);
  void shutdown().then(() => process.exit(0));
}
process.on('SIGTERM', () => shutdownOnSignal('SIGTERM'));
process.on('SIGINT', () => shutdownOnSignal('SIGINT'));

// We must not serve any request against a half-applied schema, so
// migrations run to completion before the server starts listening. A
// migration failure is fatal: log it and exit rather than silently falling
// back to whatever schema state happens to exist.
/**
 * Sunucu gerçekten dinlemeye başladığında çözülür. Testler bunu bekler —
 * sabit bir `sleep` yerine, çünkü göç süresi makineye göre değişir ve uyku
 * ya yavaş ya da güvenilmezdir.
 */
export const ready: Promise<void> = runMigrations()
  .then(() => new Promise<void>((resolve) => {
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
      resolve();
    });
  }))
  .catch((err: unknown) => {
    console.error('[pit-wall] migrations failed, refusing to start:', err);
    process.exit(1);
  });
