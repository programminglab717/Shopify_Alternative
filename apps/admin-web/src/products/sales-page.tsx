import {
  BadgePercent,
  CalendarClock,
  CircleCheck,
  CircleOff,
  Plus,
  Tag,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import type { OrderStage } from '@hatti/tokens';
import {
  PriceSaleCancelMutation,
  PriceSaleCreateMutation,
  PriceSalesQuery,
} from '../api/operations';
import type {
  PriceSale,
  PriceSaleCancelData,
  PriceSaleCreateData,
  PriceSaleCreateInput,
  PriceSalesData,
  PriceSaleStatus,
  UserError,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatDateTime } from '../i18n/format';
import { useLocale, type Translate } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { ProductFinder } from '../online-store/link-page';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { FormSection } from './product-form';
import { EDITS_PRODUCTS } from './status';

/** Most products one sale takes (ADR-443). */
export const MOST_ON_SALE = 250;

const STATUS: Record<PriceSaleStatus, { colour: OrderStage; icon: LucideIcon }> = {
  SCHEDULED: { colour: 'confirmed', icon: CalendarClock },
  RUNNING: { colour: 'delivered', icon: BadgePercent },
  ENDED: { colour: 'returned', icon: CircleCheck },
  CANCELLED: { colour: 'cancelled', icon: CircleOff },
};

const FIELDS: Record<string, MessageKey> = {
  name: 'sales.name',
  percentOff: 'sales.percentOff',
  startsAt: 'sales.startsAt',
  endsAt: 'sales.endsAt',
  productIds: 'sales.products',
};

interface OnSale {
  id: string;
  title: string;
}

/** The core's words for a problem, its field or product named (ADR-443). */
function saleProblem(error: UserError, products: readonly OnSale[], t: Translate): string {
  const [field, index] = error.field ?? [];
  const product = field === 'productIds' && index !== undefined ? products[Number(index)] : null;
  if (product) return `${product.title}: ${error.message}`;
  const named = field ? FIELDS[field] : undefined;
  return named ? `${t(named)}: ${error.message}` : error.message;
}

/** A sale set ahead: its name, how much off, from when to when, and its products. */
function NewSale() {
  const { t } = useLocale();
  const create = useAdminMutation<PriceSaleCreateData, { input: PriceSaleCreateInput }>(
    PriceSaleCreateMutation,
  );
  const [name, setName] = useState('');
  const [percent, setPercent] = useState('');
  const [starts, setStarts] = useState('');
  const [ends, setEnds] = useState('');
  const [products, setProducts] = useState<OnSale[]>([]);
  const [picking, setPicking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const ready =
    name.trim() !== '' && percent !== '' && starts !== '' && ends !== '' && products.length > 0;

  const onAdd = (id: string, title: string) => {
    if (products.some((each) => each.id === id)) setNote(t('sales.already', { title }));
    else if (products.length >= MOST_ON_SALE) setNote(t('sales.most', { most: MOST_ON_SALE }));
    else {
      setNote(null);
      setProducts([...products, { id, title }]);
    }
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setProblem(null);
    setMade(null);
    try {
      const { priceSaleCreate } = await create.mutateAsync({
        input: {
          name: name.trim(),
          percentOff: Number(percent),
          startsAt: new Date(starts).toISOString(),
          endsAt: new Date(ends).toISOString(),
          productIds: products.map((each) => each.id),
        },
      });
      const error = priceSaleCreate.userErrors[0];
      if (error) {
        setProblem(saleProblem(error, products, t));
        return;
      }
      setMade(priceSaleCreate.priceSale?.name ?? name.trim());
      setName('');
      setPercent('');
      setStarts('');
      setEnds('');
      setProducts([]);
      setPicking(false);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <FormSection title={t('sales.new')} hint={t('sales.newHint')}>
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
        <TextField
          label={t('sales.name')}
          hint={t('sales.nameHint')}
          required
          dir="auto"
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <TextField
          label={t('sales.percentOff')}
          hint={t('sales.percentOffHint')}
          type="number"
          inputMode="numeric"
          ltr
          required
          min={1}
          max={90}
          step={1}
          value={percent}
          onChange={(event) => setPercent(event.target.value)}
        />
        <div className="grid gap-3 md:grid-cols-2">
          <TextField
            label={t('sales.startsAt')}
            hint={t('sales.startsAtHint')}
            type="datetime-local"
            ltr
            required
            value={starts}
            onChange={(event) => setStarts(event.target.value)}
          />
          <TextField
            label={t('sales.endsAt')}
            hint={t('sales.endsAtHint')}
            type="datetime-local"
            ltr
            required
            value={ends}
            onChange={(event) => setEnds(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-2">
          <span className="font-medium">{t('sales.products')}</span>
          {products.length === 0 ? (
            <p className="text-secondary">{t('sales.noProducts')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
              {products.map((each, index) => (
                <li key={each.id} className="flex items-center gap-1 px-3 py-2">
                  <span className="min-w-0 flex-1" dir="auto">
                    {each.title}
                  </span>
                  <Button
                    variant="tertiary"
                    aria-label={t('sales.remove', { title: each.title })}
                    icon={<Trash2 aria-hidden className="size-5" />}
                    onClick={() => setProducts(products.filter((_, at) => at !== index))}
                  />
                </li>
              ))}
            </ul>
          )}
          {picking ? (
            <ProductFinder onAdd={onAdd} note={note} />
          ) : (
            <Button
              variant="secondary"
              className="self-start"
              icon={<Plus aria-hidden className="size-5" />}
              onClick={() => setPicking(true)}
            >
              {t('sales.add')}
            </Button>
          )}
        </div>
        {problem && <Alert tone="danger">{problem}</Alert>}
        {made && <Alert tone="success">{t('sales.made', { name: made })}</Alert>}
        <Button
          type="submit"
          className="self-start"
          busy={create.isPending}
          disabled={!ready}
          icon={<BadgePercent aria-hidden className="size-5" />}
        >
          {t('sales.create')}
        </Button>
      </form>
    </FormSection>
  );
}

/** A sale as the list shows it, cancelled ahead or ended early by those who change products. */
function SaleCard({ sale, edits }: { sale: PriceSale; edits: boolean }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const cancel = useAdminMutation<PriceSaleCancelData, { id: string }>(PriceSaleCancelMutation);
  const [problem, setProblem] = useState<string | null>(null);
  const when = (iso: string) => formatDateTime(iso, timezone, locale);
  const { colour, icon } = STATUS[sale.status];

  const onCancel = async () => {
    setProblem(null);
    try {
      const { priceSaleCancel } = await cancel.mutateAsync({ id: sale.id });
      const error = priceSaleCancel.userErrors[0];
      if (error) setProblem(error.message);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 font-medium" dir="auto">
          {sale.name}
        </span>
        <Badge colour={colour} icon={icon} label={t(`sales.status.${sale.status}` as MessageKey)} />
      </div>
      <span className="text-secondary">
        {t('sales.summary', { percent: sale.percentOff, count: sale.productsCount })}
      </span>
      <span className="text-secondary">
        {t('sales.when', { start: when(sale.startsAt), end: when(sale.endsAt) })}
      </span>
      {sale.endedAt && sale.status === 'ENDED' && (
        <span className="text-secondary">{t('sales.endedAt', { date: when(sale.endedAt) })}</span>
      )}
      {sale.products.length > 0 && (
        <span className="text-secondary" dir="auto">
          {sale.products.map((product) => product.title).join(', ')}
        </span>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
      {edits && (sale.status === 'SCHEDULED' || sale.status === 'RUNNING') && (
        <Button
          variant="secondary"
          className="self-start"
          busy={cancel.isPending}
          onClick={() => void onCancel()}
        >
          {t(sale.status === 'SCHEDULED' ? 'sales.cancel' : 'sales.endNow')}
        </Button>
      )}
    </Card>
  );
}

/**
 * Sales set ahead (CAT-17, ADR-443): a percentage off chosen products from a time to a time, their
 * prices cut when it starts and put back when it ends. Owners and managers set and cancel them;
 * others read them.
 */
export function SalesPage() {
  const { t } = useLocale();
  const shop = useShop();
  const query = useAdminQuery<PriceSalesData>(['priceSales'], PriceSalesQuery);
  const edits = EDITS_PRODUCTS.includes(shop.role);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <Tag aria-hidden className="size-7 text-secondary" />
        {t('sales.title')}
      </h1>
      <p className="text-secondary">{t('sales.intro')}</p>
      {edits && <NewSale />}
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : query.data.priceSales.length === 0 ? (
        <EmptyState title={t('sales.none')} body={t('sales.noneHint')} />
      ) : (
        <ul className="flex flex-col gap-3">
          {query.data.priceSales.map((sale) => (
            <li key={sale.id}>
              <SaleCard sale={sale} edits={edits} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
