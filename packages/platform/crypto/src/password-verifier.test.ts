import { describe, expect, it } from 'vitest';
import { checkPassword, passwordVerifier } from './index.js';

describe('Verifiers of shared passwords', () => {
  it('check a password however it is spaced or composed, each with a salt of its own', async () => {
    const verifier = await passwordVerifier('eid-2026');
    expect(verifier).toMatch(/^scrypt\$16384\$8\$1\$[\w-]{22}\$[\w-]{43}$/);
    expect(await checkPassword('eid-2026', verifier)).toBe(true);
    expect(await checkPassword(' eid-2026 ', verifier)).toBe(true);
    expect(await checkPassword('eid-2025', verifier)).toBe(false);
    expect(await passwordVerifier('eid-2026')).not.toBe(verifier);
    // An Urdu password typed with a combining mark, or composed, is the same password.
    const urdu = await passwordVerifier('آم');
    expect(await checkPassword('آم'.normalize('NFD'), urdu)).toBe(true);
  });

  it('check nothing against a verifier not made here, or one asking too much', async () => {
    for (const bad of [
      '',
      'plain',
      'bcrypt$16384$8$1$c2FsdA$a2V5',
      'scrypt$1048577$8$1$c2FsdA$a2V5',
      'scrypt$16384$64$1$c2FsdA$a2V5',
      'scrypt$16384$8$1$$a2V5',
    ]) {
      expect(await checkPassword('eid-2026', bad), bad).toBe(false);
    }
  });
});
