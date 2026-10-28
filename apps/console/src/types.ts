/** A shop's request waiting for Hatti's people (ADR-508), as the console's server lists it. */
export interface SupportRequest {
  id: string;
  shop: { id: string; name: string; plan: string };
  channel: 'admin' | 'whatsapp';
  topic: string;
  language: 'en' | 'ur';
  priority: number;
  message: string;
  callBack: string | null;
  createdAt: string;
  dueAt: string;
  late: boolean;
  lastInbound: { text: string; at: string } | null;
}

export interface AnsweredSupportRequest {
  request: SupportRequest;
  whatsapp: 'sent' | 'window_closed' | 'unavailable' | 'failed' | 'none';
  whatsappError?: string;
}

/** Something done in the console, as its log keeps it. */
export interface ConsoleAction {
  id: string;
  email: string;
  action: string;
  subject: string | null;
  details: Record<string, unknown>;
  at: string;
}
