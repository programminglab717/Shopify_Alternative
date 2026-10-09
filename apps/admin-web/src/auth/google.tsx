import { useEffect, useRef } from 'react';
import { useLocale } from '../i18n/locale';

/** What the core gives to start Google's sign-in: its client ID, and a nonce for the token. */
export interface GoogleOptions {
  clientId: string;
  nonce: string;
}

/** The part of Google Identity Services' `google.accounts.id` the admin uses. */
interface GoogleIdentity {
  initialize(config: {
    client_id: string;
    nonce: string;
    callback: (answer: { credential: string }) => void;
    ux_mode?: 'popup';
    context?: 'signin' | 'use';
  }): void;
  renderButton(
    parent: HTMLElement,
    options: {
      type: 'standard';
      theme: 'outline';
      size: 'large';
      text: 'continue_with';
      shape: 'rectangular';
      width: number;
      locale: string;
    },
  ): void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdentity } };
  }
}

let loading: Promise<GoogleIdentity> | null = null;

/** Google Identity Services, loaded from Google once and only when a page asks for it. */
function loadGoogle(): Promise<GoogleIdentity> {
  const ready = window.google?.accounts?.id;
  if (ready) return Promise.resolve(ready);
  loading ??= new Promise<GoogleIdentity>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => {
      const loaded = window.google?.accounts?.id;
      if (loaded) resolve(loaded);
      else reject(new Error('Google sign-in did not load'));
    };
    script.onerror = () => {
      loading = null;
      reject(new Error('Google sign-in did not load'));
    };
    document.head.append(script);
  });
  return loading;
}

/**
 * Google's own "Continue with Google" button (ADR-164), started with the core's client ID and
 * nonce: the ID token Google gives back goes to `onToken`, for the core to check.
 */
export function GoogleButton({
  options,
  onToken,
  onError,
}: {
  options: GoogleOptions;
  onToken: (idToken: string) => void;
  onError: (failure: unknown) => void;
}) {
  const { locale } = useLocale();
  const box = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onToken, onError });
  useEffect(() => {
    handlers.current = { onToken, onError };
  });

  useEffect(() => {
    let live = true;
    loadGoogle()
      .then((google) => {
        if (!live || !box.current) return;
        google.initialize({
          client_id: options.clientId,
          nonce: options.nonce,
          ux_mode: 'popup',
          callback: (answer) => handlers.current.onToken(answer.credential),
        });
        box.current.replaceChildren();
        google.renderButton(box.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          width: Math.min(400, box.current.clientWidth || 320),
          locale,
        });
      })
      .catch((failure: unknown) => live && handlers.current.onError(failure));
    return () => {
      live = false;
    };
  }, [options.clientId, options.nonce, locale]);

  return <div ref={box} className="flex min-h-11 justify-center" />;
}
