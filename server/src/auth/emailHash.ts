/**
 * We never store raw email addresses. Accounts are linked across providers by
 * a peppered SHA-256 (HMAC) of the normalised address.
 *
 * The pepper must never be rotated: rotating it orphans every existing link.
 *
 * Normalisation is deliberately plain `.toLowerCase()`, NOT a locale-aware
 * case fold. Email local-parts and domains are ASCII/case-folded per RFC by
 * convention across every provider we support (Google/Apple/Facebook/email
 * password), and `.toLowerCase()` has none of the Turkish-locale trap that
 * `.toLocaleLowerCase('tr-TR')` has (that trap — where 'I' maps to dotless
 * 'ı' — is a real bug we hit in src/identity/profanity.ts for nickname
 * moderation, which legitimately needs Turkish-locale folding for Turkish
 * text). Emails are not Turkish text, so plain lowercase is correct here.
 * `.normalize('NFC')` is applied first so visually identical addresses with
 * different Unicode composition (rare, but possible in the local-part of an
 * internationalised address) hash identically.
 */
import { createHmac } from 'node:crypto';

export function hashEmail(email: string): string {
  const pepper = process.env.EMAIL_HASH_PEPPER;
  if (!pepper) throw new Error('EMAIL_HASH_PEPPER is not set');
  const normalised = email.trim().normalize('NFC').toLowerCase();
  return createHmac('sha256', pepper).update(normalised).digest('base64url');
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isPlausibleEmail(email: string): boolean {
  return EMAIL_SHAPE.test(email.trim()) && email.trim().length <= 254;
}
