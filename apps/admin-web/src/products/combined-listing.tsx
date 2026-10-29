import { ArrowDown, ArrowUp, Layers, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { CombinedListingDeleteMutation, CombinedListingSetMutation } from '../api/operations';
import type {
  CombinedListing,
  CombinedListingDeleteData,
  CombinedListingSetData,
  ProductDetail,
  UserError,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { ProductFinder } from '../online-store/link-page';
import { CheckField } from '../settings/settings-form';
import { useAdminMutation } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';
import { FormSection } from './product-form';

/** Most products a listing holds (ADR-799). */
export const MOST_COMBINED = 100;

/** A product of the listing as the card edits it. */
interface Member {
  productId: string;
  title: string;
  value: string;
  valueUr: string;
}

const membersOf = (listing: CombinedListing | null | undefined): Member[] =>
  (listing?.products ?? []).map((each) => ({
    productId: each.productId,
    title: each.product?.title ?? '',
    value: each.value,
    valueUr: each.valueUr ?? '',
  }));

/** The core's words for a product's problem, the product named where it is one. */
function memberProblem(error: UserError, members: readonly Member[]): string {
  const field = error.field ?? [];
  const index = field[1] === 'products' ? Number(field[2]) : Number.NaN;
  const member = Number.isInteger(index) ? members[index] : undefined;
  return member ? `${member.title}: ${error.message}` : error.message;
}

/**
 * The combined listing a product is in (CAT-23, ADR-799): the option its products differ by,
 * such as Colour, and each product with its value, this one among them, in the order its pages
 * offer them, and whether collections show it as one card (ADR-901). Saved whole; stopped, each
 * product is shown on its own again.
 */
export function ProductCombinedListingCard({ product }: { product: ProductDetail }) {
  const { t } = useLocale();
  const set = useAdminMutation<CombinedListingSetData, Record<string, unknown>>(
    CombinedListingSetMutation,
  );
  const remove = useAdminMutation<CombinedListingDeleteData, { id: string }>(
    CombinedListingDeleteMutation,
  );
  const [listingId, setListingId] = useState(product.combinedListing?.id ?? null);
  const [optionName, setOptionName] = useState(product.combinedListing?.optionName ?? '');
  const [optionNameUr, setOptionNameUr] = useState(product.combinedListing?.optionNameUr ?? '');
  const [oneCard, setOneCard] = useState(product.combinedListing?.oneCard ?? false);
  const own: Member = { productId: product.id, title: product.title, value: '', valueUr: '' };
  const [members, setMembers] = useState<Member[]>(() => {
    const kept = membersOf(product.combinedListing);
    return kept.length > 0 ? kept : [own];
  });
  const [picking, setPicking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const move = (index: number, by: number) => {
    const next = [...members];
    const [taken] = next.splice(index, 1);
    next.splice(index + by, 0, taken!);
    setMembers(next);
  };

  const change = (index: number, words: Partial<Pick<Member, 'value' | 'valueUr'>>) =>
    setMembers(members.map((each, at) => (at === index ? { ...each, ...words } : each)));

  const onAdd = (productId: string, title: string) => {
    if (members.some((each) => each.productId === productId)) {
      setNote(t('combined.already', { title }));
    } else if (members.length >= MOST_COMBINED) {
      setNote(t('combined.most', { most: MOST_COMBINED }));
    } else {
      setNote(null);
      setMembers([...members, { productId, title, value: '', valueUr: '' }]);
    }
  };

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setDone(null);
    if (members.length < 2) {
      setProblem(t('combined.fewer'));
      return;
    }
    try {
      const { combinedListingSet } = await set.mutateAsync({
        id: listingId,
        input: {
          optionName: optionName.trim(),
          optionNameUr: optionNameUr.trim() || null,
          products: members.map((each) => ({
            productId: each.productId,
            value: each.value.trim(),
            valueUr: each.valueUr.trim() || null,
          })),
          oneCard,
        },
      });
      const error = combinedListingSet.userErrors[0];
      if (error || !combinedListingSet.combinedListing) {
        setProblem(error ? memberProblem(error, members) : t('state.error'));
        return;
      }
      const saved = combinedListingSet.combinedListing;
      setListingId(saved.id);
      setOptionName(saved.optionName);
      setOptionNameUr(saved.optionNameUr ?? '');
      setOneCard(saved.oneCard);
      setMembers(membersOf(saved));
      setDone(t('combined.saved'));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  const onDelete = async () => {
    if (!listingId) return;
    setProblem(null);
    setDone(null);
    try {
      const { combinedListingDelete } = await remove.mutateAsync({ id: listingId });
      const error = combinedListingDelete.userErrors[0];
      if (error) {
        setProblem(error.message);
        return;
      }
      setListingId(null);
      setOptionName('');
      setOptionNameUr('');
      setOneCard(false);
      setMembers([own]);
      setDone(t('combined.deleted'));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <FormSection title={t('combined.title')} hint={t('combined.hint')}>
      <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-3">
        {members.length < 2 && <p className="text-secondary">{t('combined.none')}</p>}
        <TextField
          label={t('combined.option')}
          hint={t('combined.optionHint')}
          dir="auto"
          maxLength={255}
          required
          value={optionName}
          onChange={(event) => setOptionName(event.target.value)}
        />
        <TextField
          label={t('combined.optionUr')}
          hint={t('combined.urHint')}
          dir="rtl"
          lang="ur"
          maxLength={255}
          value={optionNameUr}
          onChange={(event) => setOptionNameUr(event.target.value)}
        />
        <ol className="flex flex-col divide-y divide-line rounded-control border border-line">
          {members.map((each, index) => (
            <li key={each.productId} className="flex flex-wrap items-end gap-2 px-3 py-2">
              <div className="flex min-w-48 flex-1 flex-col gap-2">
                <TextField
                  label={t('combined.value', { title: each.title })}
                  hint={each.productId === product.id ? t('combined.this') : undefined}
                  dir="auto"
                  maxLength={255}
                  required
                  value={each.value}
                  onChange={(event) => change(index, { value: event.target.value })}
                />
                <TextField
                  label={t('combined.valueUr', { title: each.title })}
                  dir="rtl"
                  lang="ur"
                  maxLength={255}
                  value={each.valueUr}
                  onChange={(event) => change(index, { valueUr: event.target.value })}
                />
              </div>
              <Button
                variant="tertiary"
                aria-label={t('combined.moveUp', { title: each.title })}
                disabled={index === 0}
                icon={<ArrowUp aria-hidden className="size-5" />}
                onClick={() => move(index, -1)}
              />
              <Button
                variant="tertiary"
                aria-label={t('combined.moveDown', { title: each.title })}
                disabled={index === members.length - 1}
                icon={<ArrowDown aria-hidden className="size-5" />}
                onClick={() => move(index, 1)}
              />
              {each.productId !== product.id && (
                <Button
                  variant="tertiary"
                  aria-label={t('combined.remove', { title: each.title })}
                  icon={<Trash2 aria-hidden className="size-5" />}
                  onClick={() => setMembers(members.filter((_, at) => at !== index))}
                />
              )}
            </li>
          ))}
        </ol>
        {picking ? (
          <ProductFinder onAdd={onAdd} note={note} />
        ) : (
          <Button
            variant="secondary"
            className="self-start"
            icon={<Plus aria-hidden className="size-5" />}
            disabled={members.length >= MOST_COMBINED}
            onClick={() => setPicking(true)}
          >
            {t('combined.add')}
          </Button>
        )}
        <CheckField
          label={t('combined.oneCard')}
          hint={t('combined.oneCardHint')}
          checked={oneCard}
          onChange={setOneCard}
        />
        {problem && <Alert tone="danger">{problem}</Alert>}
        {done && <Alert tone="success">{done}</Alert>}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            busy={set.isPending}
            icon={<Layers aria-hidden className="size-5" />}
          >
            {t('combined.save')}
          </Button>
          {listingId && (
            <Button variant="tertiary" busy={remove.isPending} onClick={() => void onDelete()}>
              {t('combined.delete')}
            </Button>
          )}
        </div>
      </form>
    </FormSection>
  );
}
