import { Plus, Save, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ProductPersonalisationSetMutation } from '../api/operations';
import type {
  PersonalisationFieldValue,
  ProductDetail,
  ProductPersonalisationSetData,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { CheckField, Pair, parseList, Problems, SelectField } from '../settings/settings-form';
import { useAdminMutation } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';
import { FormSection } from './product-form';

/** As many fields as the core asks for on a product (ADR-689). */
const MAX_FIELDS = 5;

type Kind = PersonalisationFieldValue['kind'];

interface FieldDraft {
  key: number;
  name: string;
  kind: Kind;
  required: boolean;
  /** A text field's longest answer, as typed. */
  maxLength: string;
  /** A choice's options, as typed, commas between. */
  choices: string;
}

/** What the core takes for each field: a text field's length, or a choice's options. */
export function fieldsInput(drafts: readonly FieldDraft[]) {
  return drafts.map((draft) =>
    draft.kind === 'CHOICE'
      ? {
          name: draft.name,
          kind: draft.kind,
          required: draft.required,
          choices: parseList(draft.choices),
        }
      : {
          name: draft.name,
          kind: draft.kind,
          required: draft.required,
          maxLength: draft.maxLength.trim() === '' ? null : Number(draft.maxLength),
        },
  );
}

/** A draft's problems, by the part of it each is about, from what the core said of `fields`. */
type DraftErrors = Partial<Record<'name' | 'maxLength' | 'choices', string>>;

/**
 * What a product made to order asks the shopper for on its page (CAT-15, ADR-690): up to five
 * fields, text of a length or a choice among the shop's words, each answer going with the item on
 * its order and packing slip. Saved together.
 */
export function ProductPersonalisationCard({ product }: { product: ProductDetail }) {
  const { t } = useLocale();
  const set = useAdminMutation<
    ProductPersonalisationSetData,
    { productId: string; fields: ReturnType<typeof fieldsInput> }
  >(ProductPersonalisationSetMutation);
  const next = useRef(0);
  const draftsOf = (fields: readonly PersonalisationFieldValue[]): FieldDraft[] =>
    fields.map((field) => ({
      key: (next.current += 1),
      name: field.name,
      kind: field.kind,
      required: field.required,
      maxLength: field.maxLength === null ? '' : String(field.maxLength),
      choices: field.choices.join(', '),
    }));
  const [kept, setKept] = useState(() => draftsOf(product.personalisationFields ?? []));
  const [drafts, setDrafts] = useState(kept);
  const [errors, setErrors] = useState<Record<number, DraftErrors>>({});
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const changed = JSON.stringify(fieldsInput(drafts)) !== JSON.stringify(fieldsInput(kept));

  const change = (key: number, part: Partial<FieldDraft>) =>
    setDrafts((all) => all.map((each) => (each.key === key ? { ...each, ...part } : each)));

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setErrors({});
    setProblems([]);
    setSaved(false);
    try {
      const { productPersonalisationSet: result } = await set.mutateAsync({
        productId: product.id,
        fields: fieldsInput(drafts),
      });
      if (result.userErrors.length > 0) {
        const byDraft: Record<number, DraftErrors> = {};
        const rest: string[] = [];
        for (const error of result.userErrors) {
          const [list, at, part] = error.field ?? [];
          const draft = list === 'fields' && at !== undefined ? drafts[Number(at)] : undefined;
          if (draft && (part === 'name' || part === 'maxLength' || part === 'choices')) {
            const mine = (byDraft[draft.key] ??= {});
            mine[part] = mine[part] ? `${mine[part]} ${error.message}` : error.message;
          } else {
            rest.push(error.message);
          }
        }
        setErrors(byDraft);
        setProblems(rest);
        return;
      }
      const now = draftsOf(result.personalisationFields ?? []);
      setKept(now);
      setDrafts(now);
      setSaved(true);
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  return (
    <FormSection title={t('personalisation.title')} hint={t('personalisation.hint')}>
      <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-4">
        {drafts.length === 0 ? (
          <p className="text-secondary">{t('personalisation.none')}</p>
        ) : (
          <ol aria-label={t('personalisation.title')} className="flex flex-col gap-4">
            {drafts.map((draft, index) => {
              const number = index + 1;
              const mine = errors[draft.key] ?? {};
              return (
                <li key={draft.key}>
                  <fieldset className="flex flex-col gap-3 rounded-control border border-line p-3">
                    <legend className="px-1 font-medium">
                      {t('personalisation.field', { number })}
                    </legend>
                    <Pair>
                      <TextField
                        label={t('personalisation.name')}
                        hint={t('personalisation.nameHint')}
                        dir="auto"
                        required
                        maxLength={40}
                        value={draft.name}
                        error={mine.name}
                        onChange={(event) => change(draft.key, { name: event.target.value })}
                      />
                      <SelectField<Kind>
                        label={t('personalisation.kind')}
                        value={draft.kind}
                        options={[
                          { value: 'TEXT', label: t('personalisation.kindText') },
                          { value: 'CHOICE', label: t('personalisation.kindChoice') },
                        ]}
                        onChange={(kind) => change(draft.key, { kind })}
                      />
                    </Pair>
                    {draft.kind === 'TEXT' ? (
                      <TextField
                        label={t('personalisation.maxLength')}
                        hint={t('personalisation.maxLengthHint')}
                        type="number"
                        inputMode="numeric"
                        ltr
                        min={1}
                        max={250}
                        value={draft.maxLength}
                        error={mine.maxLength}
                        onChange={(event) => change(draft.key, { maxLength: event.target.value })}
                      />
                    ) : (
                      <TextField
                        label={t('personalisation.choices')}
                        hint={t('personalisation.choicesHint')}
                        dir="auto"
                        value={draft.choices}
                        error={mine.choices}
                        onChange={(event) => change(draft.key, { choices: event.target.value })}
                      />
                    )}
                    <CheckField
                      label={t('personalisation.required')}
                      hint={t('personalisation.requiredHint')}
                      checked={draft.required}
                      onChange={(required) => change(draft.key, { required })}
                    />
                    <Button
                      variant="danger"
                      className="self-start"
                      aria-label={t('personalisation.remove', { number })}
                      icon={<Trash2 aria-hidden className="size-5" />}
                      onClick={() =>
                        setDrafts((all) => all.filter((each) => each.key !== draft.key))
                      }
                    >
                      {t('personalisation.removeShort')}
                    </Button>
                  </fieldset>
                </li>
              );
            })}
          </ol>
        )}
        <Button
          variant="secondary"
          className="self-start"
          disabled={drafts.length >= MAX_FIELDS}
          icon={<Plus aria-hidden className="size-5" />}
          onClick={() =>
            setDrafts((all) => [
              ...all,
              {
                key: (next.current += 1),
                name: '',
                kind: 'TEXT',
                required: true,
                maxLength: '',
                choices: '',
              },
            ])
          }
        >
          {t('personalisation.add')}
        </Button>
        <Problems problems={problems} />
        {saved && !changed && <Alert tone="success">{t('personalisation.saved')}</Alert>}
        <Button
          type="submit"
          className="self-start"
          busy={set.isPending}
          disabled={!changed}
          icon={<Save aria-hidden className="size-5" />}
        >
          {t('personalisation.save')}
        </Button>
      </form>
    </FormSection>
  );
}
