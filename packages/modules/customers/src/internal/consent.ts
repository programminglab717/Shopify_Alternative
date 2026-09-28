import type { Actor, InputChecker } from '@hatti/api';
import type { Tx } from '@hatti/db';
import { appendEvents } from '@hatti/events';
import { newId } from '@hatti/ids';
import { sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { CustomerEvents, type MarketingConsentUpdatedPayload } from './events.js';
import type { MarketingConsentRecord } from './records.js';
import {
  MARKETING_CHANNELS,
  consentEvents,
  customers,
  type ConsentActorKind,
  type ConsentSourceValue,
  type CustomerRow,
  type MarketingChannelValue,
  type MarketingStateValue,
} from './schema.js';

export const CONSENT_LIMITS = { wording: 1_000 } as const;

/** A customer agreeing to, or withdrawing from, marketing on one channel. */
export interface MarketingConsentInput {
  channel: MarketingChannelValue;
  /** Subscribing or unsubscribing; not_subscribed is only where everyone starts. */
  state: MarketingStateValue;
  /** What the customer agreed to, e.g. the text beside a checkbox. Needed to subscribe. */
  wording?: string | null;
  /** Where they said so; manual for staff and api for apps when left out. */
  source?: ConsentSourceValue | null;
  /** When they said so, if before now. */
  collectedAt?: Date | null;
}

/** A consent change that passed its checks. */
export interface ConsentChange {
  /** Where it came from in the input, for errors found later. */
  field: string[];
  channel: MarketingChannelValue;
  state: MarketingStateValue;
  source: ConsentSourceValue;
  wording: string | null;
  /** Null: now. */
  collectedAt: Date | null;
}

/** The customer columns holding each channel's consent. */
const COLUMNS = {
  whatsapp: { state: 'whatsappConsent', at: 'whatsappConsentAt' },
  sms: { state: 'smsConsent', at: 'smsConsentAt' },
  email: { state: 'emailConsent', at: 'emailConsentAt' },
} as const satisfies Record<
  MarketingChannelValue,
  { state: keyof CustomerRow; at: keyof CustomerRow }
>;

/** A customer's consent per channel, from their row. */
export function consentOf(row: CustomerRow): Record<MarketingChannelValue, MarketingConsentRecord> {
  const consent = {} as Record<MarketingChannelValue, MarketingConsentRecord>;
  for (const channel of MARKETING_CHANNELS) {
    consent[channel] = {
      state: row[COLUMNS[channel].state],
      consentedAt: row[COLUMNS[channel].at],
    };
  }
  return consent;
}

/** Checks consent changes; returns those that pass, adding errors for the rest. */
export function checkConsentChanges(
  check: InputChecker,
  field: string[],
  inputs: readonly MarketingConsentInput[] | null | undefined,
  actor: Actor,
): ConsentChange[] {
  const seen = new Set<MarketingChannelValue>();
  const changes: ConsentChange[] = [];
  (inputs ?? []).forEach((input, index) => {
    const at = [...field, String(index)];
    const errorsBefore = check.errors.length;
    if (seen.has(input.channel)) {
      check.addMessage(at, 'INVALID', 'The same channel is listed twice');
    }
    seen.add(input.channel);
    if (input.state === 'not_subscribed') {
      check.addMessage(
        [...at, 'state'],
        'INVALID',
        'Consent is given (subscribed) or withdrawn (unsubscribed)',
      );
    }
    if (input.source === 'contact_changed') {
      check.addMessage([...at, 'source'], 'INVALID', 'Only Hatti records contact changes');
    }
    const wording = check.text([...at, 'wording'], input.wording, {
      required: input.state === 'subscribed',
      max: CONSENT_LIMITS.wording,
    });
    const collectedAt = input.collectedAt ?? null;
    if (
      collectedAt &&
      (collectedAt.getTime() > Date.now() + 60_000 || collectedAt.getUTCFullYear() < 2000)
    ) {
      check.add([...at, 'collectedAt'], 'INVALID', "can't be in the future");
    }
    if (check.errors.length === errorsBefore) {
      changes.push({
        field: at,
        channel: input.channel,
        state: input.state,
        source: input.source ?? (actor.kind === 'staff' ? 'manual' : 'api'),
        wording,
        collectedAt,
      });
    }
  });
  return changes;
}

function actorColumns(actor: Actor | 'system'): {
  actorKind: ConsentActorKind;
  actorId: string | null;
} {
  if (actor === 'system') return { actorKind: 'system', actorId: null };
  return actor.kind === 'app'
    ? { actorKind: 'app', actorId: actor.tokenId }
    : { actorKind: 'staff', actorId: actor.userId };
}

/** The number or address a channel reaches the customer on, or null if it has none. */
export function contactFor(
  channel: MarketingChannelValue,
  customer: Pick<CustomerRow, 'phone' | 'email'>,
): string | null {
  return channel === 'email' ? customer.email : customer.phone;
}

/**
 * Records consent changes for a customer inside the caller's transaction: one ledger entry and one
 * event per channel whose state changes, and the customer columns to set. Changes that leave a
 * channel's state as it is are skipped. `customer` must already have the contacts the changes
 * are for (a new email, say).
 */
export async function recordConsentChanges(
  tx: Tx,
  shopId: string,
  customer: Pick<CustomerRow, 'id' | 'phone' | 'email'> &
    Partial<Record<(typeof COLUMNS)[MarketingChannelValue]['state'], MarketingStateValue>>,
  changes: readonly ConsentChange[],
  actor: Actor | 'system',
  version: number,
): Promise<{ set: PgUpdateSetSource<typeof customers>; changed: MarketingChannelValue[] }> {
  // In order: a reset followed by a new subscription leaves the channel subscribed.
  const states = new Map<MarketingChannelValue, MarketingStateValue>();
  const effective = changes.filter((change) => {
    const current =
      states.get(change.channel) ?? customer[COLUMNS[change.channel].state] ?? 'not_subscribed';
    if (current === change.state) return false;
    states.set(change.channel, change.state);
    return true;
  });
  if (effective.length === 0) return { set: {}, changed: [] };

  await tx.insert(consentEvents).values(
    effective.map((change) => ({
      shopId,
      id: newId(),
      customerId: customer.id,
      channel: change.channel,
      state: change.state,
      source: change.source,
      wording: change.wording,
      contact: contactFor(change.channel, customer)!,
      ...actorColumns(actor),
      collectedAt: change.collectedAt ?? sql`now()`,
    })),
  );
  await appendEvents<MarketingConsentUpdatedPayload>(
    tx,
    shopId,
    effective.map((change) => ({
      type: CustomerEvents.MarketingConsentUpdated,
      aggregateType: 'customer',
      aggregateId: customer.id,
      payload: { channel: change.channel, state: change.state, source: change.source, version },
    })),
  );
  // The ledger's time and the customer's agree: both are the transaction's when not given.
  const set: PgUpdateSetSource<typeof customers> = {};
  for (const change of effective) {
    const columns = COLUMNS[change.channel];
    Object.assign(set, {
      [columns.state]: change.state,
      [columns.at]: change.collectedAt ?? sql`now()`,
    });
  }
  return { set, changed: [...new Set(effective.map((change) => change.channel))] };
}

/** Email consent needs an email address. */
export function checkEmailConsent(
  check: InputChecker,
  changes: readonly ConsentChange[],
  email: string | null,
): void {
  for (const change of changes) {
    if (change.channel === 'email' && change.state !== 'not_subscribed' && email === null) {
      check.addMessage(
        change.field,
        'INVALID',
        'Add an email address before recording email consent',
      );
    }
  }
}

/** Resets consent for the channels whose number or address a change of profile replaces. */
export function contactResets(
  current: Pick<CustomerRow, 'email'>,
  changes: Partial<Pick<CustomerRow, 'phone' | 'email'>>,
): ConsentChange[] {
  const reset = (channel: MarketingChannelValue): ConsentChange => ({
    field: [],
    channel,
    state: 'not_subscribed',
    source: 'contact_changed',
    wording: null,
    collectedAt: null,
  });
  return [
    ...('phone' in changes ? [reset('whatsapp'), reset('sms')] : []),
    ...('email' in changes && current.email !== null ? [reset('email')] : []),
  ];
}
