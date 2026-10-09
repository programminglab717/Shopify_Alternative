import { Link } from '@tanstack/react-router';
import { Copy, ExternalLink, Link2Off, Save } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  ConversionEventsQuery,
  MetaConversionsDeleteMutation,
  MetaConversionsQuery,
  MetaConversionsUpdateMutation,
} from '../api/operations';
import type {
  ConversionEvent,
  ConversionEventsData,
  ConversionMoment,
  MetaConversions,
  MetaConversionsData,
  MetaConversionsDeleteData,
  MetaConversionsUpdateData,
} from '../api/types';
import type { StaffRole } from '../auth/session';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { errorText } from '../i18n/errors';
import { formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection } from '../products/product-form';
import { Problems, SelectField, settingProblem } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

/** Who sets where the shop's orders go to Meta, and sees how they went (ADR-143). */
export const SETS_META: readonly StaffRole[] = ['owner', 'manager', 'marketer'];

const MOMENTS: readonly ConversionMoment[] = ['PLACED', 'CONFIRMED', 'DELIVERED'];

/** The moments listed: all of them, or those of one status. */
const STATUSES = ['ALL', 'PENDING', 'SENT', 'FAILED', 'EXPIRED', 'SKIPPED'] as const;
type StatusChoice = (typeof STATUSES)[number];

const LABELS: Partial<Record<string, MessageKey>> = {
  pixelId: 'meta.pixelId',
  accessToken: 'meta.accessToken',
  testEventCode: 'meta.testEventCode',
};

/** An address to give another service, to copy or open. */
function FeedCard({ url }: { url: string }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  return (
    <FormSection title={t('meta.feed')} hint={t('meta.feedHint')}>
      <code className="num break-all rounded-control bg-canvas px-2 py-1" dir="ltr">
        {url}
      </code>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          icon={<Copy aria-hidden className="size-5" />}
          onClick={() => void navigator.clipboard?.writeText(url).then(() => setCopied(true))}
        >
          {copied ? t('staff.copied') : t('meta.copyFeed')}
        </Button>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-12 items-center gap-2 rounded-control border border-line bg-surface px-4 font-medium md:min-h-10"
        >
          <ExternalLink aria-hidden className="size-5" />
          {t('linkPage.open')}
        </a>
      </div>
    </FormSection>
  );
}

/**
 * Connecting the shop's Meta dataset, or changing how its orders go to it: the pixel's ID, a
 * token for the conversions API, sealed and never shown again, which moment is Purchase, and a
 * code for test events. Only what changed is sent, once the member confirms who they are.
 */
function MetaForm({ current }: { current: MetaConversions | null }) {
  const { t } = useLocale();
  const update = useAdminMutation<MetaConversionsUpdateData, { input: Record<string, unknown> }>(
    MetaConversionsUpdateMutation,
  );
  const { run, panel } = useRecentAuthentication();
  const [pixelId, setPixelId] = useState(current?.pixelId ?? '');
  const [accessToken, setAccessToken] = useState('');
  const [purchaseAt, setPurchaseAt] = useState<ConversionMoment>(current?.purchaseAt ?? 'PLACED');
  const [testEventCode, setTestEventCode] = useState(current?.testEventCode ?? '');
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  const changes: Record<string, unknown> = {
    ...(pixelId.trim() !== (current?.pixelId ?? '') && { pixelId: pixelId.trim() }),
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
        const { metaConversionsUpdate } = await update.mutateAsync({ input: changes });
        const kept = metaConversionsUpdate.metaConversions;
        if (metaConversionsUpdate.userErrors.length > 0 || !kept) {
          setProblems(
            metaConversionsUpdate.userErrors.map((error) =>
              settingProblem(error, t, LABELS, () => null),
            ),
          );
          return;
        }
        setPixelId(kept.pixelId);
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
        label={t('meta.pixelId')}
        hint={t('meta.pixelIdHint')}
        inputMode="numeric"
        autoComplete="off"
        ltr
        required={!current}
        value={pixelId}
        onChange={(event) => setPixelId(event.target.value)}
      />
      <TextField
        label={current ? t('meta.newAccessToken') : t('meta.accessToken')}
        hint={
          current
            ? t('meta.accessTokenKept', { hint: current.accessTokenHint })
            : t('meta.accessTokenHint')
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
          label={t('meta.purchaseAt')}
          value={purchaseAt}
          options={MOMENTS.map((moment) => ({
            value: moment,
            label: t(`meta.purchaseAt.${moment}` as MessageKey),
          }))}
          onChange={setPurchaseAt}
        />
        <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t(`meta.purchaseHint.${purchaseAt}` as MessageKey)}
        </p>
      </div>
      <TextField
        label={t('meta.testEventCode')}
        hint={t('meta.testEventCodeHint')}
        autoComplete="off"
        ltr
        value={testEventCode}
        onChange={(event) => setTestEventCode(event.target.value)}
      />
      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t('couriers.sealed')}
      </p>
      <Problems problems={problems} />
      {saved && !changed && <Alert tone="success">{t('meta.saved')}</Alert>}
      <Button
        type="submit"
        className="self-start"
        busy={update.isPending}
        disabled={!changed}
        icon={<Save aria-hidden className="size-5" />}
      >
        {current ? t('meta.save') : t('meta.connect')}
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

/** Disconnecting Meta, once asked whether they mean it. */
function Disconnect({ pixelId }: { pixelId: string }) {
  const { t } = useLocale();
  const remove = useAdminMutation<MetaConversionsDeleteData, Record<string, never>>(
    MetaConversionsDeleteMutation,
  );
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const onDisconnect = async () => {
    setProblem(null);
    try {
      const { metaConversionsDelete } = await remove.mutateAsync({});
      const error = metaConversionsDelete.userErrors[0];
      if (error) setProblem(error.message);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {asking ? (
        <Alert tone="warning">
          <p>{t('meta.disconnectAsk', { pixelId })}</p>
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
          {t('meta.disconnect')}
        </Button>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </div>
  );
}

/** One moment of an order sent, or to be sent, to Meta, and how it went. */
function EventRow({ event, timezone }: { event: ConversionEvent; timezone: string }) {
  const { t, locale } = useLocale();
  const shop = useShop();
  const tone =
    event.status === 'SENT'
      ? 'text-success'
      : event.status === 'FAILED' || event.status === 'EXPIRED'
        ? 'text-danger'
        : 'text-secondary';
  return (
    <li className="flex flex-col gap-0.5 px-4 py-3">
      <span className="flex flex-wrap justify-between gap-x-3">
        <span className="font-medium">
          {t(`meta.moment.${event.moment}` as MessageKey)}
          {event.eventName && (
            <span className="num text-secondary" dir="ltr">
              {' · '}
              {event.eventName}
            </span>
          )}
        </span>
        <span className={`font-medium ${tone}`}>
          {t(`meta.status.${event.status}` as MessageKey)}
        </span>
      </span>
      <span className="flex flex-wrap gap-x-3 text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        <span>
          {event.sentAt
            ? t('meta.sentAt', { date: formatDateTime(event.sentAt, timezone, locale) })
            : t('meta.happened', { date: formatDateTime(event.occurredAt, timezone, locale) })}
        </span>
        {event.attempts > 1 && <span>{t('meta.attempts', { count: event.attempts })}</span>}
        <Link
          to="/$shopId/orders/$orderId"
          params={{ shopId: shop.id, orderId: event.orderId }}
          className="font-medium text-primary underline"
        >
          {t('meta.order')}
        </Link>
      </span>
      {event.error && (
        <span dir="auto" className="text-danger text-[length:var(--hatti-type-body-sm-size)]">
          {event.error}
        </span>
      )}
      {event.traceId && (
        <span className="num text-secondary text-[length:var(--hatti-type-body-sm-size)]" dir="ltr">
          fbtrace_id {event.traceId}
        </span>
      )}
    </li>
  );
}

/** The latest moments sent to Meta, all of them or those of one status. */
function EventsList() {
  const { t } = useLocale();
  const timezone = useShopTimezone();
  const [status, setStatus] = useState<StatusChoice>('ALL');
  const query = useAdminQuery<ConversionEventsData>(
    ['conversionEvents', status],
    ConversionEventsQuery,
    { status: status === 'ALL' ? null : status },
  );

  return (
    <FormSection title={t('meta.events')} hint={t('meta.eventsHint')}>
      <SelectField<StatusChoice>
        label={t('meta.showing')}
        value={status}
        options={STATUSES.map((each) => ({
          value: each,
          label: t(`meta.filter.${each}` as MessageKey),
        }))}
        onChange={setStatus}
      />
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : query.data.conversionEvents.nodes.length === 0 ? (
        <p className="text-secondary">{t('meta.noEvents')}</p>
      ) : (
        <>
          <Card>
            <ul className="divide-y divide-line">
              {query.data.conversionEvents.nodes.map((event) => (
                <EventRow key={event.id} event={event} timezone={timezone} />
              ))}
            </ul>
          </Card>
          {query.data.conversionEvents.pageInfo.hasNextPage && (
            <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
              {t('meta.latestOnly')}
            </p>
          )}
        </>
      )}
    </FormSection>
  );
}

/**
 * Meta and the catalog feed (MKT-10, MKT-11, ADR-142, ADR-143): the feed's address to give
 * Google Merchant Center and Meta's catalogs; the shop's Meta dataset, which its orders placed
 * through checkout go to as they are placed, confirmed and delivered, connected, changed and
 * disconnected; and the moments sent, with how each went.
 */
export function MetaTab() {
  const { t } = useLocale();
  const query = useAdminQuery<MetaConversionsData>(['metaConversions'], MetaConversionsQuery);
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const current = query.data.metaConversions;
  return (
    <div className="flex flex-col gap-4">
      <FeedCard url={query.data.shop.productFeedUrl} />
      <FormSection title={t('meta.title')} hint={t('meta.hint')}>
        {current ? (
          <Alert tone="success">
            {t('meta.connected', { pixelId: current.pixelId })}
            {current.testEventCode && ` ${t('meta.testing', { code: current.testEventCode })}`}
          </Alert>
        ) : (
          <p className="font-medium">{t('meta.notConnected')}</p>
        )}
        <MetaForm current={current} />
        {current && <Disconnect pixelId={current.pixelId} />}
      </FormSection>
      {current && <EventsList />}
    </div>
  );
}
