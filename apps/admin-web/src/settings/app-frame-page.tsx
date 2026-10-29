import { envelopeOf, requestIn, type AppBridgeNotice } from '@hatti/admin-client/app-bridge';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AppSessionQuery } from '../api/operations';
import type { AppSessionData } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, EmptyState, ErrorState, Loading } from '../ui/feedback';

/** How long an app's toast shows. */
const TOAST_MS = 5_000;

/** The app's address, with the admin's origin as `host`, for its App Bridge to answer to. */
function framedUrl(url: string): string {
  const framed = new URL(url);
  framed.searchParams.set('host', window.location.origin);
  return framed.toString();
}

/**
 * An installed public app opened inside the admin (DEV-06, ADR-852), as Shopify's embedded apps
 * are: its page in a frame, its address carrying a session token of a minute's life, which the
 * app checks with its client secret and trades for a session of its own. The frame keeps the
 * address it first loaded, so that the app is not reloaded as the admin asks again.
 *
 * The app's App Bridge (ADR-912) asks the admin, from its own frame and origin alone, for a fresh
 * session token, a toast, a page of the admin to go to, or the save bar, whose buttons it is told
 * of.
 */
export function AppFramePage() {
  const { t } = useLocale();
  const shopId = useShop().id;
  const navigate = useNavigate();
  const { appId } = useParams({ from: '/$shopId/settings/apps/$appId' });
  const query = useAdminQuery<AppSessionData>(['appSession', appId], AppSessionQuery, {
    id: appId,
  });
  const [loaded, setLoaded] = useState<{ name: string; url: string } | null>(null);
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const [saveBar, setSaveBar] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const fetched = query.data?.appSession ?? null;
  useEffect(() => {
    if (fetched) setLoaded((before) => before ?? { ...fetched, url: framedUrl(fetched.url) });
  }, [fetched]);
  const session = loaded ?? (fetched && { ...fetched, url: framedUrl(fetched.url) });
  const appOrigin = session ? new URL(session.url).origin : null;
  const { refetch } = query;

  useEffect(() => {
    if (!appOrigin) return;
    const tell = (notice: AppBridgeNotice, id?: string) =>
      frame.current?.contentWindow?.postMessage(envelopeOf(notice, id), appOrigin);
    const onMessage = (event: MessageEvent) => {
      // The app's own frame, from the app's own origin: no other page is answered.
      if (event.origin !== appOrigin || event.source !== frame.current?.contentWindow) return;
      const read = requestIn(event.data);
      if (!read) return;
      const { request } = read;
      switch (request.type) {
        case 'id_token':
          void refetch().then(({ data }) => {
            const url = data?.appSession?.url;
            const token = url ? new URL(url).searchParams.get('id_token') : null;
            if (token) tell({ type: 'id_token', token }, read.id);
          });
          break;
        case 'toast':
          setToast({ message: request.message, error: request.error });
          break;
        case 'navigate':
          void navigate({ to: `/${shopId}${request.path}` });
          break;
        case 'save_bar':
          setSaveBar(request.visible);
          break;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [appOrigin, navigate, refetch, shopId]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const press = (type: 'save' | 'discard') => {
    if (appOrigin) frame.current?.contentWindow?.postMessage(envelopeOf({ type }), appOrigin);
  };

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
          ref={frame}
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
      {saveBar && (
        <div
          role="region"
          aria-label={t('appFrame.saveBar')}
          className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-card bg-text px-4 py-2 text-surface"
        >
          <span className="font-medium">{t('appFrame.unsaved')}</span>
          <span className="flex gap-2">
            <Button variant="secondary" onClick={() => press('discard')}>
              {t('appFrame.discard')}
            </Button>
            <Button onClick={() => press('save')}>{t('appFrame.save')}</Button>
          </span>
        </div>
      )}
      <div aria-live="polite">
        {toast && (
          <Alert tone={toast.error ? 'danger' : 'success'}>
            <span dir="auto">{toast.message}</span>
          </Alert>
        )}
      </div>
      {body()}
    </div>
  );
}
