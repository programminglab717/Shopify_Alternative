/** The shop's blocked numbers (COD-07): listed, found, added before they order, and taken off. */
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, Ban, Search } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { BlocklistAddMutation, BlocklistQuery, BlocklistRemoveMutation } from '../api/operations';
import type {
  BlocklistAddData,
  BlocklistData,
  BlocklistEntryValue,
  BlocklistReason,
  BlocklistRemoveData,
} from '../api/types';
import { useSessionStore } from '../auth/context';
import type { StaffRole } from '../auth/session';
import { errorText } from '../i18n/errors';
import { formatDate } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { problemText } from '../products/product-form';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { shownPhone } from './customers-page';

/** Who keeps the shop's blocked numbers, as they block a customer from their page. */
export const KEEPS_BLOCKLIST: readonly StaffRole[] = ['owner', 'manager'];

const REASONS: readonly BlocklistReason[] = [
  'FAKE_ORDERS',
  'REFUSED_DELIVERIES',
  'FRAUD',
  'ABUSE',
  'OTHER',
];

const PAGE = 50;

/** A number blocked before it ever orders, as other shops warn of it, with why. */
function BlockNumber({ onDone }: { onDone: (said: string) => void }) {
  const { t } = useLocale();
  const add = useAdminMutation<
    BlocklistAddData,
    { input: { phone: string; reason: BlocklistReason; note: string | null } }
  >(BlocklistAddMutation);
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState<BlocklistReason>('FAKE_ORDERS');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    try {
      const { blocklistAdd } = await add.mutateAsync({
        input: { phone: phone.trim(), reason, note: note.trim() || null },
      });
      if (blocklistAdd.userErrors.length > 0) {
        setProblem(blocklistAdd.userErrors.map((error) => problemText(error, t)).join(' '));
        return;
      }
      onDone(t('blocked.added', { phone: phone.trim() }));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <Card className="p-4">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
        <h2 className="font-semibold">{t('blocked.add')}</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <TextField
            label={t('blocked.phone')}
            hint={t('blocked.phoneHint')}
            type="tel"
            inputMode="tel"
            autoComplete="off"
            ltr
            required
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
          <SelectField<BlocklistReason>
            label={t('blocked.reason')}
            value={reason}
            options={REASONS.map((each) => ({
              value: each,
              label: t(`blocked.reason.${each}` as MessageKey),
            }))}
            onChange={setReason}
          />
        </div>
        <TextField
          label={t('blocked.note')}
          hint={t('blocked.noteHint')}
          dir="auto"
          maxLength={500}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        {problem && <Alert tone="danger">{problem}</Alert>}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            variant="danger"
            busy={add.isPending}
            disabled={!phone.trim()}
            icon={<Ban aria-hidden className="size-5" />}
          >
            {t('blocked.save')}
          </Button>
          <Button variant="tertiary" onClick={() => onDone('')}>
            {t('returns.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** A blocked number: its customer, if it is one, why and since when, and Unblock. */
function Entry({
  entry,
  onUnblocked,
}: {
  entry: BlocklistEntryValue;
  onUnblocked: (said: string) => void;
}) {
  const { t, locale } = useLocale();
  const shopId = useShop().id;
  const timezone = useShopTimezone();
  const remove = useAdminMutation<BlocklistRemoveData, { phone: string }>(BlocklistRemoveMutation);
  const [problem, setProblem] = useState<string | null>(null);
  const phone = shownPhone(entry.phone);

  const unblock = async () => {
    setProblem(null);
    try {
      const { blocklistRemove } = await remove.mutateAsync({ phone: entry.phone });
      if (blocklistRemove.userErrors.length > 0) {
        setProblem(blocklistRemove.userErrors.map((error) => error.message).join(' '));
        return;
      }
      onUnblocked(t('blocked.removed', { phone }));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <li className="flex flex-col gap-1 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="num font-semibold" dir="ltr">
          {phone}
        </span>
        {entry.customer && (
          <Link
            to="/$shopId/customers/$customerId"
            params={{ shopId, customerId: entry.customer.id }}
            className="min-w-0 truncate text-primary hover:underline"
            dir="auto"
          >
            {entry.customer.displayName}
          </Link>
        )}
        <span className="flex-1" />
        <Button
          variant="tertiary"
          busy={remove.isPending}
          aria-label={t('blocked.unblockLabel', { phone })}
          onClick={() => void unblock()}
        >
          {t('customer.unblock')}
        </Button>
      </div>
      <span className="text-secondary">
        {t('blocked.since', {
          reason: t(`blocked.reason.${entry.reason}` as MessageKey),
          date: formatDate(entry.createdAt, timezone, locale),
        })}
      </span>
      {entry.note && (
        <span className="text-secondary" dir="auto">
          “{entry.note}”
        </span>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </li>
  );
}

/** The numbers, found by the words searched for, a page at a time. */
function Numbers({ search, onSaid }: { search: string; onSaid: (said: string) => void }) {
  const { t } = useLocale();
  const store = useSessionStore();
  const shopId = useShop().id;
  const numbers = useInfiniteQuery({
    queryKey: ['admin', shopId, 'blocklist', search],
    queryFn: ({ pageParam }) =>
      store.graphql<BlocklistData>(shopId, BlocklistQuery, {
        first: PAGE,
        after: pageParam,
        query: search || null,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) =>
      last.blocklist.pageInfo.hasNextPage ? last.blocklist.pageInfo.endCursor : undefined,
  });

  if (numbers.isPending) return <Loading label={t('state.loading')} />;
  if (numbers.isError) {
    return (
      <ErrorState
        message={errorText(numbers.error, t)}
        action={<Button onClick={() => void numbers.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const entries = numbers.data.pages.flatMap((page) => page.blocklist.nodes);
  if (entries.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Ban aria-hidden className="size-8 text-secondary" />}
          title={t(search ? 'blocked.noneFound' : 'blocked.none')}
        />
      </Card>
    );
  }
  return (
    <Card>
      <ul className="divide-y divide-line">
        {entries.map((entry) => (
          <Entry key={entry.id} entry={entry} onUnblocked={onSaid} />
        ))}
      </ul>
      {numbers.hasNextPage && (
        <div className="border-t border-line p-3 text-center">
          <Button
            variant="tertiary"
            busy={numbers.isFetchingNextPage}
            onClick={() => void numbers.fetchNextPage()}
          >
            {t('orders.more')}
          </Button>
        </div>
      )}
    </Card>
  );
}

/**
 * The shop's blocked numbers (COD-07, ADR-332), for owners and managers: those whose orders wait
 * for review, the latest blocked first, each with its customer, why and since when; found by a
 * number or four of its digits; a number blocked before it ever orders, and one unblocked.
 */
export function BlockedPage() {
  const { t } = useLocale();
  const shop = useShop();
  const allowed = KEEPS_BLOCKLIST.includes(shop.role);
  const [words, setWords] = useState('');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [said, setSaid] = useState('');

  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    setSearch(words.trim());
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <Link
        to="/$shopId/customers"
        params={{ shopId: shop.id }}
        className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
      >
        <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
        {t('customers.title')}
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
          {t('blocked.title')}
        </h1>
        {allowed && !adding && (
          <Button
            variant="danger"
            icon={<Ban aria-hidden className="size-5" />}
            onClick={() => {
              setSaid('');
              setAdding(true);
            }}
          >
            {t('blocked.add')}
          </Button>
        )}
      </div>
      <p className="text-secondary">{t('blocked.hint')}</p>
      {!allowed ? (
        <EmptyState title={t('blocked.cannot')} />
      ) : (
        <>
          {said && <Alert tone="success">{said}</Alert>}
          {adding && (
            <BlockNumber
              onDone={(done) => {
                setAdding(false);
                setSaid(done);
              }}
            />
          )}
          <form onSubmit={onSearch} role="search" className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute start-3 top-1/2 size-5 -translate-y-1/2 text-secondary"
            />
            <input
              type="search"
              inputMode="tel"
              value={words}
              onChange={(event) => setWords(event.target.value)}
              aria-label={t('blocked.search')}
              placeholder={t('blocked.search')}
              className="min-h-12 w-full rounded-control border border-line bg-surface ps-11 pe-3 md:min-h-10"
            />
          </form>
          <Numbers search={search} onSaid={setSaid} />
        </>
      )}
    </div>
  );
}
