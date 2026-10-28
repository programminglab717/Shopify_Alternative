import { Cpu } from 'lucide-react';
import { useState } from 'react';
import { AppFunctionEnableMutation, AppFunctionsQuery } from '../api/operations';
import type { AppFunction, AppFunctionEnableData, AppFunctionsData } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

/**
 * The functions the shop's apps give its checkout (DEV-07, ADR-868): a payment customisation
 * hiding ways to pay, or a cart validation refusing an order, each off until the owner or a
 * manager turns it on, with the settings its app asks for; and its last failure, when it ran past
 * its time or gave no answer, which checkout went on without.
 */
export function AppFunctions() {
  const { t } = useLocale();
  const query = useAdminQuery<AppFunctionsData>(['appFunctions'], AppFunctionsQuery);
  const [problem, setProblem] = useState<string | null>(null);

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
    const functions = query.data.appFunctions;
    if (functions.length === 0) return <p className="text-secondary">{t('appFunctions.none')}</p>;
    return (
      <Card>
        <ul className="divide-y divide-line">
          {functions.map((each) => (
            <FunctionRow key={each.id} fn={each} onProblem={setProblem} />
          ))}
        </ul>
      </Card>
    );
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="app-functions">
      <h2
        id="app-functions"
        className="flex items-center gap-2 text-[length:var(--hatti-type-title-size)] font-semibold"
      >
        <Cpu aria-hidden className="size-6 text-secondary" />
        {t('appFunctions.title')}
      </h2>
      <p className="text-secondary">{t('appFunctions.hint')}</p>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {body()}
    </section>
  );
}

function FunctionRow({
  fn,
  onProblem,
}: {
  fn: AppFunction;
  onProblem: (problem: string | null) => void;
}) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const enable = useAdminMutation<
    AppFunctionEnableData,
    { id: string; enabled: boolean; configuration?: string }
  >(AppFunctionEnableMutation);
  const [settings, setSettings] = useState(fn.configuration);

  const save = async (enabled: boolean) => {
    onProblem(null);
    try {
      const { appFunctionEnable: done } = await enable.mutateAsync({
        id: fn.id,
        enabled,
        ...(settings !== fn.configuration && { configuration: settings }),
      });
      if (done.userErrors[0]) onProblem(problemText(done.userErrors[0], t));
    } catch (failure) {
      onProblem(errorText(failure, t));
    }
  };

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium" dir="auto">
            {fn.title}
          </span>
          <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
            {t('appFunctions.by', { app: fn.appName })}
            {' · '}
            {t(
              fn.target === 'payment_customization'
                ? 'appFunctions.payments'
                : 'appFunctions.validation',
            )}
          </span>
        </span>
        <span className="font-medium">{t(fn.enabled ? 'appEmbeds.on' : 'appEmbeds.off')}</span>
        <Button variant="secondary" busy={enable.isPending} onClick={() => void save(!fn.enabled)}>
          {t(fn.enabled ? 'appEmbeds.turnOff' : 'appEmbeds.turnOn', { name: fn.title })}
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <TextField
            label={t('appFunctions.settings', { name: fn.title })}
            hint={t('appFunctions.settingsHint')}
            value={settings}
            onChange={(event) => setSettings(event.target.value)}
            ltr
          />
        </div>
        <Button
          variant="secondary"
          disabled={settings === fn.configuration}
          onClick={() => void save(fn.enabled)}
        >
          {t('appFunctions.saveSettings')}
        </Button>
      </div>
      {fn.lastError && fn.failedAt && (
        <Alert tone="warning">
          {t('appFunctions.failed', {
            date: formatDateTime(fn.failedAt, timezone, locale),
            error: fn.lastError,
          })}
        </Alert>
      )}
    </li>
  );
}
