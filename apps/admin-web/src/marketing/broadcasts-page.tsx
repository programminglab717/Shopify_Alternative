import { Link } from '@tanstack/react-router';
import {
  Banknote,
  CalendarDays,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Clock,
  FileText,
  Gift,
  Handshake,
  Megaphone,
  Send,
  Workflow,
  XCircle,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  BroadcastCancelMutation,
  BroadcastCreateMutation,
  BroadcastEstimateQuery,
  BroadcastsQuery,
  SegmentsQuery,
  WhatsAppTemplatesQuery,
} from '../api/operations';
import type {
  Broadcast,
  BroadcastChannel,
  BroadcastEstimateData,
  BroadcastInput,
  BroadcastPayloadData,
  BroadcastsData,
  BroadcastStatus,
  MessageLanguage,
  SegmentsData,
  WhatsAppTemplatesData,
} from '../api/types';
import { gate } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { formatCount, formatDateTime, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { problemText } from '../products/product-form';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { NoNumberHint } from './templates-page';

/** Who sends the shop's broadcasts and writes its templates (ADR-420): marketers too. */
export const MARKETS = gate(['owner', 'manager', 'marketer'], 'write_marketing_events');

/** The broadcasts a page shows at a time. */
const PAGE = 20;

const BADGES = {
  SCHEDULED: { colour: 'needsConfirmation', icon: Clock },
  SENDING: { colour: 'inTransit', icon: Send },
  SENT: { colour: 'delivered', icon: CircleCheck },
  CANCELLED: { colour: 'cancelled', icon: CircleSlash },
  FAILED: { colour: 'deliveryIssue', icon: CircleAlert },
} as const satisfies Record<BroadcastStatus, unknown>;

type When = 'now' | 'later';

/** The most an SMS campaign's own words may be (ADR-458). */
export const SMS_TEXT_MAX = 320;

/** What Hatti puts before the link to stop that ends each SMS, in its language (ADR-458). */
const TO_STOP: Record<MessageLanguage, string> = { EN: 'To stop:', UR: 'روکنے کے لیے:' };

/** A value once it has stopped changing for `ms`, so typing asks the core once. */
function useSettled<T>(value: T, ms = 400): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * Who a broadcast would reach now, and about what it costs from the shop's credit (ADR-421): those
 * of the segment, or of all, who agreed to hear from the shop on WhatsApp; or by SMS, priced by
 * the parts its words go in (ADR-458).
 */
function Estimate({
  segmentId,
  channel,
  text,
  language,
}: {
  segmentId: string;
  channel: BroadcastChannel;
  text: string;
  language: MessageLanguage;
}) {
  const { t } = useLocale();
  const sms = channel === 'SMS';
  const words = useSettled(sms ? text.trim() : '');
  const query = useAdminQuery<BroadcastEstimateData>(
    ['broadcastEstimate', segmentId, channel, words, language],
    BroadcastEstimateQuery,
    sms
      ? { segmentId: segmentId || null, channel, text: words || null, language }
      : { segmentId: segmentId || null },
  );
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) return <Alert tone="danger">{errorText(query.error, t)}</Alert>;
  const { recipients, cost, pricePerMessage, partsPerMessage } = query.data.broadcastEstimate;
  if (recipients === 0) {
    return (
      <Alert tone="warning">
        {t(sms ? 'broadcasts.reachesNoneSms' : 'broadcasts.reachesNone')}
      </Alert>
    );
  }
  const shown = {
    count: formatCount(recipients),
    cost: formatMoney(cost.amount, cost.currencyCode),
    price: formatMoney(pricePerMessage.amount, pricePerMessage.currencyCode),
  };
  return (
    <Alert tone="info">
      {sms
        ? t('broadcasts.reachesSms', { ...shown, parts: formatCount(partsPerMessage) })
        : t('broadcasts.reaches', shown)}
    </Alert>
  );
}

/**
 * A new broadcast: its name, how it goes, its approved template or, by SMS, the shop's own words
 * (ADR-458), its segment and time, estimated as it is chosen.
 */
function NewBroadcast() {
  const { t } = useLocale();
  const shop = useShop();
  const shopId = shop.id;
  const templates = useAdminQuery<WhatsAppTemplatesData>(
    ['whatsAppTemplates'],
    WhatsAppTemplatesQuery,
  );
  const segments = useAdminQuery<SegmentsData>(['segments'], SegmentsQuery);
  const create = useAdminMutation<BroadcastPayloadData, { input: BroadcastInput }>(
    BroadcastCreateMutation,
  );
  const [name, setName] = useState('');
  const [channel, setChannel] = useState<BroadcastChannel>('WHATSAPP');
  const [text, setText] = useState('');
  const [language, setLanguage] = useState<MessageLanguage>('EN');
  const [templateId, setTemplateId] = useState('');
  const [segmentId, setSegmentId] = useState('');
  const [when, setWhen] = useState<When>('now');
  const [at, setAt] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState(false);

  if (templates.isPending) return <Loading label={t('state.loading')} />;
  if (templates.isError) return <Alert tone="danger">{errorText(templates.error, t)}</Alert>;
  const approved = templates.data.whatsAppTemplates.filter((each) => each.status === 'APPROVED');
  const sms = channel === 'SMS';
  const chosen = approved.find((each) => each.id === templateId) ?? approved[0] ?? null;
  const sendAt = when === 'later' && at ? new Date(at).toISOString() : null;
  const ready =
    name.trim() !== '' &&
    (when === 'now' || sendAt !== null) &&
    (sms ? text.trim() !== '' : chosen !== null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setProblem(null);
    setScheduled(false);
    try {
      const payload = Object.values(
        await create.mutateAsync({
          input: sms
            ? {
                name: name.trim(),
                channel,
                text: text.trim(),
                language,
                segmentId: segmentId || null,
                sendAt,
              }
            : { name: name.trim(), templateId: chosen!.id, segmentId: segmentId || null, sendAt },
        }),
      )[0]!;
      const error = payload.userErrors[0];
      if (error) {
        setProblem(problemText(error, t));
        return;
      }
      setName('');
      setText('');
      setWhen('now');
      setAt('');
      setScheduled(true);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <Card className="p-4">
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
        <h2 className="font-medium">{t('broadcasts.new')}</h2>
        <SelectField<BroadcastChannel>
          label={t('broadcasts.channel')}
          value={channel}
          options={[
            { value: 'WHATSAPP', label: t('broadcasts.channel.WHATSAPP') },
            { value: 'SMS', label: t('broadcasts.channel.SMS') },
          ]}
          onChange={setChannel}
        />
        {!sms && !chosen ? (
          <>
            <p>{t('broadcasts.noTemplate')}</p>
            {templates.data.whatsAppTemplates.length === 0 && <NoNumberHint />}
            <Link
              to="/$shopId/marketing/templates"
              params={{ shopId }}
              className="self-start font-medium text-primary hover:underline"
            >
              {t('broadcasts.writeTemplate')}
            </Link>
          </>
        ) : (
          <>
            <TextField
              label={t('broadcasts.name')}
              hint={t('broadcasts.nameHint')}
              value={name}
              required
              maxLength={100}
              dir="auto"
              onChange={(event) => setName(event.target.value)}
            />
            {sms ? (
              <>
                <div className="flex flex-col gap-1">
                  <label htmlFor="broadcast-text" className="font-medium">
                    {t('broadcasts.text')}
                  </label>
                  <textarea
                    id="broadcast-text"
                    value={text}
                    rows={3}
                    dir="auto"
                    maxLength={SMS_TEXT_MAX}
                    onChange={(event) => setText(event.target.value)}
                    className="rounded-control border border-line bg-surface px-3 py-2 text-text"
                  />
                  <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                    {t('broadcasts.textCount', {
                      count: text.trim().length,
                      most: SMS_TEXT_MAX,
                    })}
                  </span>
                </div>
                <SelectField<MessageLanguage>
                  label={t('broadcasts.language')}
                  value={language}
                  options={(['EN', 'UR'] as const).map((each) => ({
                    value: each,
                    label: t(`templates.language.${each}` as MessageKey),
                  }))}
                  onChange={setLanguage}
                />
                <div className="flex flex-col gap-1">
                  <span className="font-medium">{t('broadcasts.says')}</span>
                  <p
                    className="whitespace-pre-line rounded-control border border-line bg-canvas p-3"
                    dir="auto"
                  >
                    {`${shop.name}: ${text.trim() || '…'} ${TO_STOP[language]} https://…`}
                  </p>
                  <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                    {t('broadcasts.smsHint')}
                  </span>
                </div>
              </>
            ) : (
              <>
                <SelectField<string>
                  label={t('broadcasts.template')}
                  value={chosen!.id}
                  options={approved.map((each) => ({
                    value: each.id,
                    label: `${each.name} · ${t(`templates.language.${each.language}` as MessageKey)}`,
                  }))}
                  onChange={setTemplateId}
                />
                <div className="flex flex-col gap-1">
                  <span className="font-medium">{t('broadcasts.says')}</span>
                  <p
                    className="whitespace-pre-line rounded-control border border-line bg-canvas p-3"
                    dir="auto"
                  >
                    {chosen!.body}
                  </p>
                </div>
              </>
            )}
            <SelectField<string>
              label={t('broadcasts.to')}
              value={segmentId}
              options={[
                { value: '', label: t(sms ? 'broadcasts.everyoneSms' : 'broadcasts.everyone') },
                ...(segments.data?.segments.nodes ?? []).map((each) => ({
                  value: each.id,
                  label: each.name,
                })),
              ]}
              onChange={setSegmentId}
            />
            <Estimate segmentId={segmentId} channel={channel} text={text} language={language} />
            <SelectField<When>
              label={t('broadcasts.when')}
              value={when}
              options={[
                { value: 'now', label: t('broadcasts.now') },
                { value: 'later', label: t('broadcasts.later') },
              ]}
              onChange={setWhen}
            />
            {when === 'later' && (
              <TextField
                label={t('broadcasts.at')}
                type="datetime-local"
                value={at}
                required
                onChange={(event) => setAt(event.target.value)}
              />
            )}
            <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
              {t('broadcasts.hoursHint')}
            </p>
            {problem && <Alert tone="danger">{problem}</Alert>}
            {scheduled && (
              <Alert tone="success">
                {t(sms ? 'broadcasts.scheduledSms' : 'broadcasts.scheduled')}
              </Alert>
            )}
            <Button
              type="submit"
              className="self-start"
              busy={create.isPending}
              disabled={!ready}
              icon={<Megaphone aria-hidden className="size-5" />}
            >
              {t('broadcasts.schedule')}
            </Button>
          </>
        )}
      </form>
    </Card>
  );
}

/** One broadcast: what it sends and to whom, when, how its messages went, and cancelling it. */
function BroadcastRow({ broadcast }: { broadcast: Broadcast }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const cancel = useAdminMutation<BroadcastPayloadData, { id: string }>(BroadcastCancelMutation);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const badge = BADGES[broadcast.status];
  const open = broadcast.status === 'SCHEDULED' || broadcast.status === 'SENDING';
  const { counts } = broadcast;

  const onCancel = async () => {
    setProblem(null);
    try {
      const payload = Object.values(await cancel.mutateAsync({ id: broadcast.id }))[0]!;
      const error = payload.userErrors[0];
      if (error) setProblem(problemText(error, t));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
    setAsking(false);
  };

  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="flex min-w-0 flex-col">
          <span className="font-medium" dir="auto">
            {broadcast.name}
          </span>
          <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
            {broadcast.channel === 'SMS'
              ? t('broadcasts.sendsSms', {
                  to: broadcast.segmentName ?? t('broadcasts.everyoneSms'),
                })
              : t('broadcasts.sends', {
                  template: broadcast.templateName ?? '',
                  to: broadcast.segmentName ?? t('broadcasts.everyone'),
                })}
          </span>
        </span>
        <Badge
          colour={badge.colour}
          icon={badge.icon}
          label={t(`broadcasts.status.${broadcast.status}` as MessageKey)}
        />
      </div>
      {broadcast.text && (
        <p className="whitespace-pre-line" dir="auto">
          {broadcast.text}
        </p>
      )}
      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t(open ? 'broadcasts.goes' : 'broadcasts.went', {
          date: formatDateTime(broadcast.sendAt, timezone, locale),
        })}
      </p>
      {broadcast.recipients > 0 && (
        <p>
          {t('broadcasts.counts', {
            recipients: formatCount(broadcast.recipients),
            sent: formatCount(counts.sent + counts.delivered + counts.read),
            delivered: formatCount(counts.delivered + counts.read),
            read: formatCount(counts.read),
            failed: formatCount(counts.failed),
          })}
        </p>
      )}
      {broadcast.error && <Alert tone="danger">{broadcast.error}</Alert>}
      {problem && <Alert tone="danger">{problem}</Alert>}
      {open &&
        (asking ? (
          <div className="flex flex-wrap items-center gap-2">
            <span>{t('broadcasts.cancelSure', { name: broadcast.name })}</span>
            <Button variant="destructive" busy={cancel.isPending} onClick={() => void onCancel()}>
              {t('broadcasts.cancelYes')}
            </Button>
            <Button variant="tertiary" onClick={() => setAsking(false)}>
              {t('action.back')}
            </Button>
          </div>
        ) : (
          <Button
            variant="danger"
            className="self-start"
            icon={<XCircle aria-hidden className="size-5" />}
            onClick={() => setAsking(true)}
          >
            {t('broadcasts.cancel')}
          </Button>
        ))}
    </Card>
  );
}

/**
 * Marketing (MKT-01): the shop's broadcasts on WhatsApp, and by SMS (MKT-02, ADR-459), a new one
 * estimated as it is chosen and scheduled (ADR-421), and those made, the latest first, with how
 * their messages went; and the way to its templates, its automations (ADR-428), Pakistan's
 * marketing calendar (ADR-484) and its ad spend (ADR-554).
 */
export function BroadcastsPage() {
  const { t } = useLocale();
  const shopId = useShop().id;
  const [after, setAfter] = useState<string[]>([]);
  const cursor = after.at(-1) ?? null;
  const query = useAdminQuery<BroadcastsData>(['broadcasts', cursor], BroadcastsQuery, {
    first: PAGE,
    after: cursor,
  });
  const page = query.data?.broadcasts;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <Megaphone aria-hidden className="size-7 text-secondary" />
        {t('nav.marketing')}
      </h1>
      <p className="text-secondary">{t('broadcasts.intro')}</p>
      <Card>
        <Link
          to="/$shopId/marketing/templates"
          params={{ shopId }}
          className="flex min-h-16 items-center gap-3 px-4 py-3"
        >
          <FileText aria-hidden className="size-6 shrink-0 text-secondary" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-medium">{t('templates.title')}</span>
            <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
              {t('templates.linkHint')}
            </span>
          </span>
          <ChevronRight aria-hidden className="size-5 text-secondary rtl:rotate-180" />
        </Link>
        <Link
          to="/$shopId/marketing/automations"
          params={{ shopId }}
          className="flex min-h-16 items-center gap-3 border-t border-line px-4 py-3"
        >
          <Workflow aria-hidden className="size-6 shrink-0 text-secondary" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-medium">{t('automations.title')}</span>
            <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
              {t('automations.linkHint')}
            </span>
          </span>
          <ChevronRight aria-hidden className="size-5 text-secondary rtl:rotate-180" />
        </Link>
        <Link
          to="/$shopId/marketing/calendar"
          params={{ shopId }}
          className="flex min-h-16 items-center gap-3 border-t border-line px-4 py-3"
        >
          <CalendarDays aria-hidden className="size-6 shrink-0 text-secondary" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-medium">{t('calendar.title')}</span>
            <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
              {t('calendar.linkHint')}
            </span>
          </span>
          <ChevronRight aria-hidden className="size-5 text-secondary rtl:rotate-180" />
        </Link>
        <Link
          to="/$shopId/marketing/referrals"
          params={{ shopId }}
          className="flex min-h-16 items-center gap-3 border-t border-line px-4 py-3"
        >
          <Gift aria-hidden className="size-6 shrink-0 text-secondary" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-medium">{t('referrals.title')}</span>
            <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
              {t('referrals.linkHint')}
            </span>
          </span>
          <ChevronRight aria-hidden className="size-5 text-secondary rtl:rotate-180" />
        </Link>
        <Link
          to="/$shopId/marketing/affiliates"
          params={{ shopId }}
          className="flex min-h-16 items-center gap-3 border-t border-line px-4 py-3"
        >
          <Handshake aria-hidden className="size-6 shrink-0 text-secondary" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-medium">{t('affiliates.title')}</span>
            <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
              {t('affiliates.linkHint')}
            </span>
          </span>
          <ChevronRight aria-hidden className="size-5 text-secondary rtl:rotate-180" />
        </Link>
        <Link
          to="/$shopId/marketing/ad-spend"
          params={{ shopId }}
          className="flex min-h-16 items-center gap-3 border-t border-line px-4 py-3"
        >
          <Banknote aria-hidden className="size-6 shrink-0 text-secondary" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-medium">{t('adSpend.title')}</span>
            <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
              {t('adSpend.linkHint')}
            </span>
          </span>
          <ChevronRight aria-hidden className="size-5 text-secondary rtl:rotate-180" />
        </Link>
      </Card>
      <NewBroadcast />
      <h2 className="font-semibold">{t('broadcasts.yours')}</h2>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : page!.nodes.length === 0 ? (
        <EmptyState title={t('broadcasts.none')} />
      ) : (
        <ul className="flex flex-col gap-3">
          {page!.nodes.map((broadcast) => (
            <li key={broadcast.id}>
              <BroadcastRow broadcast={broadcast} />
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {after.length > 0 && (
          <Button variant="secondary" onClick={() => setAfter((all) => all.slice(0, -1))}>
            {t('broadcasts.newer')}
          </Button>
        )}
        {page?.pageInfo.hasNextPage && page.pageInfo.endCursor && (
          <Button
            variant="secondary"
            onClick={() => setAfter((all) => [...all, page.pageInfo.endCursor!])}
          >
            {t('broadcasts.older')}
          </Button>
        )}
      </div>
    </div>
  );
}
