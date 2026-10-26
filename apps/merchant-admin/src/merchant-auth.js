import crypto from 'node:crypto';

// Merchant portal authentication helpers (no external dependencies).
// - Passwords: scrypt (N=16384, r=8, p=1, 64-byte key, 16-byte salt),
//   stored as `scrypt:<salt-hex>:<hash-hex>`, verified timing-safely.
// - Sessions: raw token = 32 random bytes hex; only its sha256 hex is
//   stored in the DB, so a database leak alone cannot forge a session.
// - No server secret is needed: tokens are random, not signed.

export const MERCHANT_SESSION_COOKIE = 'paynova_merchant_session';
export const MERCHANT_SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LEN = 64;
const SALT_LEN = 16;

export function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P
  });
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    if (!password || !stored || typeof stored !== 'string') return false;
    const parts = stored.split(':');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    if (salt.length === 0 || expected.length !== SCRYPT_KEY_LEN) return false;
    const actual = crypto.scryptSync(password, salt, SCRYPT_KEY_LEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function createSessionToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  return { token, tokenHash };
}

export function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

export function parseSessionCookie(req) {
  const header = req.headers?.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (name === MERCHANT_SESSION_COOKIE) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

function isSecureRequest(req) {
  const proto = String(req.headers?.['x-forwarded-proto'] || '').toLowerCase();
  if (proto === 'https') return true;
  const host = String(req.headers?.host || '');
  // On a public (non-localhost) host, always mark the cookie Secure.
  // Localhost development keeps it non-Secure so plain-http login works.
  return host !== '' && host !== 'localhost' && !host.startsWith('localhost:')
    && host !== '127.0.0.1' && !host.startsWith('127.0.0.1:');
}

function cookieAttributes(req) {
  return `Path=/merchant; HttpOnly; SameSite=Lax${isSecureRequest(req) ? '; Secure' : ''}`;
}

export function sessionCookieHeader(token, req) {
  const maxAge = Math.floor(MERCHANT_SESSION_TTL_MS / 1000);
  return `${MERCHANT_SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${maxAge}; ${cookieAttributes(req)}`;
}

export function clearSessionCookieHeader(req) {
  return `${MERCHANT_SESSION_COOKIE}=; Max-Age=0; ${cookieAttributes(req)}`;
}

export function clientIp(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || '';
}

// ---- Login rate limiting (in-memory, per ip + email) ----
// Max 5 failed attempts per 15 minutes, then 429. Successful login clears
// the counter. This is a brute-force brake, not a persistent lockout.

const MAX_FAILED = 5;
const WINDOW_MS = 15 * 60 * 1000;
const failures = new Map(); // key -> { count, firstAt }

function rateLimitKey(req, email) {
  return `${clientIp(req)}|${String(email || '').trim().toLowerCase()}`;
}

export function isLoginRateLimited(req, email) {
  const entry = failures.get(rateLimitKey(req, email));
  if (!entry) return false;
  if (Date.now() - entry.firstAt > WINDOW_MS) {
    failures.delete(rateLimitKey(req, email));
    return false;
  }
  return entry.count >= MAX_FAILED;
}

export function recordLoginFailure(req, email) {
  const key = rateLimitKey(req, email);
  const now = Date.now();
  const entry = failures.get(key);
  if (!entry || now - entry.firstAt > WINDOW_MS) {
    failures.set(key, { count: 1, firstAt: now });
  } else {
    entry.count += 1;
  }
}

export function clearLoginFailures(req, email) {
  failures.delete(rateLimitKey(req, email));
}

export function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function slugifyBusinessName(name) {
  const base = String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'merchant';
}
