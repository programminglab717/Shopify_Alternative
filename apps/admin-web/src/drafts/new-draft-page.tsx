import { useNavigate } from '@tanstack/react-router';
import { Minus, Plus, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { DraftOrderCreateMutation, DraftVariantsQuery } from '../api/operations';
import type { DraftSource, DraftVariantsData, MoneyValue, UserError } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection, priceText, TextArea } from '../products/product-form';
import { CheckField, Pair, Problems, SelectField, settingProblem } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { TextField } from '../ui/field';

interface Line {
  variantId: string;
  title: string;
  price: MoneyValue;
  /** The price agreed in the chat, as typed; the variant's own when left as it is. */
  agreed: string;
  quantity: number;
}

const SOURCES: readonly DraftSource[] = ['WHATSAPP', 'INSTAGRAM', 'FACEBOOK', 'MANUAL'];

const LABELS: Partial<Record<string, MessageKey>> = {
  lineItems: 'drafts.items.title',
  shippingPrice: 'drafts.delivery',
  discount: 'drafts.discount',
  shippingAddress: 'drafts.address',
  phone: 'drafts.phone',
  city: 'drafts.city',
  address1: 'drafts.address1',
  name: 'drafts.name',
};

/** Finding products by words, to add their variants to the draft. */
function ProductPicker({ onAdd }: { onAdd: (line: Omit<Line, 'quantity'>) => void }) {
  const { t } = useLocale();
  const [words, setWords] = useState('');
  const [searched, setSearched] = useState<string | null>(null);
  const query = useAdminQuery<DraftVariantsData>(
    ['draftVariants', searched],
    DraftVariantsQuery,
    { query: searched },
    { enabled: searched !== null },
  );

  // A search box, not a form: it sits inside the draft's own form.
  const onSearch = () => setSearched(words.trim());

  return (
    <div className="flex flex-col gap-3">
      <div role="search" className="flex gap-2">
        <input
          type="search"
          value={words}
          onChange={(event) => setWords(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            onSearch();
          }}
          aria-label={t('drafts.findProducts')}
          placeholder={t('drafts.findProducts')}
          className="min-h-12 min-w-0 flex-1 rounded-control border border-line bg-surface px-3 md:min-h-10"
        />
        <Button
          variant="secondary"
          icon={<Search aria-hidden className="size-5" />}
          onClick={onSearch}
        >
          {t('drafts.find')}
        </Button>
      </div>
      {query.data && (
        <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
          {query.data.products.nodes.length === 0 && (
            <li className="px-3 py-2 text-secondary">{t('drafts.noProducts')}</li>
          )}
          {query.data.products.nodes.flatMap((product) =>
            product.variants.map((variant) => {
              const title =
                product.variants.length > 1 ? `${product.title} · ${variant.title}` : product.title;
              return (
                <li key={variant.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span dir="auto">{title}</span>
                    <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                      <span className="num">{formatMoney(variant.price.amount)}</span> ·{' '}
                      {variant.availableForSale
                        ? t('drafts.inStock', { count: variant.inventoryQuantity })
                        : t('drafts.outOfStock')}
                    </span>
                  </span>
                  <Button
                    variant="tertiary"
                    icon={<Plus aria-hidden className="size-5" />}
                    aria-label={t('drafts.add', { title })}
                    onClick={() =>
                      onAdd({
                        variantId: variant.id,
                        title,
                        price: variant.price,
                        agreed: priceText(variant.price.amount),
                      })
                    }
                  >
                    {t('drafts.addShort')}
                  </Button>
                </li>
              );
            }),
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * A new draft order (ORD-03): what the customer picked in the chat or on the call, at the prices
 * agreed; where the conversation was, how they pay, the delivery charge and anything off; their
 * address where staff have it, or else the link asks them for it.
 */
export function NewDraftPage() {
  const { t } = useLocale();
  const shopId = useShop().id;
  const navigate = useNavigate();
  const create = useAdminMutation<
    { draftOrderCreate: { draftOrder: { id: string } | null; userErrors: UserError[] } },
    { input: Record<string, unknown> }
  >(DraftOrderCreateMutation);
  const [lines, setLines] = useState<Line[]>([]);
  const [source, setSource] = useState<DraftSource>('WHATSAPP');
  const [payment, setPayment] = useState<'CASH_ON_DELIVERY' | 'BANK_TRANSFER'>('CASH_ON_DELIVERY');
  const [delivery, setDelivery] = useState('');
  const [discount, setDiscount] = useState('');
  const [note, setNote] = useState('');
  const [hasAddress, setHasAddress] = useState(false);
  const [address, setAddress] = useState({ name: '', phone: '', city: '', address1: '' });
  const [problems, setProblems] = useState<string[]>([]);

  const add = (line: Omit<Line, 'quantity'>) =>
    setLines((now) =>
      now.some((each) => each.variantId === line.variantId)
        ? now.map((each) =>
            each.variantId === line.variantId ? { ...each, quantity: each.quantity + 1 } : each,
          )
        : [...now, { ...line, quantity: 1 }],
    );
  const change = (variantId: string, next: Partial<Line> | null) =>
    setLines((now) =>
      next === null
        ? now.filter((each) => each.variantId !== variantId)
        : now.map((each) => (each.variantId === variantId ? { ...each, ...next } : each)),
    );

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (lines.length === 0) {
      setProblems([t('drafts.noLines')]);
      return;
    }
    setProblems([]);
    try {
      const { draftOrderCreate } = await create.mutateAsync({
        input: {
          lineItems: lines.map((line) => ({
            variantId: line.variantId,
            quantity: line.quantity,
            ...(line.agreed.trim() &&
              line.agreed.trim() !== priceText(line.price.amount) && {
                price: line.agreed.trim(),
              }),
          })),
          source,
          paymentMethod: payment,
          ...(delivery.trim() && { shippingPrice: delivery.trim() }),
          ...(discount.trim() && { discount: discount.trim() }),
          ...(note.trim() && { note: note.trim() }),
          ...(hasAddress && {
            shippingAddress: {
              name: address.name.trim(),
              phone: address.phone.trim(),
              city: address.city.trim(),
              address1: address.address1.trim(),
            },
          }),
        },
      });
      const made = draftOrderCreate.draftOrder;
      if (draftOrderCreate.userErrors.length > 0 || !made) {
        setProblems(draftOrderCreate.userErrors.map((error) => settingProblem(error, t, LABELS)));
        return;
      }
      await navigate({ to: '/$shopId/drafts/$draftId', params: { shopId, draftId: made.id } });
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  return (
    <form
      onSubmit={(event) => void onSubmit(event)}
      className="mx-auto flex max-w-3xl flex-col gap-4 pb-8"
    >
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('drafts.new')}
      </h1>
      <FormSection title={t('drafts.items.title')}>
        <ProductPicker onAdd={add} />
        {lines.length > 0 && (
          <ul className="flex flex-col divide-y divide-line">
            {lines.map((line) => (
              <li key={line.variantId} className="flex flex-col gap-2 py-3">
                <div className="flex items-start justify-between gap-2">
                  <span dir="auto" className="font-medium">
                    {line.title}
                  </span>
                  <Button
                    variant="danger"
                    aria-label={t('drafts.remove', { title: line.title })}
                    icon={<Trash2 aria-hidden className="size-5" />}
                    onClick={() => change(line.variantId, null)}
                  />
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex items-center gap-1">
                    <Button
                      variant="secondary"
                      aria-label={t('drafts.fewer', { title: line.title })}
                      disabled={line.quantity <= 1}
                      icon={<Minus aria-hidden className="size-5" />}
                      onClick={() => change(line.variantId, { quantity: line.quantity - 1 })}
                    />
                    <span className="num min-w-10 text-center" aria-live="polite">
                      {line.quantity}
                    </span>
                    <Button
                      variant="secondary"
                      aria-label={t('drafts.more', { title: line.title })}
                      icon={<Plus aria-hidden className="size-5" />}
                      onClick={() => change(line.variantId, { quantity: line.quantity + 1 })}
                    />
                  </div>
                  <TextField
                    label={t('drafts.price', { title: line.title })}
                    inputMode="decimal"
                    ltr
                    className="w-36"
                    value={line.agreed}
                    onChange={(event) => change(line.variantId, { agreed: event.target.value })}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </FormSection>
      <FormSection title={t('drafts.terms')}>
        <Pair>
          <SelectField
            label={t('drafts.source')}
            value={source}
            options={SOURCES.map((each) => ({
              value: each,
              label: t(`drafts.source.${each}` as MessageKey),
            }))}
            onChange={setSource}
          />
          <SelectField
            label={t('drafts.payment')}
            value={payment}
            options={[
              { value: 'CASH_ON_DELIVERY', label: t('drafts.payment.CASH_ON_DELIVERY') },
              { value: 'BANK_TRANSFER', label: t('drafts.payment.BANK_TRANSFER') },
            ]}
            onChange={setPayment}
          />
        </Pair>
        <Pair>
          <TextField
            label={t('drafts.delivery')}
            hint={t('drafts.deliveryHint')}
            inputMode="decimal"
            ltr
            value={delivery}
            onChange={(event) => setDelivery(event.target.value)}
          />
          <TextField
            label={t('drafts.discount')}
            hint={t('drafts.discountHint')}
            inputMode="decimal"
            ltr
            value={discount}
            onChange={(event) => setDiscount(event.target.value)}
          />
        </Pair>
        <TextArea label={t('drafts.note')} value={note} onChange={setNote} />
      </FormSection>
      <FormSection title={t('drafts.address')} hint={t('drafts.addressHint')}>
        <CheckField label={t('drafts.haveAddress')} checked={hasAddress} onChange={setHasAddress} />
        {hasAddress && (
          <>
            <Pair>
              <TextField
                label={t('drafts.name')}
                required
                dir="auto"
                value={address.name}
                onChange={(event) => setAddress({ ...address, name: event.target.value })}
              />
              <TextField
                label={t('drafts.phone')}
                required
                type="tel"
                inputMode="tel"
                placeholder="0300 1234567"
                ltr
                value={address.phone}
                onChange={(event) => setAddress({ ...address, phone: event.target.value })}
              />
            </Pair>
            <TextField
              label={t('drafts.city')}
              required
              dir="auto"
              value={address.city}
              onChange={(event) => setAddress({ ...address, city: event.target.value })}
            />
            <TextField
              label={t('drafts.address1')}
              required
              dir="auto"
              value={address.address1}
              onChange={(event) => setAddress({ ...address, address1: event.target.value })}
            />
          </>
        )}
      </FormSection>
      <Problems problems={problems} />
      <Button type="submit" busy={create.isPending} className="self-start">
        {t('drafts.create')}
      </Button>
    </form>
  );
}
