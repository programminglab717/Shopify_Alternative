import { Link } from '@tanstack/react-router';
import { Clock, Eye, EyeOff, Save, Star } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  ProductReviewHideMutation,
  ProductReviewPublishMutation,
  ProductReviewsQuery,
  ReviewSettingsQuery,
  ReviewSettingsUpdateMutation,
} from '../api/operations';
import type {
  ProductReview,
  ProductReviewHideData,
  ProductReviewPublishData,
  ProductReviewStatus,
  ProductReviewsData,
  ReviewSettingsData,
  ReviewSettingsUpdateData,
} from '../api/types';
import { permits } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { SETS_SETTINGS } from '../settings/settings-page';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { problemText } from './product-form';
import { EDITS_PRODUCTS } from './status';

/** The reviews a page shows at a time. */
const PAGE = 50;

const STATUSES: readonly ProductReviewStatus[] = ['PENDING', 'PUBLISHED', 'HIDDEN'];

/** From how many stars reviews publish by themselves: none, or 3, 4 or 5. */
const PUBLISH_FROM = ['', '3', '4', '5'] as const;
type PublishFrom = (typeof PUBLISH_FROM)[number];

/** How many days after delivery customers are asked for one: never, or these. */
const REQUEST_AFTER = ['', '1', '2', '3', '5', '7', '10', '14'] as const;
type RequestAfter = (typeof REQUEST_AFTER)[number];

const BADGES = {
  PENDING: { colour: 'needsConfirmation', icon: Clock },
  PUBLISHED: { colour: 'delivered', icon: Eye },
  HIDDEN: { colour: 'cancelled', icon: EyeOff },
} as const;

/** A review's stars, read out as words. */
function Stars({ rating }: { rating: number }) {
  const { t } = useLocale();
  return (
    <span
      className="inline-flex items-center gap-0.5"
      role="img"
      aria-label={t('reviews.stars', { rating })}
    >
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          aria-hidden
          className={`size-4 ${star <= rating ? 'fill-warning text-warning' : 'text-line'}`}
        />
      ))}
    </span>
  );
}

function Review({ review, moderates }: { review: ProductReview; moderates: boolean }) {
  const { t, locale } = useLocale();
  const shop = useShop();
  const timezone = useShopTimezone();
  const publish = useAdminMutation<ProductReviewPublishData, { id: string }>(
    ProductReviewPublishMutation,
  );
  const hide = useAdminMutation<ProductReviewHideData, { id: string }>(ProductReviewHideMutation);
  const [problem, setProblem] = useState<string | null>(null);
  const badge = BADGES[review.status];

  const act = async (to: 'publish' | 'hide') => {
    setProblem(null);
    try {
      const error =
        to === 'publish'
          ? (await publish.mutateAsync({ id: review.id })).productReviewPublish.userErrors[0]
          : (await hide.mutateAsync({ id: review.id })).productReviewHide.userErrors[0];
      if (error) setProblem(problemText(error, t));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="flex min-w-0 flex-col gap-1">
          <Link
            to="/$shopId/products/$productId"
            params={{ shopId: shop.id, productId: review.productId }}
            className="font-medium text-primary hover:underline"
            dir="auto"
          >
            {review.productTitle}
          </Link>
          <span className="flex flex-wrap items-center gap-2">
            <Stars rating={review.rating} />
            <span className="text-secondary" dir="auto">
              {review.authorName}
            </span>
          </span>
        </span>
        <Badge
          colour={badge.colour}
          icon={badge.icon}
          label={t(`reviews.status.${review.status}` as MessageKey)}
        />
      </div>
      {review.body ? (
        <p className="whitespace-pre-line" dir="auto">
          {review.body}
        </p>
      ) : (
        <p className="text-secondary">{t('reviews.noWords')}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('reviews.written', { date: formatDateTime(review.updatedAt, timezone, locale) })}
        </span>
        <Link
          to="/$shopId/orders/$orderId"
          params={{ shopId: shop.id, orderId: review.orderId }}
          className="font-medium text-primary hover:underline text-[length:var(--hatti-type-body-sm-size)]"
        >
          {t('reviews.order')}
        </Link>
        {moderates && review.status !== 'PUBLISHED' && (
          <Button
            variant="secondary"
            icon={<Eye aria-hidden className="size-5" />}
            busy={publish.isPending}
            onClick={() => void act('publish')}
          >
            {t('reviews.publish')}
          </Button>
        )}
        {moderates && review.status !== 'HIDDEN' && (
          <Button
            variant="tertiary"
            icon={<EyeOff aria-hidden className="size-5" />}
            busy={hide.isPending}
            onClick={() => void act('hide')}
          >
            {t('reviews.hide')}
          </Button>
        )}
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
    </Card>
  );
}

/**
 * How the shop takes reviews, for its owner and managers (ADR-399, ADR-400): from how many stars
 * they publish by themselves, and how many days after delivery customers are asked on WhatsApp.
 */
function ReviewSettingsForm() {
  const { t } = useLocale();
  const query = useAdminQuery<ReviewSettingsData>(['reviewSettings'], ReviewSettingsQuery);
  const update = useAdminMutation<
    ReviewSettingsUpdateData,
    { input: { publishFrom: number | null; requestAfterDays: number | null } }
  >(ReviewSettingsUpdateMutation);
  const [publishFrom, setPublishFrom] = useState<PublishFrom>('');
  const [requestAfter, setRequestAfter] = useState<RequestAfter>('');
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const stored = query.data?.reviewSettings;
  useEffect(() => {
    if (!stored) return;
    setPublishFrom(String(stored.publishFrom ?? '') as PublishFrom);
    setRequestAfter(String(stored.requestAfterDays ?? '') as RequestAfter);
  }, [stored]);

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) return <Alert tone="danger">{errorText(query.error, t)}</Alert>;
  const changed =
    publishFrom !== String(stored?.publishFrom ?? '') ||
    requestAfter !== String(stored?.requestAfterDays ?? '');

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setSaved(false);
    try {
      const { reviewSettingsUpdate } = await update.mutateAsync({
        input: {
          publishFrom: publishFrom === '' ? null : Number(publishFrom),
          requestAfterDays: requestAfter === '' ? null : Number(requestAfter),
        },
      });
      const error = reviewSettingsUpdate.userErrors[0];
      if (error) setProblem(problemText(error, t));
      else setSaved(true);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <Card className="p-4">
      <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-3">
        <h2 className="font-medium">{t('reviews.settings')}</h2>
        <SelectField<PublishFrom>
          label={t('reviews.publishFrom')}
          value={publishFrom}
          options={PUBLISH_FROM.map((value) => ({
            value,
            label:
              value === ''
                ? t('reviews.publishNever')
                : t('reviews.publishStars', { count: Number(value) }),
          }))}
          onChange={setPublishFrom}
        />
        <SelectField<RequestAfter>
          label={t('reviews.requestAfter')}
          value={requestAfter}
          options={REQUEST_AFTER.map((value) => ({
            value,
            label:
              value === ''
                ? t('reviews.requestNever')
                : t('reviews.requestDays', { count: Number(value) }),
          }))}
          onChange={setRequestAfter}
        />
        <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('reviews.requestHint')}
        </p>
        {problem && <Alert tone="danger">{problem}</Alert>}
        {saved && !changed && <Alert tone="success">{t('reviews.saved')}</Alert>}
        <Button
          type="submit"
          className="self-start"
          busy={update.isPending}
          disabled={!changed}
          icon={<Save aria-hidden className="size-5" />}
        >
          {t('reviews.save')}
        </Button>
      </form>
    </Card>
  );
}

/**
 * Products' reviews (MKT-05, ADR-399), those waiting for the shop first: each with its product,
 * stars, author and words, published or hidden by those who change products; and, for the owner
 * and managers, how reviews publish and when customers are asked for them (ADR-400).
 */
export function ReviewsPage() {
  const { t } = useLocale();
  const shop = useShop();
  const [status, setStatus] = useState<ProductReviewStatus>('PENDING');
  const [after, setAfter] = useState<string[]>([]);
  const cursor = after.at(-1) ?? null;
  const query = useAdminQuery<ProductReviewsData>(
    ['productReviews', status, cursor],
    ProductReviewsQuery,
    { first: PAGE, after: cursor, status },
  );
  const moderates = permits(shop, EDITS_PRODUCTS);
  const shown = query.data?.productReviews ?? [];
  /** The oldest shown, to go on from, when the page is full. */
  const last = shown.length === PAGE ? shown.at(-1)!.id : null;

  const choose = (next: ProductReviewStatus) => {
    setStatus(next);
    setAfter([]);
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <Star aria-hidden className="size-7 text-secondary" />
        {t('reviews.title')}
      </h1>
      <p className="text-secondary">{t('reviews.intro')}</p>
      {permits(shop, SETS_SETTINGS) && <ReviewSettingsForm />}
      <div role="tablist" className="flex flex-wrap gap-2">
        {STATUSES.map((each) => (
          <button
            key={each}
            type="button"
            role="tab"
            aria-selected={status === each}
            onClick={() => choose(each)}
            className={`min-h-10 rounded-full border px-4 ${
              status === each ? 'border-primary bg-primary text-on-primary' : 'border-line'
            }`}
          >
            {t(`reviews.tab.${each}` as MessageKey)}
          </button>
        ))}
      </div>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : query.data.productReviews.length === 0 ? (
        <EmptyState
          title={after.length > 0 ? t('reviews.noMore') : t(`reviews.none.${status}` as MessageKey)}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {query.data.productReviews.map((review) => (
            <li key={review.id}>
              <Review review={review} moderates={moderates} />
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {after.length > 0 && (
          <Button variant="secondary" onClick={() => setAfter((all) => all.slice(0, -1))}>
            {t('reviews.newer')}
          </Button>
        )}
        {last && (
          <Button variant="secondary" onClick={() => setAfter((all) => [...all, last])}>
            {t('reviews.older')}
          </Button>
        )}
      </div>
    </div>
  );
}
