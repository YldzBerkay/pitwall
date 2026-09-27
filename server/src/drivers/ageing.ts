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
 * NEDEN YEDEK KADRO YALNIZCA YAŞLANIYOR (GELİŞMİYOR):
 * `lobby_drivers`ta artık `reserve` satırları var (Aşama B'nin pazar/imza
 * işi) ama onları asıl koltuklarla aynı çift-tabanlı `developRosterSeason`a
 * SOKMUYORUZ (o tam olarak iki sürücülük bir çift bekliyor) — yalnızca
 * `ageOneSeason` uygular, tıpkı istemcinin kendi yedek kadrosuna yaptığı
 * gibi (`driverSlice.ts` `squad: state.squad.map(... ageOneSeason ...)`).
 *
 * NEDEN SÖZLEŞME TİKİ AYNI GEÇİŞTE:
 * Görev metni: "the winter pass from f50b6fd must tick [contracts]... That
 * belongs in the same once-only rollover transaction." `tickContract` bu
 * yüzden BURADA, her satırın yaş/gelişim yazmasıyla aynı döngüde, aynı
 * `client`le çağrılıyor — `rolloverRace`in tek taahhüdü hem yaş/gelişimi
 * hem sözleşmeyi taşır; ortada çöken bir süreç birini yapıp diğerini
 * atlayan bir lobi bırakmaz.
 *
 * AI TAKIM: "sözleşmeler otomatik yenilenir, AI transfer penceresi gelene
 * kadar" (görev metni) — bu geçiş `seasonsLeft`i asla sıfıra indirmez,
 * her kışın sonunda taze bir döneme (`AI_RENEWAL_SEASONS`) sıfırlar. Tam
 * `runTransferWindow` (poaching/rookie doldurma) BİLEREK ÇAĞRILMIYOR — görev
 * metni "Do NOT build the AI transfer window" diyor.
 *
 * İNSAN TAKIM, YEDEK KADRO: sözleşmesi biten bir yedek kadro sürücüsü
 * gerçekten AYRILIR — satır silinir ve `lobby_driver_signings`teki
 * kimliği serbest bırakılır (`releaseMarketSigning`). Bu, "pazara döner"in
 * gerçekten gözlemlenebilir hali: onu pazara SOKAN bir yazma yok (pazar hiç
 * saklanmıyor, bkz. `drivers/market.ts`), ama artık "zaten imzalanmış"
 * değil — o kimlik yeniden imzalanabilir hale gelir.
 *
 * İNSAN TAKIM, ASIL KOLTUK: bir yarış koltuğu asla BOŞ bırakılamaz, ve onu
 * yeniden dolduracak mekanizma (poaching/rookie) tam olarak yukarıda
 * BİLEREK dışarıda bırakılan AI transfer penceresidir. Bu yüzden bir koltuk
 * sözleşmesi sıfıra indiğinde koltuk BOŞALTILMAZ — sürücü kalır, sözleşme
 * "son yıl"da (`seasonsLeft = 1`) sabitlenir, taban altına asla inmez. Bu,
 * görevin kendi ölçeğini aşmadan (poaching/rookie inşa etmeden) test
 * edilebilir, dürüst bir ara durumdur; tam yerine koyma AI transfer
 * penceresiyle birlikte gelecek bir görevdir.
 */
import type { PoolClient } from 'pg';
import { ageOneSeason, developRosterSeason } from '@pitwall/shared/driverMarket';
import type { Driver } from '@pitwall/shared/teams';
import {
  loadLobbyDrivers, saveDriverAfterSeason, updateContract, deleteReserveDriver, releaseMarketSigning,
  type LobbyDriver,
} from './repo.ts';
import { loadHumanTeamKeys } from '../lobby/lobbyRepo.ts';

/** How long a renewed AI contract runs before the next automatic renewal. */
const AI_RENEWAL_SEASONS = 2;

/**
 * Ticks one driver row's contract for the season now beginning. See the
 * module docblock for what happens to each of the three cases (AI, human
 * reserve, human race seat).
 */
async function tickContract(client: PoolClient, lobbyId: string, row: LobbyDriver, isHuman: boolean): Promise<void> {
  if (!isHuman) {
    await updateContract(client, lobbyId, row.id, { seasonsLeft: AI_RENEWAL_SEASONS, wage: row.contract.wage });
    return;
  }

  const seasonsLeft = row.contract.seasonsLeft - 1;
  if (seasonsLeft > 0) {
    await updateContract(client, lobbyId, row.id, { seasonsLeft, wage: row.contract.wage });
    return;
  }

  // Expired.
  if (row.position === 'reserve') {
    await deleteReserveDriver(client, lobbyId, row.id);
    await releaseMarketSigning(client, lobbyId, row.id);
    return;
  }
  // A race seat: see module docblock for why it is clamped, not vacated.
  await updateContract(client, lobbyId, row.id, { seasonsLeft: 1, wage: row.contract.wage });
}

/**
 * Ages (and, for an AI-run team, develops) every driver in the lobby for the
 * season now beginning, and ticks every driver's contract alongside it.
 * MUST be called with the rollover's own transaction `client`, inside the
 * same `if (seasonRolled)` branch that regresses the cars (`rollover.ts`) —
 * see this module's doc comment.
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
    else rest.push(row); // reserve squad
  }

  const teamKeys = new Set([...seats.keys()].map((key) => key.slice(0, key.lastIndexOf(':'))));
  for (const teamKey of teamKeys) {
    const seat0 = seats.get(`${teamKey}:seat_0`);
    const seat1 = seats.get(`${teamKey}:seat_1`);
    if (!seat0 || !seat1) continue; // half a pair should not happen (see repo.ts) — nothing safe to write
    const isHuman = humanTeamKeys.has(teamKey);
    const [next0, next1]: [Driver, Driver] = isHuman
      ? [ageOneSeason(seat0.driver), ageOneSeason(seat1.driver)]
      : developRosterSeason([seat0.driver, seat1.driver], teamKey, nextSeasonNo, lobbyId);
    await saveDriverAfterSeason(client, lobbyId, seat0.id, next0);
    await saveDriverAfterSeason(client, lobbyId, seat1.id, next1);
    await tickContract(client, lobbyId, seat0, isHuman);
    await tickContract(client, lobbyId, seat1, isHuman);
  }

  for (const row of rest) {
    const isHuman = row.teamKey ? humanTeamKeys.has(row.teamKey) : false;
    await saveDriverAfterSeason(client, lobbyId, row.id, ageOneSeason(row.driver));
    await tickContract(client, lobbyId, row, isHuman);
  }
}
