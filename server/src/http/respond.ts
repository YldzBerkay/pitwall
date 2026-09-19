import type { ServerResponse } from 'node:http';

export const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,authorization',
  'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
} as const;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  let payload: string;
  try {
    payload = JSON.stringify(body);
  } catch (err) {
    // Handler returned something JSON.stringify can't serialize (circular
    // structure, BigInt, ...). Fall back to a safe, always-serializable
    // error payload instead of letting the exception escape mid-response.
    console.error('sendJson: failed to serialize response body:', err);
    if (res.headersSent) {
      // Nothing more we can do without corrupting an already-started
      // response; end the connection so the client doesn't hang.
      res.end();
      return;
    }
    payload = JSON.stringify({ error: 'internal_error' });
    status = 500;
  }
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...CORS_HEADERS,
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, status: number, code: string): void {
  sendJson(res, status, { error: code });
}
