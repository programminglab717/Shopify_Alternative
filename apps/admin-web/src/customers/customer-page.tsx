import { parsePkMobile } from '@hatti/pk';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, Ban, Eye, MessageCircle, Phone, Save } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  BlocklistAddMutation,
  BlocklistRemoveMutation,
  CustomerPhoneRevealMutation,
  CustomerQuery,
  CustomerUpdateMutation,
} from '../api/operations';
import type {
  BlocklistAddData,
  BlocklistReason,
  BlocklistRemoveData,
  CustomerData,
  CustomerDetail,
  CustomerPhoneRevealData,
  CustomerUpdateData,
} from '../api/types';
import type { StaffRole } from '../auth/session';
import { errorText } from '../i18n/errors';
import { formatCount, formatDate, formatMoney, formatRelative } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { StageBadge } from '../orders/stage';
import { FormSection, parseTags, problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { useWide } from '../ui/wide';
import { shownPhone } from './customers-page';

/** The roles that change customers and the blocklist (docs/design/02 §6). */
const EDITS_CUSTOMERS: readonly StaffRole[] = ['owner', 'manager'];

const REASONS: readonly BlocklistReason[] = [
  'FAKE_ORDERS',
  'REFUSED_DELIVERIES',
  'FRAUD',
  'ABUSE',
  'OTHER',
];

/** Their number, a tap from a call or a WhatsApp chat once staff may see it whole. */
function Contact({ customer }: { customer: CustomerDetail }) {
  const { t } = useLocale();
  const reveal = useAdminMutation<CustomerPhoneRevealData, { id: string }>(
    CustomerPhoneRevealMutation,
  );
  const [revealed, setRevealed] = useState<{ phone: string | null; otherPhones: string[] } | null>(
    null,
  );
  const [problem, setProblem] = useState<string | null>(null);
  const masked = customer.phone.includes('•');
  const phone = revealed?.phone ?? (masked ? null : customer.phone);
  const others = revealed?.otherPhones ?? customer.otherPhones;
  const mobile = phone ? parsePkMobile(phone) : null;

  const onReveal = async () => {
    setProblem(null);
    try {
      const { customerPhoneReveal } = await reveal.mutateAsync({ id: customer.id });
      if (customerPhoneReveal.userErrors[0]) {
        setProblem(problemText(customerPhoneReveal.userErrors[0], t));
      } else setRevealed(customerPhoneReveal);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <FormSection title={t('customer.contact')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="num">{phone ? shownPhone(phone) : customer.phone}</span>
        {masked && !revealed && (
          <Button
            variant="tertiary"
            icon={<Eye aria-hidden className="size-5" />}
            busy={reveal.isPending}
            onClick={() => void onReveal()}
          >
            {t('desk.revealPhone')}
          </Button>
        )}
      </div>
      {phone && (
        <div className="flex flex-wrap gap-2">
          <a
            href={`tel:${phone}`}
            className="inline-flex min-h-12 items-center gap-2 rounded-control bg-primary px-4 font-medium text-on-primary md:min-h-10"
          >
            <Phone aria-hidden className="size-5" />
            {t('desk.call')}
          </a>
          {mobile && (
            <a
              href={`https://wa.me/${mobile.e164.slice(1)}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-12 items-center gap-2 rounded-control border border-line px-4 font-medium md:min-h-10"
            >
              <MessageCircle aria-hidden className="size-5" />
              {t('desk.whatsapp')}
            </a>
          )}
        </div>
      )}
      {others.length > 0 && (
        <p className="text-secondary">
          {t('customer.otherPhones')}:{' '}
          <span className="num">{others.map((other) => shownPhone(other)).join(', ')}</span>
        </p>
      )}
      {customer.email && <p className="break-all">{customer.email}</p>}
      <p className="text-secondary">
        {t(`customer.whatsapp.${customer.whatsappMarketingConsent.marketingState}` as MessageKey)}
      </p>
      {problem && <Alert tone="danger">{problem}</Alert>}
    </FormSection>
  );
}

/** How their orders went: delivered, returned, cancelled, on their way. */
function Record({ customer }: { customer: CustomerDetail }) {
  const { t } = useLocale();
  const history = customer.deliveryHistory;
  const finished = history.delivered + history.returned;
  const rows: [MessageKey, number, string][] = [
    ['customer.delivered', history.delivered, ''],
    ['customer.returned', history.returned, history.returned > 0 ? 'text-danger' : ''],
    ['customer.cancelled', history.cancelled, ''],
    ['customer.inProgress', history.inProgress, ''],
  ];
  return (
    <FormSection title={t('customer.record')}>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="flex flex-col">
          <dt className="text-secondary">{t('customer.ordersLabel')}</dt>
          <dd className="num text-[length:var(--hatti-type-title-size)] font-semibold">
            {formatCount(customer.numberOfOrders)}
          </dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-secondary">{t('customer.spent')}</dt>
          <dd className="num text-[length:var(--hatti-type-title-size)] font-semibold">
            {formatMoney(customer.amountSpent.amount, customer.amountSpent.currencyCode)}
          </dd>
        </div>
        {rows.map(([label, count, tone]) => (
          <div key={label} className="flex flex-col">
            <dt className="text-secondary">{t(label)}</dt>
            <dd className={`num text-[length:var(--hatti-type-title-size)] font-semibold ${tone}`}>
              {formatCount(count)}
            </dd>
          </div>
        ))}
      </dl>
      {finished > 0 && (
        <p className={history.returned * 2 >= finished ? 'text-danger' : 'text-secondary'}>
          {t('customer.deliveryRate', {
            delivered: formatCount(history.delivered),
            finished: formatCount(finished),
          })}
        </p>
      )}
    </FormSection>
  );
}

/** Their orders, the latest first, each a tap from its page. */
function Orders({ customer, timezone }: { customer: CustomerDetail; timezone: string }) {
  const { t, locale } = useLocale();
  const shopId = useShop().id;
  const orders = customer.orders.nodes;
  return (
    <FormSection title={t('customer.orders')}>
      {orders.length === 0 ? (
        <p className="text-secondary">{t('customer.noOrders')}</p>
      ) : (
        <ul className="-mx-4 divide-y divide-line border-t border-line">
          {orders.map((order) => (
            <li key={order.id}>
              <Link
                to="/$shopId/orders/$orderId"
                params={{ shopId, orderId: order.id }}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3"
              >
                <span className="num font-semibold">{order.name}</span>
                <span className="flex-1 text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                  {formatRelative(order.createdAt, timezone, locale)}
                </span>
                <StageBadge stage={order.stage} />
                <span className="num font-medium">
                  {formatMoney(order.totalPrice.amount, order.totalPrice.currencyCode)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </FormSection>
  );
}

/** The shop's own note and tags on them. */
function NoteAndTags({ customer, edits }: { customer: CustomerDetail; edits: boolean }) {
  const { t } = useLocale();
  const update = useAdminMutation<
    CustomerUpdateData,
    { id: string; input: { note: string; tags: string[] } }
  >(CustomerUpdateMutation);
  const [note, setNote] = useState(customer.note);
  const [tags, setTags] = useState(customer.tags.join(', '));
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const changed =
    note.trim() !== customer.note || parseTags(tags).join(',') !== customer.tags.join(',');

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setOutcome(null);
    try {
      const { customerUpdate } = await update.mutateAsync({
        id: customer.id,
        input: { note: note.trim(), tags: parseTags(tags) },
      });
      setOutcome(
        customerUpdate.userErrors[0]
          ? { ok: false, text: problemText(customerUpdate.userErrors[0], t) }
          : { ok: true, text: t('product.saved') },
      );
    } catch (failure) {
      setOutcome({ ok: false, text: errorText(failure, t) });
    }
  };

  if (!edits && !customer.note && customer.tags.length === 0) return null;
  return (
    <form onSubmit={(event) => void onSave(event)}>
      <FormSection title={t('customer.notes')}>
        <fieldset disabled={!edits} className="contents">
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('customer.note')}</span>
            <textarea
              value={note}
              rows={3}
              dir="auto"
              onChange={(event) => setNote(event.target.value)}
              className="rounded-control border border-line bg-surface px-3 py-2"
            />
          </label>
          <TextField
            label={t('product.tags')}
            hint={edits ? t('product.tagsHint') : undefined}
            value={tags}
            dir="auto"
            onChange={(event) => setTags(event.target.value)}
          />
        </fieldset>
        {outcome && <Alert tone={outcome.ok ? 'success' : 'danger'}>{outcome.text}</Alert>}
        {edits && (
          <Button
            type="submit"
            className="self-end"
            busy={update.isPending}
            disabled={!changed}
            icon={<Save aria-hidden className="size-5" />}
          >
            {t('product.save')}
          </Button>
        )}
      </FormSection>
    </form>
  );
}

/** Blocking their number, whose new orders then wait for review (COD-07); or unblocking it. */
function Blocklist({ customer, timezone }: { customer: CustomerDetail; timezone: string }) {
  const { t, locale } = useLocale();
  const add = useAdminMutation<
    BlocklistAddData,
    { input: { phone: string; reason: BlocklistReason; note: string | null } }
  >(BlocklistAddMutation);
  const remove = useAdminMutation<BlocklistRemoveData, { phone: string }>(BlocklistRemoveMutation);
  const [choosing, setChoosing] = useState(false);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const entry = customer.blocklistEntry;

  const run = async (action: () => Promise<{ userErrors: { message: string }[] }>) => {
    setProblem(null);
    try {
      const { userErrors } = await action();
      if (userErrors[0]) setProblem(userErrors[0].message);
      else setChoosing(false);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <FormSection title={t('customer.blocklist')} hint={entry ? undefined : t('customer.blockHint')}>
      {entry ? (
        <>
          <Alert tone="danger">
            {t('customer.blockedFor', {
              reason: t(`customer.reason.${entry.reason}` as MessageKey),
              date: formatDate(entry.createdAt, timezone, locale),
            })}
            {entry.note && ` “${entry.note}”`}
          </Alert>
          <Button
            variant="secondary"
            className="self-start"
            busy={remove.isPending}
            onClick={() =>
              void run(
                async () => (await remove.mutateAsync({ phone: customer.phone })).blocklistRemove,
              )
            }
          >
            {t('customer.unblock')}
          </Button>
        </>
      ) : choosing ? (
        <div className="flex flex-col gap-3">
          <TextField
            label={t('desk.note')}
            value={note}
            dir="auto"
            onChange={(event) => setNote(event.target.value)}
          />
          <div role="group" aria-label={t('customer.blockWhy')} className="flex flex-wrap gap-2">
            {REASONS.map((reason) => (
              <Button
                key={reason}
                variant="secondary"
                disabled={add.isPending}
                onClick={() =>
                  void run(
                    async () =>
                      (
                        await add.mutateAsync({
                          input: { phone: customer.phone, reason, note: note.trim() || null },
                        })
                      ).blocklistAdd,
                  )
                }
              >
                {t(`customer.reason.${reason}` as MessageKey)}
              </Button>
            ))}
          </div>
          <Button variant="tertiary" className="self-start" onClick={() => setChoosing(false)}>
            {t('action.back')}
          </Button>
        </div>
      ) : (
        <Button
          variant="danger"
          className="self-start"
          icon={<Ban aria-hidden className="size-5" />}
          onClick={() => setChoosing(true)}
        >
          {t('customer.block')}
        </Button>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </FormSection>
  );
}

/**
 * A customer's page (CUS-01): how to reach them, how their orders went, which of them are open,
 * where they have had things delivered, and the shop's note and tags; owners and managers block
 * their number from it.
 */
export function CustomerPage() {
  const { t, locale } = useLocale();
  const shop = useShop();
  const { customerId } = useParams({ from: '/$shopId/customers/$customerId' });
  // On a phone, how to reach them comes first; beside their record on a wider screen.
  const wide = useWide();
  const query = useAdminQuery<CustomerData>(['customer', customerId], CustomerQuery, {
    id: customerId,
  });

  const back = (
    <Link
      to="/$shopId/customers"
      params={{ shopId: shop.id }}
      className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
    >
      <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
      {t('customers.title')}
    </Link>
  );

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const { customer, shop: details } = query.data;
  if (!customer) {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        {back}
        <EmptyState title={t('customer.notFound')} />
      </div>
    );
  }
  const edits = EDITS_CUSTOMERS.includes(shop.role);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 pb-8">
      {back}
      <header className="flex flex-col gap-1">
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold" dir="auto">
          {customer.displayName}
        </h1>
        <p className="text-secondary">
          {t('customer.since', { date: formatDate(customer.createdAt, details.timezone, locale) })}
        </p>
      </header>
      <div className="grid gap-4 md:grid-cols-[2fr_1fr] md:items-start">
        <div className="flex flex-col gap-4">
          {!wide && <Contact customer={customer} />}
          <Record customer={customer} />
          <Orders customer={customer} timezone={details.timezone} />
          {customer.addresses.length > 0 && (
            <FormSection title={t('customer.addresses')}>
              <ul className="flex flex-col gap-2">
                {customer.addresses.map((address, index) => (
                  <li key={index}>
                    <Card className="p-3">
                      <address className="not-italic" dir="auto">
                        {address.formatted.join(', ')}
                      </address>
                    </Card>
                  </li>
                ))}
              </ul>
            </FormSection>
          )}
        </div>
        <div className="flex flex-col gap-4">
          {wide && <Contact customer={customer} />}
          <NoteAndTags customer={customer} edits={edits} />
          {edits && <Blocklist customer={customer} timezone={details.timezone} />}
        </div>
      </div>
    </div>
  );
}
