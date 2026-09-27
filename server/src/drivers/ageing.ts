/**
 * Season rollover's roster pass — every driver in the lobby a year older,
 * an AI-run team's pair grown toward potential.
 *
 * NEDEN AYRI BİR MODÜL, `rollover.ts`İN İÇİNDE DEĞİL:
 * Kış resetinin araç tarafı (`rollover.ts`) üç sayı taşıyor (motor/aero/grip);
 * kadro geçişi her takım için iki (ya da daha fazla) sürücünün yaşını ve
 * stat'larını taşıyor — çok daha büyük bir geçiş. `rolloverRace`in kendi
 * KORUMASINI (tek taahhütte, `phase = 'result'` UPDATE'inin `where`i) burada
 * YENİDEN YAZMIYORUZ — bu modülün TEK girişi `ageDriversForSeason`, ve onu
 * `rolloverRace` kendi taşıdığı transaction `client`iyle, KIŞ RESETİYLE AYNI
 * `if (seasonRolled)` bloğunda çağırıyor. Böylece kazanan tek çağıran hem
 * araç geriletir hem kadroyu yaşlandırır, ikisi TEK taahhütte iner; ortada
 * çöken bir süreç ne aracı geriletilmiş-kadroyu-yaşlanmamış ne de tersi bir
 * lobi bırakmaz.
 *
 * NEDEN İNSAN TAKIM ≠ AI TAKIM:
 * Eski masaüstü/mobil istemcinin `driverSlice.ts` `ageDrivers`ı, oyuncunun
 * KENDİ ikilisine yalnızca `ageOneSeason` uygular — potansiyele doğru büyüme
 * YOKTUR, o yalnızca antrenmandan (`trainingGain`) gelir. Rakip takımlara ise
 * `developRosterSeason` uygulanır: onları hiç kimse antrenman ettirmez, kış
 * geçişi onları BÜYÜTMEZSE hiçbir zaman büyümezler. Sunucuda birden fazla
 * koltuk insan olabildiği için bu ayrım KOLTUK BAZINDA taşınır: bir takımı
 * hangi kuralın yönettiğini `lobby_seats.user_id`in dolu olup olmadığı
 * belirler (`lobbyRepo.ts` `loadHumanTeamKeys`) — `managed` DEĞİL, o bir
 * hafta sonu asistan/insan arasında gidip gelen geçici bir damga
 * (`checkin.ts`), takımın SAHİPLİĞİNİ değil.
 *
 * NEDEN LOBİ KİMLİĞİ TOHUMA GİRİYOR:
 * `developRosterSeason`in KENDİ tohumu (`shared/driverMarket.ts`) yalnızca
 * takım + sezona bakıyordu — istemcide TEK bir kayıt olduğu için sorun
 * değildi. Sunucuda aynı `aurelia` takımı aynı anda onlarca lobide var; bu
 * tohum lobi kimliğini içermeseydi HEPSİ aynı sezonda AYNI şekilde gelişirdi
 * — tam bu depoda bir keresinde gerçekten yakalanan hata (bkz.
 * `espionage.ts`'in `missionSeed` docblock'u: casus görevi tohumu bir zamanlar
 * yalnızca hedef takım adının UZUNLUĞUNU taşıyordu, her lobi aynı sonucu
 * görüyordu). `developRosterSeason` artık `lobbyId`yi de alıyor.
 *
 * NEDEN YEDEK KADRO (henüz yok) YALNIZCA YAŞLANIYOR:
 * `drivers/repo.ts`in kendi notu: yedek kadro dolgusu Aşama B. Bugün
 * `lobby_drivers`ta `reserve` pozisyonunda hiçbir satır yok, ama şema onu
 * kabul ediyor. Böyle bir satır bir gün ortaya çıkarsa bu geçiş onu asıl
 * koltuklarla aynı çift-tabanlı `developRosterSeason`a SOKMAZ (o tam olarak
 * iki sürücülük bir çift bekliyor) — yalnızca `ageOneSeason` uygular, tıpkı
 * istemcinin kendi yedek kadrosuna yaptığı gibi (`driverSlice.ts` `squad:
 * state.squad.map(... ageOneSeason ...)`).
 */
import type { PoolClient } from 'pg';
import { ageOneSeason, developRosterSeason } from '@pitwall/shared/driverMarket';
import type { Driver } from '@pitwall/shared/teams';
import { loadLobbyDrivers, saveDriverAfterSeason, type LobbyDriver } from './repo.ts';
import { loadHumanTeamKeys } from '../lobby/lobbyRepo.ts';

/**
 * Ages (and, for an AI-run team, develops) every driver in the lobby for the
 * season now beginning. MUST be called with the rollover's own transaction
 * `client`, inside the same `if (seasonRolled)` branch that regresses the
 * cars (`rollover.ts`) — see this module's doc comment.
 */
export async function ageDriversForSeason(client: PoolClient, lobbyId: string, nextSeasonNo: number): Promise<void> {
  const [drivers, humanTeamKeys] = await Promise.all([
    loadLobbyDrivers(lobbyId, client),
    loadHumanTeamKeys(lobbyId, client),
  ]);

  const seats = new Map<string, LobbyDriver>(); // `${teamKey}:${position}` -> row
  const rest: LobbyDriver[] = [];
  for (const row of drivers) {
    if (!row.teamKey) continue; // market: not signed to any roster yet — out of scope (Stage B)
    if (row.position === 'seat_0' || row.position === 'seat_1') seats.set(`${row.teamKey}:${row.position}`, row);
    else rest.push(row); // reserve squad, once seeding creates it — see module doc
  }

  const teamKeys = new Set([...seats.keys()].map((key) => key.slice(0, key.lastIndexOf(':'))));
  for (const teamKey of teamKeys) {
    const seat0 = seats.get(`${teamKey}:seat_0`);
    const seat1 = seats.get(`${teamKey}:seat_1`);
    if (!seat0 || !seat1) continue; // half a pair should not happen (see repo.ts) — nothing safe to write
    const [next0, next1]: [Driver, Driver] = humanTeamKeys.has(teamKey)
      ? [ageOneSeason(seat0.driver), ageOneSeason(seat1.driver)]
      : developRosterSeason([seat0.driver, seat1.driver], teamKey, nextSeasonNo, lobbyId);
    await saveDriverAfterSeason(client, lobbyId, seat0.id, next0);
    await saveDriverAfterSeason(client, lobbyId, seat1.id, next1);
  }

  for (const row of rest) {
    await saveDriverAfterSeason(client, lobbyId, row.id, ageOneSeason(row.driver));
  }
}
