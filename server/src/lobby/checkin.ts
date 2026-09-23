/**
 * Yarış tarifinin OYUNCUYA BAKAN iki ucu: check-in ve canlı pit çağrısı.
 *
 * NEDEN BU İKİSİ AYNI DOSYADA: ikisi de aynı tarifi besler ve aynı tek şarta
 * hizmet eder — herkes AYNI yarışı görmeli. Check-in, ışıklar sönerken donan
 * "bu aracı kim sürüyor" kararını belirler; pit çağrısı ise DEĞİŞMEZ karar
 * günlüğüne tek satır ekler. Üçüncü parça (tohum) sunucunun kendi işidir.
 *
 * EV DESENİ (`economy/routes.ts` ile birebir aynı): yönlendirici yol
 * parametresi bilmez, bu yüzden `lobbyId` GÖVDEDE gelir; takım anahtarı
 * oyuncunun KENDİ `lobby_seats` satırından okunur, gövdeden ASLA; `now` bu
 * dosyada `new Date()` ile örneklenir (server/README.md §"now sadece route'ta
 * örneklenir").
 *
 * YOL SEÇİMİ: eski tek ligli uç noktalar (`/checkin`, `/pit`, `src/index.ts`
 * içinde) hâlâ ayakta ve yönlendirici onlardan ÖNCE çalışıyor; aynı yolu
 * burada kaydetmek eskisini sessizce gölgelerdi. Bu yüzden lobi uçları
 * `/race/checkin` ve `/race/pit` adlarını alıyor. Eski uçlar ayrı bir görevde
 * kaldırılacak.
 *
 * ── DEĞİŞTİRİLEMEYEN KURAL ───────────────────────────────────────────────
 * Bir pit kararı, onu TÜKETEN tur simüle edilmeden ÖNCE kalıcı olmak
 * zorundadır. Tur önce koşar da yazma sonra düşerse canlı yarış kararı yok
 * sayar, sonraki her yeniden oynatma uygular: iki farklı yarış. Günlük
 * ekleme-only ve değişmez olduğu için yazılmış satır geri alınamaz — tek
 * savunma, geç kalmış bir kararı YAZMAMAKTIR. Bu yüzden:
 *  1. İstek, yazma taahhüt edilmeden `ok` DÖNMEZ (aşağıdaki `await`).
 *  2. Yarışın o anki turu hesaplanır ve KESİN İLERİDE olmayan her tur
 *     reddedilir (`lap_already_run`).
 *
 * ── PİT ÇAĞRISI İPTALİ YOK (kasıtlı) ─────────────────────────────────────
 * Bugünkü `src/league.ts` `compound: null` ile bir çağrıyı geri çekmeye izin
 * veriyor. Ekleme-only bir günlük bunu İFADE EDEMEZ: "iptal" satırı ya
 * günlüğü sıraya bağımlı kılar (aynı tarif, okuma sırasına göre iki farklı
 * yarış) ya da mevcut satırı değiştirmeyi gerektirir — ikisi de determinizmi
 * bitirir. Bu yüzden `compound` ZORUNLUDUR ve `null` bir istemci hatasıdır.
 * Bunu "eksik özellik" sanıp sonradan eklemeyin.
 */
import type { Router, RequestContext, RouteResult } from '../http/router.ts';
import { verifySession } from '../auth/jwt.ts';
import { query, withTransaction } from '../db/pool.ts';
import { compounds, type CompoundKey } from '@pitwall/shared/carCustomisation';
import { appendDecision, loadRun } from './raceRepo.ts';
import { RACE_TICK_MS } from './runner.ts';

interface SeatRow {
  team_key: string;
}

interface LobbyRow {
  phase: string;
  season_no: number;
  round_no: number;
}

/** Oyuncunun bu lobideki KENDİ koltuğu — `teamKey`in TEK kaynağı. */
async function findOwnTeamKey(lobbyId: string, userId: string): Promise<string | null> {
  const res = await query<SeatRow>(
    `select team_key from lobby_seats where lobby_id = $1 and user_id = $2`,
    [lobbyId, userId],
  );
  return res.rows[0]?.team_key ?? null;
}

async function loadLobbyRow(lobbyId: string): Promise<LobbyRow | null> {
  const res = await query<LobbyRow>(
    `select phase, season_no, round_no from lobbies where id = $1`, [lobbyId],
  );
  return res.rows[0] ?? null;
}

const unauthorized: RouteResult = { status: 401, body: { error: 'unauthorized' } };
const forbidden: RouteResult = { status: 403, body: { error: 'forbidden' } };
const invalidRequest: RouteResult = { status: 400, body: { error: 'invalid_request' } };
const wrongPhase: RouteResult = { status: 409, body: { error: 'wrong_phase' } };

function conflict(code: string): RouteResult {
  return { status: 409, body: { error: code } };
}

function readLobbyId(ctx: RequestContext): string | null {
  const lobbyId = ctx.body['lobbyId'];
  return typeof lobbyId === 'string' && lobbyId.length > 0 ? lobbyId : null;
}

/**
 * Yarış saatinin dediği tur — `runner.ts` ile AYNI formül.
 *
 * Tur sayacı hiçbir yerde SAKLANMAZ; saklansaydı tarifin dışında ikinci bir
 * gerçek kaynağı olurdu. Otorite `race_runs.started_at` ile gerçek saattir:
 * `tur = (now - started_at) / RACE_TICK_MS`. Koşucunun tik döngüsü de tam
 * olarak buraya kadar oynatır, yani bu sayı "şu an koşulmuş olan son tur"dur.
 */
function currentLap(now: Date, startedAt: Date): number {
  return Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / RACE_TICK_MS));
}

function isCompound(value: unknown): value is CompoundKey {
  // Büyük harf zorunlu: `race_decisions_compound_check` küçük harfli `'soft'`u
  // 23514 ile reddeder ve o hata `appendDecision`dan FIRLAR (500 olurdu).
  // Doğrulamayı burada yapmak, istemci hatasını 400 olarak döndürür.
  return typeof value === 'string' && compounds.some((c) => c.key === value);
}

export function registerCheckinRoutes(router: Router): void {
  /**
   * "Kendi yarışımı süreceğim."
   *
   * Yalnızca `checkin` evresinde: `open`da pencere daha açılmadı, `live`de ise
   * katılım ZATEN DONDU (`runner.startRaceFor`). Işıklar söndükten sonra
   * koltuğu insana çevirmek, tarifte asistan yazan bir aracı oyuncuya
   * verirmiş gibi görünürdü — motor o kararı okumadığı için oyuncuya işleyen
   * ama hiçbir şey yapmayan bir düğme kalırdı.
   */
  router.post('/race/checkin', async (ctx: RequestContext): Promise<RouteResult> => {
    const userId = await verifySession(ctx.bearer);
    if (!userId) return unauthorized;

    const lobbyId = readLobbyId(ctx);
    if (!lobbyId) return invalidRequest;

    // Koltuk ÖNCE: lobide yeri olmayan biri evreyi bile öğrenmemeli.
    const teamKey = await findOwnTeamKey(lobbyId, userId);
    if (!teamKey) return forbidden;

    // Evre koşulu UPDATE'in kendi `where`inde: önce `select` edip sonra yazmak
    // kontrol-sonra-davran yarışıdır — tam o aralıkta lobiyi `live`e taşıyan
    // bir tik, ışıklar söndükten SONRA yazılan bir check-in'e izin verirdi
    // (`phase.ts`/`lease.ts` ile aynı sözleşme).
    const res = await query<SeatRow>(
      `update lobby_seats s set managed = 'human', joined_at = coalesce(s.joined_at, now())
        where s.lobby_id = $1 and s.user_id = $2
          and exists (select 1 from lobbies l where l.id = s.lobby_id and l.phase = 'checkin')
       returning s.team_key`,
      [lobbyId, userId],
    );
    // Koltuğu yukarıda bulduk, yani sıfır satır yalnızca evrenin `checkin`
    // olmamasından gelebilir.
    if (res.rowCount === 0) return wrongPhase;

    return { status: 200, body: { ok: true, teamKey: res.rows[0].team_key } };
  });

  /**
   * Canlı pit çağrısı — değişmez günlüğe tek satır.
   *
   * Gövde: `{ lobbyId, driverIdx, compound, lap? }`. `lap` verilmezse karar
   * koşulacak İLK tura yazılır; verilirse ileri bir tur için planlanmış
   * demektir ve yine "kesin ileride" kuralından geçer.
   */
  router.post('/race/pit', async (ctx: RequestContext): Promise<RouteResult> => {
    const userId = await verifySession(ctx.bearer);
    if (!userId) return unauthorized;

    const lobbyId = readLobbyId(ctx);
    if (!lobbyId) return invalidRequest;

    const driverIdx = ctx.body['driverIdx'];
    if (driverIdx !== 0 && driverIdx !== 1) return invalidRequest;

    const compound = ctx.body['compound'];
    // `null` KASITLA geçersiz: iptal desteklenmiyor (dosya başlığına bakın).
    if (!isCompound(compound)) return invalidRequest;

    const requestedLap = ctx.body['lap'];
    if (requestedLap !== undefined
      && (typeof requestedLap !== 'number' || !Number.isInteger(requestedLap) || requestedLap < 1)) {
      return invalidRequest;
    }

    const teamKey = await findOwnTeamKey(lobbyId, userId);
    if (!teamKey) return forbidden;

    const lobby = await loadLobbyRow(lobbyId);
    if (!lobby) return forbidden;
    if (lobby.phase !== 'live') return wrongPhase;

    const run = await loadRun(lobbyId, lobby.season_no, lobby.round_no);
    // Evre `live` ama tarif henüz yazılmamış: ışıkları söndüren tik daha
    // koşmadı. Tur da yok (saatin başlangıcı `started_at`), yani "ileride mi"
    // sorusunun cevabı yok — ve `race_decisions_run_fk` zaten yazmayı
    // reddederdi. Sessiz bir 500 yerine dürüst bir 409.
    if (!run) return conflict('race_not_started');
    if (run.finishedAt) return conflict('race_finished');

    // DONMUŞ GERÇEK: aracı kimin sürdüğü koltuktan değil TARİFTEN okunur.
    // `raceEngine` yalnızca `managed: 'human'` araçların kararını okur; asistan
    // bir araca karar yazmak oyuncuya "işledi" görünen ama yarışta hiçbir
    // karşılığı olmayan bir satır bırakırdı — üstelik günlük değişmez olduğu
    // için silinemezdi.
    if (run.snapshot.entries[teamKey]?.managed !== 'human') return conflict('not_checked_in');

    // `now` YALNIZCA burada örneklenir; gövdeden gelen bir zaman damgası
    // okunmaz. Okunsaydı istemci geçmiş bir an bildirip KOŞULMUŞ bir tura
    // karar yazdırabilirdi — canlı yarışın göremeyeceği, ama her yeniden
    // oynatmanın uygulayacağı bir karar.
    const now = new Date();
    const lap = currentLap(now, run.startedAt);
    // KESİN İLERİDE: `lap` şu an koşulmuş son turdur, ona (ya da öncesine)
    // yazmak geriye dönük karar demektir. Varsayılan `lap + 1` yine de körü
    // körüne yazılmaz; istemcinin istediği tur da aynı kapıdan geçer.
    const targetLap = requestedLap ?? lap + 1;
    if (targetLap <= lap) return conflict('lap_already_run');

    // Cevap, yazma TAAHHÜT EDİLENE kadar dönmez. `await`i kaldırıp erken `ok`
    // dönmek tam olarak yukarıdaki kuralı kırar: oyuncu kararının geçtiğini
    // sanırken tur onsuz koşulabilir.
    const written = await withTransaction((client) => appendDecision(client, {
      lobbyId,
      seasonNo: lobby.season_no,
      roundNo: lobby.round_no,
      lap: targetLap,
      teamKey,
      driverIdx,
      compound,
      now,
    }));
    // `false` = aynı araç+tur için zaten bir karar var. Bu bir sunucu hatası
    // DEĞİL, günlüğün değişmezliğidir: İLK karar geçerli.
    if (!written) return conflict('already_decided');

    return { status: 200, body: { ok: true, teamKey, driverIdx, compound, lap: targetLap } };
  });
}
