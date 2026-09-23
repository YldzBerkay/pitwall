/**
 * Yarış TARİFİNİN deposu — `race_runs`, `race_decisions`, `race_settlements`.
 *
 * Yarış durumu saklanmaz; onu yeniden üreten tarif saklanır (004_race.sql).
 * Bu modül `replay.ts` ile şema arasındaki tek geçittir ve bilerek ince
 * tutulmuştur: okuduğu satırları doğrudan `RaceSnapshot` / `DecisionLogEntry`
 * şeklinde verir, böylece iki taraf arasında çeviri katmanı gerekmez.
 *
 * NEDEN "İLK KARAR GEÇERLİ":
 * Yeniden oynatmanın bit düzeyinde aynı olması karar günlüğünün DEĞİŞMEZ
 * olmasına bağlı. Aynı (tur, takım, sürücü) için ikinci bir karar kabul
 * edilseydi, günlüğü daha önce okuyup yarışı oynatmış bir istemci ile sonra
 * okuyan bir başkası FARKLI yarış görürdü — tasarımın tek şartı ("herkes aynı
 * yarışı görür") tam da orada kırılırdı. Bu yüzden ilk yazan kazanır ve
 * `race_decisions_pk` ikinciyi reddeder.
 *
 * NEDEN KORUMA OKUMADA DEĞİL YAZMADA:
 * "Önce `select` et, yoksa `insert` et" biçimi kontrol-sonra-davran yarışıdır:
 * iki eşzamanlı çağıran da "satır yok" görür, ikisi de ilerler ve biri
 * yakalanmamış bir 23505 ile patlar (ya da daha kötüsü, iki karar da
 * yazılabilseydi günlük çatallanırdı). Tek atomik `insert ... on conflict do
 * nothing` bu pencereyi tamamen kapatır: kararı veritabanı verir, `rowCount`
 * da sonucu bildirir.
 *
 * YANLIŞ BİLEŞİK BİR HATADIR, YARIŞ DEĞİL:
 * `false` "başkası önce yazdı" demektir ve normaldir. Küçük harfli `'soft'`
 * gibi bir bileşik ise çağıranın hatasıdır (23514) ve `false`a katlanırsa
 * sessizce kaybolur — günlük değişmez olduğu için o kararı sonradan düzeltmek
 * de mümkün değildir. Bu yüzden kontrol kısıtı ihlali yukarı FIRLAR.
 *
 * `now` asla buradan okunmaz; her zaman çağıran verir (server/README.md §225).
 */
import type { PoolClient } from 'pg';
import { query } from '../db/pool.ts';
import type { DecisionLogEntry, RaceSnapshot } from './replay.ts';

/** Bir yarışı tek olarak adlandıran üçlü. */
export interface RaceRunKey {
  lobbyId: string;
  seasonNo: number;
  roundNo: number;
}

/** Saklanan tarif. `replay.ts`in `ReplayInput`una doğrudan beslenir. */
export interface RaceRun {
  seed: number;
  snapshot: RaceSnapshot;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface StartRunInput extends RaceRunKey {
  seed: number;
  snapshot: RaceSnapshot;
  now: Date;
}

/**
 * Işıklar sönerken tarifi bir kez yazar.
 *
 * İkinci bir çağrı FIRLAR (`race_runs_pk`), `false` dönmez: bir turun iki kez
 * başlaması `appendDecision`ın yarıştığı gibi beklenen bir durum değil,
 * koşucunun kiralama mantığında bir hatadır ve görünmesi gerekir.
 */
export async function startRun(client: PoolClient, input: StartRunInput): Promise<void> {
  await client.query(
    `insert into race_runs (lobby_id, season_no, round_no, seed, snapshot, started_at)
     values ($1, $2, $3, $4, $5::jsonb, $6)`,
    [input.lobbyId, input.seasonNo, input.roundNo, input.seed, JSON.stringify(input.snapshot), input.now],
  );
}

interface RunRow {
  seed: number;
  snapshot: RaceSnapshot;
  started_at: Date;
  finished_at: Date | null;
}

/** Tarifi okur. `seed` `integer` olduğu için JS'e `number` olarak döner. */
export async function loadRun(lobbyId: string, seasonNo: number, roundNo: number): Promise<RaceRun | null> {
  const res = await query<RunRow>(
    `select seed, snapshot, started_at, finished_at
     from race_runs
     where lobby_id = $1 and season_no = $2 and round_no = $3`,
    [lobbyId, seasonNo, roundNo],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { seed: row.seed, snapshot: row.snapshot, startedAt: row.started_at, finishedAt: row.finished_at };
}

export interface AppendDecisionInput extends RaceRunKey, DecisionLogEntry {
  now: Date;
}

/**
 * Bir pit kararını günlüğe ekler. `true`: bu karar geçerli oldu.
 * `false`: aynı araç+tur için zaten bir karar vardı (ilk karar geçerli).
 *
 * Çatışma tek bir atomik yazmayla saptanır — önce okuyup sonra yazmak yarışır.
 * Bileşik kısıtı ihlali (23514) kasıtla yakalanmaz; yukarıya fırlar.
 */
export async function appendDecision(client: PoolClient, input: AppendDecisionInput): Promise<boolean> {
  const res = await client.query(
    `insert into race_decisions
       (lobby_id, season_no, round_no, lap, team_key, driver_idx, compound, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (lobby_id, season_no, round_no, lap, team_key, driver_idx) do nothing`,
    [
      input.lobbyId, input.seasonNo, input.roundNo,
      input.lap, input.teamKey, input.driverIdx, input.compound, input.now,
    ],
  );
  return (res.rowCount ?? 0) > 0;
}

interface DecisionRow {
  lap: number;
  team_key: string;
  driver_idx: 0 | 1;
  compound: DecisionLogEntry['compound'];
}

/**
 * Günlüğü tura göre sıralı okur.
 *
 * `replayRace` kararları zaten tura göre gruplayabiliyor, ama sıralamayı
 * burada garantilemek günlüğü insan gözüyle okunabilir ve kısmi oynatmalarda
 * (`uptoLap`) kesilebilir kılar. Aynı tur içinde araç anahtarına göre kırıyoruz
 * ki çıktı yazma sırasından bağımsız, belirli olsun.
 */
export async function loadDecisions(
  lobbyId: string, seasonNo: number, roundNo: number,
): Promise<DecisionLogEntry[]> {
  const res = await query<DecisionRow>(
    `select lap, team_key, driver_idx, compound
     from race_decisions
     where lobby_id = $1 and season_no = $2 and round_no = $3
     order by lap, team_key, driver_idx`,
    [lobbyId, seasonNo, roundNo],
  );
  return res.rows.map((r) => ({
    lap: r.lap,
    teamKey: r.team_key,
    driverIdx: r.driver_idx,
    compound: r.compound,
  }));
}

/**
 * Bayrakta koşuyu damgalar. `seed`/`snapshot`a dokunmaz — `race_runs_immutable`
 * tetikleyicisi zaten dokunmayı reddeder; `finished_at` güncellenebilir kalır.
 */
export async function finishRun(
  client: PoolClient, lobbyId: string, seasonNo: number, roundNo: number, finishedAt: Date,
): Promise<void> {
  await client.query(
    `update race_runs set finished_at = $4
     where lobby_id = $1 and season_no = $2 and round_no = $3`,
    [lobbyId, seasonNo, roundNo, finishedAt],
  );
}

/**
 * Ödemenin yapıldığını işaretler. `true`: bu çağıran ödemeyi üstlendi.
 * `false`: başka biri (ya da çökmeden önceki bu süreç) zaten ödedi.
 *
 * Yeniden oynatmanın zorunlu tamamlayıcısı: çöken bir sunucu aynı yarışı
 * yeniden oynatıp bitirebilir, ama Altın/RP iki kez yazılmamalıdır. Çağıran
 * bunu ödeme yazmalarıyla AYNI işlem içinde kullanmalı — bu yüzden `client`
 * alır: `false` dönerse işlem geri alınır ve hiçbir şey ödenmez.
 */
export async function markSettled(
  client: PoolClient, lobbyId: string, seasonNo: number, roundNo: number, settledAt: Date,
): Promise<boolean> {
  const res = await client.query(
    `insert into race_settlements (lobby_id, season_no, round_no, settled_at)
     values ($1, $2, $3, $4)
     on conflict (lobby_id, season_no, round_no) do nothing`,
    [lobbyId, seasonNo, roundNo, settledAt],
  );
  return (res.rowCount ?? 0) > 0;
}
