import { Languages } from 'lucide-react';
import { useLocale } from '../i18n/locale';

/** The EN/اردو switch the admin keeps in its header (docs/design/02 §2). */
export function LanguageToggle() {
  const { t, locale, setLocale } = useLocale();
  return (
    <button
      type="button"
      lang={locale === 'en' ? 'ur' : 'en'}
      aria-label={t('language.toggleLabel')}
      onClick={() => setLocale(locale === 'en' ? 'ur' : 'en')}
      className="inline-flex min-h-12 items-center gap-2 rounded-control px-3 text-secondary hover:bg-surface md:min-h-10"
    >
      <Languages aria-hidden className="size-5" />
      {t('language.toggle')}
    </button>
  );
}
