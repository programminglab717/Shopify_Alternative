import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { FileText, PackageCheck, Printer, Truck, X } from 'lucide-react';
import { useState } from 'react';
import {
  CourierBookingCancelMutation,
  CourierLabelsQuery,
  CourierLoadSheetQuery,
  OrdersBookMutation,
  OrdersQuery,
  ShippingQuery,
} from '../api/operations';
import type {
  CourierAccount,
  CourierBooking,
  CourierBookingCancelData,
  CourierDocumentData,
  OrdersBookData,
  OrdersData,
  PaperSize,
  ShippingData,
} from '../api/types';
import { useSessionStore } from '../auth/context';
import { errorText } from '../i18n/errors';
import { formatCount, formatMoney, formatRelative } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { openPrintTab } from '../ui/print';

type Tab = 'book' | 'booked';

/** The shipping page's search: which tab. */
export interface ShippingSearch {
  tab?: Tab;
}

export function validateShippingSearch(search: Record<string, unknown>): ShippingSearch {
  return search.tab === 'booked' ? { tab: 'booked' } : {};
}

/** Orders a page asks to book, the most a booking takes being 250. */
const TO_BOOK = 100;

/** A courier account by its name, with its courier where the name is the shop's own. */
function accountName(account: CourierAccount): string {
  return account.name === account.courierName
    ? account.name
    : `${account.name} (${account.courierName})`;
}

/** Packed orders, booked with the shop's courier at a tap, all or those chosen. */
function ToBook({ accounts }: { accounts: CourierAccount[] }) {
  const { t, locale } = useLocale();
  const shopId = useShop().id;
  const timezone = useShopTimezone();
  const orders = useAdminQuery<OrdersData>(['orders', 'TO_BOOK'], OrdersQuery, {
    first: TO_BOOK,
    stage: 'TO_BOOK',
  });
  const book = useAdminMutation<OrdersBookData, { ids: string[]; accountId: string | null }>(
    OrdersBookMutation,
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [accountId, setAccountId] = useState(
    accounts.find((account) => account.isDefault)?.id ?? accounts[0]?.id ?? '',
  );
  const [outcome, setOutcome] = useState<{ booked: number; refused: string[] } | null>(null);

  if (orders.isPending) return <Loading label={t('state.loading')} />;
  if (orders.isError) {
    return (
      <ErrorState
        message={errorText(orders.error, t)}
        action={<Button onClick={() => void orders.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const shown = orders.data.orders.nodes.filter((order) => !order.overPlanLimit);
  const names = new Map(shown.map((order) => [order.id, order.name]));

  const onBook = async () => {
    setOutcome(null);
    try {
      const { ordersBook } = await book.mutateAsync({
        ids: [...selected],
        accountId: accountId || null,
      });
      setOutcome({
        booked: ordersBook.bookings.length,
        refused: [
          ...ordersBook.refused.map((refusal) =>
            `${names.get(refusal.orderId) ?? ''} ${refusal.message}`.trim(),
          ),
          ...ordersBook.userErrors.map((error) => error.message),
        ],
      });
      setSelected(new Set());
    } catch (failure) {
      setOutcome({ booked: 0, refused: [errorText(failure, t)] });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {accounts.length === 0 && <Alert tone="info">{t('shipping.noAccount')}</Alert>}
      {outcome && (
        <Alert tone={outcome.refused.length > 0 ? 'warning' : 'success'}>
          {outcome.booked > 0 && <p>{t('shipping.booked', { count: outcome.booked })}</p>}
          {outcome.refused.length > 0 && (
            <ul className="list-disc ps-5">
              {outcome.refused.map((message, index) => (
                <li key={index}>{message}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}
      {shown.length === 0 ? (
        <Card>
          <EmptyState
            icon={<PackageCheck aria-hidden className="size-8 text-secondary" />}
            title={t('shipping.nothingToBook')}
            body={t('shipping.nothingToBookBody')}
          />
        </Card>
      ) : (
        <Card>
          <div className="flex items-center gap-3 border-b border-line px-4 py-2">
            <input
              type="checkbox"
              checked={selected.size === shown.length}
              onChange={(event) =>
                setSelected(
                  event.target.checked ? new Set(shown.map((order) => order.id)) : new Set(),
                )
              }
              aria-label={t('orders.selectAll')}
              className="size-5 accent-[var(--hatti-color-primary)]"
            />
            <span className="text-secondary">
              {t('orders.selected', { count: formatCount(selected.size) })}
            </span>
          </div>
          <ul className="divide-y divide-line">
            {shown.map((order) => (
              <li key={order.id} className="flex items-center gap-3 px-4 py-3">
                <input
                  type="checkbox"
                  checked={selected.has(order.id)}
                  onChange={(event) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(order.id);
                      else next.delete(order.id);
                      return next;
                    })
                  }
                  aria-label={t('orders.select', { name: order.name })}
                  className="size-5 shrink-0 accent-[var(--hatti-color-primary)]"
                />
                <Link
                  to="/$shopId/orders/$orderId"
                  params={{ shopId, orderId: order.id }}
                  className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1"
                >
                  <span className="num font-semibold">{order.name}</span>
                  <span className="min-w-0 flex-1 truncate text-secondary">
                    {order.customer?.displayName ?? order.shippingAddress.name}
                    {order.shippingAddress.city ? ` · ${order.shippingAddress.city}` : ''}
                  </span>
                  <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                    {formatRelative(order.createdAt, timezone, locale)}
                  </span>
                  <span className="num font-medium">
                    {formatMoney(order.totalPrice.amount, order.totalPrice.currencyCode)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {selected.size > 0 && accounts.length > 0 && (
        <div className="fixed inset-x-0 bottom-16 z-20 flex flex-wrap items-center justify-center gap-2 px-4 md:bottom-6">
          {accounts.length > 1 && (
            <select
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              aria-label={t('shipping.account')}
              className="min-h-12 rounded-control border border-line bg-surface px-3 md:min-h-10"
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {accountName(account)}
                </option>
              ))}
            </select>
          )}
          <Button
            busy={book.isPending}
            icon={<Truck aria-hidden className="size-5" />}
            onClick={() => void onBook()}
          >
            {t('shipping.book', { count: formatCount(selected.size) })}
          </Button>
        </div>
      )}
    </div>
  );
}

/** What became of a booking, in the merchant's words. */
function BookingStatus({ booking }: { booking: CourierBooking }) {
  const { t } = useLocale();
  if (booking.status === 'FAILED') {
    return (
      <span className="text-danger">
        {t('shipping.status.FAILED')}
        {booking.error ? `: ${booking.error}` : ''}
      </span>
    );
  }
  if (booking.status === 'BOOKED' && booking.parcelStatus) {
    return <span>{t(`shipping.parcel.${booking.parcelStatus}` as MessageKey)}</span>;
  }
  return (
    <span className={booking.status === 'PENDING' ? 'text-secondary' : ''}>
      {t(`shipping.status.${booking.status}` as MessageKey)}
    </span>
  );
}

/** Bookings, the latest first: their labels printed, the load sheet for the rider. */
function Booked({ accounts }: { accounts: CourierAccount[] }) {
  const { t, locale } = useLocale();
  const shop = useShop();
  const store = useSessionStore();
  const query = useAdminQuery<ShippingData>(
    ['shipping'],
    ShippingQuery,
    { first: 50 },
    {
      // Read again while bookings wait for their courier, to show each as it is booked.
      refetchInterval: (data) =>
        data?.courierBookings.nodes.some((booking) => booking.status === 'PENDING') ? 5000 : false,
    },
  );
  const cancel = useAdminMutation<CourierBookingCancelData, { id: string }>(
    CourierBookingCancelMutation,
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [paper, setPaper] = useState<PaperSize>('THERMAL_4X6');
  const [printing, setPrinting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const print = async (fetchDocument: () => Promise<CourierDocumentData>) => {
    setProblem(null);
    const tab = openPrintTab();
    if (!tab) {
      setProblem(t('shipping.popupBlocked'));
      return;
    }
    setPrinting(true);
    try {
      tab.show((await fetchDocument()).html);
    } catch (failure) {
      tab.close();
      setProblem(errorText(failure, t));
    } finally {
      setPrinting(false);
    }
  };

  const printLabels = () =>
    print(async () => {
      const data = await store.graphql<{ courierLabels: CourierDocumentData }>(
        shop.id,
        CourierLabelsQuery,
        { ids: [...selected], language: 'BILINGUAL', paper },
      );
      return data.courierLabels;
    });

  const printLoadSheet = (accountId: string) =>
    print(async () => {
      const data = await store.graphql<{ courierLoadSheet: CourierDocumentData }>(
        shop.id,
        CourierLoadSheetQuery,
        { accountId, language: 'BILINGUAL' },
      );
      return data.courierLoadSheet;
    });

  const onCancel = async (booking: CourierBooking) => {
    setProblem(null);
    try {
      const { courierBookingCancel } = await cancel.mutateAsync({ id: booking.id });
      if (courierBookingCancel.userErrors[0])
        setProblem(courierBookingCancel.userErrors[0].message);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const bookings = query.data.courierBookings.nodes;
  const printable = bookings.filter((booking) => booking.status === 'BOOKED');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {accounts.map((account) => (
          <Button
            key={account.id}
            variant="secondary"
            busy={printing}
            icon={<FileText aria-hidden className="size-5" />}
            onClick={() => void printLoadSheet(account.id)}
          >
            {accounts.length > 1
              ? t('shipping.loadSheetOf', { account: accountName(account) })
              : t('shipping.loadSheet')}
          </Button>
        ))}
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {bookings.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Truck aria-hidden className="size-8 text-secondary" />}
            title={t('shipping.noBookings')}
          />
        </Card>
      ) : (
        <Card>
          {printable.length > 0 && (
            <div className="flex items-center gap-3 border-b border-line px-4 py-2">
              <input
                type="checkbox"
                checked={printable.every((booking) => selected.has(booking.id))}
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? new Set(printable.map((booking) => booking.id))
                      : new Set(),
                  )
                }
                aria-label={t('shipping.selectBooked')}
                className="size-5 accent-[var(--hatti-color-primary)]"
              />
              <span className="text-secondary">
                {t('orders.selected', { count: formatCount(selected.size) })}
              </span>
            </div>
          )}
          <ul className="divide-y divide-line">
            {bookings.map((booking) => (
              <li key={booking.id} className="flex items-center gap-3 px-4 py-3">
                {booking.status === 'BOOKED' ? (
                  <input
                    type="checkbox"
                    checked={selected.has(booking.id)}
                    onChange={(event) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(booking.id);
                        else next.delete(booking.id);
                        return next;
                      })
                    }
                    aria-label={t('orders.select', { name: booking.orderName })}
                    className="size-5 shrink-0 accent-[var(--hatti-color-primary)]"
                  />
                ) : (
                  <span aria-hidden className="size-5 shrink-0" />
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Link
                      to="/$shopId/orders/$orderId"
                      params={{ shopId: shop.id, orderId: booking.orderId }}
                      className="num font-semibold hover:underline"
                    >
                      {booking.orderName}
                    </Link>
                    <span className="text-secondary">
                      {booking.courierName}
                      {booking.trackingNumber && (
                        <>
                          {' · '}
                          <span className="num">{booking.trackingNumber}</span>
                        </>
                      )}
                    </span>
                    <span className="flex-1" />
                    {booking.codAmount && Number(booking.codAmount.amount) > 0 && (
                      <span className="num font-medium">
                        {formatMoney(booking.codAmount.amount, booking.codAmount.currencyCode)}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 text-[length:var(--hatti-type-body-sm-size)]">
                    <BookingStatus booking={booking} />
                    <span className="text-secondary">
                      {formatRelative(
                        booking.bookedAt ?? booking.createdAt,
                        query.data.shop.timezone,
                        locale,
                      )}
                    </span>
                  </div>
                </div>
                {booking.status === 'PENDING' && (
                  <Button
                    variant="tertiary"
                    aria-label={t('shipping.cancelBooking', { name: booking.orderName })}
                    icon={<X aria-hidden className="size-5" />}
                    disabled={cancel.isPending}
                    onClick={() => void onCancel(booking)}
                  />
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-16 z-20 flex flex-wrap items-center justify-center gap-2 px-4 md:bottom-6">
          <select
            value={paper}
            onChange={(event) => setPaper(event.target.value as PaperSize)}
            aria-label={t('shipping.paper')}
            className="min-h-12 rounded-control border border-line bg-surface px-3 md:min-h-10"
          >
            <option value="THERMAL_4X6">{t('shipping.paper.THERMAL_4X6')}</option>
            <option value="A4">{t('shipping.paper.A4')}</option>
          </select>
          <Button
            busy={printing}
            icon={<Printer aria-hidden className="size-5" />}
            onClick={() => void printLabels()}
          >
            {t('shipping.printLabels', { count: formatCount(selected.size) })}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Shipping (SHP-01, SHP-02, docs/design/02 §3): packed orders booked with the shop's courier in a
 * tap, then their labels printed and the load sheet handed to the rider; each booking followed
 * as its courier books and carries it.
 */
export function ShippingPage() {
  const { t } = useLocale();
  const shop = useShop();
  const navigate = useNavigate();
  const { tab = 'book' } = useSearch({ from: '/$shopId/shipping' });
  const accounts = useAdminQuery<ShippingData>(['shipping'], ShippingQuery, { first: 50 });

  const tabs: [Tab, MessageKey][] = [
    ['book', 'shipping.toBook'],
    ['booked', 'shipping.bookings'],
  ];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 pb-24">
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('shipping.title')}
      </h1>
      <div role="tablist" className="flex gap-2">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() =>
              void navigate({
                to: '/$shopId/shipping',
                params: { shopId: shop.id },
                search: key === 'book' ? {} : { tab: key },
              })
            }
            className={`inline-flex min-h-10 items-center rounded-full border px-3 ${
              tab === key
                ? 'border-primary bg-primary text-on-primary'
                : 'border-line bg-surface text-text'
            }`}
          >
            {t(label)}
          </button>
        ))}
      </div>
      {accounts.isPending ? (
        <Loading label={t('state.loading')} />
      ) : accounts.isError ? (
        <ErrorState
          message={errorText(accounts.error, t)}
          action={<Button onClick={() => void accounts.refetch()}>{t('action.retry')}</Button>}
        />
      ) : tab === 'book' ? (
        <ToBook accounts={accounts.data.courierAccounts} />
      ) : (
        <Booked accounts={accounts.data.courierAccounts} />
      )}
    </div>
  );
}
