import { useId } from 'react';
import type { ReactNode } from 'react';
import { ProductSuggestionsQuery } from '../api/operations';
import type { ProductStatus, ProductSuggestionsData, UserError } from '../api/types';
import { useLocale } from '../i18n/locale';
import type { Translate } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { useAdminQuery } from '../shell/shop-context';
import { Card } from '../ui/feedback';
import { TextField } from '../ui/field';
import { PRODUCT_STATUSES } from './status';

/** A product's own details as the form holds them; tags as the merchant types them. */
export interface DetailsState {
  title: string;
  description: string;
  status: ProductStatus;
  productType: string;
  vendor: string;
  tags: string;
}

export const EMPTY_DETAILS: DetailsState = {
  title: '',
  description: '',
  status: 'ACTIVE',
  productType: '',
  vendor: '',
  tags: '',
};

/** Tags typed with commas between them, each once. */
export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

/** The details as the API takes them: blanks left out of what may be blank. */
export function detailsInput(details: DetailsState) {
  return {
    title: details.title.trim(),
    description: details.description.trim(),
    status: details.status,
    productType: details.productType.trim() || null,
    vendor: details.vendor.trim() || null,
    tags: parseTags(details.tags),
  };
}

/** Rupees as merchants type them: whole or with paisa, commas allowed. */
export function parsePrice(text: string): string | null {
  const plain = text.replace(/,/g, '').trim();
  return /^\d{1,9}(\.\d{1,2})?$/.test(plain) ? plain : null;
}

/** A count of stock: a whole number, 0 or more. */
export function parseStock(text: string): number | null {
  const plain = text.replace(/,/g, '').trim();
  return /^\d{1,7}$/.test(plain) ? Number(plain) : null;
}

/** A price as the form shows it: whole rupees without their paisa. */
export function priceText(amount: string | undefined | null): string {
  if (!amount) return '';
  return amount.replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1');
}

const FIELDS: Record<string, MessageKey> = {
  title: 'product.titleLabel',
  description: 'product.description',
  productType: 'product.type',
  vendor: 'product.vendor',
  tags: 'product.tags',
  price: 'product.price',
  compareAtPrice: 'product.compareAt',
  sku: 'product.sku',
  options: 'product.options',
  values: 'product.optionValues',
  name: 'product.optionName',
  quantity: 'product.stock',
};

/** A problem the API found, with the field it is about in the merchant's words. */
export function problemText(error: UserError, t: Translate): string {
  const named = [...(error.field ?? [])].reverse().find((part) => part in FIELDS);
  return named ? `${t(FIELDS[named]!)}: ${error.message}` : error.message;
}

export function FormSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <Card className="p-4">
      <section aria-labelledby={id} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id={id} className="font-semibold">
            {title}
          </h2>
          {hint && <p className="text-secondary">{hint}</p>}
        </div>
        {children}
      </section>
    </Card>
  );
}

/** A labelled box of several lines, for a description or instructions. */
export function TextArea({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        rows={5}
        dir="auto"
        onChange={(event) => onChange(event.target.value)}
        className="rounded-control border border-line bg-surface px-3 py-2 text-text"
      />
    </div>
  );
}

/** Title and description, what shoppers read first. */
export function DetailsFields({
  details,
  onChange,
}: {
  details: DetailsState;
  onChange: (details: DetailsState) => void;
}) {
  const { t } = useLocale();
  return (
    <FormSection title={t('product.details')}>
      <TextField
        label={t('product.titleLabel')}
        value={details.title}
        required
        maxLength={255}
        dir="auto"
        placeholder={t('product.titleHint')}
        onChange={(event) => onChange({ ...details, title: event.target.value })}
      />
      <TextArea
        label={t('product.description')}
        value={details.description}
        onChange={(description) => onChange({ ...details, description })}
      />
    </FormSection>
  );
}

/** Whether shoppers see it: on sale, a draft, or put away. */
export function StatusChoice({
  status,
  onChange,
}: {
  status: ProductStatus;
  onChange: (status: ProductStatus) => void;
}) {
  const { t } = useLocale();
  const name = useId();
  return (
    <FormSection title={t('product.statusLabel')}>
      <div role="radiogroup" className="flex flex-col gap-2">
        {(Object.keys(PRODUCT_STATUSES) as ProductStatus[]).map((each) => (
          <label
            key={each}
            className={`flex cursor-pointer items-start gap-3 rounded-control border p-3 ${
              status === each ? 'border-primary' : 'border-line'
            }`}
          >
            <input
              type="radio"
              name={name}
              value={each}
              checked={status === each}
              onChange={() => onChange(each)}
              className="mt-1 size-5 accent-[var(--hatti-color-primary)]"
            />
            <span className="flex flex-col">
              <span className="font-medium">{t(PRODUCT_STATUSES[each].label)}</span>
              <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                {t(PRODUCT_STATUSES[each].hint)}
              </span>
            </span>
          </label>
        ))}
      </div>
    </FormSection>
  );
}

/** Type, vendor and tags, which collections and searches sort products by. */
export function OrganiseFields({
  details,
  onChange,
}: {
  details: DetailsState;
  onChange: (details: DetailsState) => void;
}) {
  const { t } = useLocale();
  const id = useId();
  // The types and vendors the shop already uses, offered as they are typed, so one is not written
  // two ways; a new one is typed as before.
  const suggestions = useAdminQuery<ProductSuggestionsData>(
    ['productSuggestions'],
    ProductSuggestionsQuery,
  );
  return (
    <FormSection title={t('product.organise')}>
      <TextField
        label={t('product.type')}
        value={details.productType}
        maxLength={255}
        dir="auto"
        list={`${id}-types`}
        autoComplete="off"
        placeholder={t('product.typeHint')}
        onChange={(event) => onChange({ ...details, productType: event.target.value })}
      />
      <datalist id={`${id}-types`}>
        {suggestions.data?.productTypes.map((each) => (
          <option key={each} value={each} />
        ))}
      </datalist>
      <TextField
        label={t('product.vendor')}
        value={details.vendor}
        maxLength={255}
        dir="auto"
        list={`${id}-vendors`}
        autoComplete="off"
        onChange={(event) => onChange({ ...details, vendor: event.target.value })}
      />
      <datalist id={`${id}-vendors`}>
        {suggestions.data?.productVendors.map((each) => (
          <option key={each} value={each} />
        ))}
      </datalist>
      <TextField
        label={t('product.tags')}
        hint={t('product.tagsHint')}
        value={details.tags}
        dir="auto"
        onChange={(event) => onChange({ ...details, tags: event.target.value })}
      />
    </FormSection>
  );
}

/** A small field in a variant's row, labelled for screen readers by the variant it is for. */
export function CellInput({
  label,
  value,
  onChange,
  invalid = false,
  numeric = false,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  numeric?: boolean;
  placeholder?: string;
}) {
  return (
    <input
      aria-label={label}
      aria-invalid={invalid || undefined}
      value={value}
      placeholder={placeholder}
      inputMode={numeric ? 'decimal' : undefined}
      dir={numeric ? 'ltr' : 'auto'}
      onChange={(event) => onChange(event.target.value)}
      className={`num min-h-12 w-full min-w-0 rounded-control border bg-surface px-3 md:min-h-10 ${
        invalid ? 'border-danger' : 'border-line'
      }`}
    />
  );
}
