import { ArrowDown, ArrowUp, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { ProductComplementsSetMutation } from '../api/operations';
import type { ProductComplementsSetData, ProductDetail, UserError } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { ProductFinder } from '../online-store/link-page';
import { useAdminMutation } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { FormSection } from './product-form';

/** A product it pairs with: its ID and its title. */
interface Paired {
  id: string;
  title: string;
}

/** Most products one pairs with (ADR-435), as Shopify allows. */
export const MOST_PAIRED = 10;

const same = (a: readonly Paired[], b: readonly Paired[]) =>
  a.length === b.length && a.every((each, index) => each.id === b[index]!.id);

/** The core's words for a product's problem, the product named where it is one (ADR-435). */
function pairingProblem(error: UserError, paired: readonly Paired[]): string {
  const field = error.field ?? [];
  const index = field[0] === 'complementIds' ? Number(field[1]) : Number.NaN;
  const product = Number.isInteger(index) ? paired[index] : undefined;
  return product ? `${product.title}: ${error.message}` : error.message;
}

/**
 * The products the shop pairs with this one (MKT-09, ADR-435): a dupatta with a kurta, khussas
 * with a suit. The storefront recommends them as complementary, in this order, on its page and
 * where a theme asks; none, and it recommends none.
 */
export function ProductPairingsCard({ product }: { product: ProductDetail }) {
  const { t } = useLocale();
  const set = useAdminMutation<
    ProductComplementsSetData,
    { productId: string; complementIds: string[] }
  >(ProductComplementsSetMutation);
  const [stored, setStored] = useState<Paired[]>(() => product.complementaryProducts ?? []);
  const [paired, setPaired] = useState(stored);
  const [picking, setPicking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const changed = !same(paired, stored);

  const move = (index: number, by: number) => {
    const next = [...paired];
    const [taken] = next.splice(index, 1);
    next.splice(index + by, 0, taken!);
    setPaired(next);
  };

  const onAdd = (id: string, title: string) => {
    if (id === product.id) setNote(t('pairings.notItself'));
    else if (paired.some((each) => each.id === id)) setNote(t('pairings.already', { title }));
    else if (paired.length >= MOST_PAIRED) setNote(t('pairings.most', { most: MOST_PAIRED }));
    else {
      setNote(null);
      setPaired([...paired, { id, title }]);
    }
  };

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setSaved(false);
    try {
      const { productComplementsSet } = await set.mutateAsync({
        productId: product.id,
        complementIds: paired.map((each) => each.id),
      });
      const error = productComplementsSet.userErrors[0];
      if (error) {
        setProblem(pairingProblem(error, paired));
        return;
      }
      const now = productComplementsSet.complementaryProducts ?? [];
      setStored(now);
      setPaired(now);
      setSaved(true);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <FormSection title={t('pairings.title')} hint={t('pairings.hint', { most: MOST_PAIRED })}>
      <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-3">
        {paired.length === 0 ? (
          <p className="text-secondary">{t('pairings.none')}</p>
        ) : (
          <ol className="flex flex-col divide-y divide-line rounded-control border border-line">
            {paired.map((each, index) => (
              <li key={each.id} className="flex items-center gap-1 px-3 py-2">
                <span className="min-w-0 flex-1" dir="auto">
                  {each.title}
                </span>
                <Button
                  variant="tertiary"
                  aria-label={t('pairings.moveUp', { title: each.title })}
                  disabled={index === 0}
                  icon={<ArrowUp aria-hidden className="size-5" />}
                  onClick={() => move(index, -1)}
                />
                <Button
                  variant="tertiary"
                  aria-label={t('pairings.moveDown', { title: each.title })}
                  disabled={index === paired.length - 1}
                  icon={<ArrowDown aria-hidden className="size-5" />}
                  onClick={() => move(index, 1)}
                />
                <Button
                  variant="tertiary"
                  aria-label={t('pairings.remove', { title: each.title })}
                  icon={<Trash2 aria-hidden className="size-5" />}
                  onClick={() => setPaired(paired.filter((_, at) => at !== index))}
                />
              </li>
            ))}
          </ol>
        )}
        {picking ? (
          <ProductFinder onAdd={onAdd} note={note} />
        ) : (
          <Button
            variant="secondary"
            className="self-start"
            icon={<Plus aria-hidden className="size-5" />}
            disabled={paired.length >= MOST_PAIRED}
            onClick={() => setPicking(true)}
          >
            {t('pairings.add')}
          </Button>
        )}
        {problem && <Alert tone="danger">{problem}</Alert>}
        {saved && !changed && (
          <Alert tone="success">
            {stored.length > 0 ? t('pairings.savedOn') : t('pairings.savedOff')}
          </Alert>
        )}
        <Button
          type="submit"
          className="self-start"
          busy={set.isPending}
          disabled={!changed}
          icon={<Sparkles aria-hidden className="size-5" />}
        >
          {t('pairings.save')}
        </Button>
      </form>
    </FormSection>
  );
}
