/**
 * Lobi yarışının SAF yeniden oynatması.
 *
 * NEDEN bit düzeyinde aynı olmak zorunda:
 *
 * Yarış durumunu saklamıyoruz; onu üreten TARİFİ saklıyoruz — tohum, ışıklar
 * söndüğünde dondurulan katılımlar (`RaceSnapshot`) ve her pit kararının hangi
 * turda verildiğini yazan karar günlüğü. Yarış motoru deterministik:
 * `advanceLap` rastgeleliğini `(seed, round, lap)` üçlüsünden çekiyor, taşınan
 * değişken bir durumdan değil. Bu yüzden tarifi yeniden oynatmak birebir aynı
 * yarışı verir.
 *
 * Üç şey buna dayanıyor:
 *  1. Kullanıcının şartı: herkes AYNI yarışı görmeli — kimse farklı bir sonuç
 *     görmemeli. Tarif tek olduğu sürece yarış da tektir.
 *  2. Geç katılan istemci: 40. turda bağlanan bir oyuncuya, o ana kadarki
 *     gerçek durum yeniden oynatılarak gösterilir.
 *  3. Çöken sunucu: yarışın ortasında yeniden başlayan süreç, karar
 *     günlüğünden aynı yere geri döner.
 *
 * Bu modül SAFtır: veritabanı yok, saat yok, `Math.random()` yok. Çağıran her
 * şeyi verir.
 *
 * TUR SÖZLEŞMESİ (Görev 8 — pit uç noktası — aynısını yazmak zorunda):
 *   `lap: N` olan bir karar, N. turu simüle eden `advanceLap` çağrısına
 *   verilir; yani `state.lap === N - 1` iken yapılan çağrıya. Başka bir
 *   deyişle N, kararın ETKİ ETTİĞİ tur — sürücünün N. turda pite girdiği tur.
 *   Dolayısıyla canlı yarışta `state.lap === L` iken alınan bir pit çağrısı
 *   `lap: L + 1` olarak yazılır: koşulacak ilk tur odur.
 *   `uptoLap: L` ile oynatma, `lap <= L` olan kararları uygular; daha
 *   ilerideki kararlar görmezden gelinir.
 */
import {
  advanceLap,
  simulateQualifying,
  startRace,
  weatherFor,
  type AiBonus,
  type Decisions,
  type Entries,
  type QualiRisk,
  type RaceState,
  type Rosters,
} from '@pitwall/shared/raceEngine';
import { trackForRound } from '@pitwall/shared/tracks';
import type { CompoundKey } from '@pitwall/shared/carCustomisation';
import type { TeamStanding } from '@pitwall/shared/teams';

/** Işıklar söndüğünde dondurulan her şey. Yarış boyunca değişmez. */
export interface RaceSnapshot {
  entries: Entries;
  risks: Record<string, QualiRisk>;
  standings: TeamStanding[];
  aiBonus: AiBonus;
  rosters: Rosters;
}

/** Günlüğe yazılan tek bir pit kararı. `lap`: kararın etki ettiği tur. */
export interface DecisionLogEntry {
  lap: number;
  teamKey: string;
  driverIdx: 0 | 1;
  compound: CompoundKey;
}

export interface ReplayInput {
  seed: number;
  round: number;
  snapshot: RaceSnapshot;
  decisions: readonly DecisionLogEntry[];
  /** Bu tura kadar oynat. Verilmezse yarış bitene kadar koşar. */
  uptoLap?: number;
}

/**
 * Tarifi yarışa çevirir. Aynı girdi her zaman aynı `RaceState`i verir.
 */
export function replayRace(input: ReplayInput): RaceState {
  const { seed, round, snapshot, decisions } = input;
  const track = trackForRound(round);
  const weather = weatherFor(track, seed);

  // Sıralama turları başlangıç gridini belirler — grid değişirse bütün yarış
  // değişir. `risks` bu yüzden tarifin parçası, süs değil.
  const qualifying = simulateQualifying({
    track,
    entries: snapshot.entries,
    risks: snapshot.risks,
    wet: weather.wetAtStart,
    round,
    seed,
    aiBonus: snapshot.aiBonus,
    rosters: snapshot.rosters,
  });

  let state = startRace({
    standings: snapshot.standings,
    track,
    entries: snapshot.entries,
    weather,
    grid: qualifying.grid,
    round,
    seed,
    aiBonus: snapshot.aiBonus,
    rosters: snapshot.rosters,
  });

  // Kararları turlarına göre grupla. Günlüğün sırası önemsiz olmalı: aynı
  // (tur, takım, sürücü) için sonradan yazılan karar öncekini ezer, ki bu
  // uç noktanın "son çağrı geçerli" davranışıyla örtüşür.
  const byLap = new Map<number, Decisions>();
  for (const d of decisions) {
    let lapMap = byLap.get(d.lap);
    if (!lapMap) byLap.set(d.lap, (lapMap = {}));
    lapMap[`${d.teamKey}:${d.driverIdx}`] = { compound: d.compound };
  }

  const lastLap = input.uptoLap === undefined ? track.laps : Math.min(input.uptoLap, track.laps);
  for (let lap = state.lap + 1; lap <= lastLap; lap += 1) {
    if (state.finished) break;
    state = advanceLap(state, track, byLap.get(lap) ?? {});
  }
  return state;
}
