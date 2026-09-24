/**
 * Lobi hafta sonunun EVRE İLERLEMESİ: open → checkin → live.
 *
 * NEDEN VERİTABANI OTORİTE:
 * Evre, bir sürecin belleğindeki alanda değil satırda durur. Bellekteki bir
 * `setInterval` + alan ikilisi, deploy ya da çökme anında her lobinin hafta
 * sonunun neresinde olduğunu kaybederdi. Burada süreç yalnızca UYANIR, "vakti
 * gelen kim" diye veritabanına sorar ve onları ilerletir. Bir saat kapalı
 * kalmış bir sunucu geri geldiğinde tam kaldığı yerden değil, OLMASI GEREKEN
 * yerden devam eder (aşağıdaki yetişme davranışı).
 *
 * NEDEN BU MODÜL YARIŞ SÜRMÜYOR:
 * Burada yalnızca evre ilerler; yarış başlatmak, tur işlemek, `race_runs`'a
 * yazmak koşucunun işidir. Ayrı tutmak bu modülü tek başına sınanabilir
 * kılar: evre geçişinin doğruluğunu kanıtlamak için motoru çalıştırmak
 * gerekmez.
 *
 * NEDEN KOŞUL UPDATE'İN KENDİ `where`'İNDE:
 * Geçiş koşulu önce `select` edilip sonra `update` edilseydi klasik
 * kontrol-sonra-davran yarışı olurdu: iki süreç de aynı `open` lobiyi görür,
 * ikisi de ilerletir — lobi çift ilerler. Koşul UPDATE'in kendi `where`'inde
 * olduğu için kararı satır kilidi altında Postgres verir ve ikinci yazan
 * `rowCount = 0` alır (server/README.md'deki `spendGold` deseni, `lease.ts`
 * ile aynı sözleşme).
 *
 * `now` asla buradan okunmaz; her zaman çağıran verir (README §225). Tik
 * döngüsü de test de tek bir ana bağlı kalır, böylece "vakti geldi mi"
 * kararı yeniden üretilebilir olur.
 */
import { withTransaction } from '../db/pool.ts';
import type { LobbyPhase } from './lobbyRepo.ts';

/**
 * Check-in penceresi: yarış anından NE KADAR ÖNCE oyunculara "kendi yarışını
 * süreceğini onayla" sorusunun sorulduğu süre. Pencere açıldığında lobi
 * `checkin`e geçer; onaylamayan takımı ışıklar söndüğünde asistan devralır ve
 * bu seçim orada DONAR (yarışın yeniden oynatılabilir kalması için).
 */
export const CHECKIN_WINDOW_MS = 5 * 60 * 1000;

/**
 * Bu çağrıda gerçekten ilerleyen bir lobi.
 *
 * `seasonNo`/`roundNo` BURADA, çünkü `sweep.ts` bu geçişi `hub.publishPhase`
 * ile duyururken istemciye SEZON VE TUR da vermek zorunda (görev brifi:
 * "istemcinin doğru settlement'ı isteyebilmesi ve yerel tur sayacının
 * kalkacak olması" için). İkinci bir sorguyla lobiyi yeniden okumak yerine
 * bu UPDATE'in zaten döndürdüğü satırdan taşımak: aynı satır kilidi altında
 * okunan tek bir gerçek, araya sızabilecek bir yarış koşulu yok.
 */
export interface PhaseAdvance {
  lobbyId: string;
  from: LobbyPhase;
  to: LobbyPhase;
  seasonNo: number;
  roundNo: number;
}

interface AdvancedRow {
  id: string;
  season_no: number;
  round_no: number;
}

/**
 * Vakti gelmiş lobileri bir evre ileri taşır ve SADECE gerçekten taşınanları
 * döner (boş dizi = yapılacak iş yoktu).
 *
 * YETİŞME DAVRANIŞI — iki adım AYNI ÇAĞRIDA, bu sırayla koşar. Saatler önce
 * yarışması gereken bir `open` lobi önce `checkin`e, hemen ardından aynı
 * çağrıda `live`e geçer; tek bir uyanışta doğru yere varır, bir sonraki tiki
 * beklemez. `checkin`i ATLAMAK yerine İÇİNDEN GEÇİRMEYİ seçtik: hafta sonunun
 * her turu aynı evre dizisini yaşar, yani koşucunun ve istemcinin "checkin'e
 * girildi" anına asılı davranışları (katılımın dondurulması, istemci bildirimi)
 * gecikmeli bir lobide de tetiklenir. Atlasaydık, yalnızca sunucu kapalı
 * kaldığı için farklı bir kod yolundan geçen ikinci bir hafta sonu biçimi
 * doğardı — sınanmayan ve bu yüzden bozulacak olan bir yol.
 *
 * İki UPDATE tek işlemde: bir gözlemci lobiyi ya `open` ya `live` görür,
 * yetişmenin ortasındaki geçici `checkin`i asla görmez.
 */
export async function advanceDuePhases(now: Date): Promise<PhaseAdvance[]> {
  // Eşik `now`dan TÜRETİLİR, sorgu içinde `now()` okunmaz: tek bir andan
  // türeyen iki eşik, aynı çağrının iki adımının aynı ana göre karar
  // vermesini garanti eder.
  const checkinThreshold = new Date(now.getTime() + CHECKIN_WINDOW_MS);

  return withTransaction(async (client) => {
    const moved: PhaseAdvance[] = [];

    // 1) open → checkin: yarışa CHECKIN_WINDOW_MS'ten az kaldıysa.
    const toCheckin = await client.query<AdvancedRow>(
      `update lobbies set phase = 'checkin'
        where phase = 'open' and next_race_at <= $1
        returning id, season_no, round_no`,
      [checkinThreshold],
    );
    for (const row of toCheckin.rows) {
      moved.push({ lobbyId: row.id, from: 'open', to: 'checkin', seasonNo: row.season_no, roundNo: row.round_no });
    }

    // 2) checkin → live: yarış anı geçtiyse. Yukarıdaki adımın yeni
    // yazdıklarını da görür — yetişme tam olarak buradan doğar.
    const toLive = await client.query<AdvancedRow>(
      `update lobbies set phase = 'live'
        where phase = 'checkin' and next_race_at <= $1
        returning id, season_no, round_no`,
      [now],
    );
    for (const row of toLive.rows) {
      moved.push({ lobbyId: row.id, from: 'checkin', to: 'live', seasonNo: row.season_no, roundNo: row.round_no });
    }

    return moved;
  });
}
