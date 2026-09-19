/**
 * In-app purchases for gold packs, behind one function.
 *
 * `purchaseGoldPack(sku)` resolves true only when the store confirms the
 * purchase and the transaction is finished as a consumable. The SDK is
 * react-native-iap (OpenIAP API). What still has to exist outside the code:
 * the products themselves in App Store Connect / Google Play Console, with
 * exactly the SKUs in `economy.ts`. Until then the store returns "not found"
 * and this resolves false — nothing is granted.
 */

import { Platform } from 'react-native';

type IapModule = typeof import('react-native-iap');

let mod: IapModule | undefined;
let connected = false;

function load(): IapModule | undefined {
  if (mod) return mod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional native module, must not throw at import time
    mod = require('react-native-iap') as IapModule;
    return mod;
  } catch {
    return undefined;
  }
}

export const iapAvailable = (): boolean => Boolean(load());

async function ensureConnection(m: IapModule): Promise<boolean> {
  if (connected) return true;
  try {
    connected = Boolean(await m.initConnection());
  } catch {
    connected = false;
  }
  return connected;
}

/** Store price labels for the packs, when the store knows them; undefined otherwise. */
export async function fetchPackPrices(skus: string[]): Promise<Record<string, string>> {
  const m = load();
  if (!m || !(await ensureConnection(m))) return {};
  try {
    const products = await m.fetchProducts({ skus, type: 'in-app' });
    const out: Record<string, string> = {};
    for (const p of products ?? []) {
      const product = p as unknown as { id?: string; productId?: string; displayPrice?: string; localizedPrice?: string };
      const id = product.id ?? product.productId;
      const price = product.displayPrice ?? product.localizedPrice;
      if (id && price) out[id] = price;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Buy one consumable pack. Resolves when the store confirms or fails.
 * @returns true when the purchase completed and was finished (consumed).
 */
export function purchaseGoldPack(sku: string, timeoutMs = 60_000): Promise<boolean> {
  const m = load();
  if (!m) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
    void ensureConnection(m).then(async (ok) => {
      if (!ok) return done(false);
      const updated = m.purchaseUpdatedListener(async (purchase) => {
        const bought = (purchase as unknown as { productId?: string; id?: string });
        if ((bought.productId ?? bought.id) !== sku) return;
        try {
          await m.finishTransaction({ purchase, isConsumable: true });
          done(true);
        } catch {
          done(false);
        } finally {
          updated.remove();
          failed.remove();
        }
      });
      const failed = m.purchaseErrorListener(() => {
        updated.remove();
        failed.remove();
        done(false);
      });
      try {
        await m.requestPurchase({
          request: Platform.OS === 'ios' ? { apple: { sku } } : { google: { skus: [sku] } },
          type: 'in-app',
        });
      } catch {
        updated.remove();
        failed.remove();
        done(false);
      }
      setTimeout(() => { updated.remove(); failed.remove(); done(false); }, timeoutMs);
    });
  });
}
