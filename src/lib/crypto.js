import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

/** 短小、URL 安全的随机 ID */
export function makeId(prefix = '', bytes = 9) {
  const s = crypto.randomBytes(bytes).toString('base64url');
  return prefix ? `${prefix}_${s}` : s;
}

export function makeToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** 公开分享令牌：便于手输，去掉易混字符 */
const TOKEN_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function makeShareToken(len = 12) {
  const buf = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += TOKEN_ALPHABET[buf[i] % TOKEN_ALPHABET.length];
  return out;
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  let derived;
  try {
    derived = await scrypt(String(password), salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
