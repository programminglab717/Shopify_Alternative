import { Link } from '@tanstack/react-router';
import { PackageCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { AppUninstallMutation, InstalledAppsQuery } from '../api/operations';
import type { AppUninstallData, InstalledAppsData } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatDate } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { scopeLabel } from './app-scopes';

/**
 * The public apps installed on the shop through OAuth (DEV-05, ADR-851): what each reaches, as
 * its owner or a manager approved, and a way to uninstall it, its token stopping at once.
 */
export function InstalledApps() {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const shopId = useShop().id;
  const query = useAdminQuery<InstalledAppsData>(['installedApps'], InstalledAppsQuery);
  const uninstall = useAdminMutation<AppUninstallData, { id: string }>(AppUninstallMutation);
  const [removing, setRemoving] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const onUninstall = async (id: string) => {
    setProblem(null);
    try {
      const { appUninstall: removed } = await uninstall.mutateAsync({ id });
      if (removed.userErrors[0]) setProblem(problemText(removed.userErrors[0], t));
      setRemoving(null);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  const body = () => {
    if (query.isPending) return <Loading label={t('state.loading')} />;
    if (query.isError) {
      return (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      );
    }
    const apps = query.data.installedApps;
    if (apps.length === 0) return <p className="text-secondary">{t('installedApps.none')}</p>;
    return (
      <Card>
        <ul className="divide-y divide-line">
          {apps.map((app) => (
            <li key={app.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
              <span className="flex flex-1 flex-col">
                <Link
                  to="/$shopId/settings/apps/$appId"
                  params={{ shopId, appId: app.id }}
                  className="font-medium underline"
                  dir="auto"
                  aria-label={t('installedApps.open', { name: app.name })}
                >
                  {app.name}
                </Link>
                <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                  {t('installedApps.reaches', {
                    scopes: app.scopes.map((scope) => scopeLabel(scope, t)).join(', '),
                  })}
                  {' · '}
                  {t('installedApps.installed', {
                    date: formatDate(app.installedAt, timezone, locale),
                  })}
                </span>
              </span>
              {removing === app.id ? (
                <>
                  <span>{t('installedApps.uninstallSure', { name: app.name })}</span>
                  <Button
                    variant="destructive"
                    busy={uninstall.isPending}
                    onClick={() => void onUninstall(app.id)}
                  >
                    {t('installedApps.uninstallYes')}
                  </Button>
                  <Button variant="tertiary" onClick={() => setRemoving(null)}>
                    {t('action.back')}
                  </Button>
                </>
              ) : (
                <Button
                  variant="danger"
                  icon={<Trash2 aria-hidden className="size-5" />}
                  aria-label={t('installedApps.uninstall', { name: app.name })}
                  onClick={() => setRemoving(app.id)}
                />
              )}
            </li>
          ))}
        </ul>
      </Card>
    );
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="installed-apps">
      <h2
        id="installed-apps"
        className="flex items-center gap-2 text-[length:var(--hatti-type-title-size)] font-semibold"
      >
        <PackageCheck aria-hidden className="size-6 text-secondary" />
        {t('installedApps.title')}
      </h2>
      <p className="text-secondary">{t('installedApps.hint')}</p>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {body()}
    </section>
  );
}
