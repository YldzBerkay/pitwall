/**
 * HTTP front for the economy endpoints: one command route, one read route.
 *
 * The router (`http/router.ts`) does exact path matching with no path
 * parameters, but it DOES hand every handler the full request URL
 * (`ctx.url`), so a query string works fine on an exact path — `GET /lobby`
 * already relies on this for `?id=`. `POST /economy/action` therefore keeps
 * `lobbyId` in the request BODY alongside `type` and whatever the action
 * needs (it is described by its verb, not by what it names), while the new
 * `GET /economy/state` names its target with `?lobbyId=`, matching `GET
 * /lobby`'s own precedent instead of inventing a read-flavoured action type
 * on the mutating endpoint. A `GET` that can only ever read is also a
 * stronger guarantee than a `POST` handler that merely happens not to write
 * anything today — nothing here calls into `runAction` or any mutating repo
 * function, so this route class cannot regress into a silent write later.
 *
 * Two things this file exists to enforce (see the task's warnings):
 *  1. A session is required, and the team acted on/read comes from the
 *     player's OWN `lobby_seats` row for that lobby — never from the request
 *     body or query string. A `teamKey` sent by the caller is read nowhere
 *     in this file.
 *  2. Nothing thrown by `runAction` for an unrecognised reason is ever
 *     swallowed into a misleading 400 — it is re-thrown so the router turns
 *     it into a 500 with no detail leaked (see `http/router.ts`). The read
 *     route holds the same line for `SlotStateError`.
 */
import type { Router, RequestContext, RouteResult } from '../http/router.ts';
import { verifySession } from '../auth/jwt.ts';
import { query } from '../db/pool.ts';
import { runAction, type ActionFailureCode } from './actions.ts';
import { buildSlotState, SlotStateError } from './state.ts';
import { loadSettlementPayout } from './settlementRepo.ts';

const STATUS_BY_CODE: Record<ActionFailureCode, number> = {
  unknown_action: 400,
  bad_payload: 400,
  not_ready: 409,
  already_claimed: 409,
  already_running: 409,
  not_enough_rp: 409,
  not_enough_gold: 409,
  no_user: 400,
  not_found: 404,
  cap_reached: 409,
  no_economy: 404,
};

interface SeatRow {
  team_key: string;
}

/** The player's own seat for this lobby — the ONLY source of `teamKey`. */
async function findOwnTeamKey(lobbyId: string, userId: string): Promise<string | null> {
  const res = await query<SeatRow>(
    `select team_key from lobby_seats where lobby_id = $1 and user_id = $2`,
    [lobbyId, userId],
  );
  return res.rows[0]?.team_key ?? null;
}

function unauthorized(): RouteResult {
  return { status: 401, body: { error: 'unauthorized' } };
}

function forbidden(): RouteResult {
  return { status: 403, body: { error: 'forbidden' } };
}

// `SlotStateError` today only ever carries 'no_economy', but this map is
// keyed by the error's own reason type (not hand-picked) so a future reason
// added to `state.ts` fails to compile here instead of silently falling back
// to a generic status — the same "don't collapse distinct reasons" contract
// `STATUS_BY_CODE` above already keeps for `runAction`.
const SLOT_STATE_STATUS_BY_REASON: Record<SlotStateError['reason'], number> = {
  no_economy: 404,
};

export function registerEconomyRoutes(router: Router): void {
  // Salt okuma: hiçbir şey yazmaz. `POST /economy/action` her zaman
  // `buildSlotState`'i BİR eylemi uyguladıktan SONRA çağırıp cevap olarak
  // döndürür — ama bir ekran soğuk açıldığında önce bir şey değiştirmeden
  // "durumum ne?" diye sormanın yolu yoktu. Router path parametresi
  // desteklemiyor (bkz. `http/router.ts`), fakat `GET /lobby`'nin de
  // kanıtladığı gibi tam eşleşen bir path üstünde sorgu dizesi (`ctx.url`)
  // rahatça çalışıyor — o yüzden burada da hedefi `?lobbyId=` ile
  // tanımlıyoruz, ayrı bir eylem tipi icat etmek yerine. `teamKey` diğer
  // rotadaki gibi YALNIZCA `lobby_seats`'ten gelir; body/query'den okunan bir
  // `teamKey` yoktur ki görmezden gelinecek bir şey de olmasın. `now` da aynı
  // sözleşmeyle burada `new Date()` ile örneklenir.
  router.get('/economy/state', async (ctx: RequestContext): Promise<RouteResult> => {
    const userId = await verifySession(ctx.bearer);
    if (!userId) return unauthorized();

    const lobbyId = ctx.url.searchParams.get('lobbyId');
    if (!lobbyId) {
      return { status: 400, body: { error: 'invalid_request' } };
    }

    const teamKey = await findOwnTeamKey(lobbyId, userId);
    if (!teamKey) return forbidden();

    // Aynı gerekçeyle: bu okuma da cihaz saatine değil, kendi `new Date()`
    // örneğine güvenir — bkz. yukarıdaki `now` yorumu.
    const now = new Date();
    try {
      const state = await buildSlotState({ lobbyId, teamKey, userId, now });
      return { status: 200, body: state };
    } catch (err) {
      if (err instanceof SlotStateError) {
        return { status: SLOT_STATE_STATUS_BY_REASON[err.reason], body: { error: err.reason } };
      }
      throw err;
    }
  });

  // Salt okuma: hiçbir şey yazmaz, `buildSlotState` gibi. Oyuncu bağlı
  // DEĞİLKEN koşulmuş bir yarışın ödemesini (hangi kısmının ne kadar
  // olduğunu) okumanın tek yolu — ışıklar söndüğünde uygulamayı açık
  // tutmayan oyuncu, ne kazandığını bir daha asla öğrenemezdi (bkz.
  // `settle.ts`/`settlementRepo.ts`). Hedef yine `?lobbyId=` ve `?round=`
  // ile tanımlanır — `teamKey` burada da YALNIZCA `lobby_seats`ten gelir.
  // `season` opsiyoneldir ve verilmezse lobinin GÜNCEL sezonuna düşer; bu,
  // "son yarışımı ne kazandım" sorusunun en sık sorulduğu hâldir. Bir round
  // hiç ödenmediyse (henüz koşulmadı ya da hâlâ sürüyor) bu bir HATA değil —
  // `settlement: null` ile 200 döner, tıpkı henüz kazanılmamış bir başarım
  // gibi.
  router.get('/economy/settlement', async (ctx: RequestContext): Promise<RouteResult> => {
    const userId = await verifySession(ctx.bearer);
    if (!userId) return unauthorized();

    const lobbyId = ctx.url.searchParams.get('lobbyId');
    const roundParam = ctx.url.searchParams.get('round');
    if (!lobbyId || !roundParam) {
      return { status: 400, body: { error: 'invalid_request' } };
    }
    const roundNo = Number(roundParam);
    if (!Number.isInteger(roundNo) || roundNo < 1) {
      return { status: 400, body: { error: 'invalid_request' } };
    }

    const teamKey = await findOwnTeamKey(lobbyId, userId);
    if (!teamKey) return forbidden();

    const seasonParam = ctx.url.searchParams.get('season');
    let seasonNo: number;
    if (seasonParam !== null) {
      seasonNo = Number(seasonParam);
      if (!Number.isInteger(seasonNo) || seasonNo < 1) {
        return { status: 400, body: { error: 'invalid_request' } };
      }
    } else {
      const lobbyRow = await query<{ season_no: number }>('select season_no from lobbies where id = $1', [lobbyId]);
      seasonNo = lobbyRow.rows[0]?.season_no ?? 1;
    }

    const payout = await loadSettlementPayout(lobbyId, seasonNo, roundNo, teamKey);
    if (!payout) return { status: 200, body: { settlement: null } };

    return {
      status: 200,
      body: {
        settlement: {
          season: seasonNo,
          round: roundNo,
          position: payout.position,
          prize: payout.prize,
          sponsorIncome: payout.sponsorIncome,
          briefBonus: payout.briefBonus,
          bonusesEarned: payout.bonusesEarned,
          streaksBroken: payout.streaksBroken,
          // Bu turda kapanan pozisyonlar. Silme kalıcı olduğu için tek
          // kaynağı ödeme anında yazılan bu satır — bkz.
          // `009_settlement_expired_slots.sql`.
          expired: payout.expiredSlots,
        },
      },
    };
  });

  router.post('/economy/action', async (ctx: RequestContext): Promise<RouteResult> => {
    const userId = await verifySession(ctx.bearer);
    if (!userId) return unauthorized();

    const lobbyId = ctx.body['lobbyId'];
    if (typeof lobbyId !== 'string' || lobbyId.length === 0) {
      return { status: 400, body: { error: 'invalid_request' } };
    }

    const teamKey = await findOwnTeamKey(lobbyId, userId);
    if (!teamKey) return forbidden();

    // `now` is sampled HERE, from this machine's own clock, and nowhere
    // else. `jobs.ts` deliberately never reads the clock itself — every one
    // of its entry points takes `now` from its caller so a test can pin it
    // — which means the anti-cheat property of the whole job system (a
    // claim only succeeds once `ends_at` has really passed; a skip's gold
    // cost is computed from real remaining time) rests entirely on this
    // call site handing it a trustworthy value. `runAction` takes `now` as
    // a parameter only so tests can fix it; a request body's `now` /
    // `serverNow` / `timestamp` (if a client ever sends one) is NEVER read
    // here or in `actions.ts` — a caller-supplied instant far in the future
    // would make `skipCostGold` return 0 (a free skip) and make an unready
    // job's `ends_at <= now` compare true (an instant claim). Do not add a
    // fallback or override that lets any part of the request influence this
    // value.
    const now = new Date();
    const result = await runAction({ lobbyId, userId, teamKey, body: ctx.body, now });
    if (result.ok) return { status: 200, body: result.state };

    const status = STATUS_BY_CODE[result.code];
    if (status === undefined) {
      // A code `runAction` can return but this map doesn't know about is a
      // programming error in this file, not a client mistake — surface it
      // as a 500 via the router rather than guessing a status.
      throw new Error('registerEconomyRoutes: unmapped action failure code');
    }
    return { status, body: { error: result.code } };
  });
}
