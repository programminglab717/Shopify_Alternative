import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AppSessionQuery } from '../api/operations';
import type { AppSessionData } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { EmptyState, ErrorState, Loading } from '../ui/feedback';

/**
 * An installed public app opened inside the admin (DEV-06, ADR-852), as Shopify's embedded apps
 * are: its page in a frame, its address carrying a session token of a minute's life, which the
 * app checks with its client secret and trades for a session of its own. The frame keeps the
 * address it first loaded, so that the app is not reloaded as the admin asks again.
 */
export function AppFramePage() {
  const { t } = useLocale();
  const shopId = useShop().id;
  const { appId } = useParams({ from: '/$shopId/settings/apps/$appId' });
  const query = useAdminQuery<AppSessionData>(['appSession', appId], AppSessionQuery, {
    id: appId,
  });
  const [loaded, setLoaded] = useState<{ name: string; url: string } | null>(null);
  const fetched = query.data?.appSession ?? null;
  useEffect(() => {
    if (fetched) setLoaded((before) => before ?? fetched);
  }, [fetched]);
  const session = loaded ?? fetched;

  const back = (
    <Link
      to="/$shopId/settings/apps"
      params={{ shopId }}
      className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
    >
      <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
      {t('appFrame.back')}
    </Link>
  );

  const body = () => {
    if (session) {
      return (
        <iframe
          title={t('appFrame.title', { name: session.name })}
          src={session.url}
          className="min-h-[75dvh] w-full rounded-card border border-line bg-surface"
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads"
          referrerPolicy="no-referrer"
        />
      );
    }
    if (query.isPending) return <Loading label={t('state.loading')} />;
    if (query.isError) {
      return (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      );
    }
    return <EmptyState title={t('appFrame.missing')} />;
  };

  return (
    <div className="flex flex-col gap-3 pb-8">
      {back}
      {session && (
        <h1 className="text-[length:var(--hatti-type-title-size)] font-semibold" dir="auto">
          {session.name}
        </h1>
      )}
      {body()}
    </div>
  );
}
