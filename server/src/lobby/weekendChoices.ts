/**
 * Koltuk başına hafta sonu tercihleri: practice bias, bileşik (sıralama
 * lastiği ve yarış başlangıç lastiği AYNI alan, bkz. `shared/src/raceEngine.ts`
 * `CarSetup.compound`), taktik ön ayarı, sıralama riski.
 *
 * EV DESENİ (`lobby/checkin.ts` ve `economy/routes.ts` ile birebir aynı):
 * yönlendirici yol parametresi bilmez, `lobbyId` GÖVDEDE gelir; takım anahtarı
 * oyuncunun KENDİ `lobby_seats` satırından okunur — gövdede bir `teamKey`
 * gelse bile YOK SAYILIR, çünkü onu okumak oyuncunun başka bir takım adına
 * karar yazmasına izin verirdi; `now` bu dosyada `new Date()` ile örneklenir
 * (server/README.md §"now sadece route'ta örneklenir").
 *
 * NEDEN YALNIZCA `open`/`checkin`DE KABUL EDİLİR:
 * `runner.ts`in `startRaceFor`i bu satırı IŞIKLAR SÖNERKEN TEK SEFER okur ve
 * `RaceSnapshot.entries`e donar (004_race.sql'in "durum değil tarif" kuralı).
 * `live`den sonra satırı değiştirmek TARİFİ ETKİLEMEZ — donmuş yarış zaten
 * kopyasını almıştır — ama oyuncuya "kaydettim" diyen, hiçbir karşılığı
 * olmayan sahte bir düğme bırakırdı. Bu yüzden `live`den itibaren istek 409
 * ile reddedilir; sessizce yutmak yerine dürüst bir cevap.
 *
 * NEDEN GÜVENİLİRLİK BURADA YOK: oyuncu seçimi değildir, fabrika
 * seviyelerinden türetilir (bkz. `runner.ts` `reliabilityFor`). Bu dosya
 * yalnızca `lobby_seats`e yazılan DÖRT seçimi bilir.
 */
import type { Router, RequestContext, RouteResult } from '../http/router.ts';
import { verifySession } from '../auth/jwt.ts';
import { query } from '../db/pool.ts';
import { compounds, type CompoundKey } from '@pitwall/shared/carCustomisation';
import type { TacticPreset, QualiRisk } from '@pitwall/shared/raceEngine';

interface SeatRow {
  team_key: string;
}

interface LobbyPhaseRow {
  phase: string;
}

/** Oyuncunun bu lobideki KENDİ koltuğu — `teamKey`in TEK kaynağı. */
async function findOwnTeamKey(lobbyId: string, userId: string): Promise<string | null> {
  const res = await query<SeatRow>(
    `select team_key from lobby_seats where lobby_id = $1 and user_id = $2`,
    [lobbyId, userId],
  );
  return res.rows[0]?.team_key ?? null;
}

async function loadPhase(lobbyId: string): Promise<string | null> {
  const res = await query<LobbyPhaseRow>('select phase from lobbies where id = $1', [lobbyId]);
  return res.rows[0]?.phase ?? null;
}

const unauthorized: RouteResult = { status: 401, body: { error: 'unauthorized' } };
const forbidden: RouteResult = { status: 403, body: { error: 'forbidden' } };
const invalidRequest: RouteResult = { status: 400, body: { error: 'invalid_request' } };
const wrongPhase: RouteResult = { status: 409, body: { error: 'wrong_phase' } };

function readLobbyId(ctx: RequestContext): string | null {
  const lobbyId = ctx.body['lobbyId'];
  return typeof lobbyId === 'string' && lobbyId.length > 0 ? lobbyId : null;
}

function isCompound(value: unknown): value is CompoundKey {
  // Büyük harf zorunlu: `lobby_seats_compound_check` (006_weekend_choices.sql)
  // küçük harfli `'soft'`u 23514 ile reddeder — o hata buraya varmadan
  // istemci hatasını burada 400 olarak döndürüyoruz.
  return typeof value === 'string' && compounds.some((c) => c.key === value);
}

function isTactics(value: unknown): value is TacticPreset {
  return value === 'conservative' || value === 'balanced' || value === 'aggressive';
}

function isRisk(value: unknown): value is QualiRisk {
  return value === 'safe' || value === 'aggressive';
}

function isBias(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -1 && value <= 1;
}

export function registerWeekendChoiceRoutes(router: Router): void {
  /**
   * "Bu hafta sonu böyle yarışacağım."
   *
   * Dört alan da OPSİYONELDİR: gövdede bulunmayan bir alan dokunulmadan
   * kalır (`coalesce`), yani bir istek yalnızca bias göndererek önceden
   * kaydedilmiş bileşimi silmez. Bulunan ama geçersiz bir alan (küçük harf
   * bileşik, tanınmayan taktik, aralık dışı bias) TÜM isteği 400 ile
   * reddeder — kısmi bir yazma, hangi alanların kabul hangilerinin ret
   * edildiğini gövdeye yansıtmayan belirsiz bir yarı-başarı bırakırdı.
   */
  router.post('/race/weekend-choices', async (ctx: RequestContext): Promise<RouteResult> => {
    const userId = await verifySession(ctx.bearer);
    if (!userId) return unauthorized;

    const lobbyId = readLobbyId(ctx);
    if (!lobbyId) return invalidRequest;

    // Koltuk ÖNCE: lobide yeri olmayan biri evreyi bile öğrenmemeli.
    const teamKey = await findOwnTeamKey(lobbyId, userId);
    if (!teamKey) return forbidden;

    const rawCompound = ctx.body['compound'];
    const rawBias = ctx.body['bias'];
    const rawTactics = ctx.body['tactics'];
    const rawRisk = ctx.body['qualiRisk'];

    if (rawCompound !== undefined && !isCompound(rawCompound)) return invalidRequest;
    if (rawBias !== undefined && !isBias(rawBias)) return invalidRequest;
    if (rawTactics !== undefined && !isTactics(rawTactics)) return invalidRequest;
    if (rawRisk !== undefined && !isRisk(rawRisk)) return invalidRequest;

    // Evre koşulu sorguyla AYNI ANDA kontrol edilir (UPDATE'in `where`inde):
    // önce `select` edip sonra yazmak kontrol-sonra-davran yarışıdır — tam o
    // aralıkta ışıkları söndüren bir tik, donmuş tarifi hiç etkilemeyecek
    // ama oyuncuya "kaydettim" diyen bir yazmaya izin verirdi
    // (`checkin.ts`/`phase.ts`/`lease.ts` ile aynı sözleşme).
    const res = await query<SeatRow>(
      `update lobby_seats s set
          compound   = coalesce($3, s.compound),
          bias       = coalesce($4, s.bias),
          tactics    = coalesce($5, s.tactics),
          quali_risk = coalesce($6, s.quali_risk)
        where s.lobby_id = $1 and s.user_id = $2
          and exists (
            select 1 from lobbies l where l.id = s.lobby_id and l.phase in ('open', 'checkin')
          )
       returning s.team_key`,
      [lobbyId, userId, rawCompound ?? null, rawBias ?? null, rawTactics ?? null, rawRisk ?? null],
    );
    // Koltuğu yukarıda bulduk, yani sıfır satır yalnızca evrenin `open`/`checkin`
    // olmamasından gelebilir.
    if (res.rowCount === 0) return wrongPhase;

    return { status: 200, body: { ok: true, teamKey: res.rows[0].team_key } };
  });
}

export interface StoredWeekendChoices {
  compound: CompoundKey | null;
  bias: number | null;
  tactics: TacticPreset | null;
  qualiRisk: QualiRisk | null;
}

interface WeekendChoiceRow {
  team_key: string;
  compound: string | null;
  bias: string | number | null;
  tactics: string | null;
  quali_risk: string | null;
}

/**
 * Lobinin tüm koltukları için saklanan hafta sonu tercihleri.
 *
 * `runner.ts`in `startRaceFor`i bunu IŞIKLAR SÖNERKEN TEK SEFER çağırır ve
 * sonucu `RaceSnapshot.entries`e donar; buradan sonra satır değişse de
 * donmuş yarışı etkilemez (bu dosyanın başlığındaki "durum değil tarif"
 * kuralı).
 */
export async function loadWeekendChoices(lobbyId: string): Promise<Record<string, StoredWeekendChoices>> {
  const res = await query<WeekendChoiceRow>(
    `select team_key, compound, bias, tactics, quali_risk from lobby_seats where lobby_id = $1`,
    [lobbyId],
  );
  const out: Record<string, StoredWeekendChoices> = {};
  for (const row of res.rows) {
    out[row.team_key] = {
      compound: isCompound(row.compound) ? row.compound : null,
      bias: row.bias === null ? null : Number(row.bias),
      tactics: isTactics(row.tactics) ? row.tactics : null,
      qualiRisk: isRisk(row.quali_risk) ? row.quali_risk : null,
    };
  }
  return out;
}
