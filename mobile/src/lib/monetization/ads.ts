/**
 * Rewarded ads, behind one function.
 *
 * `showRewardedAd()` resolves true only when the network reports the reward
 * was earned — closing early, a load failure, or a missing native module all
 * resolve false, so the caller never grants gold for nothing. The SDK is
 * react-native-google-mobile-ads; until the real ad units exist the app runs
 * on Google's public TEST unit ids, which serve real test creatives and can
 * never bill anyone. Swap `REWARDED_UNIT_ID` for production ids at launch.
 */

import { Platform } from 'react-native';

type AdsModule = typeof import('react-native-google-mobile-ads');

let mod: AdsModule | undefined;
let initialised = false;

function load(): AdsModule | undefined {
  if (mod) return mod;
  try {
    // Native module: absent in Expo Go and in any binary built before it was added.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional native module, must not throw at import time
    mod = require('react-native-google-mobile-ads') as AdsModule;
    return mod;
  } catch {
    return undefined;
  }
}

/** Google's public test rewarded unit; replace per platform for production. */
const REWARDED_UNIT_ID = (m: AdsModule): string =>
  Platform.select({ ios: m.TestIds.REWARDED, android: m.TestIds.REWARDED, default: m.TestIds.REWARDED });

export const adsAvailable = (): boolean => Boolean(load());

async function ensureInit(m: AdsModule) {
  if (initialised) return;
  initialised = true;
  try {
    await m.default().initialize();
  } catch {
    // Initialisation failing is not fatal for a load attempt; the load will report its own error.
  }
}

/**
 * Load and show one rewarded ad. Resolves when the ad closes.
 * @returns true if the reward was earned.
 */
export function showRewardedAd(timeoutMs = 15_000): Promise<boolean> {
  const m = load();
  if (!m) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let earned = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    void ensureInit(m).then(() => {
      const ad = m.RewardedAd.createForAdRequest(REWARDED_UNIT_ID(m), { requestNonPersonalizedAdsOnly: true });
      const unsubs = [
        ad.addAdEventListener(m.RewardedAdEventType.LOADED, () => ad.show().catch(() => done(false))),
        ad.addAdEventListener(m.RewardedAdEventType.EARNED_REWARD, () => { earned = true; }),
        ad.addAdEventListener(m.AdEventType.CLOSED, () => { unsubs.forEach((u) => u()); done(earned); }),
        ad.addAdEventListener(m.AdEventType.ERROR, () => { unsubs.forEach((u) => u()); done(false); }),
      ];
      ad.load();
      setTimeout(() => { if (!settled) { unsubs.forEach((u) => u()); done(false); } }, timeoutMs);
    });
  });
}
