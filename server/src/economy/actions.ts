/**
 * Economy action dispatcher — the brain behind the one economy command
 * endpoint.
 *
 * Spec: docs/superpowers/specs/2026-09-22-faz3a-ekonomi-sunucuya-tasarim.md
 *
 * `runAction` never trusts `teamKey` from the request: the route handler
 * resolves it from the player's own `lobby_seats` row before calling in
 * here, and this module only ever acts on that resolved value. Every
 * successful branch ends by calling `buildSlotState` and handing back the
 * WHOLE slot, never a fragment — see `state.ts`'s docblock for why that
 * shape is the point of this API.
 *
 * Every failure is reported as a short, fixed `code` from a closed union —
 * never as a message built from the request body. An `Error` thrown here
 * would be logged verbatim by the router (see `http/router.ts`), and this
 * dispatcher's inputs carry user ids and game commands that must not end up
 * in a log line.
 */
import { startJob, claimJob, skipJob } from './jobs.ts';
import { loadTeamEconomy, spendRp, addRp, setFactoryLevel } from './repo.ts';
import { spendGold, bumpGoldConverted } from '../gold/repo.ts';
import { buildSlotState, SlotStateError, type SlotState } from './state.ts';
import { withTransaction } from '../db/pool.ts';
import { departmentCost, factoryDepartments, DEPARTMENT_MAX_LEVEL } from '@pitwall/shared/factory';
import { GOLD_TO_RP, GOLD_TO_RP_DAILY_CAP } from '@pitwall/shared/economy';

export type ActionFailureCode =
  | 'unknown_action'
  | 'bad_payload'
  | 'not_ready'
  | 'already_claimed'
  | 'already_running'
  | 'not_enough_rp'
  | 'not_enough_gold'
  | 'no_user'
  | 'not_found'
  | 'cap_reached'
  | 'no_economy';

export type RunActionResult =
  | { ok: true; state: SlotState }
  | { ok: false; code: ActionFailureCode };

export interface RunActionInput {
  lobbyId: string;
  /** The account issuing the command — from the verified session, never the body. */
  userId: string;
  /** The team to act on — from the player's seat row, never the body. See module docblock. */
  teamKey: string;
  body: Record<string, unknown>;
  now: Date;
}

const KNOWN_DEPARTMENT_CODES = new Set(factoryDepartments.map((d) => d.code));

function fail(code: ActionFailureCode): RunActionResult {
  return { ok: false, code };
}

/** Runs `buildSlotState` and turns a missing economy row into a clean failure code. */
async function finish(lobbyId: string, teamKey: string, userId: string, now: Date): Promise<RunActionResult> {
  try {
    const state = await buildSlotState({ lobbyId, teamKey, userId, now });
    return { ok: true, state };
  } catch (err) {
    if (err instanceof SlotStateError) return fail('no_economy');
    throw err;
  }
}

/** A job id must be a non-empty string; anything else is a malformed request, not a crash. */
function readJobId(body: Record<string, unknown>): string | null {
  const jobId = body['jobId'];
  return typeof jobId === 'string' && jobId.length > 0 ? jobId : null;
}

export async function runAction(input: RunActionInput): Promise<RunActionResult> {
  const { lobbyId, userId, teamKey, body, now } = input;
  const type = body['type'];

  switch (type) {
    case 'startUpgrade': {
      // The client's field is called `label` (the stat it names — motor,
      // aero, grip); `jobs.ts` validates the actual value and turns an
      // unknown one into `bad_payload` on its own.
      const label = body['label'];
      if (typeof label !== 'string' || label.length === 0) return fail('bad_payload');
      const started = await startJob({ lobbyId, teamKey, kind: 'upgrade', payload: { stat: label }, now });
      if (!started.ok) return fail(started.reason);
      return finish(lobbyId, teamKey, userId, now);
    }

    case 'startTraining': {
      const driverIdx = body['driverIdx'];
      if (typeof driverIdx !== 'number') return fail('bad_payload');
      const started = await startJob({ lobbyId, teamKey, kind: 'training', payload: { driverIdx }, now });
      if (!started.ok) return fail(started.reason);
      return finish(lobbyId, teamKey, userId, now);
    }

    case 'startSpyMission': {
      // Whatever the client sent beyond the routing fields becomes the job
      // payload as-is; `jobs.ts` stores it verbatim for `spy` jobs.
      const { type: _type, lobbyId: _lobbyId, teamKey: _teamKey, ...payload } = body;
      const started = await startJob({ lobbyId, teamKey, kind: 'spy', payload, now });
      if (!started.ok) return fail(started.reason);
      return finish(lobbyId, teamKey, userId, now);
    }

    case 'claimUpgrade':
    case 'claimTraining':
    case 'claimSpyReport': {
      const jobId = readJobId(body);
      if (!jobId) return fail('bad_payload');
      const claimed = await claimJob({ lobbyId, teamKey, jobId, now });
      if (!claimed.ok) return fail(claimed.reason);
      return finish(lobbyId, teamKey, userId, now);
    }

    case 'skipUpgrade':
    case 'skipTraining':
    case 'skipSpy': {
      const jobId = readJobId(body);
      if (!jobId) return fail('bad_payload');
      const skipped = await skipJob({ lobbyId, teamKey, jobId, userId, now });
      if (!skipped.ok) return fail(skipped.reason);
      return finish(lobbyId, teamKey, userId, now);
    }

    case 'upgradeFactory': {
      const code = body['code'];
      if (typeof code !== 'string' || !KNOWN_DEPARTMENT_CODES.has(code)) return fail('bad_payload');

      const economy = await loadTeamEconomy(lobbyId, teamKey);
      if (!economy) return fail('no_economy');

      const currentLevel = economy.factoryLevels[code] ?? 0;
      if (currentLevel >= DEPARTMENT_MAX_LEVEL) return fail('cap_reached');

      const cost = departmentCost(currentLevel);
      // Spend and raise-the-level live in ONE transaction: a failed spend
      // must never leave the department bumped, and a bumped level must
      // never happen without the RP actually having left the team.
      const spent = await withTransaction(async (client) => {
        const charged = await spendRp(client, lobbyId, teamKey, cost);
        if (!charged) return false;
        await setFactoryLevel(client, lobbyId, teamKey, code, currentLevel + 1);
        return true;
      });
      if (!spent) return fail('not_enough_rp');
      return finish(lobbyId, teamKey, userId, now);
    }

    case 'convertGoldToRp': {
      const gold = body['gold'];
      if (!Number.isInteger(gold) || (gold as number) <= 0) return fail('bad_payload');
      const amount = gold as number;

      // All three writes — spend gold, credit RP, bump the day's cap
      // counter — now live in ONE transaction via `bumpGoldConverted`'s
      // client-accepting form (gold/repo.ts). A crash or thrown error
      // partway through rolls all three back together, closing the gap a
      // split version of this had: measured before the fix, a converted
      // amount of 5 with the writes split left gold at 95 (100 - 5) but RP
      // at 0 — paid and received nothing.
      //
      // The cap check is done the same way `grantGoldForAd` enforces
      // `ads_watched`: a conditional upsert whose `WHERE` clause makes the
      // cap the write's own precondition, not a fact read beforehand via
      // `capsFor`. That closes the check-then-act race this call used to
      // have (read the cap, then write, with no lock in between letting two
      // concurrent conversions both read "under cap").
      // `withTransaction` commits whatever the callback RETURNS — only a
      // throw rolls back (see its docblock in db/pool.ts). `spendGold`
      // already mutates `users.gold` before the cap check runs, so once it
      // has succeeded, reporting `cap_reached` by returning (rather than
      // throwing) would commit that spend with nothing to show for it —
      // exactly the bug this whole fix exists to close. So the cap-reached
      // path throws a sentinel, mirroring `grantGoldForAd`'s `CapReached`.
      class CapReached extends Error {}
      let result: 'not_enough_gold' | 'ok';
      try {
        result = await withTransaction(async (client) => {
          const chargedGold = await spendGold(client, userId, amount);
          if (!chargedGold) return 'not_enough_gold' as const;
          const capOk = await bumpGoldConverted(userId, now, amount, client, GOLD_TO_RP_DAILY_CAP);
          if (!capOk) throw new CapReached();
          await addRp(client, lobbyId, teamKey, amount * GOLD_TO_RP);
          return 'ok' as const;
        });
      } catch (err) {
        if (err instanceof CapReached) return fail('cap_reached');
        throw err;
      }
      if (result !== 'ok') return fail(result);

      return finish(lobbyId, teamKey, userId, now);
    }

    default:
      return fail('unknown_action');
  }
}
