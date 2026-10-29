import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, BadgeCheck, Star } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSessionStore } from '../auth/context';
import { errorText } from '../i18n/errors';
import { formatDate, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { TextArea } from '../products/product-form';
import { SelectField } from '../settings/settings-form';
import { useShop, useShopTimezone } from '../shell/shop-context';
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
  /** Whether they hold Hatti's certificate (ADR-858). */
  certified?: boolean;
  /** Their shops' ratings out of five (ADR-917). */
  rating?: { average: number | null; count: number };
}

/** A shop's review of an expert it hired (ADR-917). */
interface ExpertReview {
  shopName: string;
  rating: number;
  body: string;
  updatedAt: string;
}

interface ExpertReviews {
  reviews: ExpertReview[];
  /** Whether this shop may review the expert, having given them access, and its review. */
  shop: { allowed: boolean; review: { rating: number; body: string } | null } | null;
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
 * An expert's reviews by the shops that hired them (ADR-917), the latest first; and this shop's
 * own, to write or change, where it gave the expert access and the member hires.
 */
function Reviews({ expert, hires }: { expert: Expert; hires: boolean }) {
  const { t, locale } = useLocale();
  const store = useSessionStore();
  const shop = useShop();
  const timezone = useShopTimezone();
  const query = useQuery({
    queryKey: ['expertReviews', expert.id, shop.id],
    queryFn: () =>
      store.auth<ExpertReviews>(
        `/auth/experts/${expert.id}/reviews?${new URLSearchParams({ shopId: shop.id })}`,
      ),
  });
  const [rating, setRating] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) return <Alert tone="danger">{errorText(query.error, t)}</Alert>;
  const { reviews, shop: mine } = query.data;
  const chosen = rating ?? String(mine?.review?.rating ?? 5);
  const words = body ?? mine?.review?.body ?? '';

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    setSaved(false);
    try {
      await store.auth(`/auth/experts/${expert.id}/reviews`, {
        body: { shopId: shop.id, rating: Number(chosen), body: words.trim() || null },
      });
      setSaved(true);
      await query.refetch();
    } catch (failure) {
      setProblem(errorText(failure, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 border-t border-line pt-3">
      {reviews.length === 0 ? (
        <p className="text-secondary">{t('experts.noReviews')}</p>
      ) : (
        <ul
          className="flex flex-col gap-2"
          aria-label={t('experts.reviewsOf', { name: expert.businessName })}
        >
          {reviews.map((review) => (
            <li key={`${review.shopName}-${review.updatedAt}`} className="flex flex-col gap-1">
              <span className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium" dir="auto">
                  {review.shopName}
                </span>
                <span className="num">{t('experts.stars', { rating: review.rating })}</span>
                <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                  {formatDate(review.updatedAt, timezone, locale)}
                </span>
              </span>
              {review.body && (
                <p className="text-secondary" dir="auto">
                  {review.body}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {hires && mine?.allowed && (
        <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-3">
          <SelectField
            label={t('experts.yourRating')}
            value={chosen}
            options={[5, 4, 3, 2, 1].map((each) => ({
              value: String(each),
              label: t('experts.stars', { rating: each }),
            }))}
            onChange={(value) => {
              setSaved(false);
              setRating(value);
            }}
          />
          <TextArea
            label={t('experts.yourReview')}
            value={words}
            onChange={(value) => {
              setSaved(false);
              setBody(value);
            }}
          />
          {problem && <Alert tone="danger">{problem}</Alert>}
          {saved && <Alert tone="success">{t('experts.reviewSaved')}</Alert>}
          <Button type="submit" busy={busy} className="self-start">
            {mine.review ? t('experts.changeReview') : t('experts.saveReview')}
          </Button>
        </form>
      )}
    </div>
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
  const [reading, setReading] = useState<string | null>(null);
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
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold" dir="auto">
                    {expert.businessName}
                  </span>
                  {expert.certified && (
                    <span className="inline-flex items-center gap-1 text-primary text-[length:var(--hatti-type-body-sm-size)] font-medium">
                      <BadgeCheck aria-hidden className="size-4" />
                      {t('experts.certified')}
                    </span>
                  )}
                </span>
                <span className="num">
                  {expert.startingPrice > 0
                    ? t('experts.from', { price: formatMoney(String(expert.startingPrice)) })
                    : t('experts.ask')}
                </span>
              </span>
              {expert.rating && expert.rating.count > 0 && (
                <span className="inline-flex items-center gap-1 self-start">
                  <Star aria-hidden className="size-4 text-primary" />
                  <span className="num">
                    {t('experts.rating', {
                      average: expert.rating.average ?? 0,
                      count: expert.rating.count,
                    })}
                  </span>
                </span>
              )}
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
              <Button
                variant="tertiary"
                className="self-start"
                aria-expanded={reading === expert.id}
                onClick={() => setReading(reading === expert.id ? null : expert.id)}
              >
                {t('experts.reviews', { name: expert.businessName })}
              </Button>
              {reading === expert.id && <Reviews expert={expert} hires={hires} />}
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
