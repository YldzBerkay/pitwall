/**
 * Verifies Facebook access tokens. Facebook has no JWKS — the token is opaque
 * and must be checked against the Graph debug_token endpoint using an app
 * access token, pinning the returned app_id to ours (otherwise anyone with
 * any Facebook app could mint a token and log in as that user on our service).
 */
import type { VerifiedIdentity } from './index.ts';

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';

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
    const debugRes = await fetch(debugUrl);
    if (!debugRes.ok) return null;
    const debugBody = (await debugRes.json()) as DebugTokenResponse;
    const data = debugBody.data;

    if (!data || data.is_valid !== true || data.app_id !== appId || !data.user_id) return null;

    const providerUid = data.user_id;
    let email: string | null = null;
    try {
      const meUrl = `${GRAPH_BASE}/me?fields=id,email&access_token=${encodeURIComponent(token)}`;
      const meRes = await fetch(meUrl);
      if (meRes.ok) {
        const meBody = (await meRes.json()) as MeResponse;
        email = typeof meBody.email === 'string' ? meBody.email : null;
      }
    } catch {
      email = null;
    }

    return { providerUid, email };
  } catch {
    return null;
  }
}
