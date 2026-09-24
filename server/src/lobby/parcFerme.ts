/**
 * Parc fermé değerlendirmesi — ışıklar söndüğünde açık işlerin araca etkisi.
 *
 * GERÇEK F1 KURALI: sıralama turları bittiği anda araçlar parc fermé'ye
 * girer; takım artık araca dokunamaz. Dokunursa araç GRİD YERİNİ KAYBEDER —
 * grid'e dizilmez, pit çıkışında bekler ve saha TAMAMEN geçtikten sonra
 * salınır. Bu "sondan başlamak" değildir, ondan DAHA KÖTÜdür: son gridçi
 * ışıklarla birlikte kalkar, pit yolundaki araç ise saha önünden akıp
 * gittikten sonra, üstüne bir de pit yolu transitini ödeyerek katılır.
 * Karşılığında iki gerçek telafi vardır: sınırsız setup serbestisi ve
 * başlangıç lastiğinin serbest seçimi. Takımlar bu cezayı bazen BİLEREK
 * alır — bu yüzden ceza "sondan başla"ya sadeleştirilemez.
 *
 * Oyundaki karşılığı (kullanıcının kararı):
 *
 *   | işin durumu            | araca etkisi                    | başlangıç |
 *   | devam ediyor           | pişen stat yarıya, DNF riski x2 | normal    |
 *   | bitmiş, claim edilmemiş| geliştirme TAM çalışır          | PİT YOLU  |
 *   | bitmiş ve claim edilmiş| tam çalışır                     | normal    |
 *   | casusluk (spy)         | yok                             | normal    |
 *
 * Orta satır işin özü: parça FİZİKEN araca takılmıştır, oyuncu onu henüz
 * teslim almamış olsa bile. O yüzden araç iyileşmeyle yarışır ve bedelini
 * pit yolundan başlayarak öder. Ceza ile telafi BİRLİKTE gelir; birini alıp
 * diğerini düşürmek mekaniği tersine çevirir (saf ceza).
 *
 * BU MODÜL `pending_jobs` TABLOSUNA YAZMAZ — yalnızca okur. Claim oyuncunun
 * eylemidir; yarıştan sonra da iş hâlâ claim edilmemiş durumdadır ve oyuncu
 * onu istediği zaman toplar. Buradaki cazip ama YANLIŞ "düzeltme", biten işi
 * otomatik claim etmektir: bu, kullanıcının bilerek seçtiği claim mekaniğini
 * yok eder (bkz. `server/src/economy/jobs.ts` başlığı).
 *
 * `now` HER ZAMAN çağırandan gelir; bu modül saati asla kendisi okumaz
 * (`server/README.md` §"now sadece route'ta örneklenir"). "Bitmiş mi" sorusu
 * `openJobs(..., now)`'ın hesapladığı `ready` alanından gelir.
 */
import { carId, type PitLaneStart } from '@pitwall/shared/raceEngine';
import { factoryEffects } from '@pitwall/shared/factory';
import { UPGRADE_GAIN } from '@pitwall/shared/carCustomisation';
import { loadLobbyEconomy, type CarStats } from '../economy/repo.ts';
import { openJobs, type OpenJob } from '../economy/jobs.ts';

/**
 * İş etiketi (`payload.stat`, küçük harf) → `crippleSetup`'ın beklediği
 * BÜYÜK harf etiket ve `car` alanı. Motorun `statFieldOf`'u büyük harf
 * kullanıyor, `pending_jobs.payload` ise küçük harf; çeviri tek yerde dursun.
 */
const UPGRADE_STAT: Record<string, { field: keyof CarStats; label: string }> = {
  motor: { field: 'motor', label: 'MOTOR' },
  aero: { field: 'aero', label: 'AERO' },
  grip: { field: 'grip', label: 'GRIP' },
};



/** Bir takımın yarışa hangi araçla ve hangi cezayla çıkacağı. */
export interface TeamParcFerme {
  teamKey: string;
  /**
   * Yarışın kullanacağı ETKİN araç. `lobby_economy.car` DEĞİLDİR: o sütun
   * yalnızca claim'de yükselir, oysa biten-ama-claim-edilmemiş bir parça da
   * araçta takılıdır. Burada o parça eklenmiş hâli döner; depodaki satıra
   * dokunulmaz.
   */
  car: CarStats;
  /**
   * Hâlâ tezgahtaki geliştirmenin etiketi (MOTOR/AERO/GRIP) ya da yoksa
   * `undefined`. Doğrudan `crippleSetup(setup, buildingLabel)`'a verilir.
   */
  buildingLabel?: string;
  /**
   * Devam eden bir geliştirme var mı — varsa güvenilirlik
   * `CRIPPLED_DNF_SCALE`'e bölünür (DNF riski katlanır).
   */
  crippled: boolean;
}

/**
 * Değerlendirmenin çıktısı; iki alan iki ayrı tüketiciye gider:
 *  - `byTeam` → `RaceSnapshot.entries` kurulurken (etkin araç + sakatlama),
 *  - `pitLaneStarts` → doğrudan `RaceInput.pitLaneStarts` (motorun grid'i).
 */
export interface ParcFermeVerdict {
  byTeam: Record<string, TeamParcFerme>;
  /** `carId` (`takım:sürücü`) → ceza. Boş nesne = ceza var, lastik serbest. */
  pitLaneStarts: Record<string, PitLaneStart>;
}

/** Bir takımın kendi kararı — saf: her şeyi çağıran verir. */
function verdictForTeam(
  teamKey: string,
  car: CarStats,
  factoryLevels: Record<string, number>,
  jobs: readonly OpenJob[],
): { team: TeamParcFerme; pitLaneCarIds: string[] } {
  // Etkin araç depodaki arabanın KOPYASI üzerinde kurulur: `loadLobbyEconomy`
  // satırını mutasyona uğratmak, çağıranın elindeki ekonomiyi sessizce
  // değiştirirdi.
  const effective: CarStats = { ...car };
  let buildingLabel: string | undefined;
  const pitLaneCarIds: string[] = [];

  for (const job of jobs) {
    // Casusluk aracı hiç ilgilendirmez: rapor tezgahta değil, masada.
    if (job.kind === 'spy') continue;

    if (!job.ready) {
      // Devam eden iş: parça henüz takılmadı, araç sökük yarışır. Grid yeri
      // KAYBEDİLMEZ — parc fermé ihlali yok, sadece eksik araç var.
      if (job.kind === 'upgrade') {
        const stat = job.payload['stat'];
        buildingLabel = typeof stat === 'string' ? UPGRADE_STAT[stat]?.label : undefined;
      }
      // Devam eden pilot çalışmasının araç statlarında karşılığı yok:
      // `crippleSetup` yalnızca motor/aero/grip biliyor, pilot Faz 3b'de
      // sunucuya taşınacak. Bugün sessizce etkisiz.
      continue;
    }

    // Buradan itibaren: iş BİTMİŞ ve hâlâ claim edilmemiş (`openJobs` zaten
    // yalnızca claim edilmemişleri döndürür). Parça araçta → parc fermé
    // ihlali → pit yolu.
    if (job.kind === 'upgrade') {
      const stat = job.payload['stat'];
      const mapping = typeof stat === 'string' ? UPGRADE_STAT[stat] : undefined;
      if (!mapping) continue; // tanınmayan payload: araca da grid'e de dokunma
      // TELAFİ: claim edilseydi ne kazanacaksa onu şimdi uygula. Aynı formül
      // `jobs.ts`'in `applyJobEffect`'i ile birebir aynı olmalı.
      const gain = UPGRADE_GAIN + factoryEffects(factoryLevels).upgradeGainBonus;
      effective[mapping.field] = effective[mapping.field] + gain;
      // CEZA: araç geliştirmesi takımın İKİ aracını da vurur — parça
      // şasiye değil, takımın paketine girer.
      pitLaneCarIds.push(carId({ teamKey, driverIdx: 0, driver: '' }));
      pitLaneCarIds.push(carId({ teamKey, driverIdx: 1, driver: '' }));
      continue;
    }

    // Pilot çalışması yalnız o pilotun aracını cezalandırır: takım arkadaşı
    // grid'deki yerinden normal başlar.
    const idx = job.payload['driverIdx'];
    if (idx === 0 || idx === 1) {
      pitLaneCarIds.push(carId({ teamKey, driverIdx: idx, driver: '' }));
    }
    // Yedek pilot (idx >= 2) yarışmıyor → cezalandıracak araç da yok.
  }

  return {
    team: { teamKey, car: effective, buildingLabel, crippled: buildingLabel !== undefined },
    pitLaneCarIds,
  };
}

/**
 * Lobideki her takım için parc fermé kararını üretir.
 *
 * Yalnızca okur: `lobby_economy` ve `pending_jobs` bu çağrıdan sonra da
 * aynıdır.
 */
export async function evaluateParcFerme(lobbyId: string, now: Date): Promise<ParcFermeVerdict> {
  const economies = await loadLobbyEconomy(lobbyId);
  const byTeam: Record<string, TeamParcFerme> = {};
  const pitLaneStarts: Record<string, PitLaneStart> = {};

  for (const econ of economies) {
    const jobs = await openJobs(lobbyId, econ.teamKey, now);
    const { team, pitLaneCarIds } = verdictForTeam(econ.teamKey, econ.car, econ.factoryLevels, jobs);
    byTeam[econ.teamKey] = team;
    for (const id of pitLaneCarIds) {
      // Boş nesne: ceza var, başlangıç lastiği seçimini çağıran doldurur
      // (serbest lastik telafisi — bkz. `PitLaneStart.compound`).
      pitLaneStarts[id] = {};
    }
  }

  return { byTeam, pitLaneStarts };
}
