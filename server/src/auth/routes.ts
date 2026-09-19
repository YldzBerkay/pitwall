/**
 * HTTP endpoints over ../auth/service.ts.
 *
 * These handlers receive plaintext passwords and provider tokens in
 * ctx.body. NEVER interpolate ctx.body, an email, a password, or a token
 * into an Error, a log line, or a response body — the router's catch-all
 * logs a thrown error's message verbatim (see src/http/router.ts), and
 * doing so would write a secret straight into the server log.
 */
import type { Router, RequestContext, RouteResult } from '../http/router.ts';
import { publicProfile } from '../identity/routes.ts';
import {
  authenticateSocial,
  registerWithPassword,
  loginWithPassword,
  AuthError,
  type AuthResult,
} from './service.ts';

const STATUS_BY_CODE: Record<string, number> = {
  invalid_token: 401,
  invalid_credentials: 401,
  email_taken: 409,
};

function statusForAuthError(err: AuthError): number {
  return STATUS_BY_CODE[err.code] ?? 400;
}

function authResultToBody(result: AuthResult): { status: number; body: unknown } {
  return {
    status: result.isNew ? 201 : 200,
    body: { token: result.token, isNew: result.isNew, user: publicProfile(result.user) },
  };
}

/** Reads a body field defensively — anything but a string becomes ''. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Reads an optional onboarding string field: undefined stays undefined, anything but a string is dropped. */
function optStr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function handleSocial(ctx: RequestContext): Promise<RouteResult> {
  try {
    const result = await authenticateSocial({
      provider: str(ctx.body.provider),
      token: str(ctx.body.token),
      nicknameBase: optStr(ctx.body.nicknameBase),
      countryCode: optStr(ctx.body.countryCode),
      region: optStr(ctx.body.region),
    });
    return authResultToBody(result);
  } catch (err) {
    if (err instanceof AuthError) return { status: statusForAuthError(err), body: { error: err.code } };
    throw err;
  }
}

async function handlePasswordRegister(ctx: RequestContext): Promise<RouteResult> {
  try {
    const result = await registerWithPassword({
      email: str(ctx.body.email),
      password: str(ctx.body.password),
      nicknameBase: optStr(ctx.body.nicknameBase),
      countryCode: optStr(ctx.body.countryCode),
      region: optStr(ctx.body.region),
    });
    return authResultToBody(result);
  } catch (err) {
    if (err instanceof AuthError) return { status: statusForAuthError(err), body: { error: err.code } };
    throw err;
  }
}

async function handlePasswordLogin(ctx: RequestContext): Promise<RouteResult> {
  try {
    const result = await loginWithPassword({
      email: str(ctx.body.email),
      password: str(ctx.body.password),
    });
    return authResultToBody(result);
  } catch (err) {
    if (err instanceof AuthError) return { status: statusForAuthError(err), body: { error: err.code } };
    throw err;
  }
}

export function registerAuthRoutes(router: Router): void {
  router.post('/auth/social', handleSocial);
  router.post('/auth/password/register', handlePasswordRegister);
  router.post('/auth/password/login', handlePasswordLogin);
}
