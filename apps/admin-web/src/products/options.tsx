import { Plus, Save, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  ProductOptionsCreateMutation,
  ProductOptionsDeleteMutation,
  ProductOptionUpdateMutation,
  ProductVariantsBulkCreateMutation,
  ProductVariantsBulkDeleteMutation,
} from '../api/operations';
import type { ProductDetail, UserError } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { CheckField, parseList, SelectField } from '../settings/settings-form';
import { useAdminMutation } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';
import { FormSection, parsePrice, problemText } from './product-form';

type Option = ProductDetail['options'][number];
type Payload = Record<string, { userErrors: UserError[] }>;

/** The most options a product has, as Shopify allows. */
const MOST_OPTIONS = 3;

/** Runs a change and says what went wrong, the core's words or the network's. */
function useChange() {
  const { t } = useLocale();
  const [problem, setProblem] = useState<string | null>(null);
  const change = async (run: () => Promise<Payload>): Promise<boolean> => {
    setProblem(null);
    try {
      const answer = Object.values(await run())[0]!;
      const error = answer.userErrors[0];
      if (error) {
        setProblem(problemText(error, t));
        return false;
      }
      return true;
    } catch (failure) {
      setProblem(errorText(failure, t));
      return false;
    }
  };
  return { problem, change };
}

/** One option: renamed, its values added and deleted, or taken away. */
function OptionRow({ productId, option }: { productId: string; option: Option }) {
  const { t } = useLocale();
  const update = useAdminMutation<Payload, Record<string, unknown>>(ProductOptionUpdateMutation);
  const remove = useAdminMutation<Payload, { productId: string; options: string[] }>(
    ProductOptionsDeleteMutation,
  );
  const { problem, change } = useChange();
  const [name, setName] = useState(option.name);
  const [value, setValue] = useState('');
  const [asking, setAsking] = useState(false);

  const send = (extra: Record<string, unknown>) =>
    change(() => update.mutateAsync({ productId, option: { id: option.id }, ...extra }));

  return (
    <li className="flex flex-col gap-3 rounded-control border border-line p-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (name.trim() && name.trim() !== option.name) {
            void change(() =>
              update.mutateAsync({ productId, option: { id: option.id, name: name.trim() } }),
            );
          }
        }}
      >
        <TextField
          label={t('options.nameOf', { name: option.name })}
          dir="auto"
          className="min-w-40 flex-1"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Button
          type="submit"
          variant="secondary"
          disabled={!name.trim() || name.trim() === option.name}
          busy={update.isPending}
          icon={<Save aria-hidden className="size-5" />}
        >
          {t('options.rename')}
        </Button>
      </form>
      <ul
        className="flex flex-wrap gap-2"
        aria-label={t('options.valuesOf', { name: option.name })}
      >
        {option.optionValues.map((each) => (
          <li
            key={each.id}
            className="inline-flex min-h-10 items-center gap-1 rounded-full border border-line ps-3"
          >
            <span dir="auto">{each.name}</span>
            <button
              type="button"
              aria-label={t('options.removeValue', { value: each.name })}
              onClick={() => void send({ optionValuesToDelete: [each.id] })}
              className="inline-flex size-10 items-center justify-center rounded-full text-secondary hover:text-danger"
            >
              <X aria-hidden className="size-4" />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          const values = parseList(value);
          if (values.length === 0) return;
          void send({ optionValuesToAdd: values }).then((ok) => ok && setValue(''));
        }}
      >
        <TextField
          label={t('options.addValues', { name: option.name })}
          hint={t('options.addValuesHint')}
          dir="auto"
          className="min-w-40 flex-1"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button type="submit" variant="secondary" icon={<Plus aria-hidden className="size-5" />}>
          {t('options.add')}
        </Button>
      </form>
      {asking ? (
        <Alert tone="warning">
          <p>{t('options.deleteAsk', { name: option.name })}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="destructive"
              busy={remove.isPending}
              onClick={() =>
                void change(() => remove.mutateAsync({ productId, options: [option.id] })).then(
                  () => setAsking(false),
                )
              }
            >
              {t('options.deleteSure')}
            </Button>
            <Button variant="secondary" onClick={() => setAsking(false)}>
              {t('options.keep')}
            </Button>
          </div>
        </Alert>
      ) : (
        <Button
          variant="danger"
          className="self-start"
          icon={<Trash2 aria-hidden className="size-5" />}
          onClick={() => setAsking(true)}
        >
          {t('options.delete', { name: option.name })}
        </Button>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </li>
  );
}

/** A new option with its values, and a variant for each new combination if asked. */
function AddOption({ productId }: { productId: string }) {
  const { t } = useLocale();
  const create = useAdminMutation<Payload, Record<string, unknown>>(ProductOptionsCreateMutation);
  const { problem, change } = useChange();
  const [name, setName] = useState('');
  const [values, setValues] = useState('');
  const [everyCombination, setEveryCombination] = useState(true);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const list = parseList(values);
    if (!name.trim() || list.length === 0) return;
    void change(() =>
      create.mutateAsync({
        productId,
        options: [{ name: name.trim(), values: list }],
        variantStrategy: everyCombination ? 'CREATE' : 'LEAVE_AS_IS',
      }),
    ).then((ok) => {
      if (ok) {
        setName('');
        setValues('');
      }
    });
  };

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-3 rounded-control border border-line p-3"
    >
      <h3 className="font-semibold">{t('options.addOption')}</h3>
      <TextField
        label={t('options.optionName')}
        hint={t('options.optionNameHint')}
        dir="auto"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <TextField
        label={t('options.optionValues')}
        hint={t('options.addValuesHint')}
        dir="auto"
        value={values}
        onChange={(event) => setValues(event.target.value)}
      />
      <CheckField
        label={t('options.everyCombination')}
        hint={t('options.everyCombinationHint')}
        checked={everyCombination}
        onChange={setEveryCombination}
      />
      {problem && <Alert tone="danger">{problem}</Alert>}
      <Button
        type="submit"
        className="self-start"
        busy={create.isPending}
        disabled={!name.trim() || parseList(values).length === 0}
        icon={<Plus aria-hidden className="size-5" />}
      >
        {t('options.addOptionSubmit')}
      </Button>
    </form>
  );
}

/** The product's variants: one more for a combination it lacks, or one deleted, one kept. */
function Variants({ product }: { product: ProductDetail }) {
  const { t } = useLocale();
  const create = useAdminMutation<Payload, Record<string, unknown>>(
    ProductVariantsBulkCreateMutation,
  );
  const remove = useAdminMutation<Payload, { productId: string; variantsIds: string[] }>(
    ProductVariantsBulkDeleteMutation,
  );
  const { problem, change } = useChange();
  const [chosen, setChosen] = useState<string[]>(() =>
    product.options.map((option) => option.optionValues[0]?.name ?? ''),
  );
  const [price, setPrice] = useState('');
  const [asking, setAsking] = useState<string | null>(null);
  const taken = new Set(
    product.variants.map((variant) =>
      variant.selectedOptions.map((selected) => selected.value).join(' / '),
    ),
  );
  const exists = taken.has(chosen.join(' / '));

  const onAdd = (event: FormEvent) => {
    event.preventDefault();
    const amount = parsePrice(price);
    if (amount === null || exists) return;
    void change(() =>
      create.mutateAsync({
        productId: product.id,
        variants: [{ optionValues: chosen, price: amount }],
      }),
    ).then((ok) => ok && setPrice(''));
  };

  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-semibold">{t('options.variants')}</h3>
      <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
        {product.variants.map((variant) => (
          <li
            key={variant.id}
            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
          >
            <span dir="auto">{variant.title}</span>
            {product.variants.length > 1 &&
              (asking === variant.id ? (
                <span className="flex flex-wrap gap-2">
                  <Button
                    variant="destructive"
                    busy={remove.isPending}
                    onClick={() =>
                      void change(() =>
                        remove.mutateAsync({ productId: product.id, variantsIds: [variant.id] }),
                      ).then(() => setAsking(null))
                    }
                  >
                    {t('options.deleteVariantSure')}
                  </Button>
                  <Button variant="secondary" onClick={() => setAsking(null)}>
                    {t('options.keep')}
                  </Button>
                </span>
              ) : (
                <Button
                  variant="danger"
                  aria-label={t('options.deleteVariant', { title: variant.title })}
                  icon={<Trash2 aria-hidden className="size-5" />}
                  onClick={() => setAsking(variant.id)}
                />
              ))}
          </li>
        ))}
      </ul>
      {product.options.length > 0 && (
        <form onSubmit={onAdd} className="flex flex-wrap items-end gap-2">
          {product.options.map((option, index) => (
            <div key={option.id} className="min-w-32 flex-1">
              <SelectField
                label={option.name}
                value={chosen[index] ?? ''}
                options={option.optionValues.map((each) => ({
                  value: each.name,
                  label: each.name,
                }))}
                onChange={(next) =>
                  setChosen((all) => all.map((each, at) => (at === index ? next : each)))
                }
              />
            </div>
          ))}
          <TextField
            label={t('options.price')}
            inputMode="decimal"
            ltr
            className="w-32"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
          />
          <Button
            type="submit"
            variant="secondary"
            busy={create.isPending}
            disabled={exists || parsePrice(price) === null}
            icon={<Plus aria-hidden className="size-5" />}
          >
            {t('options.addVariant')}
          </Button>
        </form>
      )}
      {exists && product.options.length > 0 && (
        <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('options.variantExists', { title: chosen.join(' / ') })}
        </p>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </div>
  );
}

/**
 * A product's options and variants after it was made (CAT-01): its options renamed, their values
 * added and deleted where no variant uses them, an option added, with a variant for every new
 * combination if asked, or taken away where its variants would then be the same; and variants
 * added for combinations it lacks, or deleted, one always kept. Prices, SKUs and stock stay in
 * the fields above.
 */
export function ProductOptions({ product }: { product: ProductDetail }) {
  const { t } = useLocale();
  return (
    <FormSection title={t('options.title')} hint={t('options.hint')}>
      {product.options.length > 0 && (
        <ol className="flex flex-col gap-3">
          {product.options.map((option) => (
            <OptionRow key={`${option.id}-${option.name}`} productId={product.id} option={option} />
          ))}
        </ol>
      )}
      {product.options.length < MOST_OPTIONS && <AddOption productId={product.id} />}
      {/* Chosen afresh when its variants or options change. */}
      <Variants
        key={[
          ...product.variants.map((variant) => variant.id),
          ...product.options.map((option) => option.optionValues.map((each) => each.id).join()),
        ].join('|')}
        product={product}
      />
    </FormSection>
  );
}
