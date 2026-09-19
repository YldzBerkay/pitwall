/**
 * Extracts the client address from a request.
 *
 * PRIVACY CONTRACT: the returned value is passed straight to regionForIp()
 * and then dropped. It must never be written to a table, a log line, an error
 * message or an analytics event.
 */
export function clientIpOf(
  headers: Record<string, string | string[] | undefined>,
  socketAddress: string | undefined,
): string {
  const forwarded = headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const candidate = raw ? raw.split(',')[0]!.trim() : (socketAddress ?? '');
  return candidate.startsWith('::ffff:') ? candidate.slice('::ffff:'.length) : candidate;
}
