import { randomBytes } from 'node:crypto';
import { Database } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { IncidentKind, IncidentStatus, StatusComponent } from './incidents.service.js';

// Emails of Hatti's status page (BIL-06, ADR-535): anyone may ask from /status to be emailed what
// Hatti says of incidents and maintenance. An address is emailed a link to confirm first, and
// nothing else until it does; every email after carries a link to stop. The worker sends both,
// each once; this service keeps who asked and what is still to send. The core's pages use the
// application's login, the worker's sweeps the system's.

export const STATUS_SUBSCRIPTION_LIMITS = {
  /** An address unconfirmed is sent the link again at most this often. */
  resendMinutes: 60,
  /** Links to confirm a sweep sends at most, against a script asking for many addresses. */
  confirmationsPerSweep: 50,
  /** Updates are emailed while this fresh; older ones, missed while the worker was down, never. */
  freshHours: 24,
  /** Shops are told of an outage on WhatsApp while its update is this fresh (ADR-544). */
  shopNoticeFreshHours: 6,
} as const;

/** The link's path on the core's address: /status/subscription/<token>. */
export const STATUS_SUBSCRIPTION_PATH = 'status/subscription';

/** Who a link is for, as its page shows it. */
export interface StatusSubscriptionView {
  email: string;
  confirmed: boolean;
}

/** An address to email: the link to confirm, or an update with the link to stop. */
export type StatusRecipient = {
  email: string;
  token: string;
};

/** An update to email to every confirmed address, with its incident's words. */
export interface StatusUpdateToMail {
  incidentId: string;
  kind: IncidentKind;
  title: string;
  titleUr: string | null;
  components: StatusComponent[];
  status: IncidentStatus;
  body: string;
  bodyUr: string | null;
  postedAt: Date;
}

/**
 * An outage's update to tell every shop on WhatsApp (ADR-544): the one that opened it, or the one
 * that ended it.
 */
export interface StatusShopNotice {
  updateId: string;
  incidentId: string;
  kind: IncidentKind;
  title: string;
  titleUr: string | null;
  components: StatusComponent[];
  status: IncidentStatus;
  postedAt: Date;
}

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** An address as given, trimmed and in lower case; null if it isn't one. */
export function subscriberEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  return email.length >= 3 && email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null;
}

const isToken = (token: string) => /^[A-Za-z0-9_-]{32,64}$/.test(token);

@Injectable()
export class StatusSubscriptionsService {
  constructor(private readonly db: Database) {}

  /**
   * Asks for `email` to be emailed: a link to confirm goes to it next sweep, again an hour on if
   * it is asked again unconfirmed, and never to an address confirmed already. False if it isn't an
   * address. What came of it is not said, so no one learns who is subscribed.
   */
  async subscribe(input: string, now: Date = new Date()): Promise<boolean> {
    const email = subscriberEmail(input);
    if (!email) return false;
    const again = new Date(now.getTime() - STATUS_SUBSCRIPTION_LIMITS.resendMinutes * 60_000);
    await this.db.app.transaction((tx) =>
      tx.execute(sql`
        INSERT INTO trust.status_subscribers (email, token, asked_at, created_at)
        VALUES (${email}, ${randomBytes(24).toString('base64url')}, ${now.toISOString()},
                ${now.toISOString()})
            ON CONFLICT (email) DO UPDATE
                   SET asked_at = excluded.asked_at, confirm_mailed_at = NULL
                 WHERE trust.status_subscribers.confirmed_at IS NULL
                   AND trust.status_subscribers.asked_at < ${again.toISOString()}`),
    );
    return true;
  }

  /** Whose link `token` is; null if none is. */
  async view(token: string): Promise<StatusSubscriptionView | null> {
    if (!isToken(token)) return null;
    const { rows } = await this.db.app.transaction((tx) =>
      tx.execute<{ email: string; confirmed_at: string | null }>(sql`
        SELECT email, confirmed_at FROM trust.status_subscribers WHERE token = ${token}`),
    );
    const row = rows[0];
    return row ? { email: row.email, confirmed: row.confirmed_at !== null } : null;
  }

  /** Confirms the address of link `token`; null if none is. */
  async confirm(token: string, now: Date = new Date()): Promise<StatusSubscriptionView | null> {
    if (!isToken(token)) return null;
    const { rows } = await this.db.app.transaction((tx) =>
      tx.execute<{ email: string }>(sql`
        UPDATE trust.status_subscribers
           SET confirmed_at = coalesce(confirmed_at, ${now.toISOString()}::timestamptz)
         WHERE token = ${token}
        RETURNING email`),
    );
    return rows[0] ? { email: rows[0].email, confirmed: true } : null;
  }

  /** Forgets the address of link `token`: whether there was one. */
  async unsubscribe(token: string): Promise<boolean> {
    if (!isToken(token)) return false;
    const { rows } = await this.db.app.transaction((tx) =>
      tx.execute<{ id: string }>(sql`
        DELETE FROM trust.status_subscribers WHERE token = ${token} RETURNING id`),
    );
    return rows.length > 0;
  }

  /**
   * The addresses to email a link to confirm, the longest asked first, each taken once: the
   * worker emails them after.
   */
  async takeConfirmations(now: Date = new Date()): Promise<StatusRecipient[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<StatusRecipient>(sql`
        UPDATE trust.status_subscribers
           SET confirm_mailed_at = ${now.toISOString()}
         WHERE id IN (SELECT id FROM trust.status_subscribers
                       WHERE confirmed_at IS NULL AND confirm_mailed_at IS NULL
                       ORDER BY asked_at
                       LIMIT ${STATUS_SUBSCRIPTION_LIMITS.confirmationsPerSweep}
                         FOR UPDATE SKIP LOCKED)
        RETURNING email, token`),
    );
    return rows;
  }

  /**
   * Updates posted and not yet emailed, the first posted first, each taken once, and the
   * confirmed addresses to email them to. Updates older than a day are taken and not given.
   */
  async takeUpdates(
    now: Date = new Date(),
  ): Promise<{ updates: StatusUpdateToMail[]; recipients: StatusRecipient[] }> {
    const fresh = new Date(now.getTime() - STATUS_SUBSCRIPTION_LIMITS.freshHours * 3_600_000);
    return this.db.system(async (tx) => {
      const { rows } = await tx.execute<{
        incident_id: string;
        kind: IncidentKind;
        title: string;
        title_ur: string | null;
        components: StatusComponent[];
        status: IncidentStatus;
        body: string;
        body_ur: string | null;
        posted_at: string | Date;
      }>(sql`
        WITH taken AS (
          UPDATE trust.incident_updates
             SET mailed_at = ${now.toISOString()}
           WHERE id IN (SELECT id FROM trust.incident_updates
                         WHERE mailed_at IS NULL AND posted_at <= ${now.toISOString()}
                           FOR UPDATE SKIP LOCKED)
          RETURNING incident_id, status, body, body_ur, posted_at
        )
        SELECT t.incident_id, i.kind, i.title, i.title_ur, i.components, t.status, t.body,
               t.body_ur, t.posted_at
          FROM taken t JOIN trust.incidents i ON i.id = t.incident_id
         WHERE t.posted_at >= ${fresh.toISOString()}
         ORDER BY t.posted_at`);
      if (rows.length === 0) return { updates: [], recipients: [] };
      const recipients = await tx.execute<StatusRecipient>(sql`
        SELECT email, token FROM trust.status_subscribers
         WHERE confirmed_at IS NOT NULL ORDER BY confirmed_at, id`);
      return {
        updates: rows.map((row) => ({
          incidentId: row.incident_id,
          kind: row.kind,
          title: row.title,
          titleUr: row.title_ur,
          components: row.components,
          status: row.status,
          body: row.body,
          bodyUr: row.body_ur,
          postedAt: new Date(row.posted_at),
        })),
        recipients: recipients.rows,
      };
    });
  }

  /**
   * The outages' updates to tell shops of on WhatsApp at `now`, the first posted first (ADR-544):
   * of an incident or maintenance putting a part out of service, the update that opened it and
   * the one that ended it, while six hours fresh. Every other update is put aside for good here,
   * so a slow or partial trouble, and what Hatti says while it lasts, reach shops only by the
   * status page and its emails. Each given is given again until {@link shopNoticeSent}.
   */
  async shopNoticesDue(now: Date = new Date()): Promise<StatusShopNotice[]> {
    const fresh = new Date(
      now.getTime() - STATUS_SUBSCRIPTION_LIMITS.shopNoticeFreshHours * 3_600_000,
    );
    const told = sql`
      i.impact = 'outage'
      AND u.posted_at >= ${fresh.toISOString()}
      AND (u.status IN ('resolved', 'completed')
           OR u.id = (SELECT first.id FROM trust.incident_updates first
                       WHERE first.incident_id = u.incident_id
                       ORDER BY first.posted_at, first.id LIMIT 1))`;
    return this.db.system(async (tx) => {
      await tx.execute(sql`
        UPDATE trust.incident_updates u
           SET shops_told_at = ${now.toISOString()}
          FROM trust.incidents i
         WHERE i.id = u.incident_id AND u.shops_told_at IS NULL
           AND u.posted_at <= ${now.toISOString()}
           AND NOT (${told})`);
      const { rows } = await tx.execute<{
        id: string;
        incident_id: string;
        kind: IncidentKind;
        title: string;
        title_ur: string | null;
        components: StatusComponent[];
        status: IncidentStatus;
        posted_at: string | Date;
      }>(sql`
        SELECT u.id, u.incident_id, i.kind, i.title, i.title_ur, i.components, u.status,
               u.posted_at
          FROM trust.incident_updates u JOIN trust.incidents i ON i.id = u.incident_id
         WHERE u.shops_told_at IS NULL AND u.posted_at <= ${now.toISOString()} AND ${told}
         ORDER BY u.posted_at, u.id`);
      return rows.map((row) => ({
        updateId: row.id,
        incidentId: row.incident_id,
        kind: row.kind,
        title: row.title,
        titleUr: row.title_ur,
        components: row.components,
        status: row.status,
        postedAt: new Date(row.posted_at),
      }));
    });
  }

  /** Marks the update `updateId` told to every shop, at `now`. */
  async shopNoticeSent(updateId: string, now: Date = new Date()): Promise<void> {
    await this.db.system((tx) =>
      tx.execute(sql`
        UPDATE trust.incident_updates SET shops_told_at = ${now.toISOString()}
         WHERE id = ${updateId} AND shops_told_at IS NULL`),
    );
  }
}
