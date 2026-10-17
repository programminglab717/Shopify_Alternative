import { WhatsAppCloudProvider } from '@hatti/messaging/public';

// Hatti's support WhatsApp number (BIL-05, ADR-560): what a shop's staff write to it is kept as
// a request of their shop, and Hatti's answer goes back to them from it, within the day WhatsApp
// lets a business write freely after their last message.

/** How Hatti's answers go out from its support number. */
export interface SupportWhatsAppSender {
  /** Sends `text`, as written, to `to`, E.164: WhatsApp's ID for it, or why it was not taken. */
  send(to: string, text: string): Promise<{ ok: true; id: string } | { ok: false; error: string }>;
}

export const SUPPORT_WHATSAPP_SENDER = Symbol('SUPPORT_WHATSAPP_SENDER');

/** Hatti's support number on WhatsApp's Cloud API, with its token, on Meta's Graph API. */
export interface SupportWhatsAppSettings {
  baseUrl: string;
  version: string;
  phoneNumberId: string;
  accessToken: string;
}

/** Answers from Hatti's support number, through WhatsApp's Cloud API as the inbox's go. */
export function cloudSupportSender(settings: SupportWhatsAppSettings): SupportWhatsAppSender {
  const provider = new WhatsAppCloudProvider(settings);
  return {
    async send(to, text) {
      const sent = await provider.sendText(to, text);
      return sent.ok ? { ok: true, id: sent.providerMessageId } : { ok: false, error: sent.error };
    },
  };
}

/** Whether `text` is written in Urdu's letters, the Arabic script, rather than in Roman. */
export function inUrduScript(text: string): boolean {
  return /\p{Script=Arabic}/u.test(text);
}
