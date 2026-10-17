import { CircleCheck, CircleSlash, Clock, Mail, MessageCircle, Phone } from 'lucide-react';
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
  SupportRequestPayload,
  SupportRequestStatus,
  SupportRequestValue,
  SupportTopic,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { Locale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection, TextArea, problemText } from '../products/product-form';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShopTimezone } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { searchArticles } from './articles';

// Help (BIL-05, ADR-508): the help centre, how the shop reaches Hatti's people as its plan allows,
// and its requests to them with their answers, for everyone at the shop.

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
function AskForm({ answerWithinHours }: { answerWithinHours: number }) {
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

/** One of the shop's requests, with Hatti's answer once it comes. */
function Request({ request }: { request: SupportRequestValue }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const close = useAdminMutation<{ supportRequestClose: SupportRequestPayload }, { id: string }>(
    SupportRequestCloseMutation,
  );
  const status = STATUSES[request.status];
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t(TOPICS[request.topic])}</span>
        <Badge colour={status.colour} icon={status.icon} label={t(status.label)} />
        <span className="text-secondary">
          {formatDateTime(request.createdAt, timezone, locale)}
        </span>
      </div>
      <p dir="auto" className="whitespace-pre-line">
        {request.message}
      </p>
      {request.answer && (
        <div className="rounded-control border-s-4 border-primary bg-canvas p-3">
          <p className="font-medium">{t('help.answeredBy', { name: request.answeredBy ?? '' })}</p>
          <p dir="auto" className="whitespace-pre-line">
            {request.answer}
          </p>
        </div>
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
        <AskForm answerWithinHours={hattiSupport.answerWithinHours} />
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
      {support}
    </div>
  );
}
