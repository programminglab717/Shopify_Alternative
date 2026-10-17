import { Link } from '@tanstack/react-router';
import { Braces } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import {
  MetafieldsDeleteMutation,
  MetafieldsSetMutation,
  ProductMetafieldsQuery,
} from '../api/operations';
import type {
  MetafieldDefinition,
  ProductDetail,
  ProductMetafieldsData,
  UserError,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';
import { FormSection, problemText } from './product-form';

/** A value as its field shows it: a list's lines one to a line; the rest as kept. */
export function shownValue(definition: MetafieldDefinition, kept: string | undefined): string {
  if (kept === undefined) return '';
  if (definition.type === 'list.single_line_text_field') {
    try {
      return (JSON.parse(kept) as string[]).join('\n');
    } catch {
      return kept;
    }
  }
  return kept;
}

/** A value as typed, as the Admin API takes it: a list's lines as a JSON list. */
export function keptValue(definition: MetafieldDefinition, shown: string): string {
  if (definition.type === 'list.single_line_text_field') {
    return JSON.stringify(
      shown
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    );
  }
  return shown;
}

const INPUT_TYPES: Partial<Record<MetafieldDefinition['type'], string>> = {
  number_integer: 'number',
  number_decimal: 'text',
  date: 'date',
  url: 'url',
};

/** A field for one definition, of the kind its type takes. */
function ValueField({
  definition,
  value,
  onChange,
}: {
  definition: MetafieldDefinition;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useLocale();
  const id = useId();
  const hint = definition.description ?? t(`customData.hint.${definition.type}`);
  if (definition.type === 'boolean') {
    return (
      <SelectField<string>
        label={definition.name}
        value={value}
        options={[
          { value: '', label: t('customData.unset') },
          { value: 'true', label: t('customData.yes') },
          { value: 'false', label: t('customData.no') },
        ]}
        onChange={onChange}
      />
    );
  }
  if (
    definition.type === 'multi_line_text_field' ||
    definition.type === 'json' ||
    definition.type === 'list.single_line_text_field'
  ) {
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="font-medium" dir="auto">
          {definition.name}
        </label>
        <textarea
          id={id}
          value={value}
          rows={3}
          dir={definition.type === 'json' ? 'ltr' : 'auto'}
          aria-describedby={`${id}-hint`}
          onChange={(event) => onChange(event.target.value)}
          className="rounded-control border border-line bg-surface px-3 py-2"
        />
        <p
          id={`${id}-hint`}
          className="text-secondary text-[length:var(--hatti-type-body-sm-size)]"
        >
          {hint}
        </p>
      </div>
    );
  }
  return (
    <TextField
      label={definition.name}
      hint={hint}
      type={INPUT_TYPES[definition.type] ?? 'text'}
      ltr={definition.type !== 'single_line_text_field'}
      dir={definition.type === 'single_line_text_field' ? 'auto' : undefined}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/**
 * A product's custom fields (CAT-06, ADR-489): a field for each of the shop's definitions for
 * products, of the kind its type takes, saved through the Admin API's metafields; one emptied is
 * deleted. Without definitions, a pointer to Settings, where they are made.
 */
export function ProductMetafieldsCard({ product }: { product: ProductDetail }) {
  const { t } = useLocale();
  const shopId = useShop().id;
  const query = useAdminQuery<ProductMetafieldsData>(
    ['productMetafields', product.id],
    ProductMetafieldsQuery,
    { id: product.id },
  );
  const set = useAdminMutation<
    { metafieldsSet: { userErrors: UserError[] } },
    {
      metafields: { ownerId: string; namespace: string; key: string; value: string }[];
    }
  >(MetafieldsSetMutation);
  const remove = useAdminMutation<
    { metafieldsDelete: { userErrors: UserError[] } },
    { metafields: { ownerId: string; namespace: string; key: string }[] }
  >(MetafieldsDeleteMutation);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (!query.data) return null;
  const definitions = query.data.metafieldDefinitions;
  const kept = new Map(
    (query.data.product?.metafields ?? []).map((field) => [
      `${field.namespace}.${field.key}`,
      field.value,
    ]),
  );
  const idOf = (definition: MetafieldDefinition) => `${definition.namespace}.${definition.key}`;
  const shown = (definition: MetafieldDefinition) =>
    edited[idOf(definition)] ?? shownValue(definition, kept.get(idOf(definition)));
  const changed = definitions.filter((definition) => idOf(definition) in edited);

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setSaved(false);
    const filled = changed.filter((definition) => shown(definition).trim() !== '');
    const emptied = changed.filter(
      (definition) => shown(definition).trim() === '' && kept.has(idOf(definition)),
    );
    try {
      if (filled.length > 0) {
        const { metafieldsSet } = await set.mutateAsync({
          metafields: filled.map((definition) => ({
            ownerId: product.id,
            namespace: definition.namespace,
            key: definition.key,
            value: keptValue(definition, shown(definition)),
          })),
        });
        const [failed] = metafieldsSet.userErrors;
        if (failed) {
          const index = Number(failed.field?.[1]);
          const name = filled[index]?.name;
          const message = problemText(failed, t);
          setProblem(name ? `${name}: ${message}` : message);
          return;
        }
      }
      if (emptied.length > 0) {
        await remove.mutateAsync({
          metafields: emptied.map((definition) => ({
            ownerId: product.id,
            namespace: definition.namespace,
            key: definition.key,
          })),
        });
      }
      setEdited({});
      setSaved(true);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <FormSection title={t('customData.productTitle')} hint={t('customData.productHint')}>
      {definitions.length === 0 ? (
        <p className="text-secondary">
          {t('customData.productNone')}{' '}
          <Link
            to="/$shopId/settings/custom-data"
            params={{ shopId }}
            className="font-medium underline"
          >
            {t('settings.customData')}
          </Link>
        </p>
      ) : (
        <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-3">
          {definitions.map((definition) => (
            <ValueField
              key={definition.id}
              definition={definition}
              value={shown(definition)}
              onChange={(value) => {
                setSaved(false);
                setEdited({ ...edited, [idOf(definition)]: value });
              }}
            />
          ))}
          {problem && <Alert tone="danger">{problem}</Alert>}
          {saved && changed.length === 0 && (
            <Alert tone="success">{t('customData.productSaved')}</Alert>
          )}
          <Button
            type="submit"
            className="self-start"
            busy={set.isPending || remove.isPending}
            disabled={changed.length === 0}
            icon={<Braces aria-hidden className="size-5" />}
          >
            {t('customData.productSave')}
          </Button>
        </form>
      )}
    </FormSection>
  );
}
