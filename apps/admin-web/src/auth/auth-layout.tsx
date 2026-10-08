import type { ReactNode } from 'react';
import { useLocale } from '../i18n/locale';
import { LanguageToggle } from '../ui/language-toggle';

/** The frame of the screens before a shop is open: Hatti's name, the language, one card. */
export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useLocale();
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="flex items-center justify-between p-4">
        <span className="text-primary font-semibold">{t('app.name')}</span>
        <LanguageToggle />
      </header>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 pb-12">
        <section className="rounded-card border border-line bg-surface p-6">
          <h1 className="mb-6 text-[length:var(--hatti-type-title-size)] font-semibold">{title}</h1>
          {children}
        </section>
      </main>
    </div>
  );
}
