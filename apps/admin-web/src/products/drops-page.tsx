import {
  CalendarClock,
  CircleCheck,
  Plus,
  Rocket,
  Timer,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import type { OrderStage } from '@hatti/tokens';
import { DropCreateMutation, DropDeleteMutation, DropsQuery } from '../api/operations';
import type {
  DropCreateData,
  DropDeleteData,
  DropInput,
  DropStatus,
  DropValue,
  DropsData,
  UserError,
} from '../api/types';
import { permits } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { formatDateTime } from '../i18n/format';
import { useLocale, type Translate } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { ProductFinder } from '../online-store/link-page';
import { CheckField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { FormSection } from './product-form';
import { EDITS_PRODUCTS } from './status';

/** Most products one drop takes (ADR-820). */
export const MOST_IN_DROP = 250;

const STATUS: Record<DropStatus, { colour: OrderStage; icon: LucideIcon }> = {
  SCHEDULED: { colour: 'confirmed', icon: CalendarClock },
  LIVE: { colour: 'delivered', icon: Rocket },
  ENDED: { colour: 'returned', icon: CircleCheck },
};

const FIELDS: Record<string, MessageKey> = {
  name: 'drops.name',
  startsAt: 'drops.startsAt',
  endsAt: 'drops.endsAt',
  productIds: 'drops.products',
  perCustomer: 'drops.perCustomer',
  admitPerMinute: 'drops.admitPerMinute',
};

interface InDrop {
  id: string;
  title: string;
}

/** The core's words for a problem, its field or product named. */
function dropProblem(error: UserError, products: readonly InDrop[], t: Translate): string {
  const [, field, index] = error.field ?? [];
  const product = field === 'productIds' && index !== undefined ? products[Number(index)] : null;
  if (product) return `${product.title}: ${error.message}`;
  const named = field ? FIELDS[field] : undefined;
  return named ? `${t(named)}: ${error.message}` : error.message;
}

/**
 * A drop scheduled (ADR-823): its name, from when to when, how many a customer may buy, its
 * waiting room's rate, and its products.
 */
function NewDrop() {
  const { t } = useLocale();
  const create = useAdminMutation<DropCreateData, { input: DropInput }>(DropCreateMutation);
  const [name, setName] = useState('');
  const [starts, setStarts] = useState('');
  const [ends, setEnds] = useState('');
  const [limit, setLimit] = useState('');
  const [room, setRoom] = useState(false);
  const [rate, setRate] = useState('500');
  const [products, setProducts] = useState<InDrop[]>([]);
  const [picking, setPicking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const ready = name.trim() !== '' && starts !== '' && ends !== '' && products.length > 0;

  const onAdd = (id: string, title: string) => {
    if (products.some((each) => each.id === id)) setNote(t('drops.already', { title }));
    else if (products.length >= MOST_IN_DROP) setNote(t('drops.most', { most: MOST_IN_DROP }));
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
      const { dropCreate } = await create.mutateAsync({
        input: {
          name: name.trim(),
          startsAt: new Date(starts).toISOString(),
          endsAt: new Date(ends).toISOString(),
          productIds: products.map((each) => each.id),
          perCustomerLimit: limit.trim() === '' ? null : Number(limit),
          admitPerMinute: room ? Number(rate) : null,
        },
      });
      const error = dropCreate.userErrors[0];
      if (error) {
        setProblem(dropProblem(error, products, t));
        return;
      }
      setMade(dropCreate.drop?.name ?? name.trim());
      setName('');
      setStarts('');
      setEnds('');
      setLimit('');
      setRoom(false);
      setProducts([]);
      setPicking(false);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <FormSection title={t('drops.new')} hint={t('drops.newHint')}>
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
        <TextField
          label={t('drops.name')}
          required
          dir="auto"
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <div className="grid gap-3 md:grid-cols-2">
          <TextField
            label={t('drops.startsAt')}
            hint={t('drops.startsAtHint')}
            type="datetime-local"
            ltr
            required
            value={starts}
            onChange={(event) => setStarts(event.target.value)}
          />
          <TextField
            label={t('drops.endsAt')}
            hint={t('drops.endsAtHint')}
            type="datetime-local"
            ltr
            required
            value={ends}
            onChange={(event) => setEnds(event.target.value)}
          />
        </div>
        <TextField
          label={t('drops.perCustomer')}
          hint={t('drops.perCustomerHint')}
          type="number"
          inputMode="numeric"
          ltr
          min={1}
          max={100}
          step={1}
          value={limit}
          onChange={(event) => setLimit(event.target.value)}
        />
        <CheckField label={t('drops.waitingRoom')} checked={room} onChange={setRoom} />
        {room && (
          <TextField
            label={t('drops.admitPerMinute')}
            hint={t('drops.admitPerMinuteHint')}
            type="number"
            inputMode="numeric"
            ltr
            required
            min={10}
            max={100000}
            step={1}
            value={rate}
            onChange={(event) => setRate(event.target.value)}
          />
        )}
        <div className="flex flex-col gap-2">
          <span className="font-medium">{t('drops.products')}</span>
          {products.length === 0 ? (
            <p className="text-secondary">{t('drops.noProducts')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
              {products.map((each, index) => (
                <li key={each.id} className="flex items-center gap-1 px-3 py-2">
                  <span className="min-w-0 flex-1" dir="auto">
                    {each.title}
                  </span>
                  <Button
                    variant="tertiary"
                    aria-label={t('drops.remove', { title: each.title })}
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
              {t('drops.add')}
            </Button>
          )}
        </div>
        {problem && <Alert tone="danger">{problem}</Alert>}
        {made && <Alert tone="success">{t('drops.made', { name: made })}</Alert>}
        <Button
          type="submit"
          className="self-start"
          busy={create.isPending}
          disabled={!ready}
          icon={<Rocket aria-hidden className="size-5" />}
        >
          {t('drops.create')}
        </Button>
      </form>
    </FormSection>
  );
}

/** A drop as the list shows it, deleted by those who change products. */
function DropCard({ drop, edits }: { drop: DropValue; edits: boolean }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const remove = useAdminMutation<DropDeleteData, { id: string }>(DropDeleteMutation);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const when = (iso: string) => formatDateTime(iso, timezone, locale);
  const { colour, icon } = STATUS[drop.status];

  const onDelete = async () => {
    setProblem(null);
    try {
      await remove.mutateAsync({ id: drop.id });
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 font-medium" dir="auto">
          {drop.name}
        </span>
        <Badge colour={colour} icon={icon} label={t(`drops.status.${drop.status}` as MessageKey)} />
      </div>
      <span className="text-secondary">
        {t('drops.when', { start: when(drop.startsAt), end: when(drop.endsAt) })}
      </span>
      <span className="text-secondary">
        {drop.perCustomerLimit === null
          ? t('drops.noLimit')
          : t('drops.limit', { count: drop.perCustomerLimit })}
        {' · '}
        {drop.admitPerMinute === null ? (
          t('drops.noRoom')
        ) : (
          <span className="inline-flex items-center gap-1">
            <Timer aria-hidden className="size-4" />
            {t('drops.room', { count: drop.admitPerMinute })}
          </span>
        )}
      </span>
      <span className="text-secondary" dir="auto">
        {drop.products.map((product) => product.title).join(', ')}
      </span>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {edits && drop.status !== 'ENDED' && !asking && (
        <Button variant="danger" className="self-start" onClick={() => setAsking(true)}>
          {t('drops.delete')}
        </Button>
      )}
      {asking && (
        <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
          <p>{t('drops.deleteAsk', { name: drop.name })}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" busy={remove.isPending} onClick={() => void onDelete()}>
              {t('drops.deleteYes')}
            </Button>
            <Button variant="secondary" onClick={() => setAsking(false)}>
              {t('drops.keep')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * Drops (INV-09, OS-17, ADR-823): products put on sale together at a time, selling to no one
 * before it, so many to a customer while it lasts, with a waiting room where the shop wants one.
 * Owners and managers schedule and delete them, on Pro; others read them.
 */
export function DropsPage() {
  const { t } = useLocale();
  const shop = useShop();
  const query = useAdminQuery<DropsData>(['drops'], DropsQuery);
  const edits = permits(shop, EDITS_PRODUCTS);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <Rocket aria-hidden className="size-7 text-secondary" />
        {t('drops.title')}
      </h1>
      <p className="text-secondary">{t('drops.intro')}</p>
      {edits && <NewDrop />}
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : query.data.drops.length === 0 ? (
        <EmptyState title={t('drops.none')} body={t('drops.noneHint')} />
      ) : (
        <ul className="flex flex-col gap-3">
          {query.data.drops.map((drop) => (
            <li key={drop.id}>
              <DropCard drop={drop} edits={edits} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
