import { SecretBox } from '@hatti/crypto';
import { describe, expect, it } from 'vitest';
import { CliLogins, MemoryCliLoginStore, deviceNameOf, userCodeOf } from './cli-logins.js';

const box = new SecretBox([{ id: 'test', key: Buffer.alloc(32, 7) }]);

function loginsAt(clock: { now: number }) {
  return new CliLogins(
    new MemoryCliLoginStore(() => clock.now),
    box,
    'https://admin.hatti.pk',
    () => new Date(clock.now),
  );
}

describe("hatti login's waiting logins (ADR-990)", () => {
  it('reads a code as typed', () => {
    expect(userCodeOf('bcdf ghjk')).toBe('BCDF-GHJK');
    expect(userCodeOf('BCDF-GHJK')).toBe('BCDF-GHJK');
    expect(userCodeOf('BCDF-GHJ')).toBeNull();
    expect(userCodeOf('ABCD-EFGH')).toBeNull();
  });

  it("keeps a terminal's name printable and short", () => {
    expect(deviceNameOf('sana-laptop')).toBe('sana-laptop');
    expect(deviceNameOf('<script>alert(1)</script>')).toBe('scriptalert(1)script');
    expect(deviceNameOf('x'.repeat(100))).toHaveLength(60);
    expect(deviceNameOf(42)).toBe('a terminal');
  });

  it('gives the token once, sealed until it is fetched', async () => {
    const clock = { now: Date.UTC(2026, 10, 1) };
    const store = new MemoryCliLoginStore(() => clock.now);
    const logins = new CliLogins(store, box, 'https://admin.hatti.pk', () => new Date(clock.now));
    const begun = await logins.begin({ device: 'box', access: 'read' });
    expect(begun.verificationUrlComplete).toBe(
      `https://admin.hatti.pk/cli-login?code=${begun.userCode}`,
    );
    expect(await logins.claim(begun.userCode)).toBe(true);
    expect(await logins.claim(begun.userCode)).toBe(false);
    expect(
      await logins.approve(begun.userCode, { accessToken: 'hat_x', shopId: 's', scopes: ['a'] }),
    ).toBe(true);
    expect(await logins.poll(begun.deviceCode)).toEqual({
      status: 'approved',
      accessToken: 'hat_x',
      shopId: 's',
      scopes: ['a'],
    });
    expect(await logins.poll(begun.deviceCode)).toEqual({ status: 'expired' });
  });

  it('ends after ten minutes', async () => {
    const clock = { now: Date.UTC(2026, 10, 1) };
    const logins = loginsAt(clock);
    const begun = await logins.begin({});
    expect((await logins.describe(begun.userCode))?.access).toBe('write');
    clock.now += 600_000;
    expect(await logins.describe(begun.userCode)).toBeNull();
    expect(await logins.claim(begun.userCode)).toBe(false);
    expect(await logins.deny(begun.userCode)).toBe(false);
    expect(await logins.poll(begun.deviceCode)).toEqual({ status: 'expired' });
  });
});
