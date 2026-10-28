import type { Db } from '@hatti/db';
import { sql } from 'drizzle-orm';
import {
  COURSE_VERSION,
  LESSONS,
  PASS_MARK,
  QUESTIONS,
  type Lesson,
  type Words,
} from './certification-course.js';
import { AuthError } from './errors.js';

// Partners' certification (PRT-04, ADR-858): Hatti's course, its lessons and questions in English
// and Urdu, answered on the partner page and scored here, the answers never sent to the browser.
// Eight of ten right certify the partner for a year; three tries a day.

export const CERTIFICATION_LIMITS = {
  triesPerDay: 3,
  validDays: 365,
} as const;

/** The course as a partner sees it: its questions without their answers. */
export interface CourseView {
  version: string;
  lessons: readonly Lesson[];
  questions: { id: string; prompt: Words; options: Words[] }[];
  passMark: number;
}

export interface CertificateRecord {
  courseVersion: string;
  score: number;
  passedAt: Date;
  expiresAt: Date;
}

export interface AttemptResult {
  score: number;
  passed: boolean;
  /** The questions answered wrongly, by ID, to read again. */
  wrong: string[];
  certificate: CertificateRecord | null;
}

const DAY_MS = 24 * 3_600_000;

export class CertificationService {
  private readonly db: Db;
  private readonly now: () => Date;

  constructor(options: { db: Db; now?: () => Date }) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
  }

  /** The course, with its questions' options and none of their answers. */
  course(): CourseView {
    return {
      version: COURSE_VERSION,
      lessons: LESSONS,
      questions: QUESTIONS.map(({ id, prompt, options }) => ({ id, prompt, options })),
      passMark: PASS_MARK,
    };
  }

  /** The partner's certificate while it lasts; null for none, or one run out. */
  async certificateOf(userId: string): Promise<CertificateRecord | null> {
    const { rows } = await this.db.execute<{
      course_version: string;
      score: number;
      passed_at: Date | string;
      expires_at: Date | string;
    }>(sql`
      SELECT course_version, score, passed_at, expires_at FROM identity.partner_certificates
       WHERE partner_id = ${userId} AND expires_at > ${this.now().toISOString()}`);
    const row = rows[0];
    return row
      ? {
          courseVersion: row.course_version,
          score: row.score,
          passedAt: new Date(row.passed_at),
          expiresAt: new Date(row.expires_at),
        }
      : null;
  }

  /** How many more tries the partner has today. */
  async triesLeft(userId: string): Promise<number> {
    const since = new Date(this.now().getTime() - DAY_MS).toISOString();
    const { rows } = await this.db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM identity.certification_attempts
       WHERE partner_id = ${userId} AND created_at > ${since}`);
    return Math.max(0, CERTIFICATION_LIMITS.triesPerDay - (rows[0]?.count ?? 0));
  }

  /**
   * Scores the partner's `answers`, each question's chosen option by the question's ID: passed,
   * the partner is certified for a year from now, of this version of the course.
   */
  async attempt(userId: string, answers: Readonly<Record<string, number>>): Promise<AttemptResult> {
    const { rows: partner } = await this.db.execute(sql`
      SELECT 1 FROM identity.partners WHERE user_id = ${userId}`);
    if (partner.length === 0) {
      throw new AuthError('NOT_PARTNER', 403, "Join Hatti's partner programme first");
    }
    if ((await this.triesLeft(userId)) <= 0) {
      throw new AuthError(
        'RATE_LIMITED',
        429,
        'Three tries a day: read the lessons again and try tomorrow',
      );
    }
    const wrong = QUESTIONS.filter((question) => answers[question.id] !== question.answer).map(
      (question) => question.id,
    );
    const score = QUESTIONS.length - wrong.length;
    const passed = score >= PASS_MARK;
    const now = this.now();
    await this.db.execute(sql`
      INSERT INTO identity.certification_attempts
             (partner_id, course_version, score, passed, created_at)
      VALUES (${userId}, ${COURSE_VERSION}, ${score}, ${passed}, ${now.toISOString()})`);
    if (passed) {
      const expires = new Date(now.getTime() + CERTIFICATION_LIMITS.validDays * DAY_MS);
      await this.db.execute(sql`
        INSERT INTO identity.partner_certificates
               (partner_id, course_version, score, passed_at, expires_at)
        VALUES (${userId}, ${COURSE_VERSION}, ${score}, ${now.toISOString()}, ${expires.toISOString()})
        ON CONFLICT (partner_id) DO UPDATE
           SET course_version = EXCLUDED.course_version, score = EXCLUDED.score,
               passed_at = EXCLUDED.passed_at, expires_at = EXCLUDED.expires_at`);
    }
    return { score, passed, wrong, certificate: await this.certificateOf(userId) };
  }
}
