import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Verifiers of passwords that are shared rather than a person's, such as a storefront's (ADR-054):
// kept where the password must not be, and checked against what is typed.

/** scrypt's cost: some 50 ms and 16 MB a check, so a caller allows few of an address. */
const COST = { N: 16_384, r: 8, p: 1 } as const;
const KEY_BYTES = 32;

/** As typed on any keyboard: without spaces around it, in Unicode's composed form. */
function normalized(password: string): string {
  return password.trim().normalize('NFC');
}

function derive(
  password: string,
  salt: Buffer,
  cost: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      normalized(password),
      salt,
      KEY_BYTES,
      { ...cost, maxmem: 256 * cost.N * cost.r },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** A verifier of `password`, with a salt of its own: `scrypt$N$r$p$salt$key`. */
export async function passwordVerifier(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64url'), key.toString('base64url')]
    .map(String)
    .join('$');
}

/** Whether `password` is the one `verifier` was made from; false for a verifier not understood. */
export async function checkPassword(password: string, verifier: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = verifier.split('$');
  const cost = { N: Number(n), r: Number(r), p: Number(p) };
  // Within what a verifier made here has, so one written wrong costs no more.
  const understood =
    scheme === 'scrypt' &&
    Number.isInteger(Math.log2(cost.N)) &&
    cost.N >= 1_024 &&
    cost.N <= 1_048_576 &&
    Number.isInteger(cost.r) &&
    cost.r >= 1 &&
    cost.r <= 16 &&
    Number.isInteger(cost.p) &&
    cost.p >= 1 &&
    cost.p <= 4 &&
    Boolean(salt) &&
    Boolean(key);
  if (!understood) return false;
  const expected = Buffer.from(key!, 'base64url');
  const derived = await derive(password, Buffer.from(salt!, 'base64url'), cost);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
