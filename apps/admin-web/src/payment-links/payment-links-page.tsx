import {
  CircleCheck,
  CircleOff,
  Copy,
  Link2,
  MessageCircle,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  PaymentLinkCreateMutation,
  PaymentLinksQuery,
  PaymentLinkUpdateMutation,
} from '../api/operations';
import type {
  PaymentLinkCreateData,
  PaymentLinksData,
  PaymentLinkUpdateData,
  PaymentLinkValue,
} from '../api/types';
import type { StaffRole } from '../auth/session';
import { ProductPicker } from '../drafts/new-draft-page';
import { errorText } from '../i18n/errors';
import { endOfDayIn, formatCount, formatDate, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { problemText } from '../products/product-form';
import { CheckField, Pair, Problems, settingProblem } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

/** Those who make and close payment links (PAY-04): owners and managers, as they sell. */
export const MAKES_PAYMENT_LINKS: readonly StaffRole[] = ['owner', 'manager'];

/** A link's items at most, as the core takes them. */
const MOST_ITEMS = 20;

const LABELS: Partial<Record<string, MessageKey>> = {
  title: 'links.titleLabel',
  items: 'links.items',
  discountCode: 'links.discount',
  usageLimit: 'links.limit',
  expiresAt: 'links.expires',
};

interface Item {
  variantId: string;
  title: string;
  price: string;
  quantity: string;
}

/** Why a link takes no orders now, in words: closed by staff, past its day, or used up. */
function closedWhy(link: PaymentLinkValue): MessageKey | null {
  if (link.open) return null;
  if (!link.active) return 'links.closedByStaff';
  if (link.usageLimit !== null && link.ordersPlaced >= link.usageLimit) return 'links.usedUp';
  return 'links.expired';
}

/** A WhatsApp chat to anyone, the link's title and address written in it. */
const whatsappOf = (link: PaymentLinkValue) =>
  `https://wa.me/?text=${encodeURIComponent(`${link.title}\n${link.url}`)}`;

function NewLinkForm({ onDone }: { onDone: (link: PaymentLinkValue) => void }) {
  const { t } = useLocale();
  const timezone = useShopTimezone();
  const create = useAdminMutation<PaymentLinkCreateData, { input: Record<string, unknown> }>(
    PaymentLinkCreateMutation,
  );
  const [title, setTitle] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [discount, setDiscount] = useState('');
  const [prepaid, setPrepaid] = useState(false);
  const [expires, setExpires] = useState('');
  const [limit, setLimit] = useState('');
  const [problems, setProblems] = useState<string[]>([]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const usageLimit = limit.trim() ? Number(limit.replace(/,/g, '')) : null;
    if (usageLimit !== null && !Number.isInteger(usageLimit)) {
      setProblems([`${t('links.limit')}: ${t('settings.badNumber')}`]);
      return;
    }
    if (items.length === 0) {
      setProblems([t('links.noItems')]);
      return;
    }
    setProblems([]);
    try {
      const { paymentLinkCreate } = await create.mutateAsync({
        input: {
          title: title.trim(),
          items: items.map((item) => ({
            variantId: item.variantId,
            quantity: Number(item.quantity) || 1,
          })),
          ...(discount.trim() && { discountCode: discount.trim() }),
          prepaidOnly: prepaid,
          ...(expires && { expiresAt: endOfDayIn(expires, timezone) }),
          ...(usageLimit !== null && { usageLimit }),
        },
      });
      if (paymentLinkCreate.userErrors.length > 0 || !paymentLinkCreate.paymentLink) {
        setProblems(
          paymentLinkCreate.userErrors.map((error) =>
            settingProblem(error, t, LABELS, (field) => {
              const at = field.indexOf('items');
              const index = Number(field[at + 1]);
              return at >= 0 && Number.isInteger(index)
                ? t('links.itemNumber', { number: index + 1 })
                : null;
            }),
          ),
        );
      } else onDone(paymentLinkCreate.paymentLink);
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  return (
    <Card className="p-4">
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
        <h2 className="font-semibold">{t('links.new')}</h2>
        <TextField
          label={t('links.titleLabel')}
          hint={t('links.titleHint')}
          required
          dir="auto"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <section aria-label={t('links.items')} className="flex flex-col gap-2">
          <h3 className="font-medium">{t('links.items')}</h3>
          {items.length > 0 && (
            <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
              {items.map((item, index) => (
                <li key={item.variantId} className="flex flex-wrap items-end gap-3 px-3 py-2">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span dir="auto">{item.title}</span>
                    <span className="num text-secondary">{formatMoney(item.price)}</span>
                  </span>
                  <TextField
                    label={t('links.quantity', { title: item.title })}
                    inputMode="numeric"
                    ltr
                    className="w-24"
                    value={item.quantity}
                    onChange={(event) =>
                      setItems((all) =>
                        all.map((each, at) =>
                          at === index ? { ...each, quantity: event.target.value } : each,
                        ),
                      )
                    }
                  />
                  <Button
                    variant="danger"
                    aria-label={t('links.removeItem', { title: item.title })}
                    icon={<Trash2 aria-hidden className="size-5" />}
                    onClick={() => setItems((all) => all.filter((_, at) => at !== index))}
                  />
                </li>
              ))}
            </ul>
          )}
          {items.length < MOST_ITEMS && (
            <ProductPicker
              onAdd={(picked) =>
                setItems((all) =>
                  all.some((each) => each.variantId === picked.variantId)
                    ? all.map((each) =>
                        each.variantId === picked.variantId
                          ? { ...each, quantity: String((Number(each.quantity) || 1) + 1) }
                          : each,
                      )
                    : [
                        ...all,
                        {
                          variantId: picked.variantId,
                          title: picked.title,
                          price: picked.price.amount,
                          quantity: '1',
                        },
                      ],
                )
              }
            />
          )}
        </section>
        <Pair>
          <TextField
            label={t('links.discount')}
            hint={t('links.discountHint')}
            autoCapitalize="characters"
            spellCheck={false}
            ltr
            value={discount}
            onChange={(event) => setDiscount(event.target.value.toUpperCase())}
          />
          <TextField
            label={t('links.limit')}
            hint={t('links.limitHint')}
            inputMode="numeric"
            ltr
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
          />
        </Pair>
        <TextField
          label={t('links.expires')}
          hint={t('links.expiresHint')}
          type="date"
          ltr
          value={expires}
          onChange={(event) => setExpires(event.target.value)}
        />
        <CheckField
          label={t('links.prepaid')}
          hint={t('links.prepaidHint')}
          checked={prepaid}
          onChange={setPrepaid}
        />
        <Problems problems={problems} />
        <Button type="submit" busy={create.isPending} className="self-start">
          {t('links.create')}
        </Button>
      </form>
    </Card>
  );
}

/** Its address to copy or send on WhatsApp. */
function Share({ link }: { link: PaymentLinkValue }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="secondary"
        icon={<Copy aria-hidden className="size-5" />}
        onClick={() => void navigator.clipboard?.writeText(link.url).then(() => setCopied(true))}
      >
        {copied ? t('staff.copied') : t('staff.copy')}
      </Button>
      <a
        href={whatsappOf(link)}
        target="_blank"
        rel="noreferrer"
        className="inline-flex min-h-12 items-center gap-2 rounded-control border border-line bg-surface px-4 font-medium md:min-h-10"
      >
        <MessageCircle aria-hidden className="size-5" />
        {t('staff.sendOnWhatsApp')}
      </a>
    </div>
  );
}

function LinkRow({ link, edits }: { link: PaymentLinkValue; edits: boolean }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const update = useAdminMutation<
    PaymentLinkUpdateData,
    { id: string; input: { active: boolean } }
  >(PaymentLinkUpdateMutation);
  const [problem, setProblem] = useState<string | null>(null);
  const why = closedWhy(link);

  const setActive = async (active: boolean) => {
    setProblem(null);
    try {
      const { paymentLinkUpdate } = await update.mutateAsync({ id: link.id, input: { active } });
      const error = paymentLinkUpdate.userErrors[0];
      if (error) setProblem(problemText(error, t));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold" dir="auto">
          {link.title}
        </span>
        <span className="flex-1" />
        {why ? (
          <Badge colour="cancelled" icon={CircleOff} label={t(why)} />
        ) : (
          <Badge colour="delivered" icon={CircleCheck} label={t('links.open')} />
        )}
      </div>
      <p dir="auto">
        {link.items
          .map((item) =>
            t('links.itemLine', {
              quantity: formatCount(item.quantity),
              title: item.title ?? t('links.itemGone'),
            }),
          )
          .join(' · ')}
      </p>
      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {link.usageLimit === null
          ? t('links.orders', { count: formatCount(link.ordersPlaced) })
          : t('links.ordersOf', {
              count: formatCount(link.ordersPlaced),
              limit: formatCount(link.usageLimit),
            })}
        {link.discountCode && ` · ${t('links.withCode', { code: link.discountCode })}`}
        {link.prepaidOnly && ` · ${t('links.prepaidShort')}`}
        {link.expiresAt &&
          ` · ${t(Date.parse(link.expiresAt) > Date.now() ? 'links.closesOn' : 'links.closedOn', {
            date: formatDate(link.expiresAt, timezone, locale),
          })}`}
      </p>
      <code className="num break-all text-secondary" dir="ltr">
        {link.url}
      </code>
      <div className="flex flex-wrap gap-2">
        {link.open && <Share link={link} />}
        {edits &&
          (link.active ? (
            <Button
              variant="tertiary"
              icon={<CircleOff aria-hidden className="size-5" />}
              busy={update.isPending}
              onClick={() => void setActive(false)}
            >
              {t('links.close')}
            </Button>
          ) : (
            <Button
              variant="tertiary"
              icon={<RotateCcw aria-hidden className="size-5" />}
              busy={update.isPending}
              onClick={() => void setActive(true)}
            >
              {t('links.reopen')}
            </Button>
          ))}
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
    </li>
  );
}

/**
 * Payment links (PAY-04, ADR-248): one link a shop shares on WhatsApp or Instagram, each customer
 * who opens it getting a checkout of their own with its items, until it closes; what each sells,
 * how many orders it took, copied or sent on, closed and opened again. Owners and managers.
 */
export function PaymentLinksPage() {
  const { t } = useLocale();
  const { role } = useShop();
  const edits = MAKES_PAYMENT_LINKS.includes(role);
  const query = useAdminQuery<PaymentLinksData>(['paymentLinks'], PaymentLinksQuery, undefined, {
    enabled: edits,
  });
  const [making, setMaking] = useState(false);
  const [made, setMade] = useState<PaymentLinkValue | null>(null);

  if (!edits) return <EmptyState title={t('links.cannot')} />;
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const links = query.data.paymentLinks;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
          {t('links.title')}
        </h1>
        {!making && (
          <Button
            icon={<Plus aria-hidden className="size-5" />}
            onClick={() => {
              setMaking(true);
              setMade(null);
            }}
          >
            {t('links.new')}
          </Button>
        )}
      </div>
      {made && (
        <Alert tone="success">
          <div className="flex flex-col gap-2">
            <span>{t('links.made', { title: made.title })}</span>
            <code className="num break-all" dir="ltr">
              {made.url}
            </code>
            <Share link={made} />
          </div>
        </Alert>
      )}
      {making && (
        <NewLinkForm
          onDone={(link) => {
            setMaking(false);
            setMade(link);
          }}
        />
      )}
      {links.length === 0 ? (
        !making && (
          <Card>
            <EmptyState
              icon={<Link2 aria-hidden className="size-8 text-secondary" />}
              title={t('links.none')}
              body={t('links.noneBody')}
            />
          </Card>
        )
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {links.map((link) => (
              <LinkRow key={link.id} link={link} edits={edits} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
