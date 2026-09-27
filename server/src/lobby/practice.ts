/**
 * Pratik (FP1/FP2/FP3) — hafta sonunun `open` fazında saatine göre çalışan,
 * herkesin AYNI seansı gördüğü zamanlanmış oturumlar.
 *
 * NEDEN BÖYLE: pratik istemci tarafında (mobile) her oyuncunun kendi isteğiyle
 * çalıştırdığı bir özellikti; sunucu bunu `@pitwall/shared`in saf görünüm
 * ilkesine taşırken kazara SİLİNDİ. Kullanıcının onayladığı geri getiriş
 * biçimi bambaşka: bir lobinin bütün takımları için TEK bir FP1, TEK bir FP2,
 * TEK bir FP3 vardır ve her biri, ışıklar sönerken yapılanın küçük bir kopyası
 * gibi, o anın katılımını DONDURUR. Reddedilen alternatif — oyuncunun istediği
 * an çalıştırdığı bir pratik — reddedildi çünkü diğer takımların o anki
 * setup'ı oyuncuya HİÇ görünmez; herkes aynı klasmanı görsün istiyorsak
 * klasman herkes için AYNI anda, AYNI katılımdan kurulmalı.
 *
 * NEDEN DURUM DEĞİL TARİF: `004_race.sql`in ilkesinin küçük ölçekli
 * karşılığı. Bir seansın SONUCU saklanmaz; yalnızca onu üretecek TARİF
 * saklanır (tohum + o anda dondurulmuş katılım + seans numarası). Motor saf
 * ve tohumlu olduğu için (`simulatePractice`) aynı tarif her zaman aynı
 * klasmanı verir — sonuç `derivePracticeResult` ile İSTEK ANINDA türetilir.
 *
 * NEDEN KATILIM `buildFrozenEntries` İLE PAYLAŞILIYOR:
 * Pratik yarışın kullandığı ARAÇLA aynı araca bakmalı (aksi halde pratik
 * sıralaması "bu pistte nerede duruyorum" sorusuna YANLIŞ cevap verir).
 * `runner.ts`teki `buildFrozenEntries`, `startRaceFor`in ışıklar sönerken
 * kullandığı AYNI donma biçimidir; burada TEKRAR YAZILMAZ, ithal edilir
 * (server/README.md'nin "shared'in kuralları asla tekrar yazılmaz" ilkesinin
 * server-içi karşılığı).
 *
 * NEDEN TEK SEFER DONMA GARANTİSİ SQL'İN KENDİSİNDE:
 * İki süreç aynı anda aynı seansı dondurmaya çalışabilir (kira YOK burada —
 * yarışın aksine pratik seansı "kim sürüyor" sorusuna ihtiyaç duymaz, yalnızca
 * "donmuş mu değil mi" sorusuna). Koruma önce `select` edip sonra `insert`
 * etmek DEĞİL — `practice_runs_pk`e çarpan bir `insert ... on conflict do
 * nothing` DEĞİŞMEZDİR: kazanan `RETURNING` satırını görür, kaybeden hiçbir
 * satır görmez ve HİÇBİR HATA fırlamaz. `lease.ts`/`phase.ts`teki "koruma
 * UPDATE'in kendi where'inde" ilkesinin `insert` karşılığı budur.
 *
 * `now` HER ZAMAN çağırandan gelir; bu modül saati asla kendisi okumaz
 * (server/README.md §"now sadece route'ta örneklenir").
 */
import { trackForRound } from '@pitwall/shared/tracks';
import {
  simulatePractice,
  weatherFor,
  type AiBonus,
  type Entries,
  type PracticeResult,
  type Rosters,
} from '@pitwall/shared/raceEngine';
import { query } from '../db/pool.ts';
import { buildFrozenEntries, deriveSeed } from './runner.ts';

/** FP1: ışıklardan (T) 18 saat önce. */
export const FP1_OFFSET_MS = 18 * 60 * 60 * 1000;
/** FP2: T'den 12 saat önce. */
export const FP2_OFFSET_MS = 12 * 60 * 60 * 1000;
/** FP3: T'den 6 saat önce. */
export const FP3_OFFSET_MS = 6 * 60 * 60 * 1000;
/** Sprint hafta sonu TEK pratik seansı: T'den 12 saat önce. */
export const SPRINT_PRACTICE_OFFSET_MS = 12 * 60 * 60 * 1000;

/** Bir hafta sonunun pratik seanslarının, ışıklardan ÖNCEKİ ofsetleri, sırayla. */
export function practiceOffsetsMs(sprint: boolean): readonly number[] {
  return sprint ? [SPRINT_PRACTICE_OFFSET_MS] : [FP1_OFFSET_MS, FP2_OFFSET_MS, FP3_OFFSET_MS];
}

/** Bir hafta sonunda kaç pratik seansı var — sprint'te 1, normalde 3. */
export function practiceCount(sprint: boolean): number {
  return practiceOffsetsMs(sprint).length;
}

/** En büyük ofset — "hangi lobiler pratige yaklaşıyor" taramasının eşiği. */
const MAX_PRACTICE_OFFSET_MS = Math.max(...practiceOffsetsMs(false), ...practiceOffsetsMs(true));

export interface PracticeRun {
  lobbyId: string;
  seasonNo: number;
  roundNo: number;
  sessionNo: 1 | 2 | 3;
  seed: number;
  wet: boolean;
  entries: Entries;
}

interface PracticeRunRow {
  lobby_id: string;
  season_no: number;
  round_no: number;
  session_no: number;
  seed: number;
  wet: boolean;
  entries_snapshot: Entries;
}

function mapRow(row: PracticeRunRow): PracticeRun {
  return {
    lobbyId: row.lobby_id,
    seasonNo: row.season_no,
    roundNo: row.round_no,
    sessionNo: row.session_no as 1 | 2 | 3,
    seed: row.seed,
    wet: row.wet,
    entries: row.entries_snapshot,
  };
}

/** Donmuş bir pratik seansını okur; henüz donmamışsa `null`. */
export async function loadPracticeRun(
  lobbyId: string, seasonNo: number, roundNo: number, sessionNo: 1 | 2 | 3,
): Promise<PracticeRun | null> {
  const res = await query<PracticeRunRow>(
    `select lobby_id, season_no, round_no, session_no, seed, wet, entries_snapshot
       from practice_runs
      where lobby_id = $1 and season_no = $2 and round_no = $3 and session_no = $4`,
    [lobbyId, seasonNo, roundNo, sessionNo],
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

/** Bir lobinin donmuş her pratik seansı, seans numarasına göre sıralı. */
export async function loadPracticeRuns(
  lobbyId: string, seasonNo: number, roundNo: number,
): Promise<PracticeRun[]> {
  const res = await query<PracticeRunRow>(
    `select lobby_id, season_no, round_no, session_no, seed, wet, entries_snapshot
       from practice_runs
      where lobby_id = $1 and season_no = $2 and round_no = $3
      order by session_no asc`,
    [lobbyId, seasonNo, roundNo],
  );
  return res.rows.map(mapRow);
}

/**
 * Donmuş bir tarifi klasmana çevirir. SAF: veritabanı yok, saat yok — aynı
 * tarif her zaman aynı sonucu verir (Adım 5(a)'nın kanıtladığı şey tam bu).
 *
 * `aiBonus`/`rosters` `startRaceFor`daki gerekçeyle aynı sebepten boş: bu
 * kaynaklar henüz sunucuda saklanmıyor, boş bırakmak motorun varsayılanıyla
 * aynı sonucu verir.
 */
export function derivePracticeResult(run: PracticeRun): PracticeResult {
  const track = trackForRound(run.roundNo);
  const aiBonus: AiBonus = {};
  const rosters: Rosters = {};
  return simulatePractice({
    track,
    entries: run.entries,
    aiBonus,
    rosters,
    wet: run.wet,
    session: run.sessionNo,
    round: run.roundNo,
    seed: run.seed,
  });
}

interface OpenLobbyRow {
  id: string;
  season_no: number;
  round_no: number;
  next_race_at: Date;
}

/**
 * Bir seansı dondurur. Zaten donmuşsa (bu çağrı ya da eşzamanlı bir çağrı
 * tarafından) sessizce `false` döner — bu NORMAL bir durumdur, hata değil.
 * TEK dışlama kaynağı `insert ... on conflict do nothing`in kendisi: burada
 * önceden bir `select` YOKTUR — iki eşzamanlı çağrı da bu fonksiyona girer,
 * ikisi de `buildFrozenEntries`i çalıştırır, ama yalnızca BİRİ `insert`i
 * kazanır (`practice_runs_pk`e çarpan `on conflict` diğerini sessizce elemiş
 * olur). `freezeDuePracticeSessions` performans için önce ucuz bir okuma
 * yapar (bkz. onun docblock'u); bu fonksiyonun KENDİSİ o kısayola güvenmez —
 * doğrudan çağrılması da (testlerde olduğu gibi) güvenli.
 */
export async function freezePracticeSession(
  lobbyId: string, seasonNo: number, roundNo: number, sessionNo: 1 | 2 | 3, now: Date,
  // Yalnızca testler içindir: gerçek dışlamayı SAĞLAMAZ (o `insert ... on
  // conflict`in kendisinde), yalnızca eşzamanlı çağıranların kaçının bu
  // çekişmeli yazmaya GERÇEKTEN ulaştığını gözlemlemek için bir kanca.
  onBeforeInsert?: () => void,
): Promise<boolean> {
  const seed = deriveSeed(lobbyId, seasonNo, roundNo);
  const track = trackForRound(roundNo);
  const wet = weatherFor(track, seed).wetAtStart;
  // `now`: seans "başladığı an" ne kadar gerçekse okuma o kadar gerçek —
  // ışıklar sönerken `startRaceFor`in kendi `now`ı ne kadar hassassa
  // (süpürme döngüsünün tik aralığı kadar), pratik seansının donması da
  // AYNI hassasiyettedir; ikinci bir zaman kaynağı icat edilmedi.
  const { entries } = await buildFrozenEntries(lobbyId, now);

  onBeforeInsert?.();
  const res = await query<{ session_no: number }>(
    `insert into practice_runs (lobby_id, season_no, round_no, session_no, seed, wet, entries_snapshot)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (lobby_id, season_no, round_no, session_no) do nothing
     returning session_no`,
    [lobbyId, seasonNo, roundNo, sessionNo, seed, wet, JSON.stringify(entries)],
  );
  return res.rowCount === 1;
}

export interface PracticeSweepResult {
  /** Bu çağrının GERÇEKTEN dondurduğu seans sayısı (başkasının önceden
   *  dondurduğu ya da henüz vakti gelmemiş seanslar sayılmaz). */
  frozen: number;
}

/**
 * `open` fazındaki her lobi için, vakti gelmiş ve henüz donmamış pratik
 * seanslarını dondurur.
 *
 * NEDEN YALNIZCA `open`: görev brifinin şartı — pratik yalnızca `open`
 * fazında koşar. `checkin`/`live`/`result` bir lobinin artık kendi pratik
 * penceresinin dışında olduğu anlamına gelir; bu sorgunun `where phase =
 * 'open'` koşulu bunu YAPISAL olarak garanti eder, ayrı bir kontrol gerekmez.
 *
 * NEDEN KİRA YOK: `race_runs`in aksine bir pratik seansını "kim sürüyor"
 * diye bir soru yok — donma tek bir yazma, süren bir tur döngüsü değil.
 * Tek başına atomik `insert ... on conflict do nothing` yeterli dışlama.
 */
export async function freezeDuePracticeSessions(now: Date): Promise<PracticeSweepResult> {
  const threshold = new Date(now.getTime() + MAX_PRACTICE_OFFSET_MS);
  const res = await query<OpenLobbyRow>(
    `select id, season_no, round_no, next_race_at
       from lobbies
      where phase = 'open' and next_race_at <= $1`,
    [threshold],
  );

  let frozen = 0;
  for (const row of res.rows) {
    const track = trackForRound(row.round_no);
    const offsets = practiceOffsetsMs(track.sprint);
    for (let i = 0; i < offsets.length; i += 1) {
      const sessionNo = (i + 1) as 1 | 2 | 3;
      const scheduledAt = row.next_race_at.getTime() - offsets[i];
      if (scheduledAt > now.getTime()) continue;
      // Ucuz bir ön-okuma: gerçek koruma yukarıdaki `insert`in kendisinde,
      // bu yalnızca zaten donmuş bir seans için `buildFrozenEntries`in
      // (birkaç DB okuması) gereksiz yere çalışmasını önleyen bir kısayol —
      // check-then-act BURADA GÜVENLİK DEĞİL, yalnızca performans: iki süreç
      // bu okumayı aynı anda "boş" görüp ikisi de `freezeOne`e girse bile,
      // asıl karar `insert ... on conflict do nothing`de verilir.
      const already = await loadPracticeRun(row.id, row.season_no, row.round_no, sessionNo);
      if (already) continue;
      const ok = await freezePracticeSession(row.id, row.season_no, row.round_no, sessionNo, now);
      if (ok) frozen += 1;
    }
  }
  return { frozen };
}
