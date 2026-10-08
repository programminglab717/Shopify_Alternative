import { LocaleProvider, useLocale } from './i18n/locale';
import { Button } from './ui/button';

function Welcome() {
  const { t, locale, setLocale } = useLocale();
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-4">
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('app.name')}
      </h1>
      <p className="text-secondary">{t('app.tagline')}</p>
      <Button
        variant="secondary"
        aria-label={t('language.toggleLabel')}
        onClick={() => setLocale(locale === 'en' ? 'ur' : 'en')}
      >
        {t('language.toggle')}
      </Button>
    </main>
  );
}

export function App() {
  return (
    <LocaleProvider>
      <Welcome />
    </LocaleProvider>
  );
}
