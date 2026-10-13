import type { WhatsAppSignup } from '../api/types';

/** What Embedded Signup gives back: a code for the core to trade, and the number chosen. */
export interface SignupResult {
  code: string;
  businessAccountId: string;
  phoneNumberId: string;
}

/** The part of Facebook's JavaScript SDK the admin uses. */
interface FacebookSdk {
  init(options: {
    appId: string;
    version: string;
    xfbml: boolean;
    autoLogAppEvents: boolean;
  }): void;
  login(
    callback: (response: { authResponse?: { code?: string } | null }) => void,
    options: {
      config_id: string;
      response_type: 'code';
      override_default_response_type: true;
      extras: { setup: Record<string, never>; sessionInfoVersion: string };
    },
  ): void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

/** Where Embedded Signup's window speaks from. */
const FACEBOOK_ORIGINS = ['https://www.facebook.com', 'https://web.facebook.com'];

/** How long the number chosen is waited for once Facebook has given its code. */
const NUMBER_WAIT_MS = 3000;

let loading: Promise<FacebookSdk> | null = null;

/** Facebook's SDK, loaded from Facebook once and only when a shop connects its number. */
function loadFacebook(): Promise<FacebookSdk> {
  if (window.FB) return Promise.resolve(window.FB);
  loading ??= new Promise<FacebookSdk>((resolve, reject) => {
    window.fbAsyncInit = () => {
      if (window.FB) resolve(window.FB);
      else reject(new Error('Facebook did not load'));
    };
    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => {
      loading = null;
      reject(new Error('Facebook did not load'));
    };
    document.head.append(script);
  });
  return loading;
}

/** Embedded Signup's word on how it went, posted from Facebook's window. */
type SessionEvent =
  | { event: 'FINISH'; data: { phone_number_id?: string; waba_id?: string } }
  | { event: 'CANCEL' }
  | { event: 'ERROR'; data?: { error_message?: string } };

function sessionEvent(message: MessageEvent): SessionEvent | null {
  if (!FACEBOOK_ORIGINS.includes(message.origin)) return null;
  try {
    const data: unknown =
      typeof message.data === 'string' ? JSON.parse(message.data) : message.data;
    if (!data || typeof data !== 'object' || !('type' in data)) return null;
    return (data as { type: unknown }).type === 'WA_EMBEDDED_SIGNUP'
      ? (data as unknown as SessionEvent)
      : null;
  } catch {
    return null;
  }
}

/**
 * Meta's Embedded Signup (ADR-419): Facebook's window, where the shop signs in, makes or chooses
 * its WhatsApp Business account and number, and gives Hatti's app leave to send from it. The code
 * Facebook gives and the number chosen, for the core; null when the shop closed it before the end.
 */
export async function embeddedSignup(signup: WhatsAppSignup): Promise<SignupResult | null> {
  const facebook = await loadFacebook();
  facebook.init({
    appId: signup.appId,
    version: signup.graphVersion,
    xfbml: false,
    autoLogAppEvents: false,
  });
  return new Promise<SignupResult | null>((resolve, reject) => {
    let number: Omit<SignupResult, 'code'> | null = null;
    let code: string | null = null;
    let ended = false;
    const end = (outcome: () => void) => {
      if (ended) return;
      ended = true;
      window.removeEventListener('message', listen);
      outcome();
    };
    // Facebook says which number was chosen in a message, and gives the code to the callback.
    const settle = () => {
      if (number && code) end(() => resolve({ code: code!, ...number! }));
    };
    const listen = (message: MessageEvent) => {
      const session = sessionEvent(message);
      if (!session) return;
      if (session.event === 'FINISH') {
        const { phone_number_id: phoneNumberId, waba_id: businessAccountId } = session.data;
        if (phoneNumberId && businessAccountId) number = { businessAccountId, phoneNumberId };
        settle();
      } else if (session.event === 'CANCEL') {
        end(() => resolve(null));
      } else {
        const reason = session.data?.error_message ?? 'Embedded Signup failed';
        end(() => reject(new Error(reason)));
      }
    };
    window.addEventListener('message', listen);
    facebook.login(
      (response) => {
        const given = response.authResponse?.code;
        if (!given) {
          end(() => resolve(null));
          return;
        }
        code = given;
        settle();
        // The number's message comes first as a rule; it is waited for a moment if not, and
        // without one nothing can be connected.
        if (!number) window.setTimeout(() => end(() => resolve(null)), NUMBER_WAIT_MS);
      },
      {
        config_id: signup.configurationId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {}, sessionInfoVersion: '3' },
      },
    );
  });
}
