/**
 * Verifies Facebook access tokens. Facebook has no JWKS — the token is opaque
 * and must be checked against the Graph debug_token endpoint using an app
 * access token, pinning the returned app_id to ours (otherwise anyone with
 * any Facebook app could mint a token and log in as that user on our service).
 */
import type { VerifiedIdentity } from './index.ts';
import { logProviderInfraFailure } from './index.ts';

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';

// Interactive sign-in budget: 3-5s is the usual range for a path a human is
// actively waiting on. 4s rides out normal Graph API latency while keeping a
// hung Graph call from holding a connection open indefinitely on a server
// that also carries live WebSocket race traffic.
const GRAPH_TIMEOUT_MS = 4000;

interface DebugTokenResponse {
  data?: {
    is_valid?: boolean;
    app_id?: string;
    user_id?: string;
  };
}

interface MeResponse {
  id?: string;
  email?: string;
}

export async function verifyFacebookToken(token: string): Promise<VerifiedIdentity | null> {
  const appId = process.env.FACEBOOK_APP_ID;
  const appSecret = process.env.FACEBOOK_APP_SECRET;
  if (!appId || !appSecret) return null;

  try {
    const appAccessToken = `${appId}|${appSecret}`;
    const debugUrl = `${GRAPH_BASE}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(appAccessToken)}`;
    const debugRes = await fetch(debugUrl, { signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS) });
    if (!debugRes.ok) {
      // A non-2xx from Graph is an infrastructure problem, not a verdict on
      // the token — throw so the outer catch logs it, instead of collapsing
      // silently into the same null a forged token would produce.
      throw new Error(`debug_token endpoint responded with status ${debugRes.status}`);
    }
    const debugBody = (await debugRes.json()) as DebugTokenResponse;
    const data = debugBody.data;

    // From here on, a "no" is a token/app verdict from a healthy Graph
    // response, not an infrastructure failure — return null quietly.
    if (!data || data.is_valid !== true || data.app_id !== appId || !data.user_id) return null;

    const providerUid = data.user_id;
    let email: string | null = null;
    try {
      const meUrl = `${GRAPH_BASE}/me?fields=id,email&access_token=${encodeURIComponent(token)}`;
      const meRes = await fetch(meUrl, { signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS) });
      if (meRes.ok) {
        const meBody = (await meRes.json()) as MeResponse;
        email = typeof meBody.email === 'string' ? meBody.email : null;
      }
    } catch {
      // The /me lookup is best-effort (it only supplies the email); a
      // failure or timeout here does not invalidate an already-verified
      // identity, so it stays quiet and just leaves email null.
      email = null;
    }

    return { providerUid, email };
  } catch (err) {
    // Everything that reaches this point (network failure, timeout, non-2xx,
    // unparsable body) is an infrastructure problem — every ordinary token
    // rejection above returns null directly without throwing.
    logProviderInfraFailure('facebook', err);
    return null;
  }
}
