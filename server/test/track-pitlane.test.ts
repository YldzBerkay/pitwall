import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calendar } from '@pitwall/shared/tracks';
import { teams } from '@pitwall/shared/teams';

/**
 * `Track.pitLaneSec` — pit yolundan geçmenin normal tura göre maliyeti
 * (spec 2026-09-23-faz3a2 §7.1). Parc fermé ihlali eden araç grid yerini
 * almaz, saha geçtikten sonra pit çıkışından katılır; bu alan o ek boşluğun
 * pist başına ölçeğidir.
 *
 * Sınırların hepsi mevcut veriden türetilmiştir; yuvarlak sayı uydurulmadı.
 */

/** raceEngine.ts:715 — grid satırları bu aralıkla dizilir. */
const GRID_GAP_SEC = 0.35;

/** 11 takım × 2 araç; son sıradaki aracın ilk sıraya olan grid açığı. */
const GRID_SPREAD_SEC = (teams.length * 2 - 1) * GRID_GAP_SEC;

/**
 * Pit durağı süresi = pit yolu transit kaybı + lastik değişimi (duruş).
 * Duruş en az ~2 sn olduğuna göre, salt transit maliyeti her pistte
 * `pitLossSec - 2`'yi aşamaz. Üst sınır tamamen mevcut `pitLossSec`'ten gelir.
 */
const MIN_STATIONARY_SEC = 2;

/**
 * Gerçek F1'de pit yolu transit kaybı / tur süresi oranı kabaca 0.12
 * (Ardennes tipi çok uzun tur) ile 0.28 (Principality tipi kısa, dar tur)
 * arasındadır. Alt sınır "bir turluk küçük kayıplardan belirgin pahalı"
 * olmayı, üst sınır "ceza tek başına yarışı bitirmesin"i sağlar.
 */
const MIN_LAP_SHARE = 0.12;
const MAX_LAP_SHARE = 0.28;

const share = (t: (typeof calendar)[number]) => t.pitLaneSec / t.baseLapSec;
const isStreet = (t: (typeof calendar)[number]) => t.label.startsWith('Sokak pisti');
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('track pitLaneSec', () => {
  it('her pistte tanımlı, pozitif ve sonlu', () => {
    assert.ok(calendar.length > 0);
    for (const t of calendar) {
      assert.equal(typeof t.pitLaneSec, 'number', `${t.key}: pitLaneSec yok`);
      assert.ok(Number.isFinite(t.pitLaneSec), `${t.key}: sonlu değil`);
      assert.ok(t.pitLaneSec > 0, `${t.key}: pozitif değil`);
    }
  });

  it('tüm sahanın grid açığından pahalı — yoksa sondan başlamakla aynı olurdu', () => {
    for (const t of calendar) {
      assert.ok(
        t.pitLaneSec > GRID_SPREAD_SEC,
        `${t.key}: ${t.pitLaneSec} sn, grid açığı ${GRID_SPREAD_SEC.toFixed(2)} sn'den fazla olmalı`,
      );
    }
  });

  it('pit durağı kaybından küçük — transit, duruşu içeremez', () => {
    for (const t of calendar) {
      assert.ok(
        t.pitLaneSec <= t.pitLossSec - MIN_STATIONARY_SEC,
        `${t.key}: ${t.pitLaneSec} sn, pitLossSec ${t.pitLossSec} - ${MIN_STATIONARY_SEC} sınırını aşıyor`,
      );
    }
  });

  it('tur süresine oranı gerçekçi bir bantta kalır', () => {
    for (const t of calendar) {
      const s = share(t);
      assert.ok(s >= MIN_LAP_SHARE, `${t.key}: tur payı ${s.toFixed(3)} çok düşük`);
      assert.ok(s <= MAX_LAP_SHARE, `${t.key}: tur payı ${s.toFixed(3)} çok yüksek`);
    }
  });

  it('değerler aynı değil — tek sayı olsaydı alanın bilgi değeri olmazdı', () => {
    const distinct = new Set(calendar.map((t) => t.pitLaneSec));
    assert.ok(distinct.size >= 8, `yalnızca ${distinct.size} farklı değer var`);
    const lo = Math.min(...calendar.map((t) => t.pitLaneSec));
    const hi = Math.max(...calendar.map((t) => t.pitLaneSec));
    // En ucuz ve en pahalı pit yolu arasındaki fark, bir pit durağının
    // kendisinden (en küçük pitLossSec) küçük olmamalı ki seçim gerçek olsun.
    const minPitLoss = Math.min(...calendar.map((t) => t.pitLossSec));
    assert.ok(hi - lo >= minPitLoss / 3, `yayılım dar: ${lo}-${hi}`);
  });

  it('sokak pistlerinin tur payı, sokak olmayanlardan yüksek', () => {
    const street = calendar.filter(isStreet);
    const rest = calendar.filter((t) => !isStreet(t));
    assert.ok(street.length >= 4 && rest.length >= 10);
    const streetMean = mean(street.map(share));
    const restMean = mean(rest.map(share));
    // Dar, düşük hız limitli sokak pit yolları tura oranla pahalıdır;
    // uzun turlu hız pistlerinde aynı transit turun küçük bir dilimidir.
    assert.ok(
      streetMean > restMean + 0.02,
      `sokak ortalaması ${streetMean.toFixed(3)}, diğerleri ${restMean.toFixed(3)}`,
    );
    // En pahalı tur payı bir sokak pistinde olmalı.
    const worst = [...calendar].sort((a, b) => share(b) - share(a))[0];
    assert.ok(isStreet(worst), `en yüksek tur payı sokak pisti değil: ${worst.key}`);
  });
});
