/**
 * A deliberately small method+path router for node:http.
 *
 * `handle` returns false when nothing matched, so the existing league
 * endpoints in index.ts keep working untouched.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError, sendJson, CORS_HEADERS } from './respond.ts';

const MAX_BODY_BYTES = 64 * 1024;

export interface RequestContext {
  req: IncomingMessage;
  url: URL;
  body: Record<string, unknown>;
  /** Bearer token from the Authorization header, or ''. */
  bearer: string;
}

export interface RouteResult {
  status: number;
  body: unknown;
}

export type Handler = (ctx: RequestContext) => Promise<RouteResult>;

type Method = 'GET' | 'POST' | 'PATCH';

class BodyTooLargeError extends Error {}
class InvalidJsonError extends Error {}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new InvalidJsonError();
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new InvalidJsonError();
  }
}

export class Router {
  private readonly routes = new Map<string, Handler>();
  // Exact set of registered pathnames (independent of method), used to
  // decide whether an OPTIONS preflight should be answered. A Set with
  // exact-match lookup avoids the false positives a suffix/endsWith check
  // would produce (e.g. a registered "/auth/social" must not match an
  // OPTIONS for "/social").
  private readonly paths = new Set<string>();

  private add(method: Method, path: string, handler: Handler): this {
    this.routes.set(`${method} ${path}`, handler);
    this.paths.add(path);
    return this;
  }

  get(path: string, handler: Handler): this { return this.add('GET', path, handler); }
  post(path: string, handler: Handler): this { return this.add('POST', path, handler); }
  patch(path: string, handler: Handler): this { return this.add('PATCH', path, handler); }

  /** Returns true when the request was handled. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS' && this.paths.has(url.pathname)) {
      res.writeHead(204, CORS_HEADERS).end();
      return true;
    }

    const handler = this.routes.get(`${method} ${url.pathname}`);
    if (!handler) return false;

    let body: Record<string, unknown>;
    try {
      body = method === 'GET' ? {} : await readBody(req);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        // readBody stopped consuming the stream as soon as the limit was
        // crossed, so the rest of the oversized body (the client may still
        // be writing it) is left sitting unread on the socket. On a
        // keep-alive connection that leftover application data would be
        // parsed as the start of the NEXT request on reuse, corrupting it
        // (verified: without this, the client's following request on the
        // same connection fails with ECONNRESET). Force the connection to
        // close — telling the client not to reuse it — and destroy the
        // socket once the response is flushed so we don't sit here
        // draining an unbounded body into nowhere either, which is a cheap
        // DoS vector on a server that also holds long-lived race
        // WebSocket connections.
        res.setHeader('connection', 'close');
        sendError(res, 413, 'body_too_large');
        res.once('finish', () => req.destroy());
        return true;
      }
      sendError(res, 400, 'invalid_json');
      return true;
    }

    const auth = req.headers.authorization ?? '';
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';

    try {
      const result = await handler({ req, url, body, bearer });
      sendJson(res, result.status, result.body);
    } catch (err) {
      // İstemciye hiçbir iç detay sızdırma; sunucu tarafında tam kaydı tut.
      console.error(`unhandled error in ${method} ${url.pathname}:`, err);
      sendError(res, 500, 'internal_error');
    }
    return true;
  }
}
