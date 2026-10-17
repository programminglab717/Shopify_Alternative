import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SUPPORT_LIMITS, SupportService, type SupportContact } from './support.service.js';
import { billingFixture, errorsOf, unwrap, type BillingFixture } from './test-support.js';

const server = testDatabaseServer();

const CONTACT: SupportContact = {
  whatsapp: '+923001112233',
  phone: '+924235761999',
  email: 'help@hatti.pk',
  hours: { en: 'Monday to Saturday, 10am to 7pm', ur: 'پیر سے ہفتہ، صبح 10 سے شام 7' },
};

const year = { start: new Date('2026-10-01'), end: new Date('2027-10-01') };

describe.skipIf(!server)("Hatti's support for shops (BIL-05, ADR-508)", () => {
  let f: BillingFixture;
  let support: SupportService;

  beforeAll(async () => {
    f = await billingFixture(server!);
    support = new SupportService(f.db, CONTACT);
  });

  beforeEach(async () => {
    await f.reset();
    await f.admin.query('DELETE FROM billing.support_requests');
  });

  afterAll(async () => {
    await f?.close();
  });

  const ask = (tenant: TenantContext, extra: Record<string, string | null> = {}) =>
    support.request(tenant, {
      topic: 'couriers',
      message: 'PostEx bookings fail for Multan since this morning.',
      language: 'en',
      ...extra,
    });

  it('offers each plan its way to reach Hatti, and the lines Hatti set up', async () => {
    expect(await support.support(f.a)).toEqual({
      plan: 'free',
      tier: { channel: 'help_centre', priority: 3, answerWithinHours: 48 },
      whatsapp: null,
      phone: null,
      email: 'help@hatti.pk',
      hours: CONTACT.hours,
    });
    await f.subscribe(f.a, 'starter', 'yearly', year);
    expect(await support.support(f.a)).toMatchObject({
      plan: 'starter',
      tier: { channel: 'whatsapp' },
      whatsapp: '+923001112233',
      phone: null,
    });
    await f.subscribe(f.a, 'pro', 'yearly', year);
    expect(await support.support(f.a)).toMatchObject({
      tier: { channel: 'priority_call', priority: 1 },
      whatsapp: '+923001112233',
      phone: '+924235761999',
    });
    // Without Hatti's lines, requests alone.
    expect(await new SupportService(f.db, null).support(f.a)).toMatchObject({
      whatsapp: null,
      phone: null,
      email: null,
      hours: null,
    });
  });

  it("keeps a shop's requests, its call-back number checked, at the priority of its plan", async () => {
    await f.subscribe(f.a, 'growth', 'monthly', year);
    const asked = unwrap(await ask(f.a, { callBack: '0300 1234567' }));
    expect(asked).toMatchObject({
      topic: 'couriers',
      callBack: '+923001234567',
      priority: 1,
      status: 'open',
      answer: null,
    });
    expect(errorsOf(await ask(f.a, { topic: 'gossip' }))).toEqual([['input.topic', 'INVALID']]);
    expect(errorsOf(await ask(f.a, { message: 'help' }))).toEqual([['input.message', 'INVALID']]);
    expect(errorsOf(await ask(f.a, { callBack: '042 3576 1999' }))).toEqual([
      ['input.callBack', 'INVALID'],
    ]);
    const app: TenantContext = { ...f.a, actor: { kind: 'app', tokenId: newId() } };
    expect(errorsOf(await ask(app))).toEqual([['input', 'INVALID']]);

    // Another shop sees none of them; five open at most.
    expect(await support.requests(f.b)).toEqual([]);
    for (let n = 1; n < SUPPORT_LIMITS.open; n++) unwrap(await ask(f.a));
    expect(errorsOf(await ask(f.a))).toEqual([['base', 'TOO_MANY']]);
    expect(await support.requests(f.a)).toHaveLength(SUPPORT_LIMITS.open);
    expect(await support.close(f.b, asked.id)).toBeNull();
    expect((await support.close(f.a, asked.id))?.status).toBe('closed');
    unwrap(await ask(f.a));
  });

  it("lists what waits across shops, the most urgent first, for Hatti's people to answer", async () => {
    const free = unwrap(await ask(f.b, { topic: 'billing', language: 'ur' }));
    await f.subscribe(f.a, 'growth', 'monthly', year);
    const growth = unwrap(await ask(f.a));
    const waiting = await support.waiting();
    expect(waiting.map((each) => [each.id, each.shopName, each.plan])).toEqual([
      [growth.id, 'Zari', 'growth'],
      [free.id, 'B', 'free'],
    ]);

    expect(errorsOf(await support.answer(growth.id, ' ', 'Ayesha'))).toEqual([['answer', 'BLANK']]);
    expect(errorsOf(await support.answer(growth.id, 'Fixed.', ' '))).toEqual([['by', 'BLANK']]);
    expect(errorsOf(await support.answer(newId(), 'Fixed.', 'Ayesha'))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);
    const answered = unwrap(
      await support.answer(growth.id, 'PostEx fixed Multan; book again.', 'Ayesha'),
    );
    expect(answered).toMatchObject({ status: 'answered', answeredBy: 'Ayesha', shopName: 'Zari' });
    expect((await support.requests(f.a))[0]).toMatchObject({
      status: 'answered',
      answer: 'PostEx fixed Multan; book again.',
    });
    // Answered once.
    expect(errorsOf(await support.answer(growth.id, 'Again.', 'Bilal'))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);
    expect((await support.waiting()).map((each) => each.id)).toEqual([free.id]);
  });
});
