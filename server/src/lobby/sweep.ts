/**
 * Yarış SÜPÜRME DÖNGÜSÜ — buraya kadar var olan bütün parçaları (evre,
 * kira, koşucu, yayın, muhasebe) tek bir kalp atışına bağlayan yer.
 *
 * NEDEN AYRI BİR MODÜL: `advanceDuePhases`, `acquireDueLobbies`, `openRace`,
 * `LiveHub` ve `settleRace` her biri kendi başına sınanabilir ve KASITLA
 * hiçbiri diğerini çağırmıyor (`phase.ts`, `lease.ts`, `runner.ts`
 * docblock'larına bakın). Onları gerçekten canlı hale getiren tel BURADA:
 * hiçbir parça sürücüsüz kalmasın diye. `src/index.ts` bugüne kadar
 * `openRace`i hiç çağırmıyordu (yalnızca testler çağırıyordu) ve `hub.publish`
 * hiç çağrılmıyordu — bu modülden önce lobi başına yarış YALNIZCA testte
 * vardı.
 *
 * NEDEN "ŞU AN SÜRÜLEN YARIŞLAR" BELLEKTE TUTULUYOR:
 * `runner.ts`in kendi dokümantasyonundaki ölçüm burada da geçerli: her
 * süpürmede `openRace`i (yani `replayRace`i) yeniden çağırmak turların
 * KARESİ maliyetindedir. Süpürme döngüsü bu yüzden `OpenedRace` nesnelerini
 * bir turdan ötekine SAKLAR (`driving` haritası) ve yalnızca YENİ vakti gelen
 * lobiler için `openRace`e başvurur. Bu, `runner.ts`in "bellekteki durum
 * kararlı yol, yeniden oynatma kurtarma yolu" ilkesinin süpürme seviyesindeki
 * karşılığıdır.
 *
 * NEDEN `acquireDueLobbies`İN KİRASI SÜREKLİ YENİDEN İSTENMİYOR:
 * `acquireDueLobbies`in `where`i yalnızca kirası BOŞ ya da SÜRESİ DOLMUŞ
 * satırları döner (`lease.ts`). Sürdüğümüz bir yarışın kirası hâlâ geçerliyken
 * onu ikinci kez `acquireDueLobbies`den istemek anlamsızdır — zaten dönmez.
 * Kira `runner.ts`in kendi `tick()`i içindeki `renewLease` ile canlı tutulur;
 * süpürme döngüsünün işi yalnızca ELİNDEKİ koşucuları her atışta tikletmek ve
 * YENİ vakti gelenleri devralmaktır.
 *
 * NEDEN EVRE İLERLEMESİ AYRI, KİRASIZ ÇAĞRILIYOR:
 * `advanceDuePhases` kendi kendine yeten ve kirasız bir fonksiyon (bkz. onun
 * docblock'u): "hangi lobi vakti geldi" sorusu ile "kim sürüyor" sorusu
 * BAĞIMSIZDIR. Süpürme onu HER ATIŞTA, kira almadan önce çağırır ki `open`da
 * bekleyen bir lobi `live`e SIZDIRILMADAN önce ilerlesin — sıra önemlidir,
 * yoksa aynı atışta yeni `live` olmuş bir lobi bir sonraki atışa kadar
 * devralınmadan kalır.
 *
 * NEDEN "CANLI Mİ" KARARI HER SEFERİNDE VERİTABANINDAN:
 * `runner.ts`in kendi kuralı: `openRace` `phase = 'live'`e bakar, kendi
 * `advanceDuePhases` çağrımızın dönüşüne değil. Bir komşu süreç lobiyi bizden
 * önce `live`e taşımış olabilir; dönüşe güvenen bir süpürme onu sessizce
 * atlardı. `acquireDueLobbies` zaten `open`/`checkin`/`live` evrelerinin
 * hepsini tarar (`lease.ts` `DUE_PHASES`) — `openRace`in kendisi `null`
 * dönerse (henüz `live` değilse) elimizdeki kirayı hemen BIRAKIRIZ: sürülecek
 * bir şey yoksa onu tutmanın tek sonucu, o lobi gerçekten `live` olduğunda
 * BAŞKA bir sürecin (ya da bir sonraki atışımızın) onu almasını engellemektir.
 *
 * NEDEN `AlreadySettledError` BURADA YUTULUYOR:
 * `runner.ts`teki `flag()` artık damga + evre + muhasebeyi TEK işlemde yapıyor
 * (bkz. onun docblock'u). Bu istisna normal bir çökme-sonrası durumdur — bu
 * yarışı daha önce biten bir süreç zaten ödemiştir. Yakalanmazsa süpürme
 * döngüsü HER atışta "bu lobi başarısız" gibi görünür, oysa doğru olan bir
 * şey yok; bu yüzden burada özel olarak süzülür ve loglanmaz bile.
 *
 * `now` bu modülde de asla `Date.now()`la okunmaz; her çağıran kendi anını
 * verir (server/README.md §"now sadece route'ta örneklenir"). Bu, testin
 * gerçek zamanlayıcı beklemeden tek bir sabit ana göre kaç tur koştuğunu
 * denetleyebilmesinin TEK sebebi.
 */
import { AlreadySettledError } from '../economy/settle.ts';
import type { LiveHub } from './live.ts';
import { advanceDuePhases } from './phase.ts';
import { acquireDueLobbies, releaseLease } from './lease.ts';
import { openRace, type OpenedRace } from './runner.ts';
import { rolloverRace } from './rollover.ts';

/** Bir atışın rapor edeceği kadarı — testin göreceği tek şey. */
export interface SweepResult {
  /** Bu atışta evre değiştiren lobi sayısı. */
  phaseAdvances: number;
  /** Bu atışta yeni devralınan lobi sayısı. */
  claimed: number;
  /** Bu atışta en az bir tur koşan lobi sayısı. */
  ticked: number;
  /** Bu atışta bayrağı gören (ve muhasebeleşen) lobi sayısı. */
  finished: number;
}

export interface RaceSweep {
  /** Tek bir kalp atışı — testin gerçek bir zamanlayıcı beklemeden çağırdığı yer. */
  sweepOnce(now: Date): Promise<SweepResult>;
  /** Süreç kapanırken: elimizdeki bütün kiraları HEMEN bırak (`LEASE_MS` beklenmesin). */
  releaseAll(): Promise<void>;
}

export interface RaceSweepOptions {
  /** Bir atışta en fazla kaç YENİ lobi devralınır. */
  limit?: number;
}

/**
 * Bir süpürücü kurar.
 *
 * `ownerId` bu SÜRECİN kimliğidir — `acquireDueLobbies`/`renewLease`e verilen
 * aynı değer, süreçler arası dışlamanın anahtarı (`lease.ts`). `hub` yeni
 * turların yayınlanacağı oda yöneticisidir (`live.ts`).
 */
export function createRaceSweep(ownerId: string, hub: LiveHub, options: RaceSweepOptions = {}): RaceSweep {
  const limit = options.limit ?? 25;
  // lobbyId → şu an bu süreçte SÜRÜLEN yarış. Bir atıştan ötekine hayatta
  // kalır; yukarıdaki docblock'taki "her atışta yeniden oynatma karesi
  // maliyeti" tam olarak bu haritayla önlenir.
  const driving = new Map<string, OpenedRace>();

  /** Bir koşucuyu bir tik ileri alır, yayınlar ve bittiyse muhasebeleştirir. */
  async function driveOne(lobbyId: string, runner: OpenedRace, now: Date): Promise<{ ticked: boolean; finished: boolean }> {
    let result;
    try {
      result = await runner.tick(now);
    } catch (err) {
      if (err instanceof AlreadySettledError) {
        // Bkz. modül docblock'u: normal bir çökme-sonrası son. Bu koşucuyu
        // artık elimizde tutmanın anlamı yok, ödeme çoktan yapılmış.
        driving.delete(lobbyId);
        // Bu yarış ÖDENMİŞ ama lobi hâlâ `result`te takılı kalmış olabilir
        // (kendi süreç çöktü, `flag()`ten sonraki hafta sonu dönüşünü hiç
        // görmedi). `rolloverRace`in kendi koruması (`rollover.ts`) bunu
        // güvenli kılar: lobi başka biri tarafından zaten döndürülmüşse
        // UPDATE'in `where`i eşleşmez, hiçbir şey olmaz.
        await rolloverRace(lobbyId, runner.seasonNo, runner.roundNo, now);
        return { ticked: false, finished: true };
      }
      // Beklenmeyen bir hata bu lobiyi BATIRMAMALI: diğer lobiler sürmeye
      // devam etmeli. Elimizdeki koşucuyu düşürüyoruz ki bir sonraki atış,
      // kirası hâlâ geçerliyse aynı bozuk durumu tekrar denemesin — kira
      // süresi dolunca (ya da biz `releaseAll` çağırınca) başka bir devralan
      // tarifi baştan okuyup kurtarır.
      console.error(`[race-sweep] lobi ${lobbyId} tikte patladı:`, err);
      driving.delete(lobbyId);
      return { ticked: false, finished: false };
    }

    if (!result.owned) {
      // Kira başkasına geçti: bu koşucuyu bir daha hiç tiklemeyelim, aksi
      // halde iki süreç aynı yarışı sürer görünümü verir (gerçekte sürmez,
      // `tick()` hiçbir şey yapmaz ama gereksiz bir DB gidiş-gelişidir).
      driving.delete(lobbyId);
      return { ticked: false, finished: result.finished };
    }

    if (result.advanced > 0) hub.publish(lobbyId, result.state);

    if (result.finished) {
      // `flag()` (runner.ts) damga + evre + muhasebeyi zaten TEK işlemde
      // yaptı ve kirayı bıraktı; burada yapılacak ek bir şey yok, yalnızca
      // artık sürmediğimiz bu lobiyi haritadan düşürüyoruz.
      driving.delete(lobbyId);
      // Lobi tam bu anda `result`e düştü — bir sonraki hafta sonuna
      // ittirilmesi gerekiyor (bkz. `rollover.ts` docblock'u: `result`
      // `acquireDueLobbies`in taradığı evrelerden biri değil, onu buradan
      // itmezsek lobi BİR DAHA ASLA yarışmaz).
      await rolloverRace(lobbyId, runner.seasonNo, runner.roundNo, now);
    }

    return { ticked: result.advanced > 0, finished: result.finished };
  }

  async function sweepOnce(now: Date): Promise<SweepResult> {
    const advances = await advanceDuePhases(now);

    let ticked = 0;
    let finished = 0;

    // 1) Elimizde olan (bir önceki atıştan sürdürülen) yarışları ilerlet.
    for (const [lobbyId, runner] of [...driving]) {
      const outcome = await driveOne(lobbyId, runner, now);
      if (outcome.ticked) ticked += 1;
      if (outcome.finished) finished += 1;
    }

    // 2) Vakti gelmiş, henüz kimsenin elinde olmayan lobileri devral. Kirası
    // hâlâ bizde geçerli olan (`driving` içindeki) lobiler bu sorgudan zaten
    // dönmez (`lease.ts` `where race_lease_until is null or <= now`), yani
    // aynı lobiyi ikinci kez almayız.
    const leased = await acquireDueLobbies(ownerId, now, limit);
    let claimed = 0;
    for (const lobby of leased) {
      claimed += 1;
      try {
        const runner = await openRace({
          lobbyId: lobby.lobbyId, seasonNo: lobby.seasonNo, roundNo: lobby.roundNo, ownerId, now,
        });
        if (!runner) {
          // OTORİTE VERİTABANI: `acquireDueLobbies` `open`/`checkin`/`live`in
          // hepsini tarar ama `openRace` yalnızca GERÇEKTEN `live` olan
          // lobiler için bir koşucu verir (bkz. `runner.ts` docblock'u —
          // kendi `advanceDuePhases` dönüşümüze güvenmiyoruz, satıra
          // bakıyoruz). Henüz `live` değilse sürülecek bir şey yok; kirayı
          // TUTMANIN tek sonucu, gerçekten `live` olduğunda başka bir
          // sürecin (ya da bir sonraki atışımızın) bu lobiyi almasını
          // engellemek olurdu. Bu yüzden hemen bırakıyoruz.
          await releaseLease(ownerId, lobby.lobbyId);
          continue;
        }
        driving.set(lobby.lobbyId, runner);
        const outcome = await driveOne(lobby.lobbyId, runner, now);
        if (outcome.ticked) ticked += 1;
        if (outcome.finished) finished += 1;
      } catch (err) {
        console.error(`[race-sweep] lobi ${lobby.lobbyId} devralınırken patladı:`, err);
        await releaseLease(ownerId, lobby.lobbyId);
      }
    }

    return { phaseAdvances: advances.length, claimed, ticked, finished };
  }

  async function releaseAll(): Promise<void> {
    // KAPANIŞ: elimizdeki her kirayı GÖNÜLLÜ bırakıyoruz ki yeniden başlayan
    // süreç (ya da bir eş) `LEASE_MS` (15 sn) beklemeden devralabilsin
    // (`lease.ts` `releaseLease` docblock'u tam bunun için var).
    const ids = [...driving.keys()];
    driving.clear();
    await Promise.all(ids.map((id) => releaseLease(ownerId, id)));
  }

  return { sweepOnce, releaseAll };
}
