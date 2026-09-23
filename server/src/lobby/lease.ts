/**
 * Yarış sahipliğinin KİRASI — bir lobinin yarışını aynı anda tek süreç sürer.
 *
 * NEDEN KİRA, NEDEN SAHİPLİK BAYRAĞI DEĞİL:
 * Kalıcı bir `race_owner` bayrağı, sahibi çöktüğünde lobiyi sonsuza dek kilitli
 * bırakırdı — yarışı izleyen oyuncular için donmuş bir ekran demek. Süresi olan
 * bir kira, sahibin canlı olduğunu SÜREKLİ kanıtlamasını ister: yenilemeyi
 * bırakan süreç (deploy, çökme, ağ kopması) sahipliğini kendiliğinden bırakır
 * ve başka bir kopya `raceRepo` + `replay.ts` üzerinden karar günlüğünü
 * yeniden oynatıp AYNI yarışı sürdürür. Kayıp yok, çatallanma yok.
 *
 * NEDEN KORUMA YAZMANIN KENDİ `where`'İNDE:
 * `renewLease`/`releaseLease` sahiplik kontrolünü önce `select` edip sonra
 * `update` etseydi klasik kontrol-sonra-davran yarışı olurdu: iki çağıran da
 * "sahibi benim" okur, ikisi de ilerler. Koru UPDATE'in kendi `where`'indedir
 * (`where id = $1 and race_owner = $2`) ve kararı `rowCount` bildirir —
 * server/README.md §242'deki `spendGold` deseninin aynısı.
 *
 * `now` asla buradan okunmaz; her zaman çağıran verir (README §225). Kira
 * süresi aritmetiği tek bir `now`a bağlı olmalı ki test sabit bir an
 * geçirebilsin ve iki sunucu "süresi doldu"da yalnızca kendilerine verilen
 * değer üzerinden anlaşsın.
 */
import { query, withTransaction } from '../db/pool.ts';
import type { LobbyPhase } from './lobbyRepo.ts';

/**
 * Bir kiranın ömrü.
 *
 * Tik aralığı varsayılan 2.5 sn (`src/index.ts`, TICK_MS). Kira bunun birkaç
 * katı OLMALIDIR ve iki yönde de bir arıza biçimi vardır:
 *
 *  - ÇOK KISA: sağlıklı ama o an yavaş bir sahip (uzun bir GC duraklaması,
 *    ağır bir tik, gecikmeli bir veritabanı yazımı) kirasını bir tek tik
 *    içinde kaybeder. O anda başka bir süreç aynı lobiyi alır ve yarış İKİ
 *    süreç tarafından sürülür: iki yayın, iki karar akışı — "herkes aynı
 *    yarışı görür" şartı tam da burada kırılır.
 *  - ÇOK UZUN: ölen bir sahibin yarışı kira dolana kadar donmuş kalır.
 *    Bunu bekleyenler, yarışı canlı izleyen oyunculardır; 2 dakikalık bir kira
 *    çökme sonrası 2 dakikalık hareketsiz bir ekran demektir.
 *
 * 15 sn, tikin 6 katı: sağlıklı bir sahip kirasını kaybetmeden arka arkaya
 * beş tiki kaçırabilir, ölü bir sahip ise en fazla 15 sn'de devredilir.
 */
export const LEASE_MS = 15_000;

/**
 * Yarışı sürülmeyi bekleyen evreler. `result`/`finished` DIŞARIDADIR: orada
 * sürülecek bir yarış kalmamıştır. `live` İÇERİDEDİR ve asıl mesele odur —
 * sahibi ortasında çöken bir yarış tam da `live` evresindedir ve devralınması
 * gereken lobi odur.
 */
const DUE_PHASES = ['open', 'checkin', 'live'] as const;

/** Kirası bu süreçte olan bir lobi. Koşucunun yarışı bulması için yeterli. */
export interface LeasedLobby {
  lobbyId: string;
  seasonNo: number;
  roundNo: number;
  phase: LobbyPhase;
  nextRaceAt: Date;
  /** Bu andan önce `renewLease` çağrılmazsa sahiplik düşer. */
  leaseUntil: Date;
}

interface DueRow {
  id: string;
  season_no: number;
  round_no: number;
  phase: string;
  next_race_at: Date;
}

/**
 * Vakti gelmiş ve sahipsiz (ya da kirası dolmuş) lobileri `ownerId` adına alır.
 *
 * Seçme ve damgalama TEK işlemdedir ve bu zorunludur: iki ayrı işlem olsaydı,
 * iki süreç arasındaki pencerede ikisi de aynı satırı "boş" görüp ikisi de
 * damgalardı — sonuncu yazan kazanır ve ilki, kendisinin sahip olduğunu sanarak
 * yarışı sürmeye devam ederdi.
 *
 * `for update skip locked`: aynı anda tarayan başka bir süreç satırı zaten
 * kilitlemişse, beklemek yerine o satırı ATLARIZ. Dikkat: dışlamayı sağlayan
 * asıl şey satır kilidinin kendisidir (`for update`); `skip locked` bir
 * güvenlik özelliği DEĞİL, bir verim tercihidir — düz `for update` de tek
 * sahipliği korur ama bekleyen süreç kilit çözülene kadar bloke olur ve o
 * satırı ancak `where`in yeniden değerlendirilmesiyle (artık kirası canlı)
 * eler. `skip locked` ile tarayıcı hiç beklemez, sıradaki lobiye geçer;
 * çok süreçli bir taramada toplam iş aynı sürede dağılır. Bu ölçüldü: 12
 * eşzamanlı çağıranla düz `for update` de 10/10 koşuda tek sahip verdi, hiç
 * kilitlemeyen sürüm ise 5/5 düştü. Yani dışlamayı satır kilidi sağlıyor.
 * İkinci bir kazanç: bekleyen yok demek, çok satır kilitleyen iki taramanın
 * satırları farklı sıralarda alıp kilitlenmesi (deadlock) riski de yok —
 * `order by next_race_at` eşit değerlerde toplam sıra vermez.
 *
 * `limit` bir çağrının kaç lobi üstleneceğini sınırlar: bir süreç aynı anda
 * süremeyeceği kadar çok yarışı üstlenip hepsinin kirasını düşürmemelidir.
 */
export async function acquireDueLobbies(
  ownerId: string, now: Date, limit: number,
): Promise<LeasedLobby[]> {
  const leaseUntil = new Date(now.getTime() + LEASE_MS);

  return withTransaction(async (client) => {
    const due = await client.query<DueRow>(
      `select id, season_no, round_no, phase, next_race_at
         from lobbies
        where phase = any($1::text[])
          and next_race_at <= $2
          and (race_lease_until is null or race_lease_until <= $2)
        order by next_race_at asc
        limit $3
        for update skip locked`,
      [DUE_PHASES, now, limit],
    );
    if (due.rowCount === 0) return [];

    const ids = due.rows.map((r) => r.id);
    // Kilit hâlâ bizde olduğu için bu UPDATE'in ayrıca sahiplik koşuluna
    // ihtiyacı yok: satırları biz tuttuk, işlem bitene dek kimse değiştiremez.
    await client.query(
      `update lobbies set race_owner = $1, race_lease_until = $2 where id = any($3::uuid[])`,
      [ownerId, leaseUntil, ids],
    );

    return due.rows.map((row) => ({
      lobbyId: row.id,
      seasonNo: row.season_no,
      roundNo: row.round_no,
      phase: row.phase as LobbyPhase,
      nextRaceAt: row.next_race_at,
      leaseUntil,
    }));
  });
}

/**
 * Kirayı `now + LEASE_MS`'e uzatır. Yalnızca hâlâ sahip olan süreç için.
 *
 * `false` "artık sahip değilsin" demektir ve çağıran bunu CİDDİYE ALMALIDIR:
 * kira dolmuş ve lobi devralınmıştır; tik döngüsü orada durmalıdır, yoksa aynı
 * yarışı iki süreç sürer.
 *
 * Sahiplik kontrolü bilerek UPDATE'in `where`indedir — önceki bir `select` ile
 * yapılsaydı iki çağıran da aynı anda "sahibim" okuyabilirdi.
 */
export async function renewLease(ownerId: string, lobbyId: string, now: Date): Promise<boolean> {
  const res = await query(
    `update lobbies set race_lease_until = $3 where id = $1 and race_owner = $2`,
    [lobbyId, ownerId, new Date(now.getTime() + LEASE_MS)],
  );
  return res.rowCount === 1;
}

/**
 * Kirayı gönüllü bırakır (yarış bitti ya da süreç düzgün kapanıyor), böylece
 * sıradaki tarama kiranın dolmasını beklemeden lobiyi alabilir.
 *
 * Sahiplik koşulu yine UPDATE'in kendisindedir: kirayı devralmış YENİ sahibin
 * kirasını, geç kalmış eski bir sahibin `releaseLease` çağrısı silmemelidir.
 */
export async function releaseLease(ownerId: string, lobbyId: string): Promise<boolean> {
  const res = await query(
    `update lobbies set race_owner = null, race_lease_until = null
      where id = $1 and race_owner = $2`,
    [lobbyId, ownerId],
  );
  return res.rowCount === 1;
}
