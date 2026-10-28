import { Code } from 'lucide-react';
import { useState } from 'react';
import { AppEmbedEnableMutation, AppEmbedsQuery } from '../api/operations';
import type { AppEmbedEnableData, AppEmbedsData } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';

/**
 * The scripts the shop's apps offer its storefront (DEV-06, ADR-852), as Shopify's theme app
 * embeds: each off until the owner or a manager turns it on, and off again when its app changes
 * its address.
 */
export function AppEmbeds() {
  const { t } = useLocale();
  const query = useAdminQuery<AppEmbedsData>(['appEmbeds'], AppEmbedsQuery);
  const enable = useAdminMutation<AppEmbedEnableData, { id: string; enabled: boolean }>(
    AppEmbedEnableMutation,
  );
  const [problem, setProblem] = useState<string | null>(null);

  const onToggle = async (id: string, enabled: boolean) => {
    setProblem(null);
    try {
      const { appEmbedEnable: done } = await enable.mutateAsync({ id, enabled });
      if (done.userErrors[0]) setProblem(problemText(done.userErrors[0], t));
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
    const embeds = query.data.appEmbeds;
    if (embeds.length === 0) return <p className="text-secondary">{t('appEmbeds.none')}</p>;
    return (
      <Card>
        <ul className="divide-y divide-line">
          {embeds.map((embed) => (
            <li key={embed.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium" dir="auto">
                  {embed.name}
                </span>
                <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                  {t('appEmbeds.by', { app: embed.appName })}
                  {' · '}
                  <bdi className="break-all" dir="ltr">
                    {embed.src}
                  </bdi>
                </span>
              </span>
              <span className="font-medium">
                {t(embed.enabled ? 'appEmbeds.on' : 'appEmbeds.off')}
              </span>
              <Button
                variant="secondary"
                busy={enable.isPending && enable.variables?.id === embed.id}
                onClick={() => void onToggle(embed.id, !embed.enabled)}
              >
                {t(embed.enabled ? 'appEmbeds.turnOff' : 'appEmbeds.turnOn', {
                  name: embed.name,
                })}
              </Button>
            </li>
          ))}
        </ul>
      </Card>
    );
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="app-embeds">
      <h2
        id="app-embeds"
        className="flex items-center gap-2 text-[length:var(--hatti-type-title-size)] font-semibold"
      >
        <Code aria-hidden className="size-6 text-secondary" />
        {t('appEmbeds.title')}
      </h2>
      <p className="text-secondary">{t('appEmbeds.hint')}</p>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {body()}
    </section>
  );
}
