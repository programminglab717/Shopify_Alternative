import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSessionStore } from '../auth/context';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { Button } from '../ui/button';
import { Alert, Card } from '../ui/feedback';
import { TextField } from '../ui/field';

/** A partner's public app, as they see it (DEV-05, ADR-851). */
export interface PartnerApp {
  id: string;
  name: string;
  appUrl: string;
  redirectUrls: string[];
  scopes: string[];
  clientId: string;
  listed: boolean;
  createdAt: string;
}

const KEY = ['partner', 'apps'] as const;

/** The admin's consent page an app sends merchants to, with its client ID and its scopes. */
export function installLinkOf(app: PartnerApp, origin = window.location.origin): string {
  return `${origin}/oauth/authorize?${new URLSearchParams({
    client_id: app.clientId,
    scope: app.scopes.join(','),
    redirect_uri: app.redirectUrls[0] ?? '',
  })}`;
}

/**
 * The partner's public apps (DEV-05, ADR-851): each with its client ID and the link that sends
 * merchants to install it; a new one's client secret shown once, as it is registered.
 */
export function PartnerApps() {
  const { t } = useLocale();
  const store = useSessionStore();
  const queryClient = useQueryClient();
  const apps = useQuery({
    queryKey: KEY,
    queryFn: () => store.auth<{ apps: PartnerApp[] }>('/auth/partner/apps'),
  });
  const [making, setMaking] = useState(false);
  const [name, setName] = useState('');
  const [appUrl, setAppUrl] = useState('');
  const [redirects, setRedirects] = useState('');
  const [scopes, setScopes] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState<{ name: string; secret: string } | null>(null);

  const onRegister = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const made = await store.auth<{ app: PartnerApp; clientSecret: string }>(
        '/auth/partner/apps',
        {
          body: {
            name: name.trim(),
            appUrl: appUrl.trim(),
            redirectUrls: redirects.split(/\s+/).filter(Boolean),
            scopes: scopes.split(/[\s,]+/).filter(Boolean),
          },
        },
      );
      setShown({ name: made.app.name, secret: made.clientSecret });
      setMaking(false);
      setName('');
      setAppUrl('');
      setRedirects('');
      setScopes('');
      await queryClient.invalidateQueries({ queryKey: KEY });
    } catch (failure) {
      setProblem(errorText(failure, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="partner-apps" className="flex flex-col gap-2">
      <h2 id="partner-apps" className="font-semibold">
        {t('partnerApps.title')}
      </h2>
      <p className="text-secondary">{t('partnerApps.hint')}</p>
      {shown && (
        <Card className="flex flex-col gap-2 p-4">
          <Alert tone="warning">{t('partnerApps.shownOnce', { name: shown.name })}</Alert>
          <span className="font-medium">{t('partnerApps.secret')}</span>
          <code className="num break-all rounded-control bg-canvas px-2 py-1" dir="ltr">
            {shown.secret}
          </code>
          <Button className="self-start" onClick={() => setShown(null)}>
            {t('apps.done')}
          </Button>
        </Card>
      )}
      {(apps.data?.apps ?? []).map((app) => (
        <Card key={app.id} className="flex flex-col gap-1 p-3">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium" dir="auto">
              {app.name}
            </span>
            <span className="text-secondary">
              {t(app.listed ? 'partnerApps.listed' : 'partnerApps.waiting')}
            </span>
          </span>
          <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
            {t('partnerApps.clientId')}:{' '}
            <code className="num" dir="ltr">
              {app.clientId}
            </code>
          </span>
          <span className="text-secondary break-all text-[length:var(--hatti-type-body-sm-size)]">
            {t('partnerApps.installLink', { url: installLinkOf(app) })}
          </span>
        </Card>
      ))}
      {apps.isError && <Alert tone="danger">{errorText(apps.error, t)}</Alert>}
      {making ? (
        <form onSubmit={(event) => void onRegister(event)} className="flex flex-col gap-3">
          <TextField
            label={t('partnerApps.name')}
            dir="auto"
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
          <TextField
            label={t('partnerApps.appUrl')}
            dir="ltr"
            type="url"
            value={appUrl}
            onChange={(event) => setAppUrl(event.target.value)}
            required
          />
          <TextField
            label={t('partnerApps.redirects')}
            dir="ltr"
            value={redirects}
            onChange={(event) => setRedirects(event.target.value)}
            required
          />
          <TextField
            label={t('partnerApps.scopes')}
            dir="ltr"
            placeholder="read_products, write_orders"
            value={scopes}
            onChange={(event) => setScopes(event.target.value)}
            required
          />
          {problem && <Alert tone="danger">{problem}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" busy={busy}>
              {t('partnerApps.save')}
            </Button>
            <Button variant="tertiary" onClick={() => setMaking(false)}>
              {t('action.back')}
            </Button>
          </div>
        </form>
      ) : (
        <Button
          variant="secondary"
          className="self-start"
          icon={<Plus aria-hidden className="size-5" />}
          onClick={() => {
            setShown(null);
            setMaking(true);
          }}
        >
          {t('partnerApps.register')}
        </Button>
      )}
    </section>
  );
}
