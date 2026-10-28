import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Blocks } from 'lucide-react';
import { useState } from 'react';
import { AuthLayout } from '../auth/auth-layout';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { useMe, useSession, useSessionStore } from '../auth/context';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { scopeLabel } from '../settings/app-scopes';
import { SelectField } from '../settings/settings-form';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';

/** Where an install link waits while its merchant signs in. */
const PENDING = 'hatti.oauth';

/** The install link a merchant opened before signing in, if any; read once. */
export function takePendingInstall(): string | null {
  try {
    const link = window.sessionStorage.getItem(PENDING);
    window.sessionStorage.removeItem(PENDING);
    return link?.startsWith('/oauth/authorize?') ? link : null;
  } catch {
    return null;
  }
}

/** What an app's install link asks, as Shopify's apps link to their consent page. */
export interface InstallRequest {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  shop: string | null;
}

export function installRequestOf(search: string): InstallRequest | null {
  const params = new URLSearchParams(search);
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  const scope = params.get('scope');
  if (!clientId || !redirectUri || !scope) return null;
  return {
    clientId,
    redirectUri,
    scope,
    state: params.get('state') ?? '',
    shop: params.get('shop'),
  };
}

interface Consent {
  name: string;
  appUrl: string;
  partner: string;
  scopes: string[];
  listed: boolean;
}

/** The roles that install apps, as the core lets them. */
const INSTALLERS = new Set(['owner', 'manager']);

/**
 * The consent page a public app sends a merchant to (DEV-05, ADR-851):
 * `/oauth/authorize?client_id&redirect_uri&scope&state&shop`. It says which app, by whom, asks
 * to reach what; an owner or a manager picks their shop and installs it, confirming who they are
 * where they have not lately, and is sent back to the app with its code.
 */
export function OAuthPage() {
  const { t } = useLocale();
  const { signedIn } = useSession();
  const navigate = useNavigate();
  const [request] = useState(() => installRequestOf(window.location.search));

  if (!request) {
    return (
      <AuthLayout title={t('oauth.title')}>
        <Alert tone="danger">{t('oauth.badLink')}</Alert>
      </AuthLayout>
    );
  }
  if (!signedIn) {
    const keep = () => {
      try {
        window.sessionStorage.setItem(PENDING, `/oauth/authorize${window.location.search}`);
      } catch {
        // Without storage they open the link again once signed in.
      }
      void navigate({ to: '/sign-in' });
    };
    return (
      <AuthLayout title={t('oauth.title')}>
        <p className="text-secondary">{t('oauth.signInFirst')}</p>
        <Button className="mt-4 self-start" onClick={keep}>
          {t('oauth.signIn')}
        </Button>
      </AuthLayout>
    );
  }
  return <Approve request={request} />;
}

function Approve({ request }: { request: InstallRequest }) {
  const { t } = useLocale();
  const store = useSessionStore();
  const me = useMe();
  const recent = useRecentAuthentication();
  const consent = useQuery({
    queryKey: ['oauth', request.clientId, request.redirectUri, request.scope],
    queryFn: () =>
      store.auth<{ app: Consent }>(
        `/auth/oauth/app?${new URLSearchParams({
          client_id: request.clientId,
          redirect_uri: request.redirectUri,
          scope: request.scope,
        })}`,
      ),
    retry: false,
  });
  const shops = (me.data?.shops ?? []).filter((shop) => INSTALLERS.has(shop.role));
  const [chosen, setChosen] = useState<string | null>(null);
  const shopId =
    chosen ?? shops.find((shop) => shop.id === request.shop)?.id ?? shops[0]?.id ?? null;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const onInstall = async () => {
    if (!shopId) return;
    setBusy(true);
    setProblem(null);
    await recent.run(
      async () => {
        const { redirectUrl } = await store.auth<{ redirectUrl: string }>('/auth/oauth/authorize', {
          body: {
            clientId: request.clientId,
            redirectUri: request.redirectUri,
            scope: request.scope,
            state: request.state,
            shopId,
          },
        });
        window.location.assign(redirectUrl);
      },
      (failure) => setProblem(errorText(failure, t)),
    );
    setBusy(false);
  };

  const body = () => {
    if (consent.isPending || me.isPending) return <Loading label={t('state.loading')} />;
    if (consent.isError) return <ErrorState message={errorText(consent.error, t)} />;
    const app = consent.data.app;
    return (
      <div className="flex flex-col gap-4">
        <Card className="flex flex-col gap-2 p-4">
          <span className="flex items-center gap-2 font-semibold" dir="auto">
            <Blocks aria-hidden className="size-6 text-secondary" />
            {app.name}
          </span>
          <span className="text-secondary break-all" dir="ltr">
            {app.appUrl}
          </span>
          <p>{t('oauth.asks', { name: app.name, partner: app.partner })}</p>
          <ul className="list-disc ps-6">
            {app.scopes.map((scope) => (
              <li key={scope}>{scopeLabel(scope, t)}</li>
            ))}
          </ul>
        </Card>
        {!app.listed && <Alert tone="warning">{t('oauth.unlisted')}</Alert>}
        {shops.length === 0 ? (
          <Alert tone="info">{t('oauth.noShop')}</Alert>
        ) : (
          <>
            <SelectField
              label={t('oauth.shop')}
              value={shopId ?? ''}
              options={shops.map((shop) => ({ value: shop.id, label: shop.name }))}
              onChange={setChosen}
            />
            <div className="flex flex-wrap gap-2">
              <Button busy={busy} onClick={() => void onInstall()}>
                {t('oauth.install')}
              </Button>
              <Link to="/shops" className="inline-flex min-h-10 items-center text-secondary">
                {t('oauth.cancel')}
              </Link>
            </div>
          </>
        )}
        {problem && <Alert tone="danger">{problem}</Alert>}
        {recent.panel}
      </div>
    );
  };

  return <AuthLayout title={t('oauth.title')}>{body()}</AuthLayout>;
}
