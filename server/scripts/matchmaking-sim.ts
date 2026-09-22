/**
 * Eşleştirme dağılımı simülasyonu — spec §8, Faz 2 doğrulama kapısı.
 *
 * İddia şu: "Hızlı oyun bul"un ÖNERDİĞİ adayların belli bir oranında en
 * güçlü 3. ve 4. TAKIM gerçekten dolu olsun (§3.4; "n. araç" = güç
 * sırasındaki n. takım, bkz. grid.ts'teki SEAT_LADDER). Bu tek bir kartın
 * değil, kartlar akışının özelliğidir; dolayısıyla tek doğrulama yolu akışı
 * koşturup saymaktır — `npm run econ` ile aynı disiplin: denge bir görüş
 * değil, bir eşik meselesidir.
 *
 * Hedefler (%75/%65) dürüst tavanın (%80/%70, `honestCeiling`) ALTINDADIR ve
 * öyle kalmalıdır. Spec ilk yazıldığında %85/%75'ti; bu script o rakamların
 * 11 koltuklu ızgarada ulaşılamaz olduğunu ölçtü ve hedefler aşağı çekildi.
 * Tavanı yükseltmenin tek yolu koltuğu takım yerine tek araç yapmaktı —
 * tasarım gereği reddedildi: yönetici bir takım yönetir, tek araba değil.
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
import {
  CandidateShaper,
  DEFAULT_TARGETS,
  honestCeiling,
  occupancyOf,
  type Candidate,
} from '../src/lobby/matchmaking.ts';
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
  /** En güçlü 3. takımı dolu olan kartların oranı. */
  team3: number;
  /** En güçlü 4. takımı dolu olan kartların oranı. */
  team4: number;
  /** İlk iki takımı da dolu olan kartların oranı (§3.4, "yüksek ağırlık"). */
  topPair: number;
  /** İlk 3 / ilk 4 takımın TAMAMI dolu olan kartların oranı. */
  cumulativeTop3: number;
  cumulativeTop4: number;
  /**
   * Üst sınır: seçim anında havuzda o takımı GERÇEKTEN dolu en az bir aday
   * bulunma oranı. Hedefin tutulup tutulamayacağını belirleyen şey budur —
   * havuzda yoksa sunucunun yapabileceği bir şey yoktur ve uydurmaz (§3.4).
   */
  feasibleTeam3: number;
  feasibleTeam4: number;
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
  let team3 = 0;
  let team4 = 0;
  let topPair = 0;
  let cumulativeTop3 = 0;
  let cumulativeTop4 = 0;
  let feasibleTeam3 = 0;
  let feasibleTeam4 = 0;
  let poolTotal = 0;

  const record = (c: SimLobby) => {
    const o = occupancyOf(c.humanTeamKeys);
    served += 1;
    if (o.team3) team3 += 1;
    if (o.team4) team4 += 1;
    if (o.topPair) topPair += 1;
    if (o.topPair && o.team3) cumulativeTop3 += 1;
    if (o.topPair && o.team3 && o.team4) cumulativeTop4 += 1;
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
      if (pool.some((p) => occupancyOf(p.humanTeamKeys).team3)) feasibleTeam3 += 1;
      if (pool.some((p) => occupancyOf(p.humanTeamKeys).team4)) feasibleTeam4 += 1;

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
    team3: over(team3),
    team4: over(team4),
    topPair: over(topPair),
    cumulativeTop3: over(cumulativeTop3),
    cumulativeTop4: over(cumulativeTop4),
    feasibleTeam3: over(feasibleTeam3),
    feasibleTeam4: over(feasibleTeam4),
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
    `     3. takım ${pct(r.team3)} · 4. takım ${pct(r.team4)} · ilk ikisi ${pct(r.topPair)}` +
    ` · üst3 tamamı ${pct(r.cumulativeTop3)} · üst4 tamamı ${pct(r.cumulativeTop4)}` +
    `\n     havuzda vardı: 3. takım ${pct(r.feasibleTeam3)} · 4. takım ${pct(r.feasibleTeam4)}` +
    ` · ortalama havuz ${r.poolSize.toFixed(1)} lobi`
  );
}

function main(): void {
  let failed = 0;
  const check = (name: string, ok: boolean, detail = '') => {
    if (!ok) failed += 1;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const ceiling = { team3: honestCeiling(3), team4: honestCeiling(4) };

  console.log('§8 Faz 2 doğrulama kapısı — eşleştirme dağılımı\n');

  // ── 1. Sunucunun kontrol ettiği şey ──────────────────────────────────────
  // Sunucu havuzda o takımı dolu bir aday VARSA onu gösteriyor mu, ve hiçbir
  // zaman havuzda gerçekten var olandan fazlasını göstermiyor mu. Hedefin
  // tutulup tutulmaması havuzun işi; bu iki satır sunucunun işi.
  console.log('── 1. Sunucu elindekinin tamamını gösteriyor, fazlasını değil ──');
  for (const { label, options } of [...REALISTIC, ...SKEWED]) {
    const r = simulate(options);
    check(
      `${label}: 3. takım = min(hedef, havuz)`,
      r.team3 >= Math.min(DEFAULT_TARGETS.team3, r.feasibleTeam3) - TOLERANCE,
      `${pct(r.team3)} ≥ ${pct(Math.min(DEFAULT_TARGETS.team3, r.feasibleTeam3))}`,
    );
    check(
      `${label}: gerçeği aşmıyor`,
      r.team3 <= r.feasibleTeam3 + 1e-9 && r.team4 <= r.feasibleTeam4 + 1e-9,
      `${pct(r.team3)} ≤ ${pct(r.feasibleTeam3)} · ${pct(r.team4)} ≤ ${pct(r.feasibleTeam4)}`,
    );
  }

  // ── 2. Ölçülen dağılım ───────────────────────────────────────────────────
  console.log('\n── 2. Ölçülen dağılım ──');
  const measured: SimReport[] = [];
  for (const { label, options } of [...REALISTIC, ...SKEWED]) {
    const r = simulate(options);
    measured.push(r);
    console.log(`\n${label} · ${r.served} kart · ${r.lobbies} lobi (${r.freshLobbies} taze)`);
    console.log(line(r));
  }

  // ── 3. §3.4 hedefi ───────────────────────────────────────────────────────
  // Hedef, havuzun elverdiği en iyi gerçekçi dünyada tutmalı. Sakin bir
  // havuzda altında kalmak kusur değil — orada o lobiler yok, ve 1. bölüm
  // sunucunun elindekinin tamamını gösterdiğini zaten kanıtlıyor.
  console.log(
    `\n── 3. §3.4 hedefi (%${Math.round(DEFAULT_TARGETS.team3 * 100)} / %${Math.round(DEFAULT_TARGETS.team4 * 100)}) ──`,
  );
  const best = {
    team3: Math.max(...measured.map((r) => r.team3)),
    team4: Math.max(...measured.map((r) => r.team4)),
  };
  for (const rank of [3, 4] as const) {
    const key = `team${rank}` as const;
    console.log(
      `     ${rank}. takım · hedef ${pct(DEFAULT_TARGETS[key])}` +
        ` · dürüst tavan ${pct(ceiling[key])} · en iyi ölçüm ${pct(best[key])}`,
    );
  }
  console.log(
    "     Tavan = (11 - n) / (11 - 1): lobiyi dolduran 10 katılımcının ilk n-1'i,\n" +
      '     n. takım HENÜZ BOŞKEN gelmek zorunda — yoksa lobi hiç büyümez.\n' +
      '     Hedef bu çizginin ÜSTÜNE çıkarsa tutturmanın tek yolu boş koltuğu dolu\n' +
      '     göstermek olurdu; §3.4 bunu yasaklıyor. O yüzden hedef tavanın altında.',
  );
  for (const rank of [3, 4] as const) {
    const key = `team${rank}` as const;
    check(
      `§3.4: ${rank}. takım hedefi dürüst tavanın altında`,
      DEFAULT_TARGETS[key] < ceiling[key],
      `%${Math.round(DEFAULT_TARGETS[key] * 100)} < ${pct(ceiling[key])}`,
    );
    check(
      `§3.4: ${rank}. takım ≥ %${Math.round(DEFAULT_TARGETS[key] * 100)}`,
      best[key] >= DEFAULT_TARGETS[key] - TOLERANCE,
      pct(best[key]),
    );
  }

  console.log(failed === 0 ? '\nTÜMÜ GEÇTİ' : `\n${failed} KONTROL BAŞARISIZ`);
  process.exit(failed === 0 ? 0 : 1);
}

// Doğrudan çalıştırıldığında koş; test import ettiğinde koşma.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
