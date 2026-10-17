import { createHash } from 'node:crypto';
import { money, toMajorString } from '@hatti/money';
import type { ConversionMomentValue, ConversionOrder } from './meta.js';

// What an order's moments go to Google Analytics as (MKT-10, ADR-547): an event of the
// Measurement Protocol for each, as Meta's and TikTok's go (ADR-143, ADR-541), which Google Ads
// counts once the shop imports the purchase as a conversion. Its customer's details are
// normalised and hashed as Google asks, and what they bought is named by the variants' IDs, as
// the catalog feed names them (ADR-142).

const HOUR_MS = 3_600_000;

/**
 * How long after a moment it may still go: the Measurement Protocol dates an event up to 72
 * hours back, and counts one older as now. An hour is left for the request.
 */
export const GOOGLE_EVENT_WINDOW_MS = 72 * HOUR_MS - HOUR_MS;

/** The names a moment goes by when it is not the shop's purchase. */
const MOMENT_EVENTS: Readonly<Record<ConversionMomentValue, string>> = {
  placed: 'order_placed',
  confirmed: 'order_confirmed',
  delivered: 'order_delivered',
};

/**
 * What Google calls a moment: `purchase`, its recommended event, at the one the shop chose; else
 * names of their own.
 */
export function googleEventName(
  moment: ConversionMomentValue,
  purchaseAt: ConversionMomentValue,
): string {
  return moment === purchaseAt ? 'purchase' : MOMENT_EVENTS[moment];
}

/** A request's body, as the Measurement Protocol takes it: one browser's events. */
export interface GoogleEventsPayload {
  client_id: string;
  user_id: string;
  timestamp_micros: number;
  user_data?: { sha256_email_address?: string[]; sha256_phone_number?: string[] };
  events: {
    name: string;
    params: {
      transaction_id: string;
      currency: string;
      value: number;
      items: { item_id: string; quantity: number; price: number }[];
    };
  }[];
}

/**
 * An order's moment as a request of its own. Its transaction is the order's number, the same
 * however often it is sent, by which Google keeps one purchase of it.
 */
export function googleEvent(
  order: ConversionOrder,
  conversion: { moment: ConversionMomentValue; occurredAt: Date },
  options: { purchaseAt: ConversionMomentValue },
): GoogleEventsPayload {
  const amount = (minor: bigint) => Number(toMajorString(money(minor, order.currency)));
  const payload: GoogleEventsPayload = {
    client_id: googleClientId(order),
    user_id: hashed(order.customerId),
    timestamp_micros: conversion.occurredAt.getTime() * 1000,
    events: [
      {
        name: googleEventName(conversion.moment, options.purchaseAt),
        params: {
          transaction_id: String(order.number),
          currency: order.currency,
          value: amount(order.total),
          items: order.lines.map((line) => ({
            item_id: line.variantId,
            quantity: line.quantity,
            price: amount(line.unitPrice),
          })),
        },
      },
    ],
  };
  const userData = googleUserData(order);
  if (userData) payload.user_data = userData;
  return payload;
}

/**
 * The browser the events are of: the customer's own ID with the shop, hashed, so that one
 * customer's orders read as one visitor's.
 */
export function googleClientId(order: ConversionOrder): string {
  return hashed(order.customerId).slice(0, 32);
}

/**
 * The customer's details as Google matches them to its people, with user-provided data: the
 * mobile number in E.164, its plus kept, and the email in lower case, each hashed with SHA-256.
 * None when the order has neither.
 */
export function googleUserData(order: ConversionOrder): GoogleEventsPayload['user_data'] | null {
  const data: NonNullable<GoogleEventsPayload['user_data']> = {};
  const digits = order.phone?.replace(/\D/g, '');
  if (digits) data.sha256_phone_number = [hashed(`+${digits}`)];
  const email = order.email?.trim().toLowerCase();
  if (email) data.sha256_email_address = [hashed(email)];
  return Object.keys(data).length > 0 ? data : null;
}

function hashed(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
