/**
 * A lobby races once a day, at its region's local evening hour (§3.1: the
 * daily race time is DERIVED from the region, the creator does not pick it).
 *
 * The hour lives in `identity/region.ts` as an IANA zone plus a local hour,
 * so the instant has to be resolved through that zone rather than by adding a
 * fixed offset: a lobby created in March must not slide an hour when the zone
 * changes over, and "21:00 in Europe/Berlin" is a different UTC instant in
 * January than in July.
 */
import { REGION_RACE_HOUR, type Region } from '../identity/region.ts';

/**
 * Milliseconds to add to a UTC instant to read it as wall-clock time in
 * `timeZone`, evaluated AT that instant (so it carries the right DST state).
 */
function zoneOffsetMs(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);

  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  // Intl renders midnight as hour 24 in the hour12:false cycle; Date.UTC
  // rolls that over correctly, so it needs no special-casing.
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - at.getTime();
}

/** The UTC instant of `hour:00` local time on the local day containing `at`. */
function localHourInstant(timeZone: string, at: Date, hour: number): number {
  const offset = zoneOffsetMs(timeZone, at);
  const local = new Date(at.getTime() + offset);
  const naive = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour);
  // First subtraction uses the offset in effect now; re-reading the offset at
  // the candidate instant corrects the case where the clocks change between
  // the two (a race hour on a spring-forward night).
  const firstGuess = naive - offset;
  return naive - zoneOffsetMs(timeZone, new Date(firstGuess));
}

/** The next daily race instant for a region, strictly after `now`. */
export function nextRaceAt(region: Region, now: Date = new Date()): Date {
  const { timeZone, hour } = REGION_RACE_HOUR[region];
  const today = localHourInstant(timeZone, now, hour);
  if (today > now.getTime()) return new Date(today);
  return new Date(localHourInstant(timeZone, new Date(now.getTime() + 24 * 60 * 60 * 1000), hour));
}
