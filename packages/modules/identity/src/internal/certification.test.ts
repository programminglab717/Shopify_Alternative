import { randomBytes } from 'node:crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LESSONS, PASS_MARK, QUESTIONS } from './certification-course.js';
import { CertificationService } from './certification.service.js';
import { AuthError } from './errors.js';
import { ExpertsService } from './experts.service.js';

const server = testDatabaseServer();

/** Every question answered rightly, but `wrong` of them. */
const answering = (wrong = 0) =>
  Object.fromEntries(
    QUESTIONS.map((question, index) => [
      question.id,
      index < wrong ? (question.answer + 1) % question.options.length : question.answer,
    ]),
  );

describe("Hatti's course for partners (PRT-04, ADR-858)", () => {
  it('teaches and asks in English and Urdu, each question with one right option', () => {
    expect(LESSONS.length).toBeGreaterThanOrEqual(5);
    for (const lesson of LESSONS) {
      expect(lesson.title.en && lesson.title.ur && lesson.body.en && lesson.body.ur).toBeTruthy();
    }
    expect(QUESTIONS).toHaveLength(10);
    expect(new Set(QUESTIONS.map((question) => question.id)).size).toBe(10);
    for (const question of QUESTIONS) {
      expect(question.options.length).toBeGreaterThanOrEqual(3);
      expect(question.options[question.answer]).toBeDefined();
      for (const option of question.options) expect(option.en && option.ur).toBeTruthy();
    }
    // Shown without what is right.
    const shown = new CertificationService({ db: null as never }).course();
    expect(JSON.stringify(shown)).not.toContain('"answer"');
    expect(shown.passMark).toBe(PASS_MARK);
  });
});

describe.skipIf(!server)('Certifying partners (PRT-04, ADR-858)', () => {
  let testDb: TestDatabase;
  let identityDb: Database;
  let admin: pg.Client;
  let clock = new Date('2026-10-28T09:00:00Z');
  let certification: CertificationService;

  async function partner(): Promise<string> {
    const id = newId();
    await admin.query(`INSERT INTO identity.users (id, name, email) VALUES ($1, 'Hira', $2)`, [
      id,
      `${randomBytes(4).toString('hex')}@example.pk`,
    ]);
    await admin.query(
      `INSERT INTO identity.partners (user_id, business_name, referral_code) VALUES ($1, 'Rang', $2)`,
      [id, randomBytes(4).toString('hex')],
    );
    return id;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    identityDb = new Database({
      appUrl: testDb.identityUrl,
      applicationName: 'certification-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    certification = new CertificationService({ db: identityDb.app, now: () => clock });
  });

  afterAll(async () => {
    await identityDb?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('certifies a partner for a year at eight of ten, three tries a day', async () => {
    const hira = await partner();
    const failed = await certification.attempt(hira, answering(3));
    expect(failed).toMatchObject({ score: 7, passed: false, certificate: null });
    expect(failed.wrong).toEqual(QUESTIONS.slice(0, 3).map((question) => question.id));
    expect(await certification.triesLeft(hira)).toBe(2);

    const passed = await certification.attempt(hira, answering(2));
    expect(passed).toMatchObject({ score: 8, passed: true });
    expect(passed.certificate).toEqual({
      courseVersion: '2026-10',
      score: 8,
      passedAt: clock,
      expiresAt: new Date('2027-10-28T09:00:00Z'),
    });
    await certification.attempt(hira, answering(0));
    const error = await certification
      .attempt(hira, answering(0))
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe('RATE_LIMITED');
    expect((await certification.certificateOf(hira))?.score).toBe(10);

    // A day on, they may try again; a year on, the certificate has run out.
    clock = new Date(clock.getTime() + 25 * 3_600_000);
    expect(await certification.triesLeft(hira)).toBe(3);
    clock = new Date('2027-10-29T09:00:00Z');
    expect(await certification.certificateOf(hira)).toBeNull();
  });

  it('refuses those not partners, and marks certified experts so for shops', async () => {
    const stranger = newId();
    await admin.query(`INSERT INTO identity.users (id, name, email) VALUES ($1, 'Omar', $2)`, [
      stranger,
      `${randomBytes(4).toString('hex')}@example.pk`,
    ]);
    const error = await certification
      .attempt(stranger, answering())
      .catch((failure: unknown) => failure);
    expect((error as AuthError).code).toBe('NOT_PARTNER');

    clock = new Date('2026-10-28T09:00:00Z');
    const lens = await partner();
    const experts = new ExpertsService({ db: identityDb.app });
    await experts.save(lens, { headline: 'Photos', services: ['photography'], languages: ['ur'] });
    expect((await experts.profile(lens))?.certified).toBe(false);
    await new CertificationService({ db: identityDb.app }).attempt(lens, answering());
    expect((await experts.profile(lens))?.certified).toBe(true);
  });
});
