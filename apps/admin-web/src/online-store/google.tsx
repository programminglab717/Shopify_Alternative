import { Link2Off, Save } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  GoogleAnalyticsDeleteMutation,
  GoogleAnalyticsQuery,
  GoogleAnalyticsUpdateMutation,
} from '../api/operations';
import type {
  ConversionMoment,
  GoogleAnalytics,
  GoogleAnalyticsData,
  GoogleAnalyticsDeleteData,
  GoogleAnalyticsUpdateData,
} from '../api/types';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection } from '../products/product-form';
import { Problems, SelectField, settingProblem } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { EventsList, MOMENTS } from './meta';

const LABELS: Partial<Record<string, MessageKey>> = {
  measurementId: 'google.measurementId',
  apiSecret: 'google.apiSecret',
};

/**
 * Connecting the shop's Google Analytics web stream, or changing how its orders go to it: the
 * stream's measurement ID, a Measurement Protocol API secret, sealed and never shown again, and
 * which moment is the purchase. Only what changed is sent, once the member confirms who they are.
 */
function GoogleForm({ current }: { current: GoogleAnalytics | null }) {
  const { t } = useLocale();
  const update = useAdminMutation<GoogleAnalyticsUpdateData, { input: Record<string, unknown> }>(
    GoogleAnalyticsUpdateMutation,
  );
  const { run, panel } = useRecentAuthentication();
  const [measurementId, setMeasurementId] = useState(current?.measurementId ?? '');
  const [apiSecret, setApiSecret] = useState('');
  const [purchaseAt, setPurchaseAt] = useState<ConversionMoment>(current?.purchaseAt ?? 'PLACED');
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  const changes: Record<string, unknown> = {
    ...(measurementId.trim() !== (current?.measurementId ?? '') && {
      measurementId: measurementId.trim(),
    }),
    ...(apiSecret.trim() && { apiSecret: apiSecret.trim() }),
    ...(purchaseAt !== (current?.purchaseAt ?? 'PLACED') && { purchaseAt }),
  };
  const changed = Object.keys(changes).length > 0;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!changed) return;
    setProblems([]);
    setSaved(false);
    void run(
      async () => {
        const { googleAnalyticsUpdate } = await update.mutateAsync({ input: changes });
        const kept = googleAnalyticsUpdate.googleAnalytics;
        if (googleAnalyticsUpdate.userErrors.length > 0 || !kept) {
          setProblems(
            googleAnalyticsUpdate.userErrors.map((error) =>
              settingProblem(error, t, LABELS, () => null),
            ),
          );
          return;
        }
        setMeasurementId(kept.measurementId);
        setApiSecret('');
        setPurchaseAt(kept.purchaseAt);
        setSaved(true);
      },
      (failure) => setProblems([errorText(failure, t)]),
    );
  };

  const form = (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <TextField
        label={t('google.measurementId')}
        hint={t('google.measurementIdHint')}
        autoComplete="off"
        ltr
        required={!current}
        value={measurementId}
        onChange={(event) => setMeasurementId(event.target.value)}
      />
      <TextField
        label={current ? t('google.newApiSecret') : t('google.apiSecret')}
        hint={
          current
            ? t('meta.accessTokenKept', { hint: current.apiSecretHint })
            : t('google.apiSecretHint')
        }
        type="password"
        autoComplete="off"
        ltr
        required={!current}
        value={apiSecret}
        onChange={(event) => setApiSecret(event.target.value)}
      />
      <div className="flex flex-col gap-1">
        <SelectField<ConversionMoment>
          label={t('google.purchaseAt')}
          value={purchaseAt}
          options={MOMENTS.map((moment) => ({
            value: moment,
            label: t(`meta.purchaseAt.${moment}` as MessageKey),
          }))}
          onChange={setPurchaseAt}
        />
        <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t(`google.purchaseHint.${purchaseAt}` as MessageKey)}
        </p>
      </div>
      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t('couriers.sealed')}
      </p>
      <Problems problems={problems} />
      {saved && !changed && <Alert tone="success">{t('google.saved')}</Alert>}
      <Button
        type="submit"
        className="self-start"
        busy={update.isPending}
        disabled={!changed}
        icon={<Save aria-hidden className="size-5" />}
      >
        {current ? t('meta.save') : t('google.connect')}
      </Button>
    </form>
  );
  // Confirming who they are has a form of its own, so it sits beside this one, not in it.
  return (
    <>
      {form}
      {panel}
    </>
  );
}

/** Disconnecting Google, once asked whether they mean it. */
function Disconnect({ measurementId }: { measurementId: string }) {
  const { t } = useLocale();
  const remove = useAdminMutation<GoogleAnalyticsDeleteData, Record<string, never>>(
    GoogleAnalyticsDeleteMutation,
  );
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const onDisconnect = async () => {
    setProblem(null);
    try {
      const { googleAnalyticsDelete } = await remove.mutateAsync({});
      const error = googleAnalyticsDelete.userErrors[0];
      if (error) setProblem(error.message);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {asking ? (
        <Alert tone="warning">
          <p>{t('google.disconnectAsk', { measurementId })}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="destructive"
              busy={remove.isPending}
              onClick={() => void onDisconnect()}
            >
              {t('meta.disconnectSure')}
            </Button>
            <Button variant="secondary" onClick={() => setAsking(false)}>
              {t('meta.keep')}
            </Button>
          </div>
        </Alert>
      ) : (
        <Button
          variant="danger"
          className="self-start"
          icon={<Link2Off aria-hidden className="size-5" />}
          onClick={() => setAsking(true)}
        >
          {t('google.disconnect')}
        </Button>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </div>
  );
}

/**
 * Google (MKT-10, ADR-550): the shop's Google Analytics web stream, whose tag the storefront loads
 * and which its orders placed through checkout go to through the Measurement Protocol as they are
 * placed, confirmed and delivered, connected, changed and disconnected; and the moments sent, with
 * how each went.
 */
export function GoogleTab() {
  const { t } = useLocale();
  const query = useAdminQuery<GoogleAnalyticsData>(['googleAnalytics'], GoogleAnalyticsQuery);
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const current = query.data.googleAnalytics;
  return (
    <div className="flex flex-col gap-4">
      <FormSection title={t('google.title')} hint={t('google.hint')}>
        {current ? (
          <Alert tone="success">
            {t('google.connected', { measurementId: current.measurementId })} {t('google.adsHint')}
          </Alert>
        ) : (
          <p className="font-medium">{t('meta.notConnected')}</p>
        )}
        <GoogleForm current={current} />
        {current && <Disconnect measurementId={current.measurementId} />}
      </FormSection>
      {current && <EventsList platform="GOOGLE" />}
    </div>
  );
}
