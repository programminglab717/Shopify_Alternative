import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSessionStore } from '../auth/context';
import { errorText } from '../i18n/errors';
import { formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { TextArea } from '../products/product-form';
import { SelectField } from '../settings/settings-form';
import { useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

/** What an expert offers shops (ADR-855), in the order the platform lists them. */
export const EXPERT_SERVICES = [
  'setup',
  'design',
  'photography',
  'ads',
  'migration',
  'apps',
  'content',
] as const;

/** An expert as shops see them, their starting price in whole rupees; nothing for "ask". */
export interface Expert {
  id: string;
  businessName: string;
  website: string | null;
  headline: string;
  about: string;
  services: string[];
  cities: string[];
  languages: string[];
  startingPrice: number;
  listed: boolean;
}

const serviceKey = (service: string) => `experts.service.${service}` as MessageKey;

/** An enquiry to one expert, about one of what they offer. */
function Enquire({ expert }: { expert: Expert }) {
  const { t } = useLocale();
  const store = useSessionStore();
  const shop = useShop();
  const [open, setOpen] = useState(false);
  const [service, setService] = useState(expert.services[0] ?? '');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const onSend = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await store.auth(`/auth/experts/${expert.id}/enquiries`, {
        body: { shopId: shop.id, service, message: message.trim() },
      });
      setSent(true);
      setOpen(false);
    } catch (failure) {
      setProblem(errorText(failure, t));
    } finally {
      setBusy(false);
    }
  };

  if (sent) return <Alert tone="success">{t('experts.sent', { name: expert.businessName })}</Alert>;
  if (!open) {
    return (
      <Button variant="secondary" className="self-start" onClick={() => setOpen(true)}>
        {t('experts.contact', { name: expert.businessName })}
      </Button>
    );
  }
  return (
    <form onSubmit={(event) => void onSend(event)} className="flex flex-col gap-3">
      <SelectField
        label={t('experts.need')}
        value={service}
        options={expert.services.map((each) => ({ value: each, label: t(serviceKey(each)) }))}
        onChange={setService}
      />
      <TextArea label={t('experts.message')} value={message} onChange={setMessage} />
      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t('experts.messageHint')}
      </p>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={busy} disabled={!message.trim()}>
          {t('experts.send')}
        </Button>
        <Button variant="tertiary" onClick={() => setOpen(false)}>
          {t('action.back')}
        </Button>
      </div>
    </form>
  );
}

/**
 * Experts a shop hires (PRT-03, ADR-855): Hatti's partners who set stores up, design them,
 * photograph products, run ads, move shops from other platforms, build apps or write, each
 * listed after Hatti's look. The owner or a manager sends one an enquiry, which the expert
 * answers by email.
 */
export function ExpertsPage() {
  const { t, locale } = useLocale();
  const store = useSessionStore();
  const shop = useShop();
  const [service, setService] = useState('');
  const [city, setCity] = useState('');
  const hires = shop.role === 'owner' || shop.role === 'manager';
  const query = useQuery({
    queryKey: ['experts', service, city.trim().toLowerCase()],
    queryFn: () =>
      store.auth<{ experts: Expert[] }>(
        `/auth/experts?${new URLSearchParams({
          ...(service && { service }),
          ...(city.trim() && { city: city.trim() }),
        })}`,
      ),
  });

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
    const experts = query.data.experts;
    if (experts.length === 0) return <p className="text-secondary">{t('experts.none')}</p>;
    return (
      <ul className="flex flex-col gap-3" aria-label={t('experts.title')}>
        {experts.map((expert) => (
          <li key={expert.id}>
            <Card className="flex flex-col gap-2 p-4">
              <span className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold" dir="auto">
                  {expert.businessName}
                </span>
                <span className="num">
                  {expert.startingPrice > 0
                    ? t('experts.from', { price: formatMoney(String(expert.startingPrice)) })
                    : t('experts.ask')}
                </span>
              </span>
              <p dir="auto">{expert.headline}</p>
              <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                {expert.services.map((each) => t(serviceKey(each))).join(' · ')}
              </p>
              <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                {[
                  expert.cities.join(', '),
                  expert.languages
                    .map((each) => t(each === 'ur' ? 'experts.urdu' : 'experts.english'))
                    .join(', '),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              {expert.about && (
                <p className="text-secondary" dir="auto">
                  {expert.about}
                </p>
              )}
              {expert.website && (
                <a
                  href={expert.website}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="self-start text-secondary underline"
                  dir="ltr"
                >
                  {expert.website}
                </a>
              )}
              {hires && <Enquire expert={expert} />}
            </Card>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8" lang={locale}>
      <Link
        to="/$shopId/help"
        params={{ shopId: shop.id }}
        className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
      >
        <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
        {t('nav.help')}
      </Link>
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('experts.title')}
      </h1>
      <p className="text-secondary">{t('experts.hint')}</p>
      {!hires && <Alert tone="info">{t('experts.ownersHire')}</Alert>}
      <div className="flex flex-wrap gap-3">
        <SelectField
          label={t('experts.filterService')}
          value={service}
          options={[
            { value: '', label: t('experts.anyService') },
            ...EXPERT_SERVICES.map((each) => ({ value: each, label: t(serviceKey(each)) })),
          ]}
          onChange={setService}
        />
        <TextField
          label={t('experts.filterCity')}
          dir="auto"
          maxLength={40}
          value={city}
          onChange={(event) => setCity(event.target.value)}
        />
      </div>
      {body()}
    </div>
  );
}
