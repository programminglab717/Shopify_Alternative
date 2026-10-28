import { Link } from '@tanstack/react-router';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { ReportTable } from '../analytics/custom-reports';
import {
  BroadcastCreateMutation,
  CopilotDraftMutation,
  CopilotQuery,
  DiscountCodeCreateMutation,
  SegmentCreateMutation,
  WhatsAppTemplatesQuery,
} from '../api/operations';
import type {
  BroadcastInput,
  CopilotBroadcastDraft,
  CopilotData,
  CopilotDiscountDraft,
  CopilotDraftData,
  CopilotDraftValue,
  MessageLanguage,
  UserError,
  WhatsAppTemplatesData,
} from '../api/types';
import { permits } from '../auth/permissions';
import { KEEPS_SEGMENTS } from '../customers/customers-page';
import { MANAGES_DISCOUNTS } from '../discounts/discounts-page';
import { MARKETS, SMS_TEXT_MAX } from '../marketing/broadcasts-page';
import { errorText } from '../i18n/errors';
import {
  endOfDayIn,
  formatCount,
  formatDate,
  formatDateTime,
  formatMoney,
  startOfDayIn,
} from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card } from '../ui/feedback';
import { TextField } from '../ui/field';

type Made = Record<string, { userErrors: UserError[] } & Record<string, unknown>>;

/** What a drafted code gives, its least order, days and limits, as one line each. */
function discountLines(
  discount: CopilotDiscountDraft,
  t: ReturnType<typeof useLocale>['t'],
  day: (value: string) => string,
): string[] {
  return [
    discount.freeShipping
      ? t('copilot.freeShipping')
      : discount.percentage !== null
        ? t('copilot.percentOff', { percent: String(discount.percentage) })
        : t('copilot.amountOff', { amount: formatMoney(discount.amount ?? '0') }),
    discount.minimumSubtotal &&
      t('copilot.minimum', { amount: formatMoney(discount.minimumSubtotal) }),
    discount.startsOn && t('copilot.startsOn', { date: day(discount.startsOn) }),
    discount.endsOn ? t('copilot.endsOn', { date: day(discount.endsOn) }) : t('copilot.noEnd'),
    discount.oncePerCustomer && t('copilot.oncePerCustomer'),
    discount.usageLimit !== null &&
      t('copilot.usageLimit', { count: formatCount(discount.usageLimit) }),
  ].filter((line): line is string => Boolean(line));
}

/** A drafted code, made with the admin's own mutation once staff confirm it. */
function DiscountDraft({
  discount,
  onDone,
}: {
  discount: CopilotDiscountDraft;
  onDone: () => void;
}) {
  const { t, locale } = useLocale();
  const shop = useShop();
  const timezone = useShopTimezone();
  const create = useAdminMutation<Made, { discountCode: Record<string, unknown> }>(
    DiscountCodeCreateMutation,
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [made, setMade] = useState(false);
  const day = (value: string) => formatDate(`${value}T12:00:00+05:00`, timezone, locale);

  const confirm = async () => {
    setProblem(null);
    try {
      const { discountCodeCreate } = await create.mutateAsync({
        discountCode: {
          code: discount.code,
          title: discount.title,
          ...(discount.percentage !== null && { percentage: discount.percentage }),
          ...(discount.amount !== null && { amount: discount.amount }),
          ...(discount.freeShipping && { freeShipping: true }),
          minimumSubtotal: discount.minimumSubtotal,
          usageLimit: discount.usageLimit,
          oncePerCustomer: discount.oncePerCustomer,
          ...(discount.startsOn && { startsAt: startOfDayIn(discount.startsOn, timezone) }),
          endsAt: discount.endsOn ? endOfDayIn(discount.endsOn, timezone) : null,
        },
      });
      const error = discountCodeCreate!.userErrors[0];
      if (error) setProblem(error.message);
      else setMade(true);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="font-medium">
        {t('copilot.discountDraft', { code: discount.code })}
        {discount.title && <span dir="auto">{` · ${discount.title}`}</span>}
      </p>
      <ul className="list-disc ps-5 text-secondary">
        {discountLines(discount, t, day).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {made ? (
        <Alert tone="success">
          {t('copilot.discountMade', { code: discount.code })}{' '}
          <Link
            to="/$shopId/discounts"
            params={{ shopId: shop.id }}
            className="font-medium underline"
          >
            {t('copilot.seeDiscounts')}
          </Link>
        </Alert>
      ) : (
        <Actions
          can={permits(shop, MANAGES_DISCOUNTS)}
          confirm={t('copilot.makeDiscount')}
          busy={create.isPending}
          onConfirm={() => void confirm()}
          onDone={onDone}
        />
      )}
    </div>
  );
}

/** A drafted segment, its name changed as staff like, saved once they confirm it. */
function SegmentDraft({
  segment,
  onDone,
}: {
  segment: NonNullable<CopilotDraftValue['segment']>;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const shop = useShop();
  const create = useAdminMutation<Made, { name: string; query: string }>(SegmentCreateMutation);
  const [name, setName] = useState(segment.name);
  const [problem, setProblem] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);

  const confirm = async () => {
    setProblem(null);
    try {
      const { segmentCreate } = await create.mutateAsync({
        name: name.trim(),
        query: segment.query,
      });
      const error = segmentCreate!.userErrors[0];
      if (error) setProblem(error.message);
      else setMade((segmentCreate!.segment as { id: string }).id);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="font-medium">
        {t('copilot.segmentDraft', { count: formatCount(segment.customers) })}
      </p>
      <TextField
        label={t('copilot.segmentName')}
        value={name}
        dir="auto"
        onChange={(event) => setName(event.target.value)}
      />
      <code
        dir="ltr"
        className="rounded-control bg-canvas p-2 text-[length:var(--hatti-type-body-sm-size)]"
      >
        {segment.query}
      </code>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {made ? (
        <Alert tone="success">
          {t('copilot.segmentMade', { name: name.trim() })}{' '}
          <Link
            to="/$shopId/customers/segments/$segmentId"
            params={{ shopId: shop.id, segmentId: made }}
            className="font-medium underline"
          >
            {t('copilot.seeSegment')}
          </Link>
        </Alert>
      ) : (
        <Actions
          can={permits(shop, KEEPS_SEGMENTS) && Boolean(name.trim())}
          confirm={t('copilot.saveSegment')}
          busy={create.isPending}
          onConfirm={() => void confirm()}
          onDone={onDone}
        />
      )}
    </div>
  );
}

/** Words in Urdu's script are Urdu; SMS adds its own words in that language. */
const languageOf = (text: string): MessageLanguage => (/[\u0600-\u06FF]/.test(text) ? 'UR' : 'EN');

/**
 * A drafted broadcast (ADR-896): its name changed as staff like, its WhatsApp template chosen
 * from those approved, or its SMS words; its audience saved as a segment first, then it is made.
 */
function BroadcastDraft({
  broadcast,
  onDone,
}: {
  broadcast: CopilotBroadcastDraft;
  onDone: () => void;
}) {
  const { t, locale } = useLocale();
  const shop = useShop();
  const timezone = useShopTimezone();
  const sms = broadcast.channel === 'SMS';
  const templates = useAdminQuery<WhatsAppTemplatesData>(
    ['whatsAppTemplates'],
    WhatsAppTemplatesQuery,
    undefined,
    { enabled: !sms },
  );
  const segment = useAdminMutation<Made, { name: string; query: string }>(SegmentCreateMutation);
  const create = useAdminMutation<Made, { input: BroadcastInput }>(BroadcastCreateMutation);
  const [name, setName] = useState(broadcast.name);
  const [text, setText] = useState(broadcast.text ?? '');
  const [templateId, setTemplateId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [made, setMade] = useState(false);
  // A segment saved before a broadcast refused is not saved twice.
  const [segmentId, setSegmentId] = useState<string | null>(null);
  const approved = (templates.data?.whatsAppTemplates ?? []).filter(
    (each) => each.status === 'APPROVED',
  );
  const chosen = approved.find((each) => each.id === templateId) ?? approved[0] ?? null;
  const ready = Boolean(name.trim()) && (sms ? Boolean(text.trim()) : chosen !== null);
  const may = permits(shop, MARKETS) && (!broadcast.query || permits(shop, KEEPS_SEGMENTS));

  const confirm = async () => {
    setProblem(null);
    try {
      let audience = segmentId;
      if (broadcast.query && !audience) {
        const { segmentCreate } = await segment.mutateAsync({
          name: name.trim(),
          query: broadcast.query,
        });
        const error = segmentCreate!.userErrors[0];
        if (error) {
          setProblem(error.message);
          return;
        }
        audience = (segmentCreate!.segment as { id: string }).id;
        setSegmentId(audience);
      }
      const { broadcastCreate } = await create.mutateAsync({
        input: sms
          ? {
              name: name.trim(),
              channel: 'SMS',
              text: text.trim(),
              language: languageOf(text),
              segmentId: audience,
              sendAt: broadcast.sendAt,
            }
          : {
              name: name.trim(),
              templateId: chosen!.id,
              segmentId: audience,
              sendAt: broadcast.sendAt,
            },
      });
      const error = broadcastCreate!.userErrors[0];
      if (error) setProblem(error.message);
      else setMade(true);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="font-medium">
        {t(sms ? 'copilot.broadcastDraftSms' : 'copilot.broadcastDraft')}
      </p>
      <TextField
        label={t('copilot.broadcastName')}
        value={name}
        maxLength={100}
        dir="auto"
        onChange={(event) => setName(event.target.value)}
      />
      <p className="text-secondary">
        {broadcast.query
          ? t('copilot.broadcastTo', { count: formatCount(broadcast.customers ?? 0) })
          : t('copilot.broadcastToAll')}
        {' · '}
        {broadcast.sendAt
          ? t('copilot.broadcastAt', { when: formatDateTime(broadcast.sendAt, timezone, locale) })
          : t('copilot.broadcastNow')}
      </p>
      {broadcast.query && (
        <code
          dir="ltr"
          className="rounded-control bg-canvas p-2 text-[length:var(--hatti-type-body-sm-size)]"
        >
          {broadcast.query}
        </code>
      )}
      {sms ? (
        <div className="flex flex-col gap-1">
          <label htmlFor="copilot-sms" className="font-medium">
            {t('broadcasts.text')}
          </label>
          <textarea
            id="copilot-sms"
            value={text}
            rows={3}
            dir="auto"
            maxLength={SMS_TEXT_MAX}
            onChange={(event) => setText(event.target.value)}
            className="rounded-control border border-line bg-surface px-3 py-2 text-text"
          />
        </div>
      ) : templates.isPending ? null : chosen ? (
        <>
          <SelectField<string>
            label={t('broadcasts.template')}
            value={chosen.id}
            options={approved.map((each) => ({ value: each.id, label: each.name }))}
            onChange={setTemplateId}
          />
          <p
            className="whitespace-pre-line rounded-control border border-line bg-canvas p-3"
            dir="auto"
          >
            {chosen.body}
          </p>
        </>
      ) : (
        <Alert tone="warning">{t('broadcasts.noTemplate')}</Alert>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
      {made ? (
        <Alert tone="success">
          {t('copilot.broadcastMade', { name: name.trim() })}{' '}
          <Link
            to="/$shopId/marketing"
            params={{ shopId: shop.id }}
            className="font-medium underline"
          >
            {t('copilot.seeBroadcasts')}
          </Link>
        </Alert>
      ) : (
        <Actions
          can={may && ready}
          confirm={t(broadcast.sendAt ? 'copilot.scheduleBroadcast' : 'copilot.sendBroadcast')}
          busy={segment.isPending || create.isPending}
          onConfirm={() => void confirm()}
          onDone={onDone}
        />
      )}
    </div>
  );
}

/** Confirm, where staff may make it, or let the draft go. */
function Actions({
  can,
  confirm,
  busy,
  onConfirm,
  onDone,
}: {
  can: boolean;
  confirm: string;
  busy: boolean;
  onConfirm: () => void;
  onDone: () => void;
}) {
  const { t } = useLocale();
  return (
    <div className="flex flex-wrap gap-2">
      <Button busy={busy} disabled={!can} onClick={onConfirm}>
        {confirm}
      </Button>
      <Button variant="tertiary" onClick={onDone}>
        {t('copilot.discard')}
      </Button>
    </div>
  );
}

/**
 * The merchant copilot (AI-01, ADR-894, ADR-896): a request in English, Urdu or Roman Urdu drafted
 * into a discount code, segment or broadcast, which staff confirm before it is made, or a report,
 * run. Shown only
 * where Hatti's AI is set up.
 */
export function Copilot() {
  const { t } = useLocale();
  const status = useAdminQuery<CopilotData>(['copilot'], CopilotQuery);
  const ask = useAdminMutation<CopilotDraftData, { request: string }>(CopilotDraftMutation);
  const [request, setRequest] = useState('');
  const [draft, setDraft] = useState<CopilotDraftValue | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (!status.data?.copilot.available) return null;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setDraft(null);
    try {
      const { copilotDraft } = await ask.mutateAsync({ request: request.trim() });
      const error = copilotDraft.userErrors[0];
      if (error) setProblem(error.message);
      else setDraft(copilotDraft.draft);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };
  const done = () => {
    setDraft(null);
    setRequest('');
  };

  return (
    <section aria-labelledby="home-copilot" className="flex flex-col gap-2">
      <h2 id="home-copilot" className="font-semibold">
        {t('copilot.title')}
      </h2>
      <Card className="flex flex-col gap-3 p-4">
        <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-2">
          <TextField
            label={t('copilot.request')}
            hint={t('copilot.hint')}
            value={request}
            maxLength={400}
            dir="auto"
            placeholder={t('copilot.example')}
            onChange={(event) => setRequest(event.target.value)}
          />
          <Button
            type="submit"
            className="self-start"
            busy={ask.isPending}
            disabled={!request.trim()}
            icon={<Sparkles aria-hidden className="size-5" />}
          >
            {t('copilot.submit')}
          </Button>
        </form>
        {problem && <Alert tone="warning">{problem}</Alert>}
        {draft?.discount && <DiscountDraft discount={draft.discount} onDone={done} />}
        {draft?.segment && <SegmentDraft segment={draft.segment} onDone={done} />}
        {draft?.broadcast && <BroadcastDraft broadcast={draft.broadcast} onDone={done} />}
        {draft?.report && (
          <div className="flex flex-col gap-2">
            <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
              {t('ask.readAs', {
                rows: t(`reports.breakdown.${draft.report.breakdown}` as MessageKey),
                period: t(`reports.period.${draft.report.period}` as MessageKey),
              })}
            </p>
            <ReportTable result={draft.report.report} />
          </div>
        )}
      </Card>
    </section>
  );
}
