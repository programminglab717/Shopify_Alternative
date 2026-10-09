import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, Plus, Trash2, UsersRound, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ApiError } from '../api/client';
import {
  SegmentCreateMutation,
  SegmentDeleteMutation,
  SegmentFiltersQuery,
  SegmentPreviewQuery,
  SegmentQuery,
  SegmentsQuery,
  SegmentUpdateMutation,
} from '../api/operations';
import type {
  SegmentData,
  SegmentFiltersData,
  SegmentFilterValue,
  SegmentMutationData,
  SegmentPreviewData,
  SegmentsData,
  SegmentValue,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { messages } from '../i18n/messages';
import type { MessageKey } from '../i18n/messages';
import { FormSection } from '../products/product-form';
import { useAttempt } from '../returns/parcel';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { CustomerRow, KEEPS_SEGMENTS } from './customers-page';
import {
  buildQuery,
  CONSENT_STATES,
  isConsentField,
  OPS_BY_TYPE,
  parseQuery,
} from './segment-query';
import type { Condition, ConditionOp, Join } from './segment-query';

const OP_KEYS: Record<ConditionOp, string> = {
  '>=': 'gte',
  '<=': 'lte',
  '=': 'eq',
  '>': 'gt',
  '<': 'lt',
  '!=': 'ne',
  IN: 'in',
  CONTAINS: 'contains',
  'NOT CONTAINS': 'notContains',
  WITHIN_DAYS: 'withinDays',
  BEFORE_DAYS: 'beforeDays',
};

/** What a condition's comparison is called, in the words of its kind of field. */
function opLabel(filter: SegmentFilterValue, op: ConditionOp): MessageKey {
  if (filter.type === 'BOOLEAN') return 'segments.op.bool';
  const group = filter.type === 'NUMBER' || filter.type === 'MONEY' ? 'num.' : '';
  return `segments.op.${group}${OP_KEYS[op]}` as MessageKey;
}

/** A new condition on `filter`: its first comparison, and an answer where it takes one of few. */
function startOn(filter: SegmentFilterValue): Condition {
  const op = OPS_BY_TYPE[filter.type][0]!;
  const value =
    filter.type === 'BOOLEAN' ? 'true' : isConsentField(filter.name) ? 'subscribed' : '';
  return { field: filter.name, op, value };
}

/** The field a new condition starts on: the number of orders where the core has it. */
const firstFilter = (filters: readonly SegmentFilterValue[]) =>
  filters.find((each) => each.name === 'number_of_orders') ?? filters[0]!;

/** Whether the builder shows `condition`: a known field, asked one of its kind's comparisons. */
const shown = (condition: Condition, filters: readonly SegmentFilterValue[]) => {
  const filter = filters.find((each) => each.name === condition.field);
  return Boolean(filter && OPS_BY_TYPE[filter.type].includes(condition.op));
};

function useDebounced<T>(value: T, ms = 500): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** A condition: the field, how it compares, and the answer, in the merchant's words. */
function ConditionRow({
  index,
  condition,
  filters,
  onChange,
  onRemove,
}: {
  index: number;
  condition: Condition;
  filters: readonly SegmentFilterValue[];
  onChange: (condition: Condition) => void;
  onRemove: () => void;
}) {
  const { t } = useLocale();
  const filter = filters.find((each) => each.name === condition.field)!;
  const label = (name: string) =>
    `segments.field.${name}` in messages.en
      ? t(`segments.field.${name}` as MessageKey)
      : (filters.find((each) => each.name === name)?.description ?? name);
  const select =
    'min-h-12 rounded-control border border-line bg-surface px-2 text-text md:min-h-10';
  const number = { NUMBER: 'numeric', MONEY: 'decimal', DATE: 'numeric' } as const;

  return (
    <li className="flex flex-col gap-2 rounded-control border border-line p-3">
      <div className="flex items-start gap-2">
        <div className="grid flex-1 gap-2 md:grid-cols-3">
          <select
            aria-label={t('segments.fieldLabel', { number: index + 1 })}
            value={condition.field}
            onChange={(event) =>
              onChange(startOn(filters.find((each) => each.name === event.target.value)!))
            }
            className={select}
          >
            {filters.map((each) => (
              <option key={each.name} value={each.name}>
                {label(each.name)}
              </option>
            ))}
          </select>
          {OPS_BY_TYPE[filter.type].length > 1 ? (
            <select
              aria-label={t('segments.opLabel', { number: index + 1 })}
              value={condition.op}
              onChange={(event) =>
                onChange({ ...condition, op: event.target.value as ConditionOp })
              }
              className={select}
            >
              {OPS_BY_TYPE[filter.type].map((op) => (
                <option key={op} value={op}>
                  {t(opLabel(filter, op))}
                </option>
              ))}
            </select>
          ) : (
            <span className="flex min-h-10 items-center text-secondary">
              {t(opLabel(filter, condition.op))}
            </span>
          )}
          {filter.type === 'BOOLEAN' || isConsentField(filter.name) ? (
            <select
              aria-label={t('segments.valueLabel', { number: index + 1 })}
              value={condition.value}
              onChange={(event) => onChange({ ...condition, value: event.target.value })}
              className={select}
            >
              {(filter.type === 'BOOLEAN' ? ['true', 'false'] : CONSENT_STATES).map((value) => (
                <option key={value} value={value}>
                  {t(`segments.value.${value}` as MessageKey)}
                </option>
              ))}
            </select>
          ) : (
            <TextField
              label={t('segments.valueLabel', { number: index + 1 })}
              className="[&>label]:sr-only"
              hint={
                filter.type === 'DATE'
                  ? t('segments.daysHint')
                  : condition.op === 'IN'
                    ? t('segments.listHint')
                    : undefined
              }
              inputMode={number[filter.type as keyof typeof number]}
              dir="auto"
              value={condition.value}
              onChange={(event) => onChange({ ...condition, value: event.target.value })}
            />
          )}
        </div>
        <Button
          variant="tertiary"
          aria-label={t('segments.removeCondition', { number: index + 1 })}
          icon={<X aria-hidden className="size-5" />}
          onClick={onRemove}
        />
      </div>
    </li>
  );
}

/** What the segment's conditions match now: how many customers, and the newest of them. */
function Preview({ query }: { query: string }) {
  const { t } = useLocale();
  const timezone = useShopTimezone();
  const debounced = useDebounced(query);
  const preview = useAdminQuery<SegmentPreviewData>(
    ['segment-preview', debounced],
    SegmentPreviewQuery,
    { query: debounced },
    { enabled: debounced !== '' },
  );
  if (query === '') return <p className="text-secondary">{t('segments.previewEmpty')}</p>;
  if (preview.isPending || debounced !== query) return <Loading label={t('segments.counting')} />;
  if (preview.isError) {
    const failure = preview.error;
    return (
      <Alert tone="warning">
        {failure instanceof ApiError && failure.code === 'BAD_USER_INPUT'
          ? t('segments.queryProblem', { message: failure.message })
          : errorText(failure, t)}
      </Alert>
    );
  }
  const { memberCount, members } = preview.data.segmentPreview;
  return (
    <div className="flex flex-col gap-2">
      <p className="inline-flex items-center gap-2 font-medium">
        <UsersRound aria-hidden className="size-5 text-primary" />
        {t('segments.matches', { count: formatCount(memberCount) })}
      </p>
      {members.length > 0 && (
        <Card>
          <ul className="divide-y divide-line" aria-label={t('segments.members')}>
            {members.map((customer) => (
              <CustomerRow key={customer.id} customer={customer} timezone={timezone} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/**
 * A segment's name and conditions: built in words, joined so customers match all or any of them,
 * or written as the core's query where the builder cannot show it; what they match counted as
 * they change.
 */
function SegmentForm({
  segment,
  filters,
}: {
  segment?: SegmentValue;
  filters: readonly SegmentFilterValue[];
}) {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const navigate = useNavigate();
  const create = useAdminMutation<SegmentMutationData, { name: string; query: string }>(
    SegmentCreateMutation,
  );
  const update = useAdminMutation<
    SegmentMutationData,
    { id: string; name?: string; query?: string }
  >(SegmentUpdateMutation);
  const { problem, attempt } = useAttempt();
  const [start] = useState(() => {
    const parsed = parseQuery(segment?.query ?? '');
    const fits = parsed && parsed.conditions.every((each) => shown(each, filters));
    return {
      asText: !fits,
      join: fits ? parsed.join : ('AND' as Join),
      conditions: !segment ? [startOn(firstFilter(filters))] : fits ? parsed.conditions : [],
    };
  });
  const [name, setName] = useState(segment?.name ?? '');
  const [asText, setAsText] = useState(start.asText);
  const [join, setJoin] = useState<Join>(start.join);
  const [conditions, setConditions] = useState<Condition[]>(start.conditions);
  const [text, setText] = useState(segment?.query ?? '');
  const [saved, setSaved] = useState(false);
  const query = asText ? text.trim() : buildQuery(conditions, join);
  const changed = segment
    ? name.trim() !== segment.name || query !== segment.query
    : name.trim() !== '' && query !== '';

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed || !name.trim() || !query) return;
    setSaved(false);
    const made: { id?: string } = {};
    const ok = await attempt(async () => {
      const payload = Object.values(
        segment
          ? await update.mutateAsync({
              id: segment.id,
              ...(name.trim() !== segment.name && { name: name.trim() }),
              ...(query !== segment.query && { query }),
            })
          : await create.mutateAsync({ name: name.trim(), query }),
      )[0]!;
      made.id = payload.segment?.id;
      return payload;
    });
    if (!ok) return;
    if (segment) setSaved(true);
    else if (made.id) {
      await navigate({
        to: '/$shopId/customers/segments/$segmentId',
        params: { shopId, segmentId: made.id },
      });
    }
  };

  const toText = () => {
    setText(query);
    setAsText(true);
  };
  const toBuilder = () => {
    const parsed = parseQuery(text);
    if (parsed && parsed.conditions.every((each) => shown(each, filters))) {
      setJoin(parsed.join);
      setConditions(parsed.conditions);
      setAsText(false);
    }
  };
  const parsedText = asText ? parseQuery(text) : null;
  const canBuild = Boolean(parsedText?.conditions.every((each) => shown(each, filters)));

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
      <FormSection title={t('segments.details')}>
        <TextField
          label={t('segments.name')}
          hint={t('segments.nameHint')}
          required
          dir="auto"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </FormSection>
      <FormSection title={t('segments.conditions')} hint={t('segments.conditionsHint')}>
        {asText ? (
          <>
            <div className="flex flex-col gap-1">
              <label htmlFor="segment-query" className="font-medium">
                {t('segments.query')}
              </label>
              <p className="text-secondary">{t('segments.queryHint')}</p>
              <textarea
                id="segment-query"
                dir="ltr"
                rows={4}
                value={text}
                onChange={(event) => setText(event.target.value)}
                className="rounded-control border border-line bg-surface px-3 py-2 font-mono text-[length:var(--hatti-type-body-sm-size)]"
              />
            </div>
            {canBuild && (
              <Button variant="tertiary" className="self-start" onClick={toBuilder}>
                {t('segments.useBuilder')}
              </Button>
            )}
          </>
        ) : (
          <>
            {conditions.length > 1 && (
              <fieldset className="flex flex-wrap items-center gap-4">
                <legend className="sr-only">{t('segments.join')}</legend>
                {(['AND', 'OR'] as const).map((each) => (
                  <label key={each} className="flex min-h-10 items-center gap-2">
                    <input
                      type="radio"
                      name="join"
                      checked={join === each}
                      onChange={() => setJoin(each)}
                      className="size-5 accent-[var(--hatti-color-primary)]"
                    />
                    {t(each === 'AND' ? 'segments.all' : 'segments.any')}
                  </label>
                ))}
              </fieldset>
            )}
            <ul className="flex flex-col gap-2">
              {conditions.map((condition, index) => (
                <ConditionRow
                  key={index}
                  index={index}
                  condition={condition}
                  filters={filters}
                  onChange={(next) =>
                    setConditions((all) => all.map((each, at) => (at === index ? next : each)))
                  }
                  onRemove={() => setConditions((all) => all.filter((_, at) => at !== index))}
                />
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                icon={<Plus aria-hidden className="size-5" />}
                onClick={() => setConditions((all) => [...all, startOn(firstFilter(filters))])}
              >
                {t('segments.addCondition')}
              </Button>
              <Button variant="tertiary" onClick={toText}>
                {t('segments.useText')}
              </Button>
            </div>
          </>
        )}
      </FormSection>
      <FormSection title={t('segments.preview')}>
        <Preview query={query} />
      </FormSection>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {saved && !changed && <Alert tone="success">{t('segments.saved')}</Alert>}
      <Button
        type="submit"
        className="self-start"
        busy={create.isPending || update.isPending}
        disabled={!changed || !name.trim() || !query}
      >
        {t(segment ? 'segments.save' : 'segments.create')}
      </Button>
    </form>
  );
}

function BackToSegments() {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  return (
    <Link
      to="/$shopId/customers/segments"
      params={{ shopId }}
      className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
    >
      <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
      {t('segments.title')}
    </Link>
  );
}

/** The fields to build with, loaded before a form starts from them. */
function WithFilters({
  render,
}: {
  render: (filters: readonly SegmentFilterValue[]) => ReactNode;
}) {
  const { t } = useLocale();
  const query = useAdminQuery<SegmentFiltersData>(['segment-filters'], SegmentFiltersQuery);
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  return render(query.data.segmentFilters);
}

/** The shop's segments (CUS-03): each with how many customers it holds now. */
export function SegmentsPage() {
  const { t } = useLocale();
  const { id: shopId, role } = useShop();
  const query = useAdminQuery<SegmentsData>(['segments'], SegmentsQuery);
  if (!KEEPS_SEGMENTS.includes(role)) return <EmptyState title={t('segments.cannot')} />;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <Link
        to="/$shopId/customers"
        params={{ shopId }}
        className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
      >
        <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
        {t('customers.title')}
      </Link>
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('segments.title')}
      </h1>
      <p className="text-secondary">{t('segments.intro')}</p>
      <Link
        to="/$shopId/customers/segments/new"
        params={{ shopId }}
        className="inline-flex min-h-12 items-center gap-2 self-start rounded-control bg-primary px-4 font-medium text-on-primary hover:bg-primary-strong md:min-h-10"
      >
        <Plus aria-hidden className="size-5" />
        {t('segments.add')}
      </Link>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : query.data.segments.nodes.length === 0 ? (
        <Card>
          <EmptyState title={t('segments.none')} />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {query.data.segments.nodes.map((segment) => (
              <li key={segment.id}>
                <Link
                  to="/$shopId/customers/segments/$segmentId"
                  params={{ shopId, segmentId: segment.id }}
                  className="flex min-h-14 items-center justify-between gap-3 px-4 py-2 hover:bg-canvas"
                >
                  <span className="font-medium" dir="auto">
                    {segment.name}
                  </span>
                  <span className="text-secondary">
                    {t('segments.memberCount', { count: formatCount(segment.memberCount) })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** A new segment, for those who keep them. */
export function NewSegmentPage() {
  const { t } = useLocale();
  const { role } = useShop();
  if (!KEEPS_SEGMENTS.includes(role)) return <EmptyState title={t('segments.cannot')} />;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSegments />
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('segments.add')}
      </h1>
      <WithFilters render={(filters) => <SegmentForm filters={filters} />} />
    </div>
  );
}

/** The segment deleted after asking; its customers stay. */
function DeleteSegment({ segment }: { segment: SegmentValue }) {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const navigate = useNavigate();
  const remove = useAdminMutation<SegmentMutationData, { id: string }>(SegmentDeleteMutation);
  const { problem, attempt } = useAttempt();
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button
        variant="danger"
        className="self-start"
        icon={<Trash2 aria-hidden className="size-5" />}
        onClick={() => setAsking(true)}
      >
        {t('segments.delete')}
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
      <p>{t('segments.deleteAsk', { name: segment.name })}</p>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="destructive"
          busy={remove.isPending}
          onClick={() =>
            void (async () => {
              const ok = await attempt(
                async () => Object.values(await remove.mutateAsync({ id: segment.id }))[0]!,
              );
              if (ok) await navigate({ to: '/$shopId/customers/segments', params: { shopId } });
            })()
          }
        >
          {t('segments.deleteConfirm')}
        </Button>
        <Button variant="tertiary" onClick={() => setAsking(false)}>
          {t('returns.cancel')}
        </Button>
      </div>
    </div>
  );
}

/** A segment of the shop's (CUS-03): its conditions changed, its members seen, or deleted. */
export function SegmentPage() {
  const { t } = useLocale();
  const { role } = useShop();
  const { segmentId } = useParams({ from: '/$shopId/customers/segments/$segmentId' });
  const query = useAdminQuery<SegmentData>(['segment', segmentId], SegmentQuery, {
    id: segmentId,
  });
  if (!KEEPS_SEGMENTS.includes(role)) return <EmptyState title={t('segments.cannot')} />;
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const segment = query.data.segment;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSegments />
      {!segment ? (
        <EmptyState title={t('segments.notFound')} />
      ) : (
        <>
          <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold" dir="auto">
            {segment.name}
          </h1>
          <WithFilters
            render={(filters) => (
              <SegmentForm key={segment.id} segment={segment} filters={filters} />
            )}
          />
          <DeleteSegment segment={segment} />
        </>
      )}
    </div>
  );
}
