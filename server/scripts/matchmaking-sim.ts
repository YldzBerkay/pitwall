/**
 * Eşleştirme dağılımı simülasyonu — spec §8, Faz 2 doğrulama kapısı.
 *
 * İddia şu: "Hızlı oyun bul"un ÖNERDİĞİ adayların %85'inde en güçlü 3.
 * araç, %75'inde en güçlü 4. araç GERÇEKTEN dolu olsun (§3.4). Bu tek bir
 * kartın değil, kartlar akışının özelliğidir; dolayısıyla tek doğrulama yolu
 * akışı koşturup saymaktır — `npm run econ` ile aynı disiplin: denge bir
 * görüş değil, bir eşik meselesidir.
 *
 *   npm run sim:matchmaking
 *
 * Simülasyon sahte doluluk ÜRETMEZ. Dünya modeli gerçek oyuncu davranışını
 * taklit eder (lobi kuran en iyi arabayı kapar, gelen oyuncu kalanların en
 * iyisini alır), sunucu kodu da gerçeğidir: `CandidateShaper` burada üretimde
 * çağrıldığı gibi çağrılır. Ölçülen oran, kartların yansıttığı oranın ta
 * kendisidir.
 */
import { fileURLToPath } from 'node:url';
import { CandidateShaper, occupancyOf, DEFAULT_TARGETS, type Candidate } from '../src/lobby/matchmaking.ts';
import { SEAT_LADDER } from '../src/lobby/grid.ts';

/** Tekrarlanabilir rastgelelik — aynı tohum, aynı rapor. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimLobby extends Candidate {
  human: Set<string>;
  free: string[];
  /** Sezonu biten lobi havuzdan çıkar — dolmuş olsun olmasın. */
  retiresAt: number;
}

export interface SimOptions {
  /** Kaç oyuncu geliyor (gösterilen kart sayısı değil). */
  requests: number;
  /** Gösterilen kartı kabul etme olasılığı; kalanı "Başka bul". */
  acceptRate: number;
  /** Lobi kuranın / katılanın kalanların EN İYİSİNİ seçme olasılığı. */
  greedRate: number;
  /**
   * Gelen oyuncunun "Hızlı oyun bul" yerine "Lobi kur" deme olasılığı (§4.2:
   * ikisi de genel ekranda eşit ağırlıkta duruyor). Havuzun büyüklüğünü
   * belirleyen ana parametre budur.
   */
  createRate: number;
  /** Bir lobinin sezonu kaç gelişlik sürüyor — havuzda kalma süresi. */
  seasonSpan: number;
  seed: number;
  /** Dağılımı şekillendirmeden, havuzdan düz rastgele seç (karşılaştırma). */
  naive?: boolean;
}

export interface SimReport {
  /** Gösterilen kart sayısı — oranların paydası. */
  served: number;
  /** En güçlü 3. aracı dolu olan kartların oranı. */
  car3: number;
  /** En güçlü 4. aracı dolu olan kartların oranı. */
  car4: number;
  /** İlk iki aracı da dolu olan kartların oranı (§3.4, "yüksek ağırlık"). */
  topPair: number;
  /** İlk 3 / ilk 4 aracın TAMAMI dolu olan kartların oranı. */
  cumulativeTop3: number;
  cumulativeTop4: number;
  /**
   * Üst sınır: seçim anında havuzda o aracı GERÇEKTEN dolu en az bir aday
   * bulunma oranı. Hedefin tutulup tutulamayacağını belirleyen şey budur —
   * havuzda yoksa sunucunun yapabileceği bir şey yoktur ve uydurmaz (§3.4).
   */
  feasibleCar3: number;
  feasibleCar4: number;
  /** Seçim anındaki ortalama havuz büyüklüğü. */
  poolSize: number;
  /** Havuzda hiç aday kalmadığı için açılan taze lobi sayısı (§3.4). */
  freshLobbies: number;
  lobbies: number;
}

function seat(lobby: SimLobby, random: () => number, greedRate: number): void {
  if (lobby.free.length === 0) return;
  // Oyuncu çoğunlukla kalanların en iyisini alır — §3.4'ün "lobi kuranlar en
  // iyi arabayı ilk kapar, dolayısıyla üst koltuklar zaten gerçekten dolu"
  // gözlemi bu davranıştan doğar, dağıtımdan değil.
  const index = random() < greedRate ? 0 : Math.floor(random() * lobby.free.length);
  const [taken] = lobby.free.splice(index, 1);
  lobby.human.add(taken);
  lobby.humanTeamKeys = [...lobby.human];
}

export function simulate(options: SimOptions): SimReport {
  const { requests, acceptRate, greedRate, createRate, seasonSpan, seed, naive = false } = options;
  const random = mulberry32(seed);
  const shaper = new CandidateShaper(DEFAULT_TARGETS);

  let lobbies: SimLobby[] = [];
  let nextId = 1;
  let freshLobbies = 0;

  const openLobby = (tick: number): SimLobby => {
    const lobby: SimLobby = {
      lobbyId: `L${nextId++}`,
      humanTeamKeys: [],
      human: new Set(),
      free: [...SEAT_LADDER],
      retiresAt: tick + seasonSpan,
    };
    // Kurucu hemen oturur; oturmazsa lobi hiçbir havuzda görünmez (§3.2).
    seat(lobby, random, greedRate);
    lobbies.push(lobby);
    return lobby;
  };

  let served = 0;
  let car3 = 0;
  let car4 = 0;
  let topPair = 0;
  let cumulativeTop3 = 0;
  let cumulativeTop4 = 0;
  let feasibleCar3 = 0;
  let feasibleCar4 = 0;
  let poolTotal = 0;

  const record = (c: SimLobby) => {
    const o = occupancyOf(c.humanTeamKeys);
    served += 1;
    if (o.car3) car3 += 1;
    if (o.car4) car4 += 1;
    if (o.topPair) topPair += 1;
    if (o.topPair && o.car3) cumulativeTop3 += 1;
    if (o.topPair && o.car3 && o.car4) cumulativeTop4 += 1;
  };

  for (let tick = 0; tick < requests; tick += 1) {
    // Sezonu biten lobiler havuzdan düşer.
    if (tick % 64 === 0) lobbies = lobbies.filter((l) => l.retiresAt > tick);

    if (random() < createRate) {
      openLobby(tick);
      continue;
    }

    // Bir oturum: kart gelir, oyuncu ya seçer ya "Başka bul" der. Her kart
    // sayılır — oran GÖSTERİLEN adaylar üzerindendir.
    const shown = new Set<string>();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const pool = lobbies.filter(
        (l) => l.free.length > 0 && l.retiresAt > tick && !shown.has(l.lobbyId),
      );
      if (pool.length === 0) {
        // Hiç uygun aday yok → taze lobi (§3.4). Bu bir KART DEĞİLDİR.
        openLobby(tick);
        freshLobbies += 1;
        break;
      }

      poolTotal += pool.length;
      if (pool.some((p) => occupancyOf(p.humanTeamKeys).car3)) feasibleCar3 += 1;
      if (pool.some((p) => occupancyOf(p.humanTeamKeys).car4)) feasibleCar4 += 1;

      const chosen: SimLobby | null = naive
        ? pool[Math.floor(random() * pool.length)]
        : shaper.pick(pool, random);
      /* c8 ignore next -- pool boş değilse pick null dönmez */
      if (!chosen) break;
      record(chosen);
      shown.add(chosen.lobbyId);

      if (random() < acceptRate) {
        seat(chosen, random, greedRate);
        break;
      }
    }
  }

  const over = (n: number) => (served ? n / served : 0);
  return {
    served,
    car3: over(car3),
    car4: over(car4),
    topPair: over(topPair),
    cumulativeTop3: over(cumulativeTop3),
    cumulativeTop4: over(cumulativeTop4),
    feasibleCar3: over(feasibleCar3),
    feasibleCar4: over(feasibleCar4),
    poolSize: over(poolTotal),
    freshLobbies,
    lobbies: nextId - 1,
  };
}

// ── Rapor ──────────────────────────────────────────────────────────────────

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** Hedefe yaklaşma payı; ±2 puan kabul edilir. */
const TOLERANCE = 0.02;

interface World {
  label: string;
  options: SimOptions;
}

/**
 * Üç gerçekçi dünya. Ortak varsayım §3.4'ünkü: oyuncu kalanların en iyisini
 * alır (greedRate yüksek). Değişen şey talep yoğunluğu.
 */
const REALISTIC: World[] = [
  {
    label: 'sakin havuz  (kabul %45)',
    options: { requests: 30_000, acceptRate: 0.45, greedRate: 0.75, createRate: 0.05, seasonSpan: 2000, seed: 1 },
  },
  {
    label: 'normal havuz (kabul %70)',
    options: { requests: 30_000, acceptRate: 0.7, greedRate: 0.8, createRate: 0.065, seasonSpan: 2000, seed: 2 },
  },
  {
    label: 'doymuş havuz (kabul %90)',
    options: { requests: 30_000, acceptRate: 0.9, greedRate: 0.85, createRate: 0.08, seasonSpan: 2000, seed: 3 },
  },
];

/**
 * §3.4'ün varsayımının ÇÖKTÜĞÜ dünya: oyuncular en iyi arabayı kapmıyor,
 * rastgele koltuk seçiyor. Üst koltuklar doğal olarak dolmuyor, dolayısıyla
 * havuzda hedefi tutturacak aday YOK. Burada beklenen sonuç "hedef tutuyor"
 * değil, "sunucu uydurmuyor"dur.
 */
const SKEWED: World[] = [
  {
    label: 'çarpık havuz (rastgele koltuk)',
    options: { requests: 30_000, acceptRate: 0.7, greedRate: 0.2, createRate: 0.065, seasonSpan: 2000, seed: 5 },
  },
];

function line(r: SimReport): string {
  return (
    `     3. araç ${pct(r.car3)} · 4. araç ${pct(r.car4)} · ilk ikisi ${pct(r.topPair)}` +
    ` · üst3 tamamı ${pct(r.cumulativeTop3)} · üst4 tamamı ${pct(r.cumulativeTop4)}` +
    `\n     havuzda vardı: 3. araç ${pct(r.feasibleCar3)} · 4. araç ${pct(r.feasibleCar4)}` +
    ` · ortalama havuz ${r.poolSize.toFixed(1)} lobi`
  );
}

function main(): void {
  let failed = 0;
  const check = (name: string, ok: boolean, detail = '') => {
    if (!ok) failed += 1;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  console.log('§8 Faz 2 doğrulama kapısı — eşleştirme dağılımı\n');
  console.log('── 1. Hedefler tutuyor mu (gerçekçi havuzlar) ──');
  for (const { label, options } of REALISTIC) {
    const r = simulate(options);
    console.log(`\n${label} · ${r.served} kart · ${r.lobbies} lobi (${r.freshLobbies} taze)`);
    console.log(line(r));
    // Hedef bir TABANDIR: sözü verilen doluluk. Üstüne çıkmak sözü bozmaz,
    // altına düşmek bozar.
    check(`${label}: 3. araç ≥ %85`, r.car3 >= DEFAULT_TARGETS.car3 - TOLERANCE, pct(r.car3));
    check(`${label}: 4. araç ≥ %75`, r.car4 >= DEFAULT_TARGETS.car4 - TOLERANCE, pct(r.car4));
  }

  console.log('\n── 2. Sunucu havuzdan alabileceğinin tamamını alıyor mu ──');
  // Beklenen oran min(hedef, havuzda var olan)'dır. Havuz bollaştığında
  // sunucu hedefin üstüne ÇIKMAZ (§3.4 bir dağılımdır, "hep en dolusunu
  // göster" değil); havuz kıtlaştığında da altında kalmaz — elindekinin
  // tamamını gösterir.
  for (const { label, options } of [...REALISTIC, ...SKEWED]) {
    const r = simulate(options);
    check(
      `${label}: 3. araç = min(hedef, havuz)`,
      r.car3 >= Math.min(DEFAULT_TARGETS.car3, r.feasibleCar3) - TOLERANCE,
      `${pct(r.car3)} ≥ ${pct(Math.min(DEFAULT_TARGETS.car3, r.feasibleCar3))}`,
    );
    // 4. araç aynı ölçüyle yalnızca 3. araç hedefi tutuyorken ölçülebilir.
    // Kıt havuzda iki ölçüt AYNI kartı ister ama farklı lobilerde bulunur:
    // 4. aracı dolu ama 3. aracı boş bir lobiyi göstermek, 3. araç oranını
    // düşürmeden olmaz. §3.4 sıralaması nettir — 3. araç üstte yazar, o
    // yüzden çakışmada o kazanır ve burada 4. araç ölçülmez, raporlanır.
    if (r.feasibleCar3 >= DEFAULT_TARGETS.car3) {
      check(
        `${label}: 4. araç = min(hedef, havuz)`,
        r.car4 >= Math.min(DEFAULT_TARGETS.car4, r.feasibleCar4) - TOLERANCE,
        `${pct(r.car4)} ≥ ${pct(Math.min(DEFAULT_TARGETS.car4, r.feasibleCar4))}`,
      );
    } else {
      console.log(`     (${label}: 3. araç kıt — 4. araç ${pct(r.car4)}, havuzda ${pct(r.feasibleCar4)})`);
    }
  }

  console.log('\n── 3. Kıtlıkta uydurmuyor (§3.4 dürüst doluluk) ──');
  for (const { label, options } of SKEWED) {
    const r = simulate(options);
    console.log(`\n${label} · ${r.served} kart`);
    console.log(line(r));
    // Hedefin ALTINDA kalması beklenir: havuzda o aday yok. Kritik olan,
    // oranın havuzda gerçekten var olanı BİR PUAN BİLE aşmamasıdır — aşsaydı
    // sunucu dolu olmayan bir koltuğu dolu göstermiş olurdu.
    check(`${label}: hedefin altında (havuz kıt)`, r.car3 < DEFAULT_TARGETS.car3 - TOLERANCE, pct(r.car3));
    check(`${label}: gerçeği aşmıyor`, r.car3 <= r.feasibleCar3 + 1e-9, `${pct(r.car3)} ≤ ${pct(r.feasibleCar3)}`);
    check(`${label}: 4. araç gerçeği aşmıyor`, r.car4 <= r.feasibleCar4 + 1e-9, `${pct(r.car4)} ≤ ${pct(r.feasibleCar4)}`);
  }

  console.log(failed === 0 ? '\nTÜMÜ GEÇTİ' : `\n${failed} KONTROL BAŞARISIZ`);
  process.exit(failed === 0 ? 0 : 1);
}

// Doğrudan çalıştırıldığında koş; test import ettiğinde koşma.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
