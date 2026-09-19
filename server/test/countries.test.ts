import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COUNTRIES, countryByCode, isCountryCode } from '../src/identity/countries.ts';
import { REGIONS, isRegion, REGION_RACE_HOUR, REGION_LABEL } from '../src/identity/region.ts';

describe('region', () => {
  it('has seven buckets', () => {
    assert.equal(REGIONS.length, 7);
  });

  it('gives every bucket a race hour and a label', () => {
    for (const r of REGIONS) {
      assert.ok(REGION_RACE_HOUR[r], `no race hour for ${r}`);
      assert.ok(REGION_LABEL[r], `no label for ${r}`);
      assert.ok(REGION_RACE_HOUR[r].hour >= 0 && REGION_RACE_HOUR[r].hour <= 23);
      new Intl.DateTimeFormat('en', { timeZone: REGION_RACE_HOUR[r].timeZone });
    }
  });

  it('recognises only known buckets', () => {
    assert.equal(isRegion('EU'), true);
    assert.equal(isRegion('MARS'), false);
    assert.equal(isRegion(42), false);
  });
});

describe('countries', () => {
  it('covers at least 200 territories', () => {
    assert.ok(COUNTRIES.length >= 200, `only ${COUNTRIES.length} countries generated`);
  });

  it('uses two-letter uppercase ISO codes, each one only once', () => {
    const codes = COUNTRIES.map((c) => c.code);
    assert.equal(new Set(codes).size, codes.length);
    for (const code of codes) assert.match(code, /^[A-Z]{2}$/);
  });

  it('assigns every country to a valid region', () => {
    for (const c of COUNTRIES) {
      assert.ok(isRegion(c.region), `${c.code} has invalid region ${c.region}`);
    }
  });

  it('names countries in their own language, not in English', () => {
    assert.equal(countryByCode('TR')?.name, 'Türkiye');
    assert.equal(countryByCode('DE')?.name, 'Deutschland');
    assert.equal(countryByCode('ES')?.name, 'España');
    assert.equal(countryByCode('JP')?.name, '日本');
    assert.equal(countryByCode('GR')?.name, 'Ελλάδα');
    assert.equal(countryByCode('IT')?.name, 'Italia');
  });

  it('puts the obvious countries in the obvious buckets', () => {
    assert.equal(countryByCode('TR')?.region, 'MENA');
    assert.equal(countryByCode('DE')?.region, 'EU');
    assert.equal(countryByCode('US')?.region, 'NA');
    assert.equal(countryByCode('BR')?.region, 'LATAM');
    assert.equal(countryByCode('JP')?.region, 'APAC');
    assert.equal(countryByCode('ID')?.region, 'SEA');
    assert.equal(countryByCode('AU')?.region, 'OCE');
    assert.equal(countryByCode('EG')?.region, 'MENA');
    // Sahra altı Afrika'nın kendi kovası yok; saat dilimi olarak EU'ya düşer.
    assert.equal(countryByCode('NG')?.region, 'EU');
  });

  it('validates codes', () => {
    assert.equal(isCountryCode('TR'), true);
    assert.equal(isCountryCode('XX'), false);
    assert.equal(isCountryCode('tr'), false);
  });
});
