import {
  Check,
  CheckCheck,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Clock,
  Mail,
  MessageCircle,
  Paperclip,
  Phone,
} from 'lucide-react';
import { Link } from '@tanstack/react-router';
import type { LucideIcon } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  HattiSupportQuery,
  SupportRequestCloseMutation,
  SupportRequestCreateMutation,
} from '../api/operations';
import type {
  HattiSupportData,
  SupportChannel,
  SupportMessageStatus,
  SupportRequestMessageValue,
  SupportRequestPayload,
  SupportRequestStatus,
  SupportRequestValue,
  SupportTopic,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatDateTime, formatPhone } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { Locale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { mediaLabel } from '../inbox/inbox-page';
import { FormSection, TextArea, problemText } from '../products/product-form';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { searchArticles } from './articles';

// Help (BIL-05, ADR-508): the help centre, how the shop reaches Hatti's people as its plan allows,
// and its requests to them with their answers, for everyone at the shop. Those its staff wrote to
// Hatti's support WhatsApp show here too, with their messages there and how the answers went
// (ADR-561).

const CHANNELS: Record<SupportChannel, MessageKey> = {
  HELP_CENTRE: 'help.channelHelpCentre',
  WHATSAPP: 'help.channelWhatsapp',
  PRIORITY_WHATSAPP: 'help.channelPriorityWhatsapp',
  PRIORITY_CALL: 'help.channelPriorityCall',
};

const TOPICS: Record<SupportTopic, MessageKey> = {
  ORDERS: 'help.topicOrders',
  PAYMENTS: 'help.topicPayments',
  COURIERS: 'help.topicCouriers',
  STORE: 'help.topicStore',
  BILLING: 'help.topicBilling',
  ACCOUNT: 'help.topicAccount',
  OTHER: 'help.topicOther',
};

const STATUSES: Record<
  SupportRequestStatus,
  { label: MessageKey; colour: 'needsConfirmation' | 'delivered' | 'cancelled'; icon: typeof Clock }
> = {
  OPEN: { label: 'help.statusOpen', colour: 'needsConfirmation', icon: Clock },
  ANSWERED: { label: 'help.statusAnswered', colour: 'delivered', icon: CircleCheck },
  CLOSED: { label: 'help.statusClosed', colour: 'cancelled', icon: CircleSlash },
};

/** How an answer went on WhatsApp, as words and an icon. */
const DELIVERY: Record<
  SupportMessageStatus,
  { label: MessageKey; icon: LucideIcon; className: string }
> = {
  SENT: { label: 'help.delivery.SENT', icon: Check, className: 'text-secondary' },
  DELIVERED: { label: 'help.delivery.DELIVERED', icon: CheckCheck, className: 'text-secondary' },
  READ: { label: 'help.delivery.READ', icon: CheckCheck, className: 'text-info' },
  FAILED: { label: 'help.delivery.FAILED', icon: CircleAlert, className: 'text-danger' },
};

const CAPTION = 'text-[length:var(--hatti-type-body-sm-size)]';

const PLAN_NAMES = { STARTER: 'Starter', GROWTH: 'Growth', PRO: 'Pro' } as const;

/** A WhatsApp chat with Hatti's number, as wa.me takes it: digits alone. */
const whatsappLink = (number: string) => `https://wa.me/${number.replace(/\D/g, '')}`;

/** The help centre's articles, found by their words in either language. */
function HelpCentre() {
  const { t, locale } = useLocale();
  const [query, setQuery] = useState('');
  const found = searchArticles(query);
  return (
    <FormSection title={t('help.centre')}>
      <TextField
        type="search"
        label={t('help.search')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {found.length === 0 ? (
        <p className="text-secondary">{t('help.noArticles')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {found.map((article) => (
            <li key={article.id}>
              <details className="py-2">
                <summary className="min-h-10 cursor-pointer font-medium">
                  {article.title[locale]}
                </summary>
                <p className="pt-2 text-secondary">{article.body[locale]}</p>
              </details>
            </li>
          ))}
        </ul>
      )}
    </FormSection>
  );
}

/** How the shop reaches Hatti's people, as its plan allows. */
function Contact({ support }: { support: HattiSupportData['hattiSupport'] }) {
  const { t, locale } = useLocale();
  const plan = support.plan === 'FREE' ? t('billing.free') : PLAN_NAMES[support.plan];
  const link =
    'inline-flex min-h-12 items-center gap-2 rounded-control border border-line px-4 font-medium hover:bg-canvas md:min-h-10';
  return (
    <FormSection
      title={t('help.contact')}
      hint={t('help.planLine', {
        plan,
        channel: t(CHANNELS[support.channel]),
        hours: String(support.answerWithinHours),
      })}
    >
      <div className="flex flex-wrap gap-2">
        {support.whatsapp && (
          <a
            href={whatsappLink(support.whatsapp)}
            target="_blank"
            rel="noreferrer"
            className={link}
          >
            <MessageCircle aria-hidden className="size-5" />
            {t('help.whatsapp')}
          </a>
        )}
        {support.phone && (
          <a href={`tel:${support.phone}`} className={link}>
            <Phone aria-hidden className="size-5" />
            {t('help.call')}
            <span dir="ltr">{support.phone}</span>
          </a>
        )}
        {support.email && (
          <a href={`mailto:${support.email}`} className={link}>
            <Mail aria-hidden className="size-5" />
            {t('help.email')}
          </a>
        )}
      </div>
      {support.hours && (
        <p className="text-secondary">{t('help.hours', { hours: support.hours[locale] })}</p>
      )}
      {support.channel === 'HELP_CENTRE' && <p className="text-secondary">{t('help.paidPlans')}</p>}
    </FormSection>
  );
}

/** A request to Hatti's people: what about, in the shop's words, and a number to call back. */
function AskForm({
  answerWithinHours,
  whatsapp,
}: {
  answerWithinHours: number;
  whatsapp: string | null;
}) {
  const { t, locale } = useLocale();
  const [topic, setTopic] = useState<SupportTopic>('ORDERS');
  const [language, setLanguage] = useState<Locale>(locale);
  const [message, setMessage] = useState('');
  const [callBack, setCallBack] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [sent, setSent] = useState(false);
  const ask = useAdminMutation<
    { supportRequestCreate: SupportRequestPayload },
    { input: Record<string, unknown> }
  >(SupportRequestCreateMutation);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setProblems([]);
    setSent(false);
    try {
      const { supportRequestCreate } = await ask.mutateAsync({
        input: {
          topic,
          message,
          language: language === 'ur' ? 'URDU' : 'ENGLISH',
          callBack: callBack.trim() || null,
        },
      });
      if (supportRequestCreate.userErrors.length > 0) {
        setProblems(supportRequestCreate.userErrors.map((each) => problemText(each, t)));
      } else {
        setSent(true);
        setMessage('');
        setCallBack('');
      }
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  return (
    <FormSection title={t('help.ask')} hint={t('help.askHint')}>
      {whatsapp && (
        <p className="text-secondary">
          {t('help.whatsappHint')}{' '}
          <a
            href={whatsappLink(whatsapp)}
            target="_blank"
            rel="noreferrer"
            dir="ltr"
            className="font-medium text-primary underline"
          >
            {formatPhone(whatsapp)}
          </a>
        </p>
      )}
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
        <SelectField
          label={t('help.topic')}
          value={topic}
          options={(Object.keys(TOPICS) as SupportTopic[]).map((value) => ({
            value,
            label: t(TOPICS[value]),
          }))}
          onChange={setTopic}
        />
        <TextArea label={t('help.message')} value={message} onChange={setMessage} />
        <SelectField
          label={t('help.language')}
          value={language}
          options={[
            { value: 'en', label: t('help.english') },
            { value: 'ur', label: t('help.urdu') },
          ]}
          onChange={setLanguage}
        />
        <TextField
          type="tel"
          ltr
          label={t('help.callBack')}
          value={callBack}
          onChange={(event) => setCallBack(event.target.value)}
        />
        {problems.length > 0 && (
          <Alert tone="danger">
            {problems.map((problem) => (
              <p key={problem}>{problem}</p>
            ))}
          </Alert>
        )}
        {sent && (
          <Alert tone="success">{t('help.sent', { hours: String(answerWithinHours) })}</Alert>
        )}
        <div>
          <Button type="submit" busy={ask.isPending} disabled={message.trim().length === 0}>
            {t('help.send')}
          </Button>
        </div>
      </form>
    </FormSection>
  );
}

/** How an answer went on WhatsApp, and why it did not get there. */
function Delivery({ message }: { message: SupportRequestMessageValue }) {
  const { t } = useLocale();
  if (!message.status) return null;
  const delivery = DELIVERY[message.status];
  return (
    <span className={`inline-flex items-center gap-1 ${delivery.className}`}>
      <delivery.icon aria-hidden className="size-4" />
      {t(delivery.label)}
    </span>
  );
}

function DeliveryError({ message }: { message: SupportRequestMessageValue }) {
  return message.status === 'FAILED' && message.error ? (
    <p dir="auto" className={`text-danger ${CAPTION}`}>
      {message.error}
    </p>
  ) : null;
}

/**
 * A message of a request on WhatsApp: who wrote it, when, and for Hatti's how it went. What was
 * sent besides words is named, and is on the phone it was sent from alone.
 */
function ThreadMessage({
  message,
  timezone,
}: {
  message: SupportRequestMessageValue;
  timezone: string;
}) {
  const { t, locale } = useLocale();
  const outbound = message.direction === 'OUTBOUND';
  return (
    <li
      className={`flex flex-col gap-1 ${outbound ? 'rounded-control border-s-4 border-line bg-canvas p-3' : ''}`}
    >
      <span className={`flex flex-wrap items-center gap-x-2 text-secondary ${CAPTION}`}>
        <span className="font-medium text-text">
          {t(outbound ? 'help.hattiWrote' : 'help.youWrote')}
        </span>
        <time dateTime={message.at}>{formatDateTime(message.at, timezone, locale)}</time>
        {outbound && <Delivery message={message} />}
      </span>
      {(message.mediaKind || !message.body) && (
        <span className="flex flex-col">
          <span className="inline-flex items-center gap-1 font-medium">
            <Paperclip aria-hidden className="size-4" />
            {mediaLabel(message.mediaKind, t)}
          </span>
          <span className={`text-secondary ${CAPTION}`}>{t('help.mediaNote')}</span>
        </span>
      )}
      {message.body && (
        <p dir="auto" className="break-words whitespace-pre-line">
          {message.body}
        </p>
      )}
      <DeliveryError message={message} />
    </li>
  );
}

/** Hatti's answer, with how it went on WhatsApp when it was sent there too. */
function Answer({
  request,
  sent,
  timezone,
}: {
  request: SupportRequestValue;
  sent: SupportRequestMessageValue | null;
  timezone: string;
}) {
  const { t, locale } = useLocale();
  const status = sent?.status ? DELIVERY[sent.status] : null;
  const answer = (
    <div className="flex flex-col gap-1 rounded-control border-s-4 border-primary bg-canvas p-3">
      <div className="flex flex-wrap items-center gap-x-2">
        <p className="font-medium">{t('help.answeredBy', { name: request.answeredBy ?? '' })}</p>
        {sent && (
          <span className={`flex flex-wrap items-center gap-x-2 text-secondary ${CAPTION}`}>
            <time dateTime={sent.at}>{formatDateTime(sent.at, timezone, locale)}</time>
            {status && (
              <span className={`inline-flex items-center gap-1 ${status.className}`}>
                <status.icon aria-hidden className="size-4" />
                {t('help.answerOnWhatsapp', { status: t(status.label) })}
              </span>
            )}
          </span>
        )}
      </div>
      <p dir="auto" className="whitespace-pre-line">
        {request.answer}
      </p>
      {sent && <DeliveryError message={sent} />}
    </div>
  );
  return sent ? <li>{answer}</li> : answer;
}

const sameText = (body: string | null, text: string | null) =>
  body !== null && text !== null && body.trim() === text.trim();

/**
 * A request's thread as the page shows it, each thing once. A request written on WhatsApp keeps
 * its first message as the request's own, so when the thread opens with it the thread stands in
 * for it. Hatti's answer sent on WhatsApp is the last of Hatti's messages saying it: shown as the
 * answer, in its place, with how it went.
 */
function threadOf(request: SupportRequestValue) {
  const { messages } = request;
  const opensWithMessage =
    messages[0]?.direction === 'INBOUND' && sameText(messages[0].body, request.message);
  const answerAt = request.answer
    ? messages.findLastIndex(
        (each) => each.direction === 'OUTBOUND' && sameText(each.body, request.answer),
      )
    : -1;
  return { opensWithMessage, answerAt };
}

/** One of the shop's requests, with its messages on WhatsApp and Hatti's answer once it comes. */
function Request({ request }: { request: SupportRequestValue }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const close = useAdminMutation<{ supportRequestClose: SupportRequestPayload }, { id: string }>(
    SupportRequestCloseMutation,
  );
  const status = STATUSES[request.status];
  const { opensWithMessage, answerAt } = threadOf(request);
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t(TOPICS[request.topic])}</span>
        <Badge colour={status.colour} icon={status.icon} label={t(status.label)} />
        {request.channel === 'WHATSAPP' && (
          <span className="inline-flex items-center gap-1 text-secondary">
            <MessageCircle aria-hidden className="size-4" />
            {t('help.viaWhatsapp')}
          </span>
        )}
        <span className="text-secondary">
          {formatDateTime(request.createdAt, timezone, locale)}
        </span>
      </div>
      {!opensWithMessage && (
        <p dir="auto" className="whitespace-pre-line">
          {request.message}
        </p>
      )}
      {request.messages.length > 0 && (
        <ol aria-label={t('help.thread')} className="flex flex-col gap-2">
          {request.messages.map((message, index) =>
            index === answerAt ? (
              <Answer key={message.id} request={request} sent={message} timezone={timezone} />
            ) : (
              <ThreadMessage key={message.id} message={message} timezone={timezone} />
            ),
          )}
        </ol>
      )}
      {request.answer && answerAt === -1 && (
        <Answer request={request} sent={null} timezone={timezone} />
      )}
      {request.status !== 'CLOSED' && (
        <div>
          <Button
            variant="tertiary"
            busy={close.isPending}
            onClick={() => close.mutate({ id: request.id })}
          >
            {t('help.close')}
          </Button>
        </div>
      )}
    </li>
  );
}

export function HelpPage() {
  const { t } = useLocale();
  const shop = useShop();
  const query = useAdminQuery<HattiSupportData>(['hattiSupport'], HattiSupportQuery);

  let support;
  if (query.isPending) support = <Loading label={t('state.loading')} />;
  else if (query.isError) {
    support = (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  } else {
    const { hattiSupport } = query.data;
    support = (
      <>
        <Contact support={hattiSupport} />
        <AskForm
          answerWithinHours={hattiSupport.answerWithinHours}
          whatsapp={hattiSupport.whatsapp}
        />
        <Card className="p-4">
          <h2 className="font-semibold">{t('help.requests')}</h2>
          {hattiSupport.requests.length === 0 ? (
            <p className="pt-2 text-secondary">{t('help.noRequests')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {hattiSupport.requests.map((request) => (
                <Request key={request.id} request={request} />
              ))}
            </ul>
          )}
        </Card>
      </>
    );
  }
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('nav.help')}
      </h1>
      <HelpCentre />
      <Link
        to="/$shopId/help/experts"
        params={{ shopId: shop.id }}
        className="inline-flex min-h-10 items-center self-start font-medium underline"
      >
        {t('experts.link')}
      </Link>
      {support}
    </div>
  );
}
