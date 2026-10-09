import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { messages, type MessageKey } from './messages';

/** The admin's languages (design system §3): English, and Urdu written right to left. */
export type Locale = 'en' | 'ur';

const STORAGE_KEY = 'hatti.locale';

/** Values a message's `{name}` placeholders take. */
export type MessageValues = Readonly<Record<string, string | number>>;

export type Translate = (key: MessageKey, values?: MessageValues) => string;

interface LocaleContextValue {
  locale: Locale;
  dir: 'ltr' | 'rtl';
  setLocale: (locale: Locale) => void;
  t: Translate;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

/** `text` with each `{name}` replaced by its value; one left without a value stays as it is. */
export function interpolate(text: string, values?: MessageValues): string {
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

/**
 * `key`'s words in `locale`, its `{name}`s filled in; where `count` is one and the message has a
 * singular form, `key.one` ("1 order to confirm"), that one.
 */
export function translate(locale: Locale, key: MessageKey, values?: MessageValues): string {
  const table = messages[locale] as Readonly<Record<string, string>>;
  const singular = values && String(values.count) === '1' ? table[`${key}.one`] : undefined;
  return interpolate(singular ?? table[key]!, values);
}

/** The language kept from last time; browser storage may be missing or blocked. */
function storedLocale(): Locale | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'en' || value === 'ur' ? value : null;
  } catch {
    return null;
  }
}

function keepLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Kept for this visit alone.
  }
}

export function LocaleProvider({
  children,
  initial,
}: {
  children: ReactNode;
  /** For tests; otherwise the language kept, or English. */
  initial?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(() => initial ?? storedLocale() ?? 'en');
  const dir = locale === 'ur' ? 'rtl' : 'ltr';

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
    document
      .querySelector('link[rel="manifest"]')
      ?.setAttribute(
        'href',
        locale === 'ur' ? '/manifest.ur.webmanifest' : '/manifest.webmanifest',
      );
  }, [locale, dir]);

  const setLocale = useCallback((next: Locale) => {
    keepLocale(next);
    setLocaleState(next);
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, dir, setLocale, t: (key, values) => translate(locale, key, values) }),
    [locale, dir, setLocale],
  );
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error('useLocale must be used inside <LocaleProvider>');
  return value;
}
