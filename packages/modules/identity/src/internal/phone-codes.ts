import { createHash, randomInt } from 'node:crypto';

// Codes that prove a merchant's mobile number, to sign in or open an account with it (ONB-01,
// ADR-159): six digits sent on WhatsApp, or by SMS, working for ten minutes and five tries. Only a
// digest of each is kept.

export const PHONE_CODE = {
  digits: 6,
  minutes: 10,
  /** Tries at one code. */
  attempts: 5,
  /** How long a number waits before another code is sent to it. */
  resendSeconds: 30,
  /** Codes one number is sent in an hour, and in a day. */
  perNumberHourly: 5,
  perNumberDaily: 10,
  /** How long codes are kept, to look into abuse, before they go as new ones are sent. */
  keepDays: 30,
  /** How long a number proved for no account yet may open one. */
  signUpMinutes: 15,
} as const;

export type PhoneCodeChannel = 'whatsapp' | 'sms';

/** What a code says around itself: English or Urdu. */
export type PhoneCodeLanguage = 'en' | 'ur';

/**
 * Sends the codes that prove numbers, as the host application can: on WhatsApp from Hatti's own
 * number, or by SMS when WhatsApp cannot deliver it or the merchant asks; word to a number another
 * took the place of, or to one removed from its account; and word of a sign-in from a device new to
 * an account. At Hatti's cost, never
 * a shop's.
 */
export abstract class PhoneCodeSender {
  /**
   * Sends `code` to `phone`, on `channel` where it can: the channel it went by, or null when it
   * went by none.
   */
  abstract send(input: {
    phone: string;
    code: string;
    channel: PhoneCodeChannel;
    language: PhoneCodeLanguage;
  }): Promise<PhoneCodeChannel | null>;

  /**
   * Tells `phone` that the number `replacedBy` signs in to its account in its place now (ADR-173):
   * the channel it went by, or null. A host that cannot sends nothing.
   */
  async tellReplaced(input: {
    phone: string;
    replacedBy: string;
    language: PhoneCodeLanguage;
  }): Promise<PhoneCodeChannel | null> {
    void input;
    return null;
  }

  /**
   * Tells `phone` that it was removed from its account and signs in to nothing now (ADR-202): the
   * channel it went by, or null. A host that cannot sends nothing.
   */
  async tellRemoved(input: {
    phone: string;
    language: PhoneCodeLanguage;
  }): Promise<PhoneCodeChannel | null> {
    void input;
    return null;
  }

  /**
   * Tells `phone` that its account was signed in to from `device`, a device new to it, at `date`
   * (ADR-179): the channel it went by, or null. A host that cannot sends nothing.
   */
  async tellSignedIn(input: {
    phone: string;
    device: string;
    date: string;
    language: PhoneCodeLanguage;
  }): Promise<PhoneCodeChannel | null> {
    void input;
    return null;
  }
}

/** A new code: six digits, any of them. */
export function newPhoneCode(): string {
  return String(randomInt(0, 10 ** PHONE_CODE.digits)).padStart(PHONE_CODE.digits, '0');
}

/** What is kept of a code: SHA-256 of it with its row's ID. */
export function phoneCodeDigest(id: string, code: string): Buffer {
  return createHash('sha256').update(`${id}:${code}`).digest();
}

/** "+92 300 •••4567": enough for the merchant to know which number, and no more. */
export function maskPhone(e164: string): string {
  return `${e164.slice(0, 3)} ${e164.slice(3, 6)} •••${e164.slice(-4)}`;
}
