import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chargedFor, messageCostOf, smsParts } from './charges.js';
import {
  LogProvider,
  SmsGatewayProvider,
  WhatsAppCloudProvider,
  type OutgoingMessage,
} from './providers.js';
import {
  ALWAYS_SENT,
  EMAILED_KINDS,
  MESSAGE_KINDS,
  asksToStop,
  messageEmail,
  messageText,
  paidByShop,
  templateButtons,
  templateParameters,
} from './templates.js';
import { parseWhatsAppWebhook, signatureValid } from './whatsapp-webhook.js';

const SHIPPED: OutgoingMessage = {
  id: '01a0f3b1-9685-7065-988d-604298214e34',
  kind: 'order_shipped',
  channel: 'whatsapp',
  recipient: '+923001234567',
  language: 'en',
  variables: {
    shop: 'Zari Fashions',
    order: '#1043',
    courier: 'PostEx',
    tracking: 'PX123456',
    // The order's page, where its parcel's way shows (ADR-160).
    url: 'https://hatti.pk/o/Zx8kQ2mN4pR6sT0vW1yA3b',
  },
};

describe("Messages' words", () => {
  it("fills in an SMS, its order's page after it, in English and Urdu", () => {
    expect(messageText('order_shipped', 'en', SHIPPED.variables)).toBe(
      'Your order #1043 from Zari Fashions is on its way with PostEx. Tracking number: ' +
        'PX123456. https://hatti.pk/o/Zx8kQ2mN4pR6sT0vW1yA3b',
    );
    const urdu = messageText('order_placed', 'ur', {
      name: 'Ayesha',
      shop: 'Zari Fashions',
      order: '#1043',
      total: 'Rs 5,250',
    });
    expect(urdu).toContain('Ayesha');
    expect(urdu).toContain('#1043 (Rs 5,250)');
    expect(urdu).toMatch(/\p{Script=Arabic}/u);
  });

  it("gives WhatsApp's template its variables in order, a dash for one it lacks", () => {
    expect(templateParameters('order_shipped', SHIPPED.variables)).toEqual([
      'Zari Fashions',
      '#1043',
      'PostEx',
      'PX123456',
    ]);
    expect(
      templateParameters('order_placed', { shop: 'Zari', order: '#7', total: 'Rs 900' }),
    ).toEqual(['-', 'Zari', '#7', 'Rs 900']);
  });

  it("asks to confirm with the order's link by SMS, and with buttons on WhatsApp", () => {
    const asking = {
      name: 'Ayesha',
      shop: 'Zari Fashions',
      order: '#1043',
      total: 'Rs 5,250',
      url: 'https://hatti.pk/o/Zx8kQ2mN4pR6sT0vW1yA3b',
    };
    expect(messageText('order_confirmation', 'en', asking)).toBe(
      'Assalam-o-Alaikum Ayesha! Please confirm your order #1043 from Zari Fashions for ' +
        'Rs 5,250, paid in cash on delivery, so they can send it. Confirm or cancel it here: ' +
        'https://hatti.pk/o/Zx8kQ2mN4pR6sT0vW1yA3b',
    );
    expect(messageText('order_confirmation', 'ur', asking)).toMatch(
      /\p{Script=Arabic}.* https:\/\/hatti\.pk\/o\/Zx8kQ2mN4pR6sT0vW1yA3b$/u,
    );
    expect(templateParameters('order_confirmation', asking)).toEqual([
      'Ayesha',
      'Zari Fashions',
      '#1043',
      'Rs 5,250',
    ]);
    expect(templateButtons('order_confirmation', asking)).toEqual(
      ['confirm', 'cancel', 'address'].map((payload, index) => ({
        type: 'button',
        sub_type: 'quick_reply',
        index: String(index),
        parameters: [{ type: 'payload', payload }],
      })),
    );
    // The page to change the address: the template's URL ends with the link's last part.
    expect(templateButtons('order_address', asking)).toEqual([
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: 'Zx8kQ2mN4pR6sT0vW1yA3b' }],
      },
    ]);
    // Shipped, and out for delivery: a button to the order's page (ADR-160).
    for (const kind of ['order_shipped', 'order_out_for_delivery'] as const) {
      expect(templateButtons(kind, SHIPPED.variables)).toEqual([
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: 'Zx8kQ2mN4pR6sT0vW1yA3b' }],
        },
      ]);
    }
    expect(templateButtons('order_delivered', SHIPPED.variables)).toEqual([]);
  });

  it('tells a customer paying on delivery what to keep ready as their parcel goes out (ADR-160)', () => {
    const out = { shop: 'Zari Fashions', order: '#1043', due: 'Rs 5,250' };
    expect(messageText('order_out_for_delivery', 'en', out)).toBe(
      'Your order #1043 from Zari Fashions is out for delivery today. Please keep Rs 5,250 ready ' +
        'for the rider.',
    );
    expect(messageText('order_out_for_delivery', 'ur', out)).toMatch(
      /^Zari Fashions \p{Script=Arabic}.*#1043.*Rs 5,250/u,
    );
    expect(templateParameters('order_out_for_delivery', out)).toEqual([
      'Zari Fashions',
      '#1043',
      'Rs 5,250',
    ]);
  });

  it('tells the shop of a variant running low or out, at its alerts number (ADR-157)', () => {
    const stock = { shop: 'Zari Fashions', product: 'Lawn Kurta (S)', stock: '4' };
    expect(messageText('stock_low', 'en', stock)).toBe(
      'Zari Fashions: Lawn Kurta (S) is running low, with 4 left for sale online. Restock it in ' +
        'Hatti.',
    );
    expect(templateParameters('stock_low', stock)).toEqual([
      'Zari Fashions',
      'Lawn Kurta (S)',
      '4',
    ]);
    expect(messageText('stock_out', 'en', stock)).toBe(
      'Zari Fashions: Lawn Kurta (S) is out of stock online. Restock it in Hatti.',
    );
    expect(templateParameters('stock_out', stock)).toEqual(['Zari Fashions', 'Lawn Kurta (S)']);
    expect(messageText('stock_out', 'ur', stock)).toContain('Lawn Kurta (S)');
  });

  it('tells a customer of store credit given them, and of a credit about to expire (ADR-192)', () => {
    const credit = { shop: 'Zari Fashions', amount: 'Rs 1,000', balance: 'Rs 1,500' };
    expect(messageText('store_credit_given', 'en', credit)).toBe(
      'Zari Fashions: Rs 1,000 of store credit was added for you, Rs 1,500 in all. Spend it on ' +
        'your next order, ordering with this number.',
    );
    expect(templateParameters('store_credit_given', credit)).toEqual([
      'Zari Fashions',
      'Rs 1,000',
      'Rs 1,500',
    ]);
    const expiring = { shop: 'Zari Fashions', amount: 'Rs 600', date: '8 Mar, 2:00 pm' };
    expect(messageText('store_credit_expiring', 'en', expiring)).toBe(
      'Zari Fashions: Rs 600 of your store credit expires on 8 Mar, 2:00 pm. Spend it on an ' +
        'order before then, ordering with this number.',
    );
    expect(messageText('store_credit_expiring', 'ur', expiring)).toMatch(
      /^Zari Fashions: .*Rs 600.*8 Mar, 2:00 pm/u,
    );
    expect(templateParameters('store_credit_expiring', expiring)).toEqual([
      'Zari Fashions',
      'Rs 600',
      '8 Mar, 2:00 pm',
    ]);
  });

  it('tells a member of staff of an order given to them, or a comment naming them (ADR-191)', () => {
    const work = { shop: 'Zari Fashions', order: '#1043' };
    expect(messageText('order_assigned', 'en', work)).toBe(
      'Zari Fashions: order #1043 is yours to see through now. Find it among your orders in Hatti.',
    );
    expect(messageText('order_mentioned', 'en', work)).toBe(
      'Zari Fashions: a comment on order #1043 names you. Read it in Hatti.',
    );
    expect(messageText('order_mentioned', 'ur', work)).toMatch(/^Zari Fashions: .*#1043/u);
    for (const kind of ['order_assigned', 'order_mentioned'] as const) {
      expect(templateParameters(kind, work)).toEqual(['Zari Fashions', '#1043']);
      // Not the news of an order for its customer: no email carries it.
      expect(messageEmail(kind, 'en', work)).toBeNull();
    }
  });

  it('asks once more, with the same answers and link, those who have not answered (ADR-175)', () => {
    const asking = {
      name: 'Ayesha',
      shop: 'Zari Fashions',
      order: '#1043',
      total: 'Rs 5,250',
      url: 'https://hatti.pk/o/Zx8kQ2mN4pR6sT0vW1yA3b',
    };
    expect(messageText('order_confirmation_reminder', 'en', asking)).toBe(
      'Assalam-o-Alaikum Ayesha! Zari Fashions is still waiting to hear from you about your ' +
        'order #1043 for Rs 5,250, paid in cash on delivery. Confirm it so they can send it, or ' +
        'cancel it, here: https://hatti.pk/o/Zx8kQ2mN4pR6sT0vW1yA3b',
    );
    expect(messageText('order_confirmation_reminder', 'ur', asking)).toMatch(
      /\p{Script=Arabic}.* https:\/\/hatti\.pk\/o\/Zx8kQ2mN4pR6sT0vW1yA3b$/u,
    );
    expect(templateParameters('order_confirmation_reminder', asking)).toEqual(
      templateParameters('order_confirmation', asking),
    );
    expect(templateButtons('order_confirmation_reminder', asking)).toEqual(
      templateButtons('order_confirmation', asking),
    );
  });

  it('tells a customer the shop has their payment, and what is left for the rider (ADR-171)', () => {
    const paid = { name: 'Ayesha', shop: 'Zari Fashions', amount: 'Rs 5,250', order: '#1043' };
    expect(messageText('order_paid', 'en', paid)).toBe(
      'Assalam-o-Alaikum Ayesha! Zari Fashions has received your payment of Rs 5,250 for order ' +
        "#1043. Thank you! We'll tell you when it ships.",
    );
    expect(templateParameters('order_paid', paid)).toEqual([
      'Ayesha',
      'Zari Fashions',
      'Rs 5,250',
      '#1043',
    ]);
    const advance = { ...paid, amount: 'Rs 500', due: 'Rs 4,750' };
    expect(messageText('order_advance_paid', 'en', advance)).toBe(
      'Assalam-o-Alaikum Ayesha! Zari Fashions has received Rs 500 for your order #1043. Please ' +
        'keep the remaining Rs 4,750 ready for the rider.',
    );
    expect(templateParameters('order_advance_paid', advance)).toEqual([
      'Ayesha',
      'Zari Fashions',
      'Rs 500',
      '#1043',
      'Rs 4,750',
    ]);
    expect(messageText('order_advance_paid', 'ur', advance)).toContain('Rs 4,750');
  });

  it('reminds a customer to pay before the order is cancelled, with its page (ADR-174)', () => {
    const reminder = {
      name: 'Ayesha',
      shop: 'Zari Fashions',
      order: '#1043',
      amount: 'Rs 5,250',
      date: '4 Oct, 3:00 pm',
      url: 'https://hatti.pk/o/Zx8kQ2mN4pR6sT0vW1yA3b',
    };
    expect(messageText('order_payment_reminder', 'en', reminder)).toBe(
      'Assalam-o-Alaikum Ayesha! Your order #1043 from Zari Fashions still waits for its payment ' +
        'of Rs 5,250. Pay it by 4 Oct, 3:00 pm, or the order is cancelled. Its page says how: ' +
        'https://hatti.pk/o/Zx8kQ2mN4pR6sT0vW1yA3b',
    );
    expect(templateParameters('order_payment_reminder', reminder)).toEqual([
      'Ayesha',
      'Zari Fashions',
      '#1043',
      'Rs 5,250',
      '4 Oct, 3:00 pm',
    ]);
    expect(templateButtons('order_payment_reminder', reminder)).toEqual([
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: 'Zx8kQ2mN4pR6sT0vW1yA3b' }],
      },
    ]);
  });

  it("tells the shop of its bills with Hatti, at Hatti's cost (ADR-169)", () => {
    const due = { shop: 'Zari Fashions', invoice: 'HT-1042', plan: 'Starter', amount: 'Rs 2,499' };
    expect(messageText('invoice_due', 'en', due)).toBe(
      "Hatti: invoice HT-1042 for Zari Fashions's next period on Starter, Rs 2,499, waits for " +
        "payment. Pay it from Hatti's admin to keep the plan.",
    );
    expect(templateParameters('invoice_due', due)).toEqual([
      'Zari Fashions',
      'HT-1042',
      'Starter',
      'Rs 2,499',
    ]);
    expect(messageText('invoice_due', 'ur', due)).toContain('HT-1042');
    expect(templateParameters('plan_ended', { shop: 'Zari Fashions' })).toEqual(['Zari Fashions']);
    const low = { shop: 'Zari Fashions', balance: 'Rs 95.76' };
    expect(messageText('credit_low', 'en', low)).toBe(
      "Hatti: Zari Fashions's message credit is down to Rs 95.76. Messages to customers wait " +
        "once it runs out: buy more from Hatti's admin.",
    );
    expect(templateParameters('credit_low', low)).toEqual(['Zari Fashions', 'Rs 95.76']);
    // Never from the shop's credit, which may be what the notice is about; always sent.
    expect(MESSAGE_KINDS.filter((kind) => !paidByShop(kind))).toEqual([
      'invoice_due',
      'plan_ended',
      'credit_low',
    ]);
    expect(ALWAYS_SENT).toEqual(['one_time_code', 'invoice_due', 'plan_ended', 'credit_low']);
  });

  it('tells a number another took the place of which number signs in now (ADR-173)', () => {
    const replaced = { shop: 'Hatti', phone: '+92 321 •••4321' };
    expect(messageText('number_replaced', 'en', replaced)).toBe(
      'Hatti: this number no longer signs in to your Hatti account; +92 321 •••4321 does now. ' +
        "If you didn't change it, contact Hatti's support at once.",
    );
    expect(templateParameters('number_replaced', replaced)).toEqual(['+92 321 •••4321']);
    expect(messageText('number_replaced', 'ur', replaced)).toContain('+92 321 •••4321');
  });

  it('tells an account of a sign-in from a device new to it, and when (ADR-179)', () => {
    const alert = { shop: 'Hatti', device: 'Chrome on Windows', date: '5 Oct, 3:04 pm' };
    expect(messageText('sign_in_alert', 'en', alert)).toBe(
      'Hatti: your account was signed in to from Chrome on Windows on 5 Oct, 3:04 pm. ' +
        "If it wasn't you, sign that device out from your sessions in Hatti's admin and contact " +
        "Hatti's support at once.",
    );
    expect(templateParameters('sign_in_alert', alert)).toEqual([
      'Chrome on Windows',
      '5 Oct, 3:04 pm',
    ]);
    expect(messageText('sign_in_alert', 'ur', { ...alert, device: 'Windows پر Chrome' })).toContain(
      '5 Oct, 3:04 pm کو Windows پر Chrome سے',
    );
  });

  it('carries a code in its words and in the button that copies it', () => {
    const code = { shop: 'Zari Fashions', code: '048213' };
    expect(messageText('one_time_code', 'en', code)).toBe(
      '048213 is your code to place your order with Zari Fashions. It works for 10 minutes. ' +
        'Never share it.',
    );
    expect(templateParameters('one_time_code', code)).toEqual(['048213']);
    expect(templateButtons('one_time_code', code)).toEqual([
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: '048213' }],
      },
    ]);
    // Hatti's own, signing a merchant in (ADR-159): the same button, from Hatti.
    const signIn = { shop: 'Hatti', code: '731904' };
    expect(messageText('sign_in_code', 'en', signIn)).toBe(
      '731904 is your Hatti code. It works for 10 minutes. Never share it, not even with Hatti.',
    );
    expect(messageText('sign_in_code', 'ur', signIn)).toMatch(/^\p{Script=Arabic}.* 731904 /u);
    expect(templateParameters('sign_in_code', signIn)).toEqual(['731904']);
    expect(templateButtons('sign_in_code', signIn)).toEqual([
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: '731904' }],
      },
    ]);
  });

  it("carries an order's news by email too, its link a button, right to left in Urdu (ADR-181)", () => {
    // News of the order, and Hatti's notices of the shop's bills to its owner (ADR-195): not the
    // answers WhatsApp's buttons bring, codes or the shop's alerts.
    expect(EMAILED_KINDS).toEqual([
      'order_placed',
      'order_confirmation',
      'order_confirmed',
      'order_shipped',
      'order_out_for_delivery',
      'order_delivered',
      'order_cancelled',
      'order_paid',
      'order_advance_paid',
      'order_payment_reminder',
      'order_confirmation_reminder',
      'invoice_due',
      'plan_ended',
      'credit_low',
    ]);
    const shipped = messageEmail('order_shipped', 'en', SHIPPED.variables)!;
    expect(shipped.from).toBe('shop');
    expect(shipped.subject).toBe('Your order #1043 is on its way');
    expect(shipped.text).toBe(
      'Your order #1043 from Zari Fashions is on its way with PostEx. Tracking number: ' +
        'PX123456.\n\nhttps://hatti.pk/o/Zx8kQ2mN4pR6sT0vW1yA3b\n\nZari Fashions sent this ' +
        "through Hatti because you gave this email with your order. Replies to it aren't read.",
    );
    expect(shipped.html).toMatch(/^<!doctype html><html lang="en"><body /);
    expect(shipped.html).toContain('<a href="https://hatti.pk/o/Zx8kQ2mN4pR6sT0vW1yA3b" ');
    expect(shipped.html).toContain('>Open your order</a>');
    // The shop's name is written as it is, never read as HTML; with no link, no button.
    const placed = messageEmail('order_placed', 'ur', {
      name: 'Ayesha',
      shop: 'Zari <b>Lawn</b> & Co',
      order: '#1044',
      total: 'Rs 5,250',
    })!;
    expect(placed.subject).toBe('Zari <b>Lawn</b> & Co سے آپ کا آرڈر #1044');
    expect(placed.html).toMatch(/^<!doctype html><html lang="ur" dir="rtl"><body /);
    expect(placed.html).toContain('Zari &lt;b&gt;Lawn&lt;/b&gt; &amp; Co');
    expect(placed.html).not.toContain('<b>');
    expect(placed.html).not.toContain('<a ');
    expect(placed.text.split('\n\n')).toEqual([
      messageText('order_placed', 'ur', {
        name: 'Ayesha',
        shop: 'Zari <b>Lawn</b> & Co',
        order: '#1044',
        total: 'Rs 5,250',
      }),
      expect.stringMatching(/^Zari <b>Lawn<\/b> & Co نے یہ ای میل ہٹی کے ذریعے بھیجی ہے/),
    ]);
    // A subject is one line, whatever the shop is called.
    expect(messageEmail('order_confirmed', 'en', { shop: 'Zari', order: '#1\n2' })!.subject).toBe(
      'Your order #1 2 is confirmed',
    );
    expect(messageEmail('one_time_code', 'en', { shop: 'Zari', code: '048213' })).toBeNull();
    expect(messageEmail('order_address', 'en', { shop: 'Zari', order: '#1' })).toBeNull();
    expect(
      messageEmail('stock_low', 'en', { shop: 'Zari', product: 'Lawn', stock: '2' }),
    ).toBeNull();
  });

  it("emails Hatti's notices of a shop's bills to its owner from Hatti, saying why (ADR-195)", () => {
    const bill = { shop: 'Zari Fashions', invoice: 'HB-1042', plan: 'Starter', amount: 'Rs 2,499' };
    const due = messageEmail('invoice_due', 'en', bill)!;
    expect(due).toMatchObject({
      from: 'hatti',
      subject: 'Invoice HB-1042 for Zari Fashions waits for payment',
    });
    expect(due.text.split('\n\n')).toEqual([
      messageText('invoice_due', 'en', bill),
      "Hatti sent this to you as the owner of Zari Fashions, about its bills with Hatti. Replies to it aren't read.",
    ]);
    // Nothing to open from it: the admin's billing page is where they pay.
    expect(due.html).not.toContain('<a ');
    expect(messageEmail('plan_ended', 'en', { shop: 'Zari Fashions' })!.subject).toBe(
      "Zari Fashions's plan has ended",
    );
    const low = messageEmail('credit_low', 'ur', { shop: 'Zari Fashions', balance: 'Rs 97.14' })!;
    expect(low.subject).toBe('Zari Fashions کا میسج کریڈٹ Rs 97.14 رہ گیا ہے');
    expect(low.html).toMatch(/^<!doctype html><html lang="ur" dir="rtl"><body /);
    expect(low.text).toMatch(/ہٹی نے یہ ای میل آپ کو Zari Fashions کے مالک کے طور پر/);
  });

  it('hears a customer asking to stop, in English, Roman Urdu and Urdu, and nothing else', () => {
    const urdu = String.fromCharCode(0x628, 0x646, 0x62f, 0x20, 0x6a9, 0x631, 0x648);
    for (const said of ['STOP', ' stop! ', 'Band karo', 'band  kro', urdu, 'Unsubscribe.']) {
      expect(asksToStop(said), said).toBe(true);
    }
    for (const said of ['stop sending the blue one', 'where is my order?', 'band', '']) {
      expect(asksToStop(said), said).toBe(false);
    }
  });
});

describe('What a message costs', () => {
  it("counts an SMS's parts as gateways charge them: GSM's 160, or Urdu's 70", () => {
    // GSM's alphabet: 160 alone, 153 a part of a longer one; its extension counts two.
    expect(smsParts('a'.repeat(160))).toBe(1);
    expect(smsParts('a'.repeat(161))).toBe(2);
    expect(smsParts('a'.repeat(306))).toBe(2);
    expect(smsParts('a'.repeat(307))).toBe(3);
    expect(smsParts('Δ£é@'.repeat(40))).toBe(1);
    expect(smsParts('{'.repeat(80))).toBe(1);
    expect(smsParts('{'.repeat(81))).toBe(2);
    // Urdu, or any character GSM lacks: 70 alone, 67 a part.
    const ur = String.fromCharCode(0x6a9);
    expect(smsParts(ur.repeat(70))).toBe(1);
    expect(smsParts(ur.repeat(71))).toBe(2);
    expect(smsParts(ur.repeat(134))).toBe(2);
    expect(smsParts(ur.repeat(135))).toBe(3);
    expect(smsParts(`${'a'.repeat(69)}ç`)).toBe(1);
    expect(smsParts(`${'a'.repeat(70)}ç`)).toBe(2);
  });

  it("prices a message by its channel, its template's category, and its SMS's parts", () => {
    const shipped = { kind: 'order_shipped', variables: SHIPPED.variables } as const;
    expect(messageCostOf({ ...shipped, channel: 'whatsapp', language: 'ur' })).toEqual({
      channel: 'whatsapp',
      category: 'utility',
      parts: 1,
    });
    expect(messageCostOf({ ...shipped, channel: 'sms', language: 'en' })).toEqual({
      channel: 'sms',
      category: 'utility',
      parts: 1,
    });
    expect(messageCostOf({ ...shipped, channel: 'sms', language: 'ur' })).toEqual({
      channel: 'sms',
      category: 'utility',
      parts: 2,
    });
    const code = { shop: 'Zari Fashions', code: '048213' };
    expect(
      messageCostOf({ kind: 'one_time_code', channel: 'sms', language: 'en', variables: code }),
    ).toEqual({ channel: 'sms', category: 'authentication', parts: 1 });
  });

  it("charges the shop's credit for WhatsApp and SMS, never for an email (ADR-181)", () => {
    expect(chargedFor({ channel: 'whatsapp', kind: 'order_shipped' })).toBe(true);
    expect(chargedFor({ channel: 'sms', kind: 'order_shipped' })).toBe(true);
    expect(chargedFor({ channel: 'email', kind: 'order_shipped' })).toBe(false);
    // Hatti's own notices to the shop are Hatti's to pay for (ADR-169).
    expect(chargedFor({ channel: 'whatsapp', kind: 'invoice_due' })).toBe(false);
  });
});

describe("WhatsApp's webhook", () => {
  const body = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              statuses: [
                { id: 'wamid.1', status: 'delivered', timestamp: '1790940000' },
                {
                  id: 'wamid.2',
                  status: 'failed',
                  timestamp: '1790940060',
                  errors: [{ code: 131026, title: 'Message undeliverable' }],
                },
                { id: 'wamid.3', status: 'deleted', timestamp: '1790940060' },
              ],
              messages: [
                {
                  from: '923001234567',
                  id: 'wamid.in',
                  timestamp: '1790940120',
                  type: 'text',
                  text: { body: 'Band karo' },
                },
                {
                  from: '923007654321',
                  type: 'button',
                  timestamp: '1790940180',
                  context: { from: '15550001111', id: 'wamid.asked' },
                  button: { payload: 'x', text: 'Stop' },
                },
                {
                  from: '923335550001',
                  type: 'interactive',
                  timestamp: '1790940240',
                  context: { id: 'wamid.confirm' },
                  interactive: {
                    type: 'button_reply',
                    button_reply: { id: 'confirm', title: 'Confirm order' },
                  },
                },
                { from: '+92 300', type: 'text', text: { body: 'stop' } },
              ],
            },
          },
          { field: 'account_update', value: {} },
        ],
      },
    ],
  };

  it('reads statuses and replies, leaving out what it does not know', () => {
    expect(parseWhatsAppWebhook(body)).toEqual({
      statuses: [
        {
          providerMessageId: 'wamid.1',
          status: 'delivered',
          at: new Date(1790940000_000),
          error: null,
        },
        {
          providerMessageId: 'wamid.2',
          status: 'failed',
          at: new Date(1790940060_000),
          error: 'WhatsApp 131026: Message undeliverable',
        },
      ],
      inbound: [
        {
          from: '+923001234567',
          text: 'Band karo',
          replyTo: null,
          payload: null,
          at: new Date(1790940120_000),
        },
        {
          from: '+923007654321',
          text: 'Stop',
          replyTo: 'wamid.asked',
          payload: 'x',
          at: new Date(1790940180_000),
        },
        {
          from: '+923335550001',
          text: 'Confirm order',
          replyTo: 'wamid.confirm',
          payload: 'confirm',
          at: new Date(1790940240_000),
        },
      ],
    });
    expect(parseWhatsAppWebhook(null)).toEqual({ statuses: [], inbound: [] });
    expect(parseWhatsAppWebhook({ entry: 'x' })).toEqual({ statuses: [], inbound: [] });
  });

  it("takes only bodies signed with the app's secret", () => {
    const raw = Buffer.from(JSON.stringify(body));
    const signed = `sha256=${createHmac('sha256', 'app-secret').update(raw).digest('hex')}`;
    expect(signatureValid(raw, signed, 'app-secret')).toBe(true);
    expect(signatureValid(raw, signed, 'another-secret')).toBe(false);
    expect(signatureValid(Buffer.concat([raw, Buffer.from(' ')]), signed, 'app-secret')).toBe(
      false,
    );
    expect(signatureValid(raw, undefined, 'app-secret')).toBe(false);
    expect(signatureValid(raw, 'sha256=00', 'app-secret')).toBe(false);
  });
});

describe('Providers', () => {
  let server: Server;
  let baseUrl: string;
  const requests: { url: string; headers: IncomingMessage['headers']; body: unknown }[] = [];
  let answer: { status: number; body: unknown } = { status: 200, body: {} };

  beforeAll(async () => {
    server = createServer((request, response) => {
      let text = '';
      request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      request.on('end', () => {
        requests.push({ url: request.url ?? '', headers: request.headers, body: JSON.parse(text) });
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("sends WhatsApp's template from Hatti's number, and says what to do when it is refused", async () => {
    const whatsapp = new WhatsAppCloudProvider({
      baseUrl: `${baseUrl}/`,
      version: 'v26.0',
      phoneNumberId: '1098765432',
      accessToken: 'EAAG-system-user-token',
    });
    answer = { status: 200, body: { messages: [{ id: 'wamid.HBgM' }] } };
    expect(await whatsapp.send(SHIPPED)).toEqual({ ok: true, providerMessageId: 'wamid.HBgM' });
    const [sent] = requests.splice(0);
    expect(sent!.url).toBe('/v26.0/1098765432/messages');
    expect(sent!.headers.authorization).toBe('Bearer EAAG-system-user-token');
    expect(sent!.body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '923001234567',
      type: 'template',
      template: {
        name: 'hatti_order_shipped',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: ['Zari Fashions', '#1043', 'PostEx', 'PX123456'].map((text) => ({
              type: 'text',
              text,
            })),
          },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: 'Zx8kQ2mN4pR6sT0vW1yA3b' }],
          },
        ],
      },
    });

    const refused = async (status: number, error: Record<string, unknown>) => {
      answer = { status, body: { error } };
      return whatsapp.send(SHIPPED);
    };
    expect(await refused(400, { code: 131026, message: 'Message undeliverable' })).toEqual({
      ok: false,
      outcome: 'replace',
      error: 'WhatsApp 131026: Message undeliverable',
    });
    expect(await refused(400, { code: 130429, message: 'Rate limit hit' })).toMatchObject({
      outcome: 'retry',
    });
    expect(await refused(503, { code: 2, message: 'Service unavailable' })).toMatchObject({
      outcome: 'retry',
    });
    expect(await refused(400, { code: 132001, message: 'Template does not exist' })).toMatchObject({
      outcome: 'replace',
    });
    requests.splice(0);
    const nowhere = new WhatsAppCloudProvider({
      baseUrl: 'http://127.0.0.1:1',
      version: 'v26.0',
      phoneNumberId: '1',
      accessToken: 'x',
      timeoutMs: 2_000,
    });
    expect(await nowhere.send(SHIPPED)).toMatchObject({ ok: false, outcome: 'retry' });
  });

  it('writes to the log what it would have sent, an email with its subject', async () => {
    const logged: [string, string][] = [];
    const log = (channel: 'sms' | 'email') =>
      new LogProvider(channel, (message, text) => void logged.push([message.channel, text]));
    expect(await log('email').send({ ...SHIPPED, channel: 'email', recipient: 'a@b.pk' })).toEqual({
      ok: true,
      providerMessageId: `log-${SHIPPED.id}`,
    });
    await log('sms').send({ ...SHIPPED, channel: 'sms' });
    expect(logged).toEqual([
      ['email', expect.stringMatching(/^Your order #1043 is on its way\n\nYour order #1043 from /)],
      ['sms', messageText('order_shipped', 'en', SHIPPED.variables)],
    ]);
  });

  it("sends an SMS's words through the gateway, and gives up only on what it refuses", async () => {
    const sms = new SmsGatewayProvider({
      url: `${baseUrl}/sms`,
      apiKey: 'gateway-key',
      sender: 'Hatti',
    });
    const message = { ...SHIPPED, channel: 'sms' as const, language: 'ur' as const };
    answer = { status: 200, body: { id: 77 } };
    expect(await sms.send(message)).toEqual({ ok: true, providerMessageId: '77' });
    const [sent] = requests.splice(0);
    expect(sent!.headers.authorization).toBe('Bearer gateway-key');
    expect(sent!.body).toEqual({
      to: '+923001234567',
      text: messageText('order_shipped', 'ur', SHIPPED.variables),
      sender: 'Hatti',
    });
    // Taken without an ID: sent all the same, never twice.
    answer = { status: 202, body: {} };
    expect(await sms.send(message)).toEqual({ ok: true, providerMessageId: `sms-${SHIPPED.id}` });
    answer = { status: 429, body: { error: 'slow down' } };
    expect(await sms.send(message)).toMatchObject({ ok: false, outcome: 'retry' });
    answer = { status: 400, body: { error: 'invalid number' } };
    expect(await sms.send(message)).toEqual({
      ok: false,
      outcome: 'fail',
      error: 'SMS gateway 400: invalid number',
    });
    requests.splice(0);
  });
});
