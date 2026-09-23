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
 * nothing` bu pencereyi tamamen kapatır: kararı veritabanı verir.
 *
 * Aynı gerekçe "bu tur koştu mu" sorusu için de geçerli ve 005'ten beri aynı
 * biçimde çözülüyor: `appendDecision` koşu satırını kilitleyip `last_lap`e
 * kendi `where`inde bakar. Bkz. o fonksiyonun docblock'u.
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
  /**
   * Şimdiye kadar simüle edilmiş EN YÜKSEK tur (005_race_progress.sql).
   * Tarifin parçası DEĞİL — tarifin nereye kadar tüketildiğini gösteren imleç.
   * `replayRace`e girmez; yeniden oynatma hâlâ yalnızca tohum + snapshot +
   * günlükten çıkar.
   */
  lastLap: number;
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
  last_lap: number;
}

/** Tarifi okur. `seed` `integer` olduğu için JS'e `number` olarak döner. */
export async function loadRun(lobbyId: string, seasonNo: number, roundNo: number): Promise<RaceRun | null> {
  const res = await query<RunRow>(
    `select seed, snapshot, started_at, finished_at, last_lap
     from race_runs
     where lobby_id = $1 and season_no = $2 and round_no = $3`,
    [lobbyId, seasonNo, roundNo],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    seed: row.seed,
    snapshot: row.snapshot,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    lastLap: row.last_lap,
  };
}

/**
 * "Bu tura kadar koştuk" damgası. Turu simüle etmeden ÖNCE çağrılır.
 *
 * SADECE İLERİ: `where last_lap < $4` bir SINIRLAMA değil, kapının kendisidir.
 * Damga geri düşebilseydi (gecikmiş bir tik, yeniden açılan bir koşu, saati
 * geri giden bir süreç), koşulmuş bir tura karar yazma kapısı yeniden AÇILIRDI
 * — `appendDecision` tam da bu sütuna bakıyor. Bu yüzden monotonluk yazmanın
 * kendi `where`inde; önce okuyup karşılaştırmak kontrol-sonra-davran yarışıdır
 * (server/README.md §"koru YAZMANIN KENDİ `where`'inde olsun").
 *
 * Aynı satırı `appendDecision` da `for update` ile kilitler: buradaki UPDATE
 * taahhüt edilene kadar o kapı BEKLER, sonra yeni `last_lap` ile yeniden
 * değerlendirilir. Yapısal garanti oradan gelir, buradaki sıralamadan değil.
 *
 * `false`: damga zaten bu turda ya da ilerideydi — çağıran için normaldir.
 */
export async function advanceLastLap(
  client: PoolClient, key: RaceRunKey, lap: number,
): Promise<boolean> {
  const res = await client.query(
    `update race_runs set last_lap = $4
      where lobby_id = $1 and season_no = $2 and round_no = $3 and last_lap < $4`,
    [key.lobbyId, key.seasonNo, key.roundNo, lap],
  );
  return (res.rowCount ?? 0) > 0;
}

export interface AppendDecisionInput extends RaceRunKey, DecisionLogEntry {
  now: Date;
}

/**
 * `appendDecision`ın ayırt ettiği dört son. Çağıranın üçünü de ayrı ayrı
 * bilmesi gerekir: ikisi oyuncuya farklı şey söyler, biri hiç olmamalıdır.
 *  - `written`         : karar günlüğe girdi ve onu tüketecek tur HENÜZ KOŞMADI.
 *  - `already_decided` : aynı araç+tur için zaten karar vardı (ilk karar geçerli).
 *  - `lap_already_run` : o tur simüle edilmiş; yazmak iki farklı yarış demekti.
 *  - `no_run`          : bu (lobi, sezon, tur) için tarif yok — ışıklar sönmedi
 *                        ya da koşu silindi. FK zaten reddederdi; sessiz bir
 *                        500 yerine dürüst bir son.
 */
export type AppendDecisionResult = 'written' | 'already_decided' | 'lap_already_run' | 'no_run';

/**
 * Bir pit kararını günlüğe ekler — turu koşmamışsa.
 *
 * ── YAPISAL GARANTİ ──────────────────────────────────────────────────────
 * Bu fazın değiştirilemeyen kuralı: bir karar, onu TÜKETEN tur simüle
 * edilmeden ÖNCE kalıcı olmalı. Kural eskiden SAATE dayanıyordu — uç nokta
 * `(now - started_at) / RACE_TICK_MS` hesaplar, tik döngüsü aynı formülü ayrı
 * hesaplardı. İkisi arasında kilit yoktu: tik günlüğü okuduktan SONRA ama N.
 * turu simüle etmeden ÖNCE yazılan bir karar saatin kapısından geçer, canlı
 * yarışça görülmez, sonraki yeniden oynatmaca uygulanır. İki farklı yarış.
 *
 * Kapı artık `race_runs.last_lap`e bakıyor ve YAZMANIN KENDİ `where`inde:
 *  1. `run` CTE'si koşu satırını `for update` ile KİLİTLER. Tik döngüsü aynı
 *     satırı damgalarken (`advanceLastLap`) burası BEKLER.
 *  2. Kilit çözüldüğünde Postgres (READ COMMITTED) satırı yeniden okur, yani
 *     `run.last_lap` damganın TAAHHÜT EDİLMİŞ değeridir.
 *  3. `insert ... select ... where run.last_lap < $lap`: tur koşmuşsa hiç satır
 *     üretilmez, yani hiç yazma olmaz.
 * Bu yüzden "kabul edilen karar mutlaka görülür" bir zamanlama olasılığı değil,
 * satır kilidinin sonucudur. Önce `select last_lap` edip sonra yazmak tam
 * olarak kapatmaya çalıştığımız kontrol-sonra-davran yarışı olurdu.
 *
 * Tek `select` iki sonucu birlikte döndürür (yazıldı mı + otoriter `last_lap`)
 * ki çağıran `already_decided` ile `lap_already_run`ı ayırt etmek için İKİNCİ
 * bir sorgu atmak zorunda kalmasın — o sorgu yeni bir pencere açardı.
 *
 * Bileşik kısıtı ihlali (23514) kasıtla yakalanmaz; yukarıya fırlar.
 */
export async function appendDecision(
  client: PoolClient, input: AppendDecisionInput,
): Promise<AppendDecisionResult> {
  const res = await client.query<{ written: number; last_lap: number | null }>(
    `with run as (
       select last_lap from race_runs
        where lobby_id = $1 and season_no = $2 and round_no = $3
        for update
     ), ins as (
       insert into race_decisions
         (lobby_id, season_no, round_no, lap, team_key, driver_idx, compound, created_at)
       select $1::uuid, $2::integer, $3::integer, $4::integer,
              $5::text, $6::integer, $7::text, $8::timestamptz
         from run
        where run.last_lap < $4::integer
       on conflict (lobby_id, season_no, round_no, lap, team_key, driver_idx) do nothing
       returning 1
     )
     select (select count(*) from ins)::integer as written,
            (select last_lap from run)          as last_lap`,
    [
      input.lobbyId, input.seasonNo, input.roundNo,
      input.lap, input.teamKey, input.driverIdx, input.compound, input.now,
    ],
  );
  const row = res.rows[0];
  if (row.written > 0) return 'written';
  // Koşu satırı hiç yoksa `run` boştur ve skaler alt sorgu `null` döner.
  if (row.last_lap === null) return 'no_run';
  // Kapı kapalıysa yazma hiç denenmedi; açıksa `on conflict` yuttu demektir.
  return row.last_lap >= input.lap ? 'lap_already_run' : 'already_decided';
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
