import { Link2Off, Save } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  TikTokEventsDeleteMutation,
  TikTokEventsQuery,
  TikTokEventsUpdateMutation,
} from '../api/operations';
import type {
  ConversionMoment,
  TikTokEvents,
  TikTokEventsData,
  TikTokEventsDeleteData,
  TikTokEventsUpdateData,
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
  pixelCode: 'tiktok.pixelCode',
  accessToken: 'meta.accessToken',
  testEventCode: 'meta.testEventCode',
};

/**
 * Connecting the shop's TikTok pixel, or changing how its orders go to it: the pixel's code, a
 * token for the Events API, sealed and never shown again, which moment is the purchase, and a
 * code for test events. Only what changed is sent, once the member confirms who they are.
 */
function TikTokForm({ current }: { current: TikTokEvents | null }) {
  const { t } = useLocale();
  const update = useAdminMutation<TikTokEventsUpdateData, { input: Record<string, unknown> }>(
    TikTokEventsUpdateMutation,
  );
  const { run, panel } = useRecentAuthentication();
  const [pixelCode, setPixelCode] = useState(current?.pixelCode ?? '');
  const [accessToken, setAccessToken] = useState('');
  const [purchaseAt, setPurchaseAt] = useState<ConversionMoment>(current?.purchaseAt ?? 'PLACED');
  const [testEventCode, setTestEventCode] = useState(current?.testEventCode ?? '');
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  const changes: Record<string, unknown> = {
    ...(pixelCode.trim() !== (current?.pixelCode ?? '') && { pixelCode: pixelCode.trim() }),
    ...(accessToken.trim() && { accessToken: accessToken.trim() }),
    ...(purchaseAt !== (current?.purchaseAt ?? 'PLACED') && { purchaseAt }),
    ...(testEventCode.trim() !== (current?.testEventCode ?? '') && {
      testEventCode: testEventCode.trim() || null,
    }),
  };
  const changed = Object.keys(changes).length > 0;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!changed) return;
    setProblems([]);
    setSaved(false);
    void run(
      async () => {
        const { tiktokEventsUpdate } = await update.mutateAsync({ input: changes });
        const kept = tiktokEventsUpdate.tiktokEvents;
        if (tiktokEventsUpdate.userErrors.length > 0 || !kept) {
          setProblems(
            tiktokEventsUpdate.userErrors.map((error) =>
              settingProblem(error, t, LABELS, () => null),
            ),
          );
          return;
        }
        setPixelCode(kept.pixelCode);
        setAccessToken('');
        setPurchaseAt(kept.purchaseAt);
        setTestEventCode(kept.testEventCode ?? '');
        setSaved(true);
      },
      (failure) => setProblems([errorText(failure, t)]),
    );
  };

  const form = (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <TextField
        label={t('tiktok.pixelCode')}
        hint={t('tiktok.pixelCodeHint')}
        autoComplete="off"
        ltr
        required={!current}
        value={pixelCode}
        onChange={(event) => setPixelCode(event.target.value)}
      />
      <TextField
        label={current ? t('meta.newAccessToken') : t('meta.accessToken')}
        hint={
          current
            ? t('meta.accessTokenKept', { hint: current.accessTokenHint })
            : t('tiktok.accessTokenHint')
        }
        type="password"
        autoComplete="off"
        ltr
        required={!current}
        value={accessToken}
        onChange={(event) => setAccessToken(event.target.value)}
      />
      <div className="flex flex-col gap-1">
        <SelectField<ConversionMoment>
          label={t('tiktok.purchaseAt')}
          value={purchaseAt}
          options={MOMENTS.map((moment) => ({
            value: moment,
            label: t(`meta.purchaseAt.${moment}` as MessageKey),
          }))}
          onChange={setPurchaseAt}
        />
        <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t(`tiktok.purchaseHint.${purchaseAt}` as MessageKey)}
        </p>
      </div>
      <TextField
        label={t('meta.testEventCode')}
        hint={t('tiktok.testEventCodeHint')}
        autoComplete="off"
        ltr
        value={testEventCode}
        onChange={(event) => setTestEventCode(event.target.value)}
      />
      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t('couriers.sealed')}
      </p>
      <Problems problems={problems} />
      {saved && !changed && <Alert tone="success">{t('tiktok.saved')}</Alert>}
      <Button
        type="submit"
        className="self-start"
        busy={update.isPending}
        disabled={!changed}
        icon={<Save aria-hidden className="size-5" />}
      >
        {current ? t('meta.save') : t('tiktok.connect')}
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

/** Disconnecting TikTok, once asked whether they mean it. */
function Disconnect({ pixelCode }: { pixelCode: string }) {
  const { t } = useLocale();
  const remove = useAdminMutation<TikTokEventsDeleteData, Record<string, never>>(
    TikTokEventsDeleteMutation,
  );
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const onDisconnect = async () => {
    setProblem(null);
    try {
      const { tiktokEventsDelete } = await remove.mutateAsync({});
      const error = tiktokEventsDelete.userErrors[0];
      if (error) setProblem(error.message);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {asking ? (
        <Alert tone="warning">
          <p>{t('tiktok.disconnectAsk', { pixelCode })}</p>
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
          {t('tiktok.disconnect')}
        </Button>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </div>
  );
}

/**
 * TikTok (MKT-10, ADR-542): the shop's TikTok pixel, which its orders placed through checkout go
 * to through TikTok's Events API as they are placed, confirmed and delivered, connected, changed
 * and disconnected; and the moments sent, with how each went.
 */
export function TikTokTab() {
  const { t } = useLocale();
  const query = useAdminQuery<TikTokEventsData>(['tiktokEvents'], TikTokEventsQuery);
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const current = query.data.tiktokEvents;
  return (
    <div className="flex flex-col gap-4">
      <FormSection title={t('tiktok.title')} hint={t('tiktok.hint')}>
        {current ? (
          <Alert tone="success">
            {t('tiktok.connected', { pixelCode: current.pixelCode })}
            {current.testEventCode && ` ${t('tiktok.testing', { code: current.testEventCode })}`}
          </Alert>
        ) : (
          <p className="font-medium">{t('meta.notConnected')}</p>
        )}
        <TikTokForm current={current} />
        {current && <Disconnect pixelCode={current.pixelCode} />}
      </FormSection>
      {current && <EventsList platform="TIKTOK" />}
    </div>
  );
}
