import { Braces, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  MetafieldDefinitionCreateMutation,
  MetafieldDefinitionDeleteMutation,
  MetafieldDefinitionsQuery,
} from '../api/operations';
import type {
  MetafieldDefinition,
  MetafieldDefinitionsData,
  MetafieldOwnerTypeValue,
  MetafieldTypeValue,
  UserError,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { SelectField } from './settings-form';
import { BackToSettings } from './settings-page';

export const OWNER_TYPES: readonly MetafieldOwnerTypeValue[] = [
  'PRODUCT',
  'PRODUCTVARIANT',
  'COLLECTION',
];

export const METAFIELD_TYPES: readonly MetafieldTypeValue[] = [
  'single_line_text_field',
  'multi_line_text_field',
  'number_integer',
  'number_decimal',
  'boolean',
  'date',
  'date_time',
  'url',
  'color',
  'list.single_line_text_field',
  'json',
];

/** A field's key made from its name, as Shopify's admin makes one: care_instructions. */
export function keyOf(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

/**
 * Custom data (CAT-06, ADR-489): the shop's own fields of products, variants and collections, each
 * a name, a key in the `custom` namespace and the type its values take, which the product page
 * fills in and themes show with `product.metafields.custom.key`. Deleted with their values.
 */
export function CustomDataPage() {
  const { t } = useLocale();
  const query = useAdminQuery<MetafieldDefinitionsData>(
    ['metafieldDefinitions'],
    MetafieldDefinitionsQuery,
  );
  const create = useAdminMutation<
    {
      metafieldDefinitionCreate: {
        createdDefinition: MetafieldDefinition | null;
        userErrors: UserError[];
      };
    },
    {
      definition: {
        ownerType: MetafieldOwnerTypeValue;
        namespace: string;
        key: string;
        type: MetafieldTypeValue;
        name: string;
        description: string | null;
      };
    }
  >(MetafieldDefinitionCreateMutation);
  const remove = useAdminMutation<
    { metafieldDefinitionDelete: { userErrors: UserError[] } },
    { id: string }
  >(MetafieldDefinitionDeleteMutation);
  const [ownerType, setOwnerType] = useState<MetafieldOwnerTypeValue>('PRODUCT');
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [type, setType] = useState<MetafieldTypeValue>('single_line_text_field');
  const [description, setDescription] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const onCreate = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setDone(null);
    try {
      const { metafieldDefinitionCreate } = await create.mutateAsync({
        definition: {
          ownerType,
          namespace: 'custom',
          key: key || keyOf(name),
          type,
          name: name.trim(),
          description: description.trim() || null,
        },
      });
      const [failed] = metafieldDefinitionCreate.userErrors;
      if (failed) setProblem(problemText(failed, t));
      else {
        setDone(t('customData.added', { name: name.trim() }));
        setName('');
        setKey('');
        setKeyTouched(false);
        setDescription('');
      }
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  const onDelete = async (definition: MetafieldDefinition) => {
    setProblem(null);
    setDone(null);
    try {
      const { metafieldDefinitionDelete } = await remove.mutateAsync({ id: definition.id });
      const [failed] = metafieldDefinitionDelete.userErrors;
      if (failed) setProblem(problemText(failed, t));
      else setDone(t('customData.deleted', { name: definition.name }));
      setDeleting(null);
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
  const definitions = query.data.metafieldDefinitions;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSettings />
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('settings.customData')}
      </h1>
      <p className="text-secondary">{t('customData.intro')}</p>
      {done && <Alert tone="success">{done}</Alert>}
      {problem && <Alert tone="danger">{problem}</Alert>}

      {OWNER_TYPES.map((owner) => {
        const mine = definitions.filter((definition) => definition.ownerType === owner);
        return (
          <section key={owner} aria-labelledby={`custom-${owner}`} className="flex flex-col gap-2">
            <h2 id={`custom-${owner}`} className="font-semibold">
              {t(`customData.owner.${owner}`)}
            </h2>
            {mine.length === 0 ? (
              <p className="text-secondary">{t('customData.none')}</p>
            ) : (
              <Card>
                <ul className="divide-y divide-line">
                  {mine.map((definition) => (
                    <li key={definition.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="font-medium" dir="auto">
                          {definition.name}
                        </span>
                        <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                          <code dir="ltr">
                            {definition.namespace}.{definition.key}
                          </code>{' '}
                          · {t(`customData.type.${definition.type}`)} ·{' '}
                          {t('customData.filled', { count: definition.metafieldsCount })}
                        </span>
                      </span>
                      {deleting === definition.id ? (
                        <span className="flex flex-wrap items-center gap-2">
                          <span>{t('customData.deleteSure')}</span>
                          <Button
                            variant="destructive"
                            busy={remove.isPending}
                            onClick={() => void onDelete(definition)}
                          >
                            {t('customData.deleteYes')}
                          </Button>
                          <Button variant="tertiary" onClick={() => setDeleting(null)}>
                            {t('action.back')}
                          </Button>
                        </span>
                      ) : (
                        <Button
                          variant="danger"
                          icon={<Trash2 aria-hidden className="size-5" />}
                          aria-label={t('customData.delete', { name: definition.name })}
                          onClick={() => setDeleting(definition.id)}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </section>
        );
      })}

      <Card className="p-4">
        <form onSubmit={(event) => void onCreate(event)} className="flex flex-col gap-4">
          <h2 className="inline-flex items-center gap-2 font-semibold">
            <Braces aria-hidden className="size-5" />
            {t('customData.add')}
          </h2>
          <SelectField<MetafieldOwnerTypeValue>
            label={t('customData.for')}
            value={ownerType}
            options={OWNER_TYPES.map((value) => ({
              value,
              label: t(`customData.owner.${value}`),
            }))}
            onChange={setOwnerType}
          />
          <TextField
            label={t('customData.name')}
            hint={t('customData.nameHint')}
            maxLength={100}
            dir="auto"
            required
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (!keyTouched) setKey(keyOf(event.target.value));
            }}
          />
          <TextField
            label={t('customData.key')}
            hint={t('customData.keyHint', { key: key || 'care' })}
            ltr
            maxLength={64}
            value={key}
            onChange={(event) => {
              setKeyTouched(true);
              setKey(event.target.value);
            }}
          />
          <SelectField<MetafieldTypeValue>
            label={t('customData.typeLabel')}
            value={type}
            options={METAFIELD_TYPES.map((value) => ({
              value,
              label: t(`customData.type.${value}`),
            }))}
            onChange={setType}
          />
          <TextField
            label={t('customData.description')}
            maxLength={300}
            dir="auto"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <Button
            type="submit"
            busy={create.isPending}
            className="self-start"
            icon={<Plus aria-hidden className="size-5" />}
          >
            {t('customData.addSubmit')}
          </Button>
        </form>
      </Card>
    </div>
  );
}
