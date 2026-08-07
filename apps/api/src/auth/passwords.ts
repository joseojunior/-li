import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

const parameters = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function derive(password: string, salt: Buffer, keyLength: number, options: typeof parameters): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, 64, parameters);
  return `scrypt$${parameters.N}$${parameters.r}$${parameters.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  if (!encoded) return false;
  const [algorithm, n, r, p, encodedSalt, encodedKey] = encoded.split('$');
  if (algorithm !== 'scrypt' || !n || !r || !p || !encodedSalt || !encodedKey) return false;
  try {
    const expected = Buffer.from(encodedKey, 'base64url');
    const actual = await derive(password, Buffer.from(encodedSalt, 'base64url'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
