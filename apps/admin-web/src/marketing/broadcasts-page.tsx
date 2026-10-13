import { Link } from '@tanstack/react-router';
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Clock,
  FileText,
  Megaphone,
  Send,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
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
  BroadcastEstimateData,
  BroadcastInput,
  BroadcastPayloadData,
  BroadcastsData,
  BroadcastStatus,
  SegmentsData,
  WhatsAppTemplatesData,
} from '../api/types';
import type { StaffRole } from '../auth/session';
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
export const MARKETS: readonly StaffRole[] = ['owner', 'manager', 'marketer'];

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

/**
 * Who a broadcast would reach now, and about what it costs from the shop's credit (ADR-421): those
 * of the segment, or of all, who agreed to hear from the shop on WhatsApp.
 */
function Estimate({ segmentId }: { segmentId: string }) {
  const { t } = useLocale();
  const query = useAdminQuery<BroadcastEstimateData>(
    ['broadcastEstimate', segmentId],
    BroadcastEstimateQuery,
    { segmentId: segmentId || null },
  );
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) return <Alert tone="danger">{errorText(query.error, t)}</Alert>;
  const { recipients, cost, pricePerMessage } = query.data.broadcastEstimate;
  if (recipients === 0) return <Alert tone="warning">{t('broadcasts.reachesNone')}</Alert>;
  return (
    <Alert tone="info">
      {t('broadcasts.reaches', {
        count: formatCount(recipients),
        cost: formatMoney(cost.amount, cost.currencyCode),
        price: formatMoney(pricePerMessage.amount, pricePerMessage.currencyCode),
      })}
    </Alert>
  );
}

/** A new broadcast: its name, approved template, segment and time, estimated as it is chosen. */
function NewBroadcast() {
  const { t } = useLocale();
  const shopId = useShop().id;
  const templates = useAdminQuery<WhatsAppTemplatesData>(
    ['whatsAppTemplates'],
    WhatsAppTemplatesQuery,
  );
  const segments = useAdminQuery<SegmentsData>(['segments'], SegmentsQuery);
  const create = useAdminMutation<BroadcastPayloadData, { input: BroadcastInput }>(
    BroadcastCreateMutation,
  );
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [segmentId, setSegmentId] = useState('');
  const [when, setWhen] = useState<When>('now');
  const [at, setAt] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState(false);

  if (templates.isPending) return <Loading label={t('state.loading')} />;
  if (templates.isError) return <Alert tone="danger">{errorText(templates.error, t)}</Alert>;
  const approved = templates.data.whatsAppTemplates.filter((each) => each.status === 'APPROVED');
  if (approved.length === 0) {
    return (
      <Card className="flex flex-col gap-2 p-4">
        <h2 className="font-medium">{t('broadcasts.new')}</h2>
        <p>{t('broadcasts.noTemplate')}</p>
        {templates.data.whatsAppTemplates.length === 0 && <NoNumberHint />}
        <Link
          to="/$shopId/marketing/templates"
          params={{ shopId }}
          className="font-medium text-primary hover:underline"
        >
          {t('broadcasts.writeTemplate')}
        </Link>
      </Card>
    );
  }
  const chosen = approved.find((each) => each.id === templateId) ?? approved[0]!;
  const sendAt = when === 'later' && at ? new Date(at).toISOString() : null;
  const ready = name.trim() !== '' && (when === 'now' || sendAt !== null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setProblem(null);
    setScheduled(false);
    try {
      const payload = Object.values(
        await create.mutateAsync({
          input: {
            name: name.trim(),
            templateId: chosen.id,
            segmentId: segmentId || null,
            sendAt,
          },
        }),
      )[0]!;
      const error = payload.userErrors[0];
      if (error) {
        setProblem(problemText(error, t));
        return;
      }
      setName('');
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
        <TextField
          label={t('broadcasts.name')}
          hint={t('broadcasts.nameHint')}
          value={name}
          required
          maxLength={100}
          dir="auto"
          onChange={(event) => setName(event.target.value)}
        />
        <SelectField<string>
          label={t('broadcasts.template')}
          value={chosen.id}
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
            {chosen.body}
          </p>
        </div>
        <SelectField<string>
          label={t('broadcasts.to')}
          value={segmentId}
          options={[
            { value: '', label: t('broadcasts.everyone') },
            ...(segments.data?.segments.nodes ?? []).map((each) => ({
              value: each.id,
              label: each.name,
            })),
          ]}
          onChange={setSegmentId}
        />
        <Estimate segmentId={segmentId} />
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
        {scheduled && <Alert tone="success">{t('broadcasts.scheduled')}</Alert>}
        <Button
          type="submit"
          className="self-start"
          busy={create.isPending}
          disabled={!ready}
          icon={<Megaphone aria-hidden className="size-5" />}
        >
          {t('broadcasts.schedule')}
        </Button>
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
            {t('broadcasts.sends', {
              template: broadcast.templateName,
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
 * Marketing (MKT-01): the shop's WhatsApp broadcasts, a new one estimated as it is chosen and
 * scheduled (ADR-421), and those made, the latest first, with how their messages went; and the
 * way to its templates.
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
